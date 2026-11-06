// Minimal, versioned Meta Graph API client used by the Facebook Page and Instagram adapters.
//
//  - Version is pinned (DEFAULT_GRAPH_VERSION) and can be overridden by ProviderAppConfig.apiVersion.
//  - POST bodies are application/x-www-form-urlencoded; the access token and appsecret_proof
//    travel in the body, never in the URL.
//  - GET requests carry access_token / appsecret_proof as query parameters (the documented
//    Graph form). Transports log only redactProviderUrl(url), which strips both.
//  - Every request has an `op` label; final publish calls set `publishes: true`.
//  - Raw provider bodies are parsed here and NEVER propagated into user-facing messages.
import { createHmac } from 'node:crypto';
import type { AdapterContext, HttpRequest, HttpResponse, ProviderAppConfig, ProviderCredentials } from '@social-lite/core';

/**
 * Verified 2026-11-06 at https://developers.facebook.com/docs/graph-api/changelog/versions :
 * v26.0 released 2026-07-29 (expiry TBD) is the newest version listed in the versions table.
 * (The changelog index text mentions v27.0 but no v27.0 changelog page exists yet — see docs/providers/meta.md.)
 */
export const DEFAULT_GRAPH_VERSION = 'v26.0';
export const GRAPH_HOST = 'https://graph.facebook.com';
export const DIALOG_HOST = 'https://www.facebook.com';

const VERSION_RE = /^v\d{1,3}\.\d{1,2}$/;

export function graphVersion(config: ProviderAppConfig): string {
  const v = config.apiVersion?.trim();
  return v && VERSION_RE.test(v) ? v : DEFAULT_GRAPH_VERSION;
}

export function graphBase(config: ProviderAppConfig): string {
  return `${(config.baseUrls?.graph ?? GRAPH_HOST).replace(/\/+$/, '')}/${graphVersion(config)}`;
}

/** appsecret_proof = hex(HMAC-SHA256(key = app secret, message = access token)). */
export function appsecretProof(accessToken: string, appSecret: string): string {
  return createHmac('sha256', appSecret).update(accessToken).digest('hex');
}

/** Token used for Page / IG calls. Mock connections carry a { kind: 'mock' } credential. */
export function pageToken(credentials: ProviderCredentials): string | null {
  if (credentials.kind === 'meta_page') return credentials.pageAccessToken || null;
  if (credentials.kind === 'mock') return credentials.token || null;
  return null;
}

/** User token (for /me/permissions); falls back to the Page token. */
export function userToken(credentials: ProviderCredentials): string | null {
  if (credentials.kind === 'meta_page') return credentials.userAccessToken || credentials.pageAccessToken || null;
  if (credentials.kind === 'mock') return credentials.token || null;
  return null;
}

export interface GraphErrorInfo {
  httpStatus: number;
  code: number | null;
  subcode: number | null;
  type: string | null;
  isTransient: boolean;
  /** Raw provider message — internal diagnostics only, never shown to users or logged with tokens. */
  rawMessage: string | null;
  fbtraceId: string | null;
}

export type GraphResult<T = Record<string, unknown>> =
  | { ok: true; status: number; data: T; headers: Record<string, string> }
  | { ok: false; status: number; error: GraphErrorInfo; headers: Record<string, string> };

export interface GraphCall {
  method: 'GET' | 'POST';
  /** Path below the version, without leading slash, e.g. "123/feed". */
  path: string;
  /** Access token; omitted for OAuth endpoints that authenticate with client_secret. */
  token?: string | null;
  params?: Record<string, string | number | boolean | null | undefined>;
  op: string;
  publishes?: boolean;
  timeoutMs?: number;
  /** Skip appsecret_proof (OAuth endpoints). */
  noProof?: boolean;
}

function cleanParams(p: GraphCall['params']): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const [k, v] of Object.entries(p ?? {})) {
    if (v === undefined || v === null) continue;
    out.push([k, String(v)]);
  }
  return out;
}

export function buildGraphRequest(config: ProviderAppConfig, call: GraphCall): HttpRequest {
  const base = graphBase(config);
  const auth: Array<[string, string]> = [];
  if (call.token) {
    auth.push(['access_token', call.token]);
    if (config.clientSecret && !call.noProof) auth.push(['appsecret_proof', appsecretProof(call.token, config.clientSecret)]);
  }
  const params = cleanParams(call.params);
  const url = new URL(`${base}/${call.path.replace(/^\/+/, '')}`);
  if (call.method === 'GET') {
    for (const [k, v] of [...params, ...auth]) url.searchParams.append(k, v);
    return { method: 'GET', url: url.toString(), headers: { accept: 'application/json' }, op: call.op, publishes: call.publishes, timeoutMs: call.timeoutMs };
  }
  const body = new URLSearchParams([...params, ...auth]).toString();
  return {
    method: 'POST', url: url.toString(), body, op: call.op, publishes: call.publishes, timeoutMs: call.timeoutMs,
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
  };
}

export function parseGraphResponse<T = Record<string, unknown>>(res: HttpResponse): GraphResult<T> {
  let parsed: unknown = null;
  try { parsed = res.body ? JSON.parse(res.body) : null; } catch { parsed = null; }
  const obj = (parsed && typeof parsed === 'object' ? parsed : {}) as Record<string, unknown>;
  const errObj = obj.error && typeof obj.error === 'object' ? (obj.error as Record<string, unknown>) : null;
  if (res.status >= 200 && res.status < 300 && !errObj) {
    return { ok: true, status: res.status, data: obj as T, headers: res.headers };
  }
  const num = (v: unknown) => (typeof v === 'number' ? v : typeof v === 'string' && /^-?\d+$/.test(v) ? Number(v) : null);
  return {
    ok: false, status: res.status, headers: res.headers,
    error: {
      httpStatus: res.status,
      code: num(errObj?.code),
      subcode: num(errObj?.error_subcode),
      type: typeof errObj?.type === 'string' ? errObj.type : null,
      isTransient: errObj?.is_transient === true,
      rawMessage: typeof errObj?.message === 'string' ? errObj.message.slice(0, 500) : null,
      fbtraceId: typeof errObj?.fbtrace_id === 'string' ? errObj.fbtrace_id : null,
    },
  };
}

/** Send a Graph request. TransportError propagates to the caller for classification. */
export async function graph<T = Record<string, unknown>>(ctx: AdapterContext, call: GraphCall): Promise<GraphResult<T>> {
  const res = await ctx.transport.send(buildGraphRequest(ctx.config, call));
  return parseGraphResponse<T>(res);
}

export function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : typeof v === 'number' ? String(v) : null;
}
