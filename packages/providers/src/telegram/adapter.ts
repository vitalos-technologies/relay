// Telegram channel publishing adapter (Bot API). See docs/providers/telegram.md for sources.
//  - text  => sendMessage (link appended to text, link_preview_options for the link, URL buttons)
//  - image => sendPhoto multipart (bytes uploaded, caption, URL buttons)
//  - album => sendMediaGroup multipart (V1.1): 2–10 photos/videos as attach://fileN, caption on the first
//             item; media groups cannot carry reply_markup, so URL buttons are refused by validation
//  - video => sendVideo multipart (V1.1): video bytes, caption, duration/width/height, supports_streaming
//  - Telegram has no client idempotency key and no history lookup for bots: an ambiguous send
//    cannot be reconciled automatically (reconcile => 'unsupported', manual resolution).
import {
  TransportError, composeTextWithLink, validateVariant,
  type AdapterContext, type AttemptReference, type ChannelCapabilities, type ChannelConstraints, type Checkpoint,
  type ConnectionHealth, type PrepareOutcome, type ProviderCredentials, type PublishConnection, type PublishInput,
  type PublishOutcome, type PublishingAdapter, type ReconcileOutcome, type UrlButton, type ValidationResult,
} from '@social-lite/core';
import {
  TELEGRAM_FIX_ADMIN, TelegramApiError, botTokenFrom, classifyTelegramError, tgCall,
  type TgChatMember, type TgMessage, type TgUser,
} from './api.js';

export const TELEGRAM_CONSTRAINTS_VERSION = 'telegram-bot-api-10.3@2026-11-06';

export const TELEGRAM_CONSTRAINTS: ChannelConstraints = {
  maxTextLength: 4096,          // sendMessage.text: 1-4096 characters after entities parsing
  maxCaptionLength: 1024,       // sendPhoto.caption: 0-1024 characters after entities parsing
  textCounting: 'utf16',
  requiresMedia: false,
  supportsTextOnly: true,
  supportsLink: true,
  supportsButtons: true,
  maxButtons: 5,                // product limit (one URL button per row)
  maxImages: 10,                // V1.1 sendMediaGroup: "must include 2-10 items"
  maxAlbumItems: 10,
  minAlbumItems: 2,
  albumAllowsVideo: true,       // photos and videos can be grouped
  albumSupportsButtons: false,  // sendMediaGroup has no reply_markup parameter
  imageMimes: ['image/jpeg', 'image/png'],
  maxImageBytes: 10 * 1024 * 1024, // photos: 10 MB max
  minAspectRatio: 1 / 20,       // width/height ratio at most 20
  maxAspectRatio: 20,
  // V1.1 sendVideo: "Bots can currently send video files of up to 50 MB"; clients support MPEG4.
  maxVideos: 1,
  videoMimes: ['video/mp4', 'video/quicktime'],
  maxVideoBytes: 50 * 1024 * 1024,
  maxVideoSeconds: 15 * 60,     // media pipeline cap (Telegram documents no duration limit)
  videoCodecs: ['h264'],
  audioCodecs: ['aac'],
};

export const TELEGRAM_MEDIA_CONSTRAINTS_VERSION = 'telegram-bot-api-10.3@2026-11-07';

/** Bot API: "The photo's width and height must not exceed 10000 in total." */
const MAX_PHOTO_DIMENSION_SUM = 10_000;

export function telegramMessageUrl(connection: PublishConnection, messageId: string): string | null {
  if (connection.isMock) return null;
  const u = connection.username?.replace(/^@/, '');
  return u ? `https://t.me/${u}/${messageId}` : null;
}

function replyMarkup(buttons: UrlButton[]): { inline_keyboard: Array<Array<{ text: string; url: string }>> } | undefined {
  if (!buttons.length) return undefined;
  return { inline_keyboard: buttons.map((b) => [{ text: b.text, url: b.url }]) };
}

function capabilities(): ChannelCapabilities {
  return {
    provider: 'telegram',
    formats: ['text', 'image', 'album', 'video'],
    canPublish: true,
    canEditPublished: false,
    canDeletePublished: false,
    canReadMetrics: false,
    canReconcile: false,
    constraints: TELEGRAM_CONSTRAINTS,
    constraintsVersion: TELEGRAM_MEDIA_CONSTRAINTS_VERSION,
    checkedAt: new Date().toISOString(),
  };
}

function validate(input: Pick<PublishInput, 'variant' | 'media' | 'connection'>): ValidationResult {
  const r = validateVariant({
    provider: 'telegram',
    connectionId: input.connection.id,
    constraints: TELEGRAM_CONSTRAINTS,
    text: input.variant.text,
    link: input.variant.link,
    buttons: input.variant.buttons,
    media: input.media.map((m) => ({
      assetId: m.assetId, status: 'ready', mime: m.mime, bytes: m.bytes, width: m.width, height: m.height,
      kind: m.kind, durationMs: m.durationMs, videoCodec: m.videoCodec, audioCodec: m.audioCodec, frameRate: m.frameRate,
    })),
  });
  for (const m of input.media) {
    if (!isVideo(m) && m.width + m.height > MAX_PHOTO_DIMENSION_SUM) {
      r.issues.push({
        connectionId: input.connection.id, provider: 'telegram', field: 'media', code: 'dimensions',
        message: `Telegram: image width + height is ${m.width + m.height}px; at most ${MAX_PHOTO_DIMENSION_SUM}px. Resize it.`,
      });
    }
  }
  r.ok = r.issues.length === 0;
  return r;
}

const isVideo = (m: PublishInput['media'][number]) => m.kind === 'video' || m.mime.startsWith('video/');

async function prepare(_ctx: AdapterContext, input: PublishInput, checkpoint: Checkpoint | null): Promise<PrepareOutcome> {
  // Nothing to stage at the provider: media are uploaded in the same request that publishes them
  // (the Bot API has no upload-only call), so there is no checkpoint to resume beyond "ready".
  const v = validate(input);
  if (!v.ok) return { kind: 'permanent', code: 'invalid_content', message: v.issues.map((i) => i.message).join(' ') };
  return { kind: 'ready', checkpoint: checkpoint ?? { step: 'none', data: {} } };
}

const fileName = (m: PublishInput['media'][number]) => (isVideo(m) ? 'video.mp4' : m.mime === 'image/png' ? 'photo.png' : 'photo.jpg');
const blobOf = (m: PublishInput['media'][number], bytes: Uint8Array) => new Blob([bytes as unknown as ArrayBuffer], { type: isVideo(m) ? 'video/mp4' : m.mime });

/** InputMediaPhoto / InputMediaVideo for sendMediaGroup; the caption goes on the first item only. */
export function mediaGroupItems(media: PublishInput['media'], caption: string): Array<Record<string, unknown>> {
  return media.map((m, i) => ({
    type: isVideo(m) ? 'video' : 'photo',
    media: `attach://file${i}`,
    ...(i === 0 && caption.trim().length ? { caption } : {}),
    ...(isVideo(m) ? { width: m.width, height: m.height, ...(m.durationMs ? { duration: Math.round(m.durationMs / 1000) } : {}), supports_streaming: true } : {}),
  }));
}

function publishError(err: unknown): PublishOutcome {
  if (err instanceof TelegramApiError) {
    const c = classifyTelegramError(err);
    switch (c.kind) {
      case 'rate_limited': return { kind: 'rejected_safe_to_retry', code: c.code, message: c.message, retryAfterMs: c.retryAfterMs };
      case 'reconnect': return { kind: 'permanent_failure', code: c.code, message: c.message, blocking: 'reconnect' };
      case 'permission': return { kind: 'permanent_failure', code: c.code, message: c.message, blocking: 'permission' };
      case 'invalid': return { kind: 'permanent_failure', code: c.code, message: c.message };
      case 'server': return { kind: 'unknown', code: c.code, message: `${c.message} The message may or may not have been posted; check the channel before retrying.` };
    }
  }
  if (err instanceof TransportError) {
    if (!err.requestMayHaveBeenSent) return { kind: 'rejected_safe_to_retry', code: 'network_unreachable', message: 'Could not connect to Telegram; nothing was sent.' };
    return { kind: 'unknown', code: 'response_lost', message: 'The connection to Telegram was lost after the message was sent; it may have been posted. Check the channel before retrying.' };
  }
  return { kind: 'unknown', code: 'unexpected', message: 'Unexpected error while sending to Telegram; the message may have been posted. Check the channel before retrying.' };
}

async function publish(ctx: AdapterContext, input: PublishInput, _checkpoint: Checkpoint | null): Promise<PublishOutcome> {
  const token = botTokenFrom(input.credentials);
  const chatId = input.connection.providerAccountId;
  const text = composeTextWithLink(input.variant.text, input.variant.link);
  const markup = replyMarkup(input.variant.buttons);
  const image = input.media[0];

  const loaded: Uint8Array[] = [];
  for (const m of input.media) {
    try {
      loaded.push(await m.load());
    } catch {
      return { kind: 'rejected_safe_to_retry', code: 'media_unavailable', message: `The ${isVideo(m) ? 'video' : 'image'} could not be read from storage; nothing was sent.` };
    }
  }
  const bytes = loaded[0] ?? null;

  try {
    let msg: TgMessage;
    if (input.media.length > 1) {
      // V1.1 album: one request, all-or-nothing at the provider; ambiguous failures are Unknown.
      const form = new FormData();
      form.append('chat_id', chatId);
      form.append('media', JSON.stringify(mediaGroupItems(input.media, text)));
      input.media.forEach((m, i) => form.append(`file${i}`, blobOf(m, loaded[i]!), fileName(m)));
      const msgs = await tgCall<TgMessage[]>(ctx, token, 'sendMediaGroup', form, { publishes: true, timeoutMs: 180_000 });
      const ids = (Array.isArray(msgs) ? msgs : []).map((x) => String(x.message_id));
      if (!ids.length) return { kind: 'unknown', code: 'telegram_no_ids', message: 'Telegram accepted the album but returned no message ids; check the channel before retrying.' };
      return {
        kind: 'confirmed', providerIds: ids, url: telegramMessageUrl(input.connection, ids[0]!),
        publishedAt: typeof msgs[0]?.date === 'number' ? new Date(msgs[0].date * 1000).toISOString() : ctx.now().toISOString(),
      };
    }
    if (image && bytes && isVideo(image)) {
      const form = new FormData();
      form.append('chat_id', chatId);
      form.append('video', blobOf(image, bytes), fileName(image));
      if (image.durationMs) form.append('duration', String(Math.round(image.durationMs / 1000)));
      form.append('width', String(image.width));
      form.append('height', String(image.height));
      form.append('supports_streaming', 'true');
      if (text.trim().length) form.append('caption', text);
      if (markup) form.append('reply_markup', JSON.stringify(markup));
      msg = await tgCall<TgMessage>(ctx, token, 'sendVideo', form, { publishes: true, timeoutMs: 180_000 });
    } else if (image && bytes) {
      const form = new FormData();
      form.append('chat_id', chatId);
      const ext = image.mime === 'image/png' ? 'png' : 'jpg';
      form.append('photo', new Blob([bytes as unknown as ArrayBuffer], { type: image.mime }), `photo.${ext}`);
      if (text.trim().length) form.append('caption', text);
      if (markup) form.append('reply_markup', JSON.stringify(markup));
      msg = await tgCall<TgMessage>(ctx, token, 'sendPhoto', form, { publishes: true, timeoutMs: 60_000 });
    } else {
      const body: Record<string, unknown> = { chat_id: chatId, text };
      if (input.variant.link) body.link_preview_options = { is_disabled: false, url: input.variant.link };
      if (markup) body.reply_markup = markup;
      msg = await tgCall<TgMessage>(ctx, token, 'sendMessage', body, { publishes: true, timeoutMs: 30_000 });
    }
    const id = String(msg.message_id);
    return {
      kind: 'confirmed',
      providerIds: [id],
      url: telegramMessageUrl(input.connection, id),
      publishedAt: typeof msg.date === 'number' ? new Date(msg.date * 1000).toISOString() : ctx.now().toISOString(),
    };
  } catch (err) {
    return publishError(err);
  }
}

async function reconcile(_ctx: AdapterContext, ref: AttemptReference): Promise<ReconcileOutcome> {
  if (ref.providerIds.length) {
    return { kind: 'published', providerIds: ref.providerIds, url: telegramMessageUrl(ref.connection, ref.providerIds[0]!) };
  }
  return {
    kind: 'unsupported',
    reason: 'Telegram bots cannot look up channel history and the Bot API has no idempotency key, so this send cannot be verified automatically. Open the channel, then mark the delivery Published or Not published.',
  };
}

/** Evaluate the bot's membership in the channel. Shared with the connector's verify(). */
export function evaluateMember(member: TgChatMember, bot: TgUser, checkedAt: string): ConnectionHealth {
  const name = bot.username ? `@${bot.username}` : 'the bot';
  if (member.status === 'creator' || (member.status === 'administrator' && member.can_post_messages === true)) {
    return { status: 'ready', checkedAt, message: `${name} can post to this channel.` };
  }
  if (member.status === 'administrator') {
    return {
      status: 'missing_permission', checkedAt, missingPermissions: ['can_post_messages'],
      message: `${name} is an administrator but lacks the "Post Messages" right. In Telegram open the channel → Administrators → ${name} and enable "Post Messages", then click Check connection.`,
    };
  }
  return {
    status: 'missing_permission', checkedAt, missingPermissions: ['administrator', 'can_post_messages'],
    message: `${name} is not an administrator of this channel. ${TELEGRAM_FIX_ADMIN}`,
  };
}

async function health(ctx: AdapterContext, connection: PublishConnection, credentials: ProviderCredentials): Promise<ConnectionHealth> {
  const checkedAt = ctx.now().toISOString();
  const token = botTokenFrom(credentials);
  let bot: TgUser;
  try {
    bot = await tgCall<TgUser>(ctx, token, 'getMe', {});
  } catch (err) {
    if (err instanceof TelegramApiError && classifyTelegramError(err).kind === 'reconnect') {
      return { status: 'reconnect_required', checkedAt, message: classifyTelegramError(err).message };
    }
    throw err; // transient: caller keeps the previous status
  }
  try {
    const member = await tgCall<TgChatMember>(ctx, token, 'getChatMember', { chat_id: connection.providerAccountId, user_id: bot.id });
    const h = evaluateMember(member, bot, checkedAt);
    return { ...h, metadata: { bot_id: String(bot.id), bot_username: bot.username ?? null } };
  } catch (err) {
    if (err instanceof TelegramApiError) {
      const c = classifyTelegramError(err);
      if (c.kind === 'permission' || c.kind === 'invalid') {
        return { status: 'missing_permission', checkedAt, missingPermissions: ['administrator', 'can_post_messages'], message: c.kind === 'permission' ? c.message : `The bot cannot access this channel. ${TELEGRAM_FIX_ADMIN}` };
      }
      if (c.kind === 'reconnect') return { status: 'reconnect_required', checkedAt, message: c.message };
    }
    throw err;
  }
}

export const telegramAdapter: PublishingAdapter = {
  provider: 'telegram',
  capabilities: () => capabilities(),
  validate,
  prepare,
  publish,
  reconcile,
  health,
};
