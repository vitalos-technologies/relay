// Telegram bot inbox adapter (V3.5 stream B): private chats with the bot and group messages the bot can see.
// Verified 2026-11-08 at core.telegram.org/bots/api:
//  - A bot has ONE update consumer: a webhook (setWebhook) or long polling (getUpdates) — "You will not be able to
//    receive updates using getUpdates for as long as an outgoing webhook is set up". Updates are kept ≤ 24 h.
//  - setWebhook {url, secret_token (1-256 [A-Za-z0-9_-]), allowed_updates, drop_pending_updates}; the secret arrives in
//    X-Telegram-Bot-Api-Secret-Token. getWebhookInfo {url, pending_update_count, last_error_*}. deleteWebhook.
//  - sendMessage {chat_id, text ≤ 4096, reply_parameters:{message_id, allow_sending_without_reply}} → Message.
//  - deleteMessage {chat_id, message_id}: a bot can delete its own messages (< 48 h); getFile → file_path, downloaded
//    from https://api.telegram.org/file/bot<token>/<file_path> (≤ 20 MB).
// Ownership plan (Relay never overwrites another consumer): see services/inbox/channels-telegram.ts. Relay never calls
// getUpdates. There is no API to list sent messages, so an unconfirmed send is settled by a person (never resent).
import { TransportError, type AdapterContext, type ProviderCredentials } from '@social-lite/core';
import type { ChannelCapability, InboundItem, InboxAdapter, ReplyRulesInput, ReplyRulesResult, SendReplyResult } from '@social-lite/core/contracts/v35-inbox';
import { clip, epochToIso, str } from '../shared/inbox.js';
import { TelegramApiError, botTokenFrom, classifyTelegramError, tgCall, type TgWebhookInfo } from './api.js';

export const TELEGRAM_INBOX_CAPABILITY: ChannelCapability = {
  kind: 'telegram_bot',
  conversationTypes: {
    dm: { read: 'supported', reply: 'supported', visibility: 'private' },
    comment: { read: 'supported', reply: 'supported', visibility: 'public' },
  },
  inbound: 'webhook',
  history: 'None: Telegram keeps undelivered updates for 24 h and has no message history API for bots.',
  replyWindow: null,
  attachments: 'Photos, documents, voice: metadata; fetched on request (≤ 20 MB).',
  moderation: ['Delete the bot’s own messages (within 48 h)'],
  receipts: { delivered: false, read: false },
  requires: ['Bot token (no review)', 'Only chats where people message the bot, or groups it is in (privacy mode limits group messages)', 'Relay must own the bot’s update stream: added only when no webhook is set and the owner confirms no other app polls it'],
  verifiedOn: '2026-11-08',
};

interface TgFrom { id?: number; is_bot?: boolean; first_name?: string; last_name?: string; username?: string }
interface TgMsg { message_id?: number; from?: TgFrom; chat?: { id?: number; type?: string; title?: string }; date?: number; edit_date?: number; text?: string; caption?: string;
  photo?: Array<{ file_id?: string; file_size?: number }>; document?: { file_id?: string; file_name?: string; mime_type?: string; file_size?: number }; voice?: { file_id?: string; mime_type?: string; file_size?: number }; reply_to_message?: { message_id?: number } }
interface TgUpdate { update_id?: number; message?: TgMsg; edited_message?: TgMsg }

/** Envelope stored by Relay's per-channel webhook route (Telegram updates do not name the bot). */
export interface TelegramEnvelope { bot_id: string; update: TgUpdate }

const msgId = (chat: number | string, id: number | string) => `${chat}:${id}`;

export function parseTelegramWebhook(body: unknown): InboundItem[] {
  const env = (body && typeof body === 'object' ? body : {}) as Partial<TelegramEnvelope>;
  const bot = str(env.bot_id);
  const u = env.update;
  if (!bot || !u) return [];
  const m = u.message ?? u.edited_message;
  if (!m?.message_id || m.chat?.id === undefined || !m.from || m.from.is_bot) return [];
  const type = m.chat.type;
  if (type !== 'private' && type !== 'group' && type !== 'supergroup') return [];   // channel posts belong to publishing
  const id = msgId(m.chat.id, m.message_id);
  const text = clip(m.text ?? m.caption ?? '');
  if (u.edited_message) return [{ type: 'edit', accountId: bot, externalId: id, text, occurredAt: epochToIso(m.edit_date ?? m.date) }];
  const photo = m.photo?.length ? m.photo[m.photo.length - 1] : null;
  const file = m.document ?? m.voice ?? photo;
  const name = [m.from.first_name, m.from.last_name].filter(Boolean).join(' ') || null;
  return [{
    type: 'message', accountId: bot, conversationKind: type === 'private' ? 'dm' : 'comment', threadKey: `chat:${m.chat.id}`, externalId: id,
    parentExternalId: m.reply_to_message?.message_id ? msgId(m.chat.id, m.reply_to_message.message_id) : null, direction: 'inbound',
    author: { externalId: String(m.from.id ?? 'unknown'), name: name ? clip(name, 200) : null, handle: m.from.username ? `@${clip(m.from.username, 100)}` : null },
    text, occurredAt: epochToIso(m.date), relatedPostExternalId: null, subject: type === 'private' ? null : clip(m.chat.title ?? 'Group', 200),
    attachments: file?.file_id ? [{ type: m.document ? 'document' : m.voice ? 'voice' : 'photo', name: m.document?.file_name ? clip(m.document.file_name, 200) : null, size: file.file_size ?? null, providerRef: `file:${file.file_id}` }] : [],
    meta: { chat_type: type, message_id: m.message_id },
  }];
}

export function telegramReplyRules(i: ReplyRulesInput): ReplyRulesResult {
  if (i.kind === 'dm') return i.mode === 'private_message' ? { allowed: true, windowEndsAt: null } : { allowed: false, code: 'mode_not_supported', message: 'Private chats take private messages.' };
  if (i.kind === 'comment') return i.mode === 'public_reply' ? { allowed: true, windowEndsAt: null } : { allowed: false, code: 'mode_not_supported', message: 'Bots cannot start private chats; reply in the group.' };
  return { allowed: false, code: 'not_supported', message: 'Not supported on Telegram.' };
}

function replyFromTg(err: unknown): SendReplyResult {
  if (err instanceof TransportError) {
    return err.requestMayHaveBeenSent ? { kind: 'unknown', code: 'response_lost', message: 'The connection to Telegram dropped after sending. A person must check (Telegram has no lookup).' }
      : { kind: 'retry', code: 'connect_failed', message: 'Telegram could not be reached. The reply will be retried.' };
  }
  if (err instanceof TelegramApiError) {
    const c = classifyTelegramError(err);
    if (c.kind === 'rate_limited') return { kind: 'retry', code: 'rate_limited', message: 'Telegram is rate-limiting this bot. The reply will be retried.', retryAfterMs: c.retryAfterMs };
    if (c.kind === 'reconnect') return { kind: 'rejected', code: c.code, message: 'Telegram no longer accepts this bot token. Reconnect the bot.', reconnect: true };
    if (c.kind === 'server') return { kind: 'unknown', code: 'server_error', message: 'Telegram did not confirm the reply. A person must check (Telegram has no lookup).' };
    if (/blocked by the user|user is deactivated|chat not found|kicked/i.test(err.message)) return { kind: 'rejected', code: 'recipient_unavailable', message: 'The person blocked the bot or the chat no longer exists.' };
    return { kind: 'rejected', code: c.code, message: 'Telegram rejected the reply.' };
  }
  throw err;
}

export const telegramInboxAdapter: InboxAdapter = {
  kind: 'telegram_bot',
  capability: () => TELEGRAM_INBOX_CAPABILITY,
  missingPermissions: () => [],
  parseWebhook: parseTelegramWebhook,
  replyRules: telegramReplyRules,
  moderationActions: (_kind, direction) => (direction === 'outbound' ? ['delete_own'] : []),

  async sendReply(ctx, creds, _conn, input): Promise<SendReplyResult> {
    const chat = input.target.threadKey.startsWith('chat:') ? input.target.threadKey.slice(5) : null;
    if (!chat) return { kind: 'rejected', code: 'mode_not_supported', message: 'Unknown Telegram chat.' };
    if (input.text.length > 4096) return { kind: 'rejected', code: 'too_long', message: 'Telegram messages are limited to 4,096 characters.' };
    const replyTo = input.target.replyToExternalId?.split(':')[1];
    try {
      const m = await tgCall<{ message_id?: number }>(ctx, tokenOf(creds), 'sendMessage', { chat_id: chat, text: input.text, ...(replyTo ? { reply_parameters: { message_id: Number(replyTo), allow_sending_without_reply: true } } : {}) }, { publishes: true });
      return m.message_id ? { kind: 'sent', externalId: msgId(chat, m.message_id), detail: {} } : { kind: 'unknown', code: 'no_id', message: 'Telegram accepted the message without an id.' };
    } catch (err) {
      return replyFromTg(err);
    }
  },

  async findSent() { return { found: false }; },   // no Bot API to list sent messages: a person settles it

  async moderate(ctx, creds, _conn, input) {
    if (input.action !== 'delete_own') return { ok: false, code: 'not_supported', message: 'Bots can only delete their own messages here.', retryable: false };
    const [chat, id] = input.externalId.split(':');
    try {
      await tgCall(ctx, tokenOf(creds), 'deleteMessage', { chat_id: chat, message_id: Number(id) });
      return { ok: true };
    } catch (err) {
      if (err instanceof TransportError) return { ok: false, code: 'network', message: 'Telegram could not be reached. Try again.', retryable: true };
      if (err instanceof TelegramApiError) return { ok: false, code: 'refused', message: /can't be deleted/i.test(err.message) ? 'Telegram only lets bots delete their messages within 48 hours.' : 'Telegram refused to delete the message.', retryable: false };
      throw err;
    }
  },

  async resolveAttachment(ctx, creds, conn, input) {
    if (!input.providerRef.startsWith('file:')) return { kind: 'error', code: 'no_reference', message: 'No file reference.' };
    try {
      const token = tokenOf(creds);
      const f = await tgCall<{ file_path?: string; file_size?: number; data_base64?: string }>(ctx, token, 'getFile', { file_id: input.providerRef.slice(5) });
      if (conn.isMock && f.data_base64) return { kind: 'bytes', base64: f.data_base64, mime: 'application/octet-stream', name: null };
      if (!f.file_path) return { kind: 'error', code: 'too_large', message: 'Telegram does not provide files over 20 MB to bots.' };
      return { kind: 'url', url: `${(ctx.config.baseUrls?.telegram ?? 'https://api.telegram.org').replace(/\/$/, '')}/file/bot${token}/${f.file_path}`, allowHosts: ['api.telegram.org'], mime: null, name: null };
    } catch (err) {
      if (err instanceof TransportError || err instanceof TelegramApiError) return { kind: 'error', code: 'refused', message: 'Telegram refused the file lookup.' };
      throw err;
    }
  },
};

const tokenOf = (creds: ProviderCredentials): string => botTokenFrom(creds);

// ------------------------------------------------------------------ webhook ownership (used by channels-telegram.ts)
export interface TelegramWebhookState { url: string; pending: number; lastError: string | null }

export async function telegramWebhookInfo(ctx: AdapterContext, creds: ProviderCredentials): Promise<TelegramWebhookState> {
  const w = await tgCall<TgWebhookInfo & { last_error_message?: string }>(ctx, tokenOf(creds), 'getWebhookInfo', {});
  return { url: w.url ?? '', pending: w.pending_update_count ?? 0, lastError: w.last_error_message ? clip(w.last_error_message, 200) : null };
}

/** setWebhook to Relay. Callers MUST have re-checked that no webhook is set immediately before (never overwrite). */
export async function telegramSetWebhook(ctx: AdapterContext, creds: ProviderCredentials, url: string, secret: string): Promise<void> {
  await tgCall(ctx, tokenOf(creds), 'setWebhook', { url, secret_token: secret, allowed_updates: ['message', 'edited_message'], drop_pending_updates: false });
}

export async function telegramDeleteWebhook(ctx: AdapterContext, creds: ProviderCredentials): Promise<void> {
  await tgCall(ctx, tokenOf(creds), 'deleteWebhook', { drop_pending_updates: false });
}
