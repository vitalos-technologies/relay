// Shared HTTP helper for the V3 providers (TikTok, YouTube, LinkedIn, Threads, Pinterest, Bluesky).
// Builds requests for the injected Transport (live allow-listed HTTPS or the in-process fakes), parses JSON,
// and turns non-2xx responses into a ProviderHttpError with SAFE fields only (no tokens, bounded text).
import type { AdapterContext, HttpRequest, HttpResponse } from '@social-lite/core';

/** A non-2xx provider response, reduced to safe, classifiable fields. */
export class ProviderHttpError extends Error {
  constructor(
    public readonly provider: string,
    public readonly status: number,
    /** Provider error code/reason (e.g. 'access_token_invalid', 'quotaExceeded', 'ExpiredToken'). */
    public readonly code: string | null,
    /** Bounded, token-free provider message. */
    public readonly detail: string | null,
    /** Absolute epoch ms when a retry is allowed, if the provider said so. */
    public readonly retryAtMs: number | null,
    public readonly headers: Record<string, string> = {},
  ) {
    super(`${provider} API error ${status}${code ? ` ${code}` : ''}${detail ? `: ${detail}` : ''}`);
    this.name = 'ProviderHttpError';
  }
}

const SECRETISH = /(Bearer\s+|access_token=|refresh_token=|client_secret=|password["':=\s]+)[A-Za-z0-9._~+/=%-]+/gi;
/** Bounded, single-line, token-redacted text from a provider response. */
// Long opaque runs (tokens, JWTs, signed URL parts) are never echoed from provider messages.
const OPAQUE = /[A-Za-z0-9._~+/=-]{24,}/g;
export function safeText(s: unknown, max = 200): string | null {
  return typeof s === 'string' && s ? s.replace(SECRETISH, '$1<redacted>').replace(OPAQUE, '<redacted>').replace(/\s+/g, ' ').trim().slice(0, max) : null;
}

/** Provider error CODE (identifier-like, e.g. 'unaudited_client_can_only_post_to_private_accounts'): not redacted, bounded. */
export function safeCode(s: unknown, max = 80): string | null {
  return typeof s === 'string' && /^[A-Za-z0-9_.:-]{1,120}$/.test(s) ? s.slice(0, max) : null;
}

/** Retry-After (seconds or HTTP date) → absolute epoch ms. */
export function retryAfterAt(headers: Record<string, string>, nowMs: number): number | null {
  const ra = headers['retry-after'];
  if (ra) {
    const n = Number(ra);
    if (Number.isFinite(n) && n >= 0) return nowMs + n * 1000;
    const d = Date.parse(ra);
    if (Number.isFinite(d)) return d;
  }
  const reset = Number(headers['ratelimit-reset'] ?? headers['x-ratelimit-reset']);
  if (Number.isFinite(reset) && reset > 0) return reset > 1e9 ? reset * 1000 : nowMs + reset * 1000;
  return null;
}

export function parseJson(body: string): Record<string, unknown> {
  if (!body) return {};
  try {
    const v = JSON.parse(body) as unknown;
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export interface CallSpec {
  method: HttpRequest['method'];
  url: string;
  query?: Record<string, string | undefined>;
  headers?: Record<string, string>;
  bearer?: string;
  basic?: { user: string; password: string };
  json?: unknown;
  form?: Record<string, string | undefined>;
  formData?: FormData;
  bytes?: { data: Uint8Array; contentType: string; extraHeaders?: Record<string, string> };
  op: string;
  publishes?: boolean;
  timeoutMs?: number;
  /** Non-2xx statuses that are NOT errors for this call (e.g. 308 Resume Incomplete). */
  acceptStatus?: number[];
}

export interface CallResult<T> { data: T; status: number; headers: Record<string, string>; raw: HttpResponse }

export type ErrorParser = (res: HttpResponse, nowMs: number) => ProviderHttpError;

export function buildRequest(spec: CallSpec): HttpRequest {
  const url = new URL(spec.url);
  for (const [k, v] of Object.entries(spec.query ?? {})) if (v !== undefined) url.searchParams.set(k, v);
  const headers: Record<string, string> = { ...(spec.headers ?? {}) };
  if (spec.bearer) headers.authorization = `Bearer ${spec.bearer}`;
  if (spec.basic) headers.authorization = `Basic ${Buffer.from(`${spec.basic.user}:${spec.basic.password}`).toString('base64')}`;
  let body: HttpRequest['body'];
  if (spec.json !== undefined) { headers['content-type'] ??= 'application/json'; body = JSON.stringify(spec.json); }
  if (spec.form) {
    headers['content-type'] = 'application/x-www-form-urlencoded';
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(spec.form)) if (v !== undefined) p.set(k, v);
    body = p.toString();
  }
  if (spec.formData) body = spec.formData;
  if (spec.bytes) {
    headers['content-type'] = spec.bytes.contentType;
    headers['content-length'] = String(spec.bytes.data.byteLength);
    Object.assign(headers, spec.bytes.extraHeaders ?? {});
    body = spec.bytes.data;
  }
  return { method: spec.method, url: url.toString(), headers, body, op: spec.op, publishes: spec.publishes, timeoutMs: spec.timeoutMs };
}

/** Send one request; non-2xx (and not accepted) responses throw the provider's parsed error. */
export async function call<T = Record<string, unknown>>(ctx: AdapterContext, spec: CallSpec, parseError: ErrorParser): Promise<CallResult<T>> {
  const res = await ctx.transport.send(buildRequest(spec));
  const ok = (res.status >= 200 && res.status < 300) || (spec.acceptStatus ?? []).includes(res.status);
  if (!ok) throw parseError(res, ctx.now().getTime());
  return { data: parseJson(res.body) as T, status: res.status, headers: res.headers, raw: res };
}

/** Header lookup, case-insensitive (transports lower-case names; fakes may not). */
export function header(headers: Record<string, string>, name: string): string | undefined {
  const n = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) if (k.toLowerCase() === n) return v;
  return undefined;
}

/** Base URL override for tests / regional endpoints: config.baseUrls[key] ?? fallback, no trailing slash. */
export function baseUrl(ctx: Pick<AdapterContext, 'config'>, key: string, fallback: string): string {
  return (ctx.config.baseUrls?.[key] ?? fallback).replace(/\/$/, '');
}

/** Bearer/OAuth access token from stored credentials (oauth2 or mock). */
export function oauthAccessToken(credentials: { kind: string; accessToken?: string; token?: string }, provider: string): string {
  if (credentials.kind === 'oauth2' && credentials.accessToken) return credentials.accessToken;
  if (credentials.kind === 'mock' && credentials.token) return credentials.token;
  throw new Error(`${provider} connection has unsupported credentials`);
}
