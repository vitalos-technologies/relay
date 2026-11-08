// Threads API helpers. Sources (fetched 2026-11-07): docs/providers/threads.md.
//  Host graph.threads.com (graph.threads.net is equivalent, H5), version v1.0. The access token is sent as the
//  documented `access_token` parameter: in the form body for POST, in the query for GET (logs redact it).
import type { AdapterContext, HttpResponse } from '@social-lite/core';
import { utf8Length } from '@social-lite/core';
import { ProviderHttpError, baseUrl, call, parseJson, retryAfterAt, safeCode, safeText, type CallResult } from '../shared/http.js';
import type { ErrorClass } from '../shared/classify.js';

export const THREADS_GRAPH = 'https://graph.threads.com';
export const THREADS_AUTHORIZE_URL = 'https://threads.com/oauth/authorize';
export const THREADS_VERSION = 'v1.0';

export function parseThreadsError(res: HttpResponse, nowMs: number): ProviderHttpError {
  const b = parseJson(res.body);
  const e = (b.error && typeof b.error === 'object' ? b.error : {}) as Record<string, unknown>;
  const code = e.code !== undefined ? String(e.code) : (typeof b.error === 'string' ? safeCode(b.error) : null);
  const sub = e.error_subcode !== undefined ? `:${String(e.error_subcode)}` : '';
  return new ProviderHttpError('Threads', res.status, code ? `${code}${sub}` : null, safeText(e.message) ?? safeText(b.error_message) ?? safeText(b.error_description), retryAfterAt(res.headers, nowMs), res.headers);
}

export interface ThreadsRequest {
  method: 'GET' | 'POST';
  /** Path below the host, e.g. `/v1.0/me` or `/oauth/access_token`. */
  path: string;
  token?: string;
  params?: Record<string, string | undefined>;
  op: string;
  publishes?: boolean;
  timeoutMs?: number;
}

export function threadsCall<T = Record<string, unknown>>(ctx: AdapterContext, r: ThreadsRequest): Promise<CallResult<T>> {
  const url = `${baseUrl(ctx, 'threads', THREADS_GRAPH)}${r.path}`;
  const params = { ...(r.params ?? {}), ...(r.token ? { access_token: r.token } : {}) };
  return r.method === 'GET'
    ? call<T>(ctx, { method: 'GET', url, query: params, op: r.op, timeoutMs: r.timeoutMs }, parseThreadsError)
    : call<T>(ctx, { method: 'POST', url, form: params, op: r.op, publishes: r.publishes, timeoutMs: r.timeoutMs }, parseThreadsError);
}

export function classifyThreads(e: ProviderHttpError, nowMs: number): ErrorClass {
  const code = Number((e.code ?? '').split(':')[0]);
  const text = `${e.detail ?? ''}`;
  if (code === 190 || e.status === 401) return { kind: 'reconnect', code: 'threads_token_invalid', message: 'Threads rejected the access token (expired or revoked). Reconnect the Threads account.' };
  if ([4, 17, 32, 613].includes(code) || e.status === 429) {
    return { kind: 'rate_limited', code: 'rate_limited', message: 'Threads rate limit reached; it will be retried later.', retryAfterMs: e.retryAtMs ? Math.max(1000, e.retryAtMs - nowMs) : 15 * 60_000 };
  }
  if (/publishing limit|quota|250 posts/i.test(text)) return { kind: 'budget', code: 'threads_publishing_limit', message: 'The Threads profile reached its 250 posts / 24 h publishing limit. Posts are held until it resets.' };
  if (code === 10 || (code >= 200 && code <= 299) || e.status === 403) return { kind: 'permission', code: 'threads_permission', message: 'Threads refused this action: a permission (threads_content_publish) is missing or not approved for this app. Reconnect and approve publishing.' };
  if (e.status === 404 || code === 100 && /does not exist|unsupported get/i.test(text)) return { kind: 'not_found', code: 'threads_not_found', message: 'Threads could not find the object.' };
  if (e.status >= 500 || code === 1 || code === 2) return { kind: 'server', code: 'threads_server_error', message: `Threads returned a temporary error (${e.status}).` };
  return { kind: 'invalid', code: 'threads_invalid_request', message: `Threads rejected the request${e.detail ? ` (${e.detail.slice(0, 120)})` : ''}. Fix the content and schedule again.` };
}

const EMOJI = /\p{Extended_Pictographic}|\p{Regional_Indicator}/u;
let seg: Intl.Segmenter | null = null;
/** Threads text length: 500 "characters", with emojis counted as their UTF-8 bytes (H3). */
export function threadsTextLength(s: string): number {
  seg ??= new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  let n = 0;
  for (const { segment } of seg.segment(s)) n += EMOJI.test(segment) ? utf8Length(segment) : [...segment].length;
  return n;
}
