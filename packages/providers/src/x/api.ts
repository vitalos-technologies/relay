// X API v2 client helpers. Sources (checked 2026-11-06): docs/providers/x.md.
import type { AdapterContext, HttpResponse, ProviderCredentials } from '@social-lite/core';

export const X_API_BASE = 'https://api.x.com';
export const X_AUTHORIZE_URL = 'https://x.com/i/oauth2/authorize';

export function xBase(ctx: Pick<AdapterContext, 'config'>): string {
  return (ctx.config.baseUrls?.x ?? X_API_BASE).replace(/\/$/, '');
}

/** A non-2xx X API response, parsed into safe fields (no tokens; detail is bounded). */
export class XApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly type: string | null,
    public readonly title: string | null,
    public readonly detail: string | null,
    /** epoch ms from x-rate-limit-reset / retry-after, when present */
    public readonly resetAtMs: number | null,
    /** OAuth token endpoint error code (e.g. invalid_grant) */
    public readonly oauthError: string | null = null,
  ) {
    super(`X API error ${status}${type ? ` ${type.replace(/^https:\/\/api\.(x|twitter)\.com\/2\/problems\//, '')}` : ''}${detail ? `: ${detail}` : ''}`);
    this.name = 'XApiError';
  }
}

const SECRETISH = /(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi;
const clean = (s: unknown, max = 200): string | null =>
  typeof s === 'string' && s ? s.replace(SECRETISH, '$1<redacted>').replace(/\s+/g, ' ').trim().slice(0, max) : null;

export function parseXError(res: HttpResponse, nowMs: number): XApiError {
  let body: Record<string, unknown> = {};
  try { body = JSON.parse(res.body) as Record<string, unknown>; } catch { /* non-JSON */ }
  const first = Array.isArray(body.errors) ? (body.errors[0] as Record<string, unknown> | undefined) : undefined;
  const type = clean(body.type) ?? clean(first?.type);
  const title = clean(body.title) ?? clean(first?.title) ?? clean(body.error);
  const detail = clean(body.detail) ?? clean(first?.detail) ?? clean(first?.message) ?? clean(body.error_description) ?? clean(body.reason);
  let resetAtMs: number | null = null;
  const reset = Number(res.headers['x-rate-limit-reset']);
  if (Number.isFinite(reset) && reset > 0) resetAtMs = reset * 1000;
  const retryAfter = Number(res.headers['retry-after']);
  if (resetAtMs === null && Number.isFinite(retryAfter) && retryAfter > 0) resetAtMs = nowMs + retryAfter * 1000;
  return new XApiError(res.status, type, title, detail, resetAtMs, typeof body.error === 'string' ? body.error : null);
}

export function accessTokenFrom(credentials: ProviderCredentials): string {
  if (credentials.kind === 'oauth2') return credentials.accessToken;
  if (credentials.kind === 'mock') return credentials.token;
  throw new Error('X connection has unsupported credentials');
}

export interface XRequest {
  method: 'GET' | 'POST';
  path: string;
  query?: Record<string, string | undefined>;
  bearer?: string;
  basic?: { clientId: string; clientSecret: string };
  json?: unknown;
  form?: Record<string, string | undefined>;
  formData?: FormData;
  op: string;
  publishes?: boolean;
  timeoutMs?: number;
}

export async function xCall<T>(ctx: AdapterContext, r: XRequest): Promise<{ data: T; headers: Record<string, string>; status: number }> {
  const url = new URL(xBase(ctx) + r.path);
  for (const [k, v] of Object.entries(r.query ?? {})) if (v !== undefined) url.searchParams.set(k, v);
  const headers: Record<string, string> = {};
  if (r.bearer) headers.authorization = `Bearer ${r.bearer}`;
  if (r.basic) headers.authorization = `Basic ${Buffer.from(`${encodeURIComponent(r.basic.clientId)}:${encodeURIComponent(r.basic.clientSecret)}`).toString('base64')}`;
  let body: string | FormData | undefined;
  if (r.json !== undefined) { headers['content-type'] = 'application/json'; body = JSON.stringify(r.json); }
  if (r.form) {
    headers['content-type'] = 'application/x-www-form-urlencoded';
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(r.form)) if (v !== undefined) p.set(k, v);
    body = p.toString();
  }
  if (r.formData) body = r.formData;
  const res = await ctx.transport.send({ method: r.method, url: url.toString(), headers, body, op: r.op, publishes: r.publishes, timeoutMs: r.timeoutMs });
  if (res.status < 200 || res.status >= 300) throw parseXError(res, ctx.now().getTime());
  let data: T;
  try { data = (res.body ? JSON.parse(res.body) : {}) as T; } catch { throw new XApiError(res.status, null, 'invalid_json', 'X returned a response that is not JSON', null); }
  return { data, headers: res.headers, status: res.status };
}

// ------------------------------------------------------------------ classification
export type XErrorClass =
  | { kind: 'rate_limited'; code: 'rate_limited'; message: string; retryAfterMs: number }
  | { kind: 'budget'; code: string; message: string }
  | { kind: 'reconnect'; code: string; message: string }
  | { kind: 'permission'; code: string; message: string }
  | { kind: 'duplicate'; code: 'duplicate_content'; message: string }
  | { kind: 'invalid'; code: string; message: string }
  | { kind: 'server'; code: string; message: string };

const BUDGET_RE = /usage[- ]?cap|credits?|creditsdepleted|spend(ing)? limit|payment required|billing|insufficient (funds|balance)/i;

export function classifyXError(e: XApiError, nowMs: number): XErrorClass {
  const text = `${e.type ?? ''} ${e.title ?? ''} ${e.detail ?? ''}`;
  if (e.status === 401) {
    return { kind: 'reconnect', code: 'x_token_rejected', message: 'X rejected the access token (expired or access revoked). Reconnect the X account.' };
  }
  if (e.status === 402 || /usage-capped/i.test(e.type ?? '') || BUDGET_RE.test(text)) {
    return {
      kind: 'budget', code: 'x_budget_exhausted',
      message: 'X API credits are exhausted or the spending limit / usage cap was reached. Add credits or raise the limit in the X Developer Console; X posts are held until then.',
    };
  }
  if (e.status === 429) {
    const ms = e.resetAtMs !== null ? Math.max(1000, e.resetAtMs - nowMs) : 60_000;
    return { kind: 'rate_limited', code: 'rate_limited', message: `X rate limit reached; retry after ${Math.ceil(ms / 1000)}s.`, retryAfterMs: ms };
  }
  if (e.status === 403) {
    if (/duplicate/i.test(text)) {
      return { kind: 'duplicate', code: 'duplicate_content', message: 'X refused this post as duplicate content. An earlier attempt may already have been posted; check the account before retrying.' };
    }
    if (/client-forbidden|client-not-enrolled|not enrolled|attached to a project|appropriate level of api access/i.test(text)) {
      return { kind: 'permission', code: 'x_app_not_enrolled', message: 'The X developer app is not enrolled for this API access (client-not-enrolled). Attach it to a Project with pay-per-use credits in the X Developer Console, then retry.' };
    }
    return { kind: 'permission', code: 'x_forbidden', message: 'X refused the request for this account (403). Check the account is not locked or restricted and that the app has Read and write permission, then reconnect.' };
  }
  if (e.status >= 500) return { kind: 'server', code: 'x_server_error', message: `X returned a server error (${e.status}).` };
  if (/media/i.test(text)) return { kind: 'invalid', code: 'x_media_rejected', message: 'X rejected the image. Use a single JPEG or PNG up to 5 MB.' };
  if (/text|too long|length/i.test(text)) return { kind: 'invalid', code: 'x_text_rejected', message: 'X rejected the text (too long or invalid). Shorten it to 280 weighted characters.' };
  return { kind: 'invalid', code: 'x_invalid_request', message: `X rejected the request${e.detail ? ` (${e.detail.slice(0, 120)})` : ''}. Fix the content and schedule again.` };
}
