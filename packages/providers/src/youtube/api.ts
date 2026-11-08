// YouTube Data API v3 / Analytics API / Google OAuth helpers. Sources (fetched 2026-11-07): docs/providers/youtube.md.
import type { AdapterContext, HttpResponse } from '@social-lite/core';
import { ProviderHttpError, baseUrl, call, parseJson, retryAfterAt, safeText, safeCode, type CallResult, type CallSpec } from '../shared/http.js';
import { HOUR_MS, type ErrorClass } from '../shared/classify.js';

export const YT_API = 'https://www.googleapis.com';
export const YT_ANALYTICS = 'https://youtubeanalytics.googleapis.com';
export const GOOGLE_OAUTH = 'https://oauth2.googleapis.com';
export const GOOGLE_AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';

/** Google error bodies: {error:{code,message,errors:[{reason,domain}]}} or OAuth {error, error_description}. */
export function parseGoogleError(res: HttpResponse, nowMs: number): ProviderHttpError {
  const body = parseJson(res.body);
  const e = body.error;
  let code: string | null = null;
  let detail: string | null = null;
  if (e && typeof e === 'object') {
    const first = Array.isArray((e as { errors?: unknown }).errors) ? ((e as { errors: Array<Record<string, unknown>> }).errors[0] ?? {}) : {};
    code = safeCode(first.reason) ?? safeCode((e as Record<string, unknown>).status);
    detail = safeText((e as Record<string, unknown>).message);
  } else if (typeof e === 'string') {
    code = safeCode(e);
    detail = safeText(body.error_description);
  }
  return new ProviderHttpError('YouTube', res.status, code, detail, retryAfterAt(res.headers, nowMs), res.headers);
}

export function ytCall<T = Record<string, unknown>>(ctx: AdapterContext, spec: Omit<CallSpec, 'url'> & { url?: string; path?: string; base?: 'api' | 'analytics' | 'oauth' }): Promise<CallResult<T>> {
  const root = spec.base === 'analytics' ? baseUrl(ctx, 'youtubeAnalytics', YT_ANALYTICS) : spec.base === 'oauth' ? baseUrl(ctx, 'googleOAuth', GOOGLE_OAUTH) : baseUrl(ctx, 'youtube', YT_API);
  return call<T>(ctx, { ...spec, url: spec.url ?? `${root}${spec.path}` }, parseGoogleError);
}

export function classifyYouTube(e: ProviderHttpError, nowMs: number): ErrorClass {
  const r = e.code ?? '';
  const wait = (fallback: number) => (e.retryAtMs ? Math.max(1000, e.retryAtMs - nowMs) : fallback);
  if (r === 'quotaExceeded' || r === 'dailyLimitExceeded') {
    return { kind: 'budget', code: 'youtube_quota_exceeded', message: 'The YouTube API quota for this Google Cloud project is used up (videos.insert has its own 100/day bucket). Uploads are held until the quota resets or is raised.' };
  }
  if (r === 'uploadLimitExceeded') return { kind: 'cap', code: 'youtube_upload_limit', message: 'YouTube says this channel reached its upload limit; it will be retried later.', retryAfterMs: 24 * HOUR_MS };
  if (r === 'rateLimitExceeded' || r === 'userRateLimitExceeded' || r === 'uploadRateLimitExceeded' || e.status === 429) {
    return { kind: 'rate_limited', code: 'rate_limited', message: 'YouTube rate limit reached; it will be retried shortly.', retryAfterMs: wait(60_000) };
  }
  if (r === 'youtubeSignupRequired') return { kind: 'permission', code: 'youtube_channel_required', message: 'This Google account has no YouTube channel. Create a channel, then reconnect.' };
  if (e.status === 401 || r === 'authError' || r === 'invalid_grant') return { kind: 'reconnect', code: 'youtube_token_rejected', message: 'Google rejected the authorization (expired or revoked). Reconnect the YouTube account.' };
  if (r === 'insufficientPermissions' || r === 'forbidden' || r === 'ACCESS_TOKEN_SCOPE_INSUFFICIENT') {
    return { kind: 'permission', code: 'youtube_forbidden', message: 'YouTube refused this action for the connected channel (missing permission). Reconnect and approve the requested YouTube access.' };
  }
  if (e.status === 404) return { kind: 'not_found', code: 'youtube_not_found', message: 'YouTube could not find the video or upload session.' };
  if (e.status >= 500) return { kind: 'server', code: 'youtube_server_error', message: `YouTube returned a server error (${e.status}).` };
  if (e.status === 403) return { kind: 'permission', code: `youtube_${r || 'forbidden'}`.slice(0, 60), message: `YouTube refused the request${e.detail ? ` (${e.detail.slice(0, 120)})` : ''}.` };
  return { kind: 'invalid', code: r ? `youtube_${r}`.slice(0, 60) : 'youtube_invalid_request', message: `YouTube rejected the video metadata${e.detail ? ` (${e.detail.slice(0, 120)})` : ''}. Fix it and schedule again.` };
}

/** 8 MiB chunks: a multiple of 256 KB as required for resumable uploads (Y2). */
export const YT_CHUNK_BYTES = 32 * 256 * 1024;

/** `Range: bytes=0-N` → next byte to send (N+1); absent ⇒ 0. */
export function nextByteFromRange(range: string | undefined): number {
  const m = /bytes=(\d+)-(\d+)/.exec(range ?? '');
  return m ? Number(m[2]) + 1 : 0;
}
