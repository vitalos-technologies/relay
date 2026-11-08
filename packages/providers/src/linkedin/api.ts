// LinkedIn versioned REST API helpers. Sources (fetched 2026-11-07): docs/providers/linkedin.md.
//  Every /rest call sends `Linkedin-Version: YYYYMM` and `X-Restli-Protocol-Version: 2.0.0` (L1).
import type { AdapterContext, HttpResponse } from '@social-lite/core';
import { ProviderHttpError, baseUrl, call, parseJson, retryAfterAt, safeText, safeCode, type CallResult, type CallSpec } from '../shared/http.js';
import { HOUR_MS, type ErrorClass } from '../shared/classify.js';

export const LI_API = 'https://api.linkedin.com';
export const LI_OAUTH = 'https://www.linkedin.com/oauth/v2';
/** Default pinned version: li-lms-2026-10 (202511 sunsets 2026-11-16). Override: LINKEDIN_API_VERSION. */
export const LI_DEFAULT_VERSION = '202610';

export const liVersion = (ctx: Pick<AdapterContext, 'config'>): string => (ctx.config.apiVersion && /^\d{6}$/.test(ctx.config.apiVersion) ? ctx.config.apiVersion : LI_DEFAULT_VERSION);

export function parseLinkedInError(res: HttpResponse, nowMs: number): ProviderHttpError {
  const b = parseJson(res.body);
  const code = safeCode(b.code) ?? safeCode(b.error) ?? (typeof b.serviceErrorCode === 'number' ? `service_${b.serviceErrorCode}` : null);
  const detail = safeText(b.message) ?? safeText(b.error_description);
  return new ProviderHttpError('LinkedIn', res.status, code, detail, retryAfterAt(res.headers, nowMs), res.headers);
}

/** /rest call with the version + Rest.li headers. `rawQuery` is appended verbatim (Rest.li List(...) syntax). */
export function liRest<T = Record<string, unknown>>(ctx: AdapterContext, spec: Omit<CallSpec, 'url'> & { path: string; rawQuery?: string; method_?: string }): Promise<CallResult<T>> {
  const url = `${baseUrl(ctx, 'linkedin', LI_API)}${spec.path}${spec.rawQuery ? `?${spec.rawQuery}` : ''}`;
  return call<T>(ctx, { ...spec, url, headers: { 'linkedin-version': liVersion(ctx), 'x-restli-protocol-version': '2.0.0', ...(spec.headers ?? {}) } }, parseLinkedInError);
}

export function liCall<T = Record<string, unknown>>(ctx: AdapterContext, spec: CallSpec): Promise<CallResult<T>> {
  return call<T>(ctx, spec, parseLinkedInError);
}

/** Rest.li 2.0 URN encoding inside query strings / paths (`urn:li:share:1` → `urn%3Ali%3Ashare%3A1`). */
export const encUrn = (urn: string): string => encodeURIComponent(urn);

export function classifyLinkedIn(e: ProviderHttpError, nowMs: number): ErrorClass {
  const text = `${e.code ?? ''} ${e.detail ?? ''}`;
  if (e.status === 401) return { kind: 'reconnect', code: 'linkedin_token_rejected', message: 'LinkedIn rejected the access token (expired after 60 days or revoked). Reconnect the LinkedIn account.' };
  if (e.status === 429) return { kind: 'rate_limited', code: 'rate_limited', message: 'LinkedIn rate limit reached (daily limits reset at midnight UTC); it will be retried later.', retryAfterMs: e.retryAtMs ? Math.max(1000, e.retryAtMs - nowMs) : HOUR_MS };
  if (e.status === 403) {
    return { kind: 'permission', code: 'linkedin_access_denied', message: 'LinkedIn denied this action (ACCESS_DENIED): the permission was not granted or your Page role no longer allows posting. Check your role, then reconnect.' };
  }
  if ((e.status === 422 || e.status === 400) && /duplicate/i.test(text)) {
    return { kind: 'duplicate', code: 'duplicate_content', message: 'LinkedIn refused this as duplicate content; an earlier attempt may already have been posted. Check the page before retrying.' };
  }
  if (e.status === 404) return { kind: 'not_found', code: 'linkedin_not_found', message: 'LinkedIn could not find the requested entity.' };
  if (e.status === 409 || e.status >= 500) return { kind: 'server', code: e.status === 409 ? 'linkedin_conflict' : 'linkedin_server_error', message: `LinkedIn returned ${e.status === 409 ? 'a write conflict' : `a server error (${e.status})`}.` };
  if (/FIELD_LENGTH_TOO_LONG/.test(text)) return { kind: 'invalid', code: 'linkedin_text_too_long', message: 'LinkedIn rejected the text as too long. Shorten it to 3,000 characters.' };
  return { kind: 'invalid', code: e.code ? `linkedin_${e.code}`.toLowerCase().slice(0, 60) : 'linkedin_invalid_request', message: `LinkedIn rejected the request${e.detail ? ` (${e.detail.slice(0, 120)})` : ''}. Fix the content and schedule again.` };
}

// ------------------------------------------------------------------ little text (L6)
const RESERVED = /[|{}@[\]()<>#\\*_~]/g;
/** Escape `little` reserved characters; `#word` hashtags are kept as HashtagElements (word left untouched). */
export function littleEscape(text: string): string {
  const out: string[] = [];
  const re = /(^|[\s(])#([\p{L}\p{N}_]+)/gu;
  let last = 0;
  for (const m of text.matchAll(re)) {
    const start = m.index! + m[1]!.length;
    out.push(text.slice(last, start).replace(RESERVED, (c) => `\\${c}`));
    out.push(`#${m[2]}`);
    last = start + 1 + m[2]!.length;
  }
  out.push(text.slice(last).replace(RESERVED, (c) => `\\${c}`));
  return out.join('');
}

/** Inverse for matching returned commentary (removes escapes and hashtag templates). */
export function littleUnescape(text: string): string {
  return text.replace(/\{hashtag\|\\?[#＃]\|([^}]*)\}/g, '#$1').replace(/\\([|{}@[\]()<>#\\*_~])/g, '$1');
}
