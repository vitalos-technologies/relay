// Telegram Bot API client helpers (verified against https://core.telegram.org/bots/api, Bot API 10.3,
// checked 2026-11-06). The bot token is ONLY ever placed in the request path (/bot<token>/<method>);
// transports redact that path before logging, and no error message produced here contains it.
import type { AdapterContext, ProviderCredentials } from '@social-lite/core';

export const TELEGRAM_API_BASE = 'https://api.telegram.org';

/** ResponseParameters (Bot API): retry_after on flood control, migrate_to_chat_id for migrated groups. */
export interface TgResponseParameters { retry_after?: number; migrate_to_chat_id?: number }

export interface TgEnvelope<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
  parameters?: TgResponseParameters;
}

export interface TgUser { id: number; is_bot: boolean; first_name: string; username?: string }
export interface TgChat { id: number | string; type: 'private' | 'group' | 'supergroup' | 'channel'; title?: string; username?: string }
export interface TgChatMember {
  status: 'creator' | 'administrator' | 'member' | 'restricted' | 'left' | 'kicked';
  user?: TgUser;
  can_post_messages?: boolean;
}
export interface TgMessage { message_id: number | string; date?: number; chat?: TgChat }
export interface TgWebhookInfo { url: string; has_custom_certificate?: boolean; pending_update_count?: number }

const TOKEN_LIKE = /\d{5,}:[A-Za-z0-9_-]{20,}/g;

/** Remove anything token-shaped and bound the length of a provider description. */
export function sanitizeTelegramText(s: string | undefined | null, max = 160): string {
  return String(s ?? '').replace(TOKEN_LIKE, '<redacted>').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** A non-ok Bot API response. The message never contains the bot token. */
export class TelegramApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly description: string,
    public readonly retryAfterSec: number | null,
  ) {
    super(`Telegram API error ${status}: ${description}`);
    this.name = 'TelegramApiError';
  }
}

/** Token for the request path. Mock connections carry {kind:'mock'} credentials and use the simulated API. */
export function botTokenFrom(credentials: ProviderCredentials): string {
  if (credentials.kind === 'telegram_bot') return credentials.botToken;
  if (credentials.kind === 'mock') return credentials.token;
  throw new Error('Telegram connection has unsupported credentials');
}

export const BOT_TOKEN_RE = /^\d{5,}:[A-Za-z0-9_-]{30,}$/;

/**
 * Call a Bot API method. JSON body for plain parameters, multipart/form-data (FormData) for uploads.
 * All methods accept POST (Bot API "Making requests").
 */
export async function tgCall<T>(
  ctx: AdapterContext,
  token: string,
  method: string,
  params: Record<string, unknown> | FormData,
  opts: { publishes?: boolean; timeoutMs?: number } = {},
): Promise<T> {
  const base = (ctx.config.baseUrls?.telegram ?? TELEGRAM_API_BASE).replace(/\/$/, '');
  const isForm = typeof FormData !== 'undefined' && params instanceof FormData;
  const res = await ctx.transport.send({
    method: 'POST',
    url: `${base}/bot${token}/${method}`,
    headers: isForm ? {} : { 'content-type': 'application/json' },
    body: isForm ? (params as FormData) : JSON.stringify(params),
    op: `telegram.${method}`,
    publishes: opts.publishes,
    timeoutMs: opts.timeoutMs,
  });
  let env: TgEnvelope<T>;
  try {
    env = JSON.parse(res.body) as TgEnvelope<T>;
  } catch {
    throw new TelegramApiError(res.status, `unexpected non-JSON response (HTTP ${res.status})`, null);
  }
  if (env.ok && res.status < 400) return env.result as T;
  const status = env.error_code ?? res.status;
  throw new TelegramApiError(status, sanitizeTelegramText(env.description) || `HTTP ${res.status}`, env.parameters?.retry_after ?? null);
}

// ------------------------------------------------------------------ error classification
export type TelegramErrorClass =
  | { kind: 'rate_limited'; code: 'rate_limited'; message: string; retryAfterMs: number }
  | { kind: 'reconnect'; code: string; message: string }
  | { kind: 'permission'; code: string; message: string }
  | { kind: 'invalid'; code: string; message: string }
  | { kind: 'server'; code: string; message: string };

export const TELEGRAM_FIX_ADMIN =
  'In Telegram open the channel → Administrators → Add Admin, choose the bot and enable "Post Messages", then click Check connection.';

const PERMISSION_RE = /not enough rights|need administrator rights|bot was kicked|bot is not a member|chat not found|have no rights|CHAT_WRITE_FORBIDDEN|CHAT_ADMIN_REQUIRED|not allowed to post|CHANNEL_PRIVATE|bot was blocked/i;

export function classifyTelegramError(e: TelegramApiError): TelegramErrorClass {
  const d = e.description;
  if (e.status === 429) {
    const sec = e.retryAfterSec ?? 5;
    return { kind: 'rate_limited', code: 'rate_limited', message: `Telegram flood control: retry after ${sec}s.`, retryAfterMs: Math.max(1, sec) * 1000 };
  }
  if (e.status === 401 || e.status === 404) {
    return {
      kind: 'reconnect', code: 'telegram_token_rejected',
      message: 'Telegram rejected the bot token (it was revoked or regenerated in @BotFather). Reconnect with the bot\'s current token.',
    };
  }
  if (e.status === 403 || PERMISSION_RE.test(d)) {
    if (/bot was kicked|bot is not a member|chat not found|CHANNEL_PRIVATE/i.test(d)) {
      return { kind: 'permission', code: 'telegram_not_in_channel', message: `The bot is no longer in this channel (or the channel was deleted). ${TELEGRAM_FIX_ADMIN}` };
    }
    return { kind: 'permission', code: 'telegram_missing_post_right', message: `The bot is not allowed to post in this channel. ${TELEGRAM_FIX_ADMIN}` };
  }
  if (e.status >= 500) return { kind: 'server', code: 'telegram_server_error', message: `Telegram returned a server error (${e.status}).` };
  if (/message is too long/i.test(d)) return { kind: 'invalid', code: 'text_too_long', message: 'Telegram: the text exceeds 4096 characters. Shorten it.' };
  if (/caption is too long/i.test(d)) return { kind: 'invalid', code: 'caption_too_long', message: 'Telegram: the caption exceeds 1024 characters. Shorten it or send without an image.' };
  if (/message text is empty|text must be non-empty/i.test(d)) return { kind: 'invalid', code: 'empty', message: 'Telegram: the message is empty. Add text.' };
  if (/can't parse entities/i.test(d)) return { kind: 'invalid', code: 'formatting', message: 'Telegram could not parse the message formatting. Remove special formatting characters.' };
  if (/BUTTON|inline keyboard|reply markup/i.test(d)) return { kind: 'invalid', code: 'button_rejected', message: 'Telegram rejected a button. Each button needs a label and a valid https:// URL.' };
  if (e.status === 413 || /Request Entity Too Large/i.test(d)) return { kind: 'invalid', code: 'file_too_large', message: 'Telegram rejected the upload as too large. Photos must be at most 10 MB and videos at most 50 MB.' };
  if (/VIDEO|video/.test(d)) return { kind: 'invalid', code: 'video_rejected', message: 'Telegram rejected the video. Use an H.264/AAC MP4 up to 50 MB.' };
  if (/MEDIA_GROUP|media group|too (many|few) media/i.test(d)) return { kind: 'invalid', code: 'album_rejected', message: 'Telegram rejected the album. Use 2–10 photos or videos, with the caption on the first item.' };
  if (/PHOTO|IMAGE_PROCESS_FAILED|wrong file|file is too big|too big|failed to get HTTP URL content|wrong type of the web page content|dimensions/i.test(d)) {
    return { kind: 'invalid', code: 'image_rejected', message: 'Telegram rejected the image. Use a JPEG or PNG up to 10 MB, width + height at most 10000 px, aspect ratio at most 20:1.' };
  }
  return { kind: 'invalid', code: 'telegram_bad_request', message: `Telegram rejected the message (${sanitizeTelegramText(d, 120)}). Fix the content and schedule again.` };
}
