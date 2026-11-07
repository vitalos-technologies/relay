// AT Protocol / Bluesky XRPC helpers. Sources (2026-11-07): docs/providers/bluesky.md (lexicons A1–A5).
//  Requests go to the account's PDS (`didDoc` #atproto_pds); sessions come from createSession with an APP PASSWORD.
import { createHash } from 'node:crypto';
import type { AdapterContext, HttpResponse, ProviderCredentials } from '@social-lite/core';
import { ProviderHttpError, call, parseJson, retryAfterAt, safeText, safeCode, type CallResult } from '../shared/http.js';
import type { ErrorClass } from '../shared/classify.js';

export const BSKY_ENTRYWAY = 'https://bsky.social';
export const BSKY_PUBLIC_APPVIEW = 'https://public.api.bsky.app';
export const POST_COLLECTION = 'app.bsky.feed.post';

/** XRPC errors: {error, message}. */
export function parseXrpcError(res: HttpResponse, nowMs: number): ProviderHttpError {
  const b = parseJson(res.body);
  return new ProviderHttpError('Bluesky', res.status, safeCode(b.error), safeText(b.message), retryAfterAt(res.headers, nowMs), res.headers);
}

export interface XrpcRequest {
  service: string;
  nsid: string;
  method: 'GET' | 'POST';
  params?: Record<string, string | undefined>;
  json?: unknown;
  bytes?: { data: Uint8Array; contentType: string };
  jwt?: string;
  op: string;
  publishes?: boolean;
  timeoutMs?: number;
}

export function xrpc<T = Record<string, unknown>>(ctx: AdapterContext, r: XrpcRequest): Promise<CallResult<T>> {
  const url = `${(ctx.config.baseUrls?.blueskyPds ?? r.service).replace(/\/$/, '')}/xrpc/${r.nsid}`;
  return call<T>(ctx, { method: r.method, url, query: r.params, json: r.json, bytes: r.bytes, bearer: r.jwt, op: r.op, publishes: r.publishes, timeoutMs: r.timeoutMs }, parseXrpcError);
}

export const isExpiredSession = (e: ProviderHttpError): boolean => e.code === 'ExpiredToken' || e.code === 'InvalidToken';

export function classifyBluesky(e: ProviderHttpError, nowMs: number): ErrorClass {
  const code = e.code ?? '';
  const text = `${code} ${e.detail ?? ''}`;
  if (code === 'AuthenticationRequired' || code === 'AuthFactorTokenRequired' || isExpiredSession(e) || e.status === 401) {
    return { kind: 'reconnect', code: 'bluesky_auth_failed', message: 'Bluesky rejected the app password (revoked, changed or wrong). Create a new app password in Bluesky Settings and reconnect.' };
  }
  if (code === 'AccountTakedown' || code === 'AccountDeactivated' || /takendown|suspended|deactivated/i.test(text)) {
    return { kind: 'permission', code: 'bluesky_account_inactive', message: 'This Bluesky account is deactivated, suspended or taken down and cannot post.' };
  }
  if (code === 'RateLimitExceeded' || e.status === 429) {
    return { kind: 'rate_limited', code: 'rate_limited', message: 'Bluesky rate limit reached; it will be retried later.', retryAfterMs: e.retryAtMs ? Math.max(1000, e.retryAtMs - nowMs) : 5 * 60_000 };
  }
  if (/already exists|RecordAlreadyExists|duplicate/i.test(text)) return { kind: 'duplicate', code: 'bluesky_record_exists', message: 'A post with this record key already exists on Bluesky (an earlier attempt likely posted it); it will be reconciled.' };
  if (code === 'RecordNotFound' || e.status === 404) return { kind: 'not_found', code: 'bluesky_not_found', message: 'Bluesky could not find the record.' };
  if (e.status >= 500) return { kind: 'server', code: 'bluesky_server_error', message: `Bluesky returned a server error (${e.status}).` };
  if (/blob/i.test(text)) return { kind: 'invalid', code: 'bluesky_blob_rejected', message: 'Bluesky rejected an image (≤ 2,000,000 bytes, JPEG/PNG/WebP). Replace it.' };
  return { kind: 'invalid', code: code ? `bluesky_${code}`.slice(0, 60) : 'bluesky_invalid_request', message: `Bluesky rejected the post${e.detail ? ` (${e.detail.slice(0, 120)})` : ''}.` };
}

// ------------------------------------------------------------------ sessions
export interface Session { did: string; handle: string; accessJwt: string; refreshJwt: string; pdsUrl: string; accessExpiresAt: string | null }

/** `exp` of a JWT (no verification — only to schedule refreshes). */
export function jwtExpiry(jwt: string): string | null {
  try {
    const payload = JSON.parse(Buffer.from(jwt.split('.')[1] ?? '', 'base64url').toString('utf8')) as { exp?: number };
    return typeof payload.exp === 'number' ? new Date(payload.exp * 1000).toISOString() : null;
  } catch {
    return null;
  }
}

/** PDS endpoint from the DID document (#atproto_pds); falls back to the service used for login. */
export function pdsFromDidDoc(didDoc: unknown, fallback: string): string {
  const services = (didDoc as { service?: Array<{ id?: string; type?: string; serviceEndpoint?: unknown }> } | null)?.service ?? [];
  const pds = services.find((s) => s.id === '#atproto_pds' || (typeof s.id === 'string' && s.id.endsWith('#atproto_pds')) || s.type === 'AtprotoPersonalDataServer');
  const ep = typeof pds?.serviceEndpoint === 'string' ? pds.serviceEndpoint : null;
  return ep && /^https:\/\//.test(ep) ? ep.replace(/\/$/, '') : fallback;
}

interface SessionResp { did?: string; handle?: string; accessJwt?: string; refreshJwt?: string; didDoc?: unknown; active?: boolean; status?: string }

export async function createSession(ctx: AdapterContext, service: string, identifier: string, password: string): Promise<Session> {
  const r = await xrpc<SessionResp>(ctx, { service, nsid: 'com.atproto.server.createSession', method: 'POST', json: { identifier, password }, op: 'bluesky.session.create' });
  return sessionFrom(r.data, service);
}

export async function refreshSession(ctx: AdapterContext, pdsUrl: string, refreshJwt: string): Promise<Session> {
  const r = await xrpc<SessionResp>(ctx, { service: pdsUrl, nsid: 'com.atproto.server.refreshSession', method: 'POST', jwt: refreshJwt, op: 'bluesky.session.refresh' });
  return sessionFrom(r.data, pdsUrl);
}

function sessionFrom(d: SessionResp, service: string): Session {
  if (!d.did || !d.accessJwt || !d.refreshJwt) throw new ProviderHttpError('Bluesky', 502, 'InvalidSession', 'Bluesky returned an incomplete session', null);
  if (d.active === false) throw new ProviderHttpError('Bluesky', 400, 'AccountDeactivated', `account ${d.status ?? 'inactive'}`, null);
  return { did: d.did, handle: d.handle ?? d.did, accessJwt: d.accessJwt, refreshJwt: d.refreshJwt, pdsUrl: pdsFromDidDoc(d.didDoc, service), accessExpiresAt: jwtExpiry(d.accessJwt) };
}

/** Usable access for a stored credential: the stored access JWT while valid, else a fresh app-password session. */
export async function accessFor(ctx: AdapterContext, credentials: ProviderCredentials, fallbackDid: string, forceNew = false): Promise<{ jwt: string; did: string; pdsUrl: string; handle: string | null }> {
  if (credentials.kind === 'mock') return { jwt: credentials.token, did: fallbackDid, pdsUrl: BSKY_ENTRYWAY, handle: null };
  if (credentials.kind !== 'atproto_app_password') throw new Error('Bluesky connection has unsupported credentials');
  const valid = credentials.accessJwt && (!credentials.accessExpiresAt || Date.parse(credentials.accessExpiresAt) - ctx.now().getTime() > 60_000);
  if (valid && !forceNew) return { jwt: credentials.accessJwt!, did: credentials.did, pdsUrl: credentials.pdsUrl, handle: null };
  const s = await createSession(ctx, credentials.service, credentials.identifier, credentials.appPassword);
  return { jwt: s.accessJwt, did: s.did, pdsUrl: s.pdsUrl, handle: s.handle };
}

/** Run with a session; an expired/invalid access token is replaced once by a fresh app-password session. */
export async function withAccess<T>(ctx: AdapterContext, credentials: ProviderCredentials, fallbackDid: string, fn: (a: { jwt: string; did: string; pdsUrl: string; handle: string | null }) => Promise<T>): Promise<T> {
  const a = await accessFor(ctx, credentials, fallbackDid);
  try {
    return await fn(a);
  } catch (err) {
    if (err instanceof ProviderHttpError && isExpiredSession(err) && credentials.kind === 'atproto_app_password') return fn(await accessFor(ctx, credentials, fallbackDid, true));
    throw err;
  }
}

// ------------------------------------------------------------------ TID record keys (A5)
const B32 = '234567abcdefghijklmnopqrstuvwxyz';
/** TID: 53-bit microsecond timestamp + 10-bit clock id, base32-sortable, 13 chars. */
export function tid(micros: bigint, clockId: number): string {
  let v = (micros << 10n) | BigInt(clockId & 0x3ff);
  let s = '';
  for (let i = 0; i < 13; i++) { s = B32[Number(v & 31n)]! + s; v >>= 5n; }
  return s;
}
/** Deterministic per delivery: clock id from the delivery id, timestamp from the first preparation. */
export function deliveryTid(deliveryId: string, at: Date): string {
  const clock = createHash('sha256').update(deliveryId).digest().readUInt16BE(0) & 0x3ff;
  return tid(BigInt(at.getTime()) * 1000n, clock);
}
export const TID_RE = /^[234567abcdefghij][234567abcdefghijklmnopqrstuvwxyz]{12}$/;
