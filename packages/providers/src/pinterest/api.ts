// Pinterest API v5 helpers. Source: official OpenAPI v5.28.0 (fetched 2026-11-07), docs/providers/pinterest.md.
import type { AdapterContext, HttpResponse } from '@social-lite/core';
import { ProviderHttpError, baseUrl, call, parseJson, retryAfterAt, safeText, safeCode, type CallResult, type CallSpec } from '../shared/http.js';
import type { ErrorClass } from '../shared/classify.js';

export const PINTEREST_API = 'https://api.pinterest.com';
export const PINTEREST_AUTHORIZE_URL = 'https://www.pinterest.com/oauth/';

/** Errors: {code:number, message:string} (Pinterest.Lib.Error); OAuth may use {error, error_description}. */
export function parsePinterestError(res: HttpResponse, nowMs: number): ProviderHttpError {
  const b = parseJson(res.body);
  const code = typeof b.code === 'number' ? String(b.code) : safeCode(b.error);
  return new ProviderHttpError('Pinterest', res.status, code, safeText(b.message) ?? safeText(b.error_description), retryAfterAt(res.headers, nowMs), res.headers);
}

export function pinCall<T = Record<string, unknown>>(ctx: AdapterContext, spec: Omit<CallSpec, 'url'> & { path?: string; url?: string }): Promise<CallResult<T>> {
  return call<T>(ctx, { ...spec, url: spec.url ?? `${baseUrl(ctx, 'pinterest', PINTEREST_API)}${spec.path}` }, parsePinterestError);
}

export function classifyPinterest(e: ProviderHttpError, nowMs: number): ErrorClass {
  if (e.status === 401) return { kind: 'reconnect', code: 'pinterest_token_rejected', message: 'Pinterest rejected the access token (expired or revoked). Reconnect the Pinterest account.' };
  if (e.status === 429) return { kind: 'rate_limited', code: 'rate_limited', message: 'Pinterest rate limit reached; it will be retried shortly.', retryAfterMs: e.retryAtMs ? Math.max(1000, e.retryAtMs - nowMs) : 60_000 };
  if (e.status === 403) return { kind: 'permission', code: 'pinterest_forbidden', message: 'Pinterest refused this action for the board (permission or access tier). Check the board still belongs to the account and reconnect.' };
  if (e.status === 404) return { kind: 'not_found', code: 'pinterest_not_found', message: 'Pinterest could not find the board, Pin or media.' };
  if (e.status >= 500) return { kind: 'server', code: 'pinterest_server_error', message: `Pinterest returned a server error (${e.status}).` };
  return { kind: 'invalid', code: 'pinterest_invalid_request', message: `Pinterest rejected the Pin${e.detail ? ` (${e.detail.slice(0, 120)})` : ''}. Fix it and schedule again.` };
}
