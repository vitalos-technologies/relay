// TikTok Content Posting API client helpers. Sources (fetched 2026-11-07): docs/providers/tiktok.md.
//  Host https://open.tiktokapis.com; JSON bodies `application/json; charset=UTF-8`; Bearer user token.
//  Errors: {error:{code,message,log_id}} (some returned with HTTP 200, code ≠ 'ok'); OAuth: {error, error_description}.
import type { AdapterContext, HttpResponse } from '@social-lite/core';
import { ProviderHttpError, baseUrl, call, parseJson, retryAfterAt, safeText, safeCode, type CallResult, type CallSpec } from '../shared/http.js';
import { HOUR_MS, type ErrorClass } from '../shared/classify.js';

export const TIKTOK_API = 'https://open.tiktokapis.com';
export const TIKTOK_AUTHORIZE_URL = 'https://www.tiktok.com/v2/auth/authorize/';
export const TIKTOK_JSON = 'application/json; charset=UTF-8';

export function parseTikTokError(res: HttpResponse, nowMs: number): ProviderHttpError {
  const body = parseJson(res.body);
  const err = body.error;
  let code: string | null = null;
  let detail: string | null = null;
  if (err && typeof err === 'object') {
    code = safeCode((err as Record<string, unknown>).code);
    detail = safeText((err as Record<string, unknown>).message);
  } else if (typeof err === 'string') {
    code = safeCode(err);
    detail = safeText(body.error_description);
  }
  return new ProviderHttpError('TikTok', res.status, code, detail, retryAfterAt(res.headers, nowMs), res.headers);
}

/** Call a TikTok API path (or absolute URL). 200 responses whose error.code ≠ 'ok' are errors too (T2). */
export async function tiktokCall<T = Record<string, unknown>>(ctx: AdapterContext, spec: Omit<CallSpec, 'url'> & { path?: string; url?: string }): Promise<CallResult<T>> {
  const url = spec.url ?? `${baseUrl(ctx, 'tiktok', TIKTOK_API)}${spec.path}`;
  const r = await call<T>(ctx, { ...spec, url }, parseTikTokError);
  const e = (r.data as { error?: { code?: unknown } }).error;
  if (e && typeof e === 'object' && typeof e.code === 'string' && e.code !== 'ok') throw parseTikTokError({ ...r.raw, status: r.status }, ctx.now().getTime());
  return r;
}

const DAILY_CAP_MS = 6 * HOUR_MS;

export function classifyTikTok(e: ProviderHttpError, nowMs: number): ErrorClass {
  const code = e.code ?? '';
  const wait = (fallback: number) => (e.retryAtMs ? Math.max(1000, e.retryAtMs - nowMs) : fallback);
  switch (code) {
    case 'access_token_invalid':
      return { kind: 'reconnect', code: 'tiktok_token_invalid', message: 'TikTok rejected the access token (expired or revoked). Reconnect the TikTok account.' };
    case 'scope_not_authorized':
      return { kind: 'permission', code: 'tiktok_scope_missing', message: 'TikTok did not grant the posting permission (video.publish / video.upload). Reconnect and approve posting.' };
    case 'unaudited_client_can_only_post_to_private_accounts':
      return { kind: 'permission', code: 'tiktok_unaudited_client', message: 'This TikTok app has not passed TikTok\'s Direct Post audit: it can only post SELF_ONLY to private accounts. Use the inbox (draft) handoff or complete the audit.' };
    case 'url_ownership_unverified':
      return { kind: 'permission', code: 'tiktok_url_unverified', message: 'TikTok requires the media domain to be verified for pull-from-URL uploads. Verify the storage domain in the TikTok developer portal.' };
    case 'spam_risk_user_banned_from_posting':
      return { kind: 'permission', code: 'tiktok_user_banned', message: 'TikTok reports this creator is currently banned from posting.' };
    case 'reached_active_user_cap':
      return { kind: 'budget', code: 'tiktok_client_quota', message: 'The TikTok app reached its daily quota of active publishing users. Posts are held until the quota resets.' };
    case 'spam_risk_too_many_posts':
      return { kind: 'cap', code: 'tiktok_daily_post_cap', message: 'TikTok\'s daily post cap for this creator was reached; it will be retried later.', retryAfterMs: DAILY_CAP_MS };
    case 'spam_risk_too_many_pending_share':
      return { kind: 'cap', code: 'tiktok_pending_share_cap', message: 'The creator has 5 pending TikTok drafts in the last 24 h; it will be retried later.', retryAfterMs: DAILY_CAP_MS };
    case 'privacy_level_option_mismatch':
      return { kind: 'invalid', code: 'tiktok_privacy_mismatch', message: 'The chosen TikTok privacy level is not available for this creator. Pick one of the creator\'s current options.' };
    case 'rate_limit_exceeded':
      return { kind: 'rate_limited', code: 'rate_limited', message: 'TikTok rate limit reached; it will be retried shortly.', retryAfterMs: wait(60_000) };
    default:
      break;
  }
  if (e.status === 401) return { kind: 'reconnect', code: 'tiktok_unauthorized', message: 'TikTok rejected the authorization. Reconnect the TikTok account.' };
  if (e.status === 429) return { kind: 'rate_limited', code: 'rate_limited', message: 'TikTok rate limit reached; it will be retried shortly.', retryAfterMs: wait(60_000) };
  if (e.status === 403) return { kind: 'permission', code: 'tiktok_forbidden', message: `TikTok refused the request${e.detail ? ` (${e.detail.slice(0, 120)})` : ''}.` };
  if (e.status >= 500) return { kind: 'server', code: 'tiktok_server_error', message: `TikTok returned a server error (${e.status}).` };
  return { kind: 'invalid', code: code ? `tiktok_${code}`.slice(0, 60) : 'tiktok_invalid_request', message: `TikTok rejected the request${e.detail ? ` (${e.detail.slice(0, 120)})` : ''}.` };
}

// ------------------------------------------------------------------ chunk plan (T3)
export const MIN_CHUNK = 5 * 1024 * 1024;
export const MAX_SINGLE = 64 * 1024 * 1024;
export const CHUNK_BYTES = 10 * 1024 * 1024;

/** Chunk plan: whole file when ≤ 64 MB, else 10 MB chunks with the remainder folded into the last (≤ 128 MB). */
export function chunkPlan(size: number): { chunkSize: number; totalChunks: number } {
  if (size <= MAX_SINGLE) return { chunkSize: size, totalChunks: 1 };
  return { chunkSize: CHUNK_BYTES, totalChunks: Math.floor(size / CHUNK_BYTES) };
}

/** Byte range [first, last] of chunk i (the last chunk absorbs trailing bytes). */
export function chunkRange(size: number, plan: { chunkSize: number; totalChunks: number }, i: number): [number, number] {
  const first = i * plan.chunkSize;
  const last = i === plan.totalChunks - 1 ? size - 1 : first + plan.chunkSize - 1;
  return [first, last];
}
