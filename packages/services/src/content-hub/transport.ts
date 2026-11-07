// Source transport for Google (Drive/Docs) and Notion API calls (V3 Content Hub).
//  - Live: plain fetch, https only, allow-listed API hosts, manual redirects (followed only to allow-listed hosts and
//    never with the Authorization header to a different host), bounded time and bounded response bytes.
//  - Untrusted file URLs (Notion file/external URLs) never use this path in live mode: they go through the
//    SSRF-safe fetcher (services/ssrf.ts) — see fetchSourceFile().
//  - TEST transports (fakes.ts) are clearly labelled mode 'test' and refused in production.
// Logs never contain tokens, bodies or token-bearing URLs.
import { AppError } from '@social-lite/core';
import { config } from '../config.js';
import { log } from '../log.js';
import { safeFetch } from '../ssrf.js';

export interface SourceRequest {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  url: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
  /** Short operation label for logs/tests, e.g. 'drive.files.get'. */
  op: string;
  timeoutMs?: number;
  /** Response body bound (default 8 MB). */
  maxBytes?: number;
  /** Untrusted URL from an API response (Notion file URL / external file): SSRF-safe fetch in live mode. */
  untrusted?: boolean;
}

export interface SourceResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

export interface SourceTransport {
  readonly mode: 'live' | 'test';
  send(req: SourceRequest): Promise<SourceResponse>;
}

export const SOURCE_API_HOSTS = new Set([
  'www.googleapis.com', 'docs.googleapis.com', 'oauth2.googleapis.com', 'openidconnect.googleapis.com',
  'api.notion.com',
]);

export const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;

/** Thrown for every non-success outcome of a source call, classified for callers. */
export class SourceAccessError extends Error {
  constructor(
    message: string,
    readonly kind: 'auth' | 'not_found' | 'forbidden' | 'rate_limited' | 'unavailable' | 'invalid' | 'too_large' | 'conflict',
    readonly status = 0,
    readonly reason: string | null = null,
    readonly retryAfterSeconds: number | null = null,
  ) {
    super(message);
    this.name = 'SourceAccessError';
  }
  get retryable(): boolean {
    return this.kind === 'rate_limited' || this.kind === 'unavailable';
  }
}

export class SourceTooLargeError extends SourceAccessError {
  constructor(readonly limit: number) { super(`response exceeds ${limit} bytes`, 'too_large'); }
}

async function readBounded(res: Response, maxBytes: number): Promise<Buffer> {
  const declared = Number(res.headers.get('content-length') ?? '0');
  if (declared > maxBytes) {
    await res.body?.cancel().catch(() => undefined);
    throw new SourceTooLargeError(maxBytes);
  }
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new SourceTooLargeError(maxBytes);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total);
}

const redact = (url: string) => url.replace(/([?&](?:access_token|code|refresh_token|token|key|client_secret)=)[^&#]*/gi, '$1<redacted>');

export class LiveSourceTransport implements SourceTransport {
  readonly mode = 'live' as const;

  async send(req: SourceRequest): Promise<SourceResponse> {
    const maxBytes = req.maxBytes ?? DEFAULT_MAX_BYTES;
    if (req.untrusted) {
      // Notion-hosted (S3 presigned) and external file URLs: SSRF-safe, size/time bounded, no credentials sent.
      const r = await safeFetch(req.url, { maxBytes, timeoutMs: req.timeoutMs ?? 60_000, method: 'GET' });
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(r.headers)) if (typeof v === 'string') headers[k.toLowerCase()] = v;
      return { status: r.status, headers, body: r.body };
    }
    let url = new URL(req.url);
    let headers = { ...(req.headers ?? {}) };
    const started = Date.now();
    for (let hop = 0; hop < 4; hop++) {
      if (url.protocol !== 'https:' || !SOURCE_API_HOSTS.has(url.hostname)) {
        throw new SourceAccessError(`host not allowed: ${url.hostname}`, 'invalid');
      }
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), req.timeoutMs ?? 30_000);
      let res: Response;
      try {
        res = await fetch(url, {
          method: req.method, headers, body: hop === 0 ? (req.body as RequestInit['body']) : undefined, signal: ac.signal, redirect: 'manual',
        });
        if ([301, 302, 303, 307, 308].includes(res.status)) {
          const loc = res.headers.get('location');
          await res.body?.cancel().catch(() => undefined);
          if (!loc) throw new SourceAccessError('invalid redirect', 'unavailable', res.status);
          const next = new URL(loc, url);
          if (next.hostname !== url.hostname) {
            // Never forward credentials to another host.
            headers = Object.fromEntries(Object.entries(headers).filter(([k]) => k.toLowerCase() !== 'authorization'));
          }
          url = next;
          continue;
        }
        const body = await readBounded(res, maxBytes);
        const out: Record<string, string> = {};
        res.headers.forEach((v, k) => { out[k.toLowerCase()] = v; });
        const entry = { op: req.op, method: req.method, url: redact(url.origin + url.pathname), status: res.status, ms: Date.now() - started };
        if (res.status >= 400) log.warn('source_http', entry); else log.debug('source_http', entry);
        return { status: res.status, headers: out, body };
      } catch (err) {
        if (err instanceof SourceAccessError) throw err;
        const e = err as Error;
        log.warn('source_http_failed', { op: req.op, method: req.method, url: redact(url.origin + url.pathname), err: e.name });
        throw new SourceAccessError(e.name === 'AbortError' ? 'The source took too long to respond.' : 'The source could not be reached.', 'unavailable');
      } finally {
        clearTimeout(timer);
      }
    }
    throw new SourceAccessError('too many redirects', 'unavailable');
  }
}

// ------------------------------------------------------------------ test seam
type TransportFactory = (p: { source: 'google' | 'notion'; connectionId: string | null; authMode: string }) => SourceTransport;
let testFactory: TransportFactory | null = null;
let liveTransport: SourceTransport | null = null;

/** TEST SEAM: replace every source transport (labelled fakes, recorded requests). Refused in production. */
export function setSourceTransportForTests(f: TransportFactory | null): void {
  if (config().APP_ENV === 'production') throw new Error('source transport override is not available in production');
  testFactory = f;
}

/** Transport for a connection. auth_mode 'test' connections use the in-process labelled fake (never in production). */
export function sourceTransport(p: { source: 'google' | 'notion'; connectionId: string | null; authMode: string }): SourceTransport {
  const prod = config().APP_ENV === 'production';
  if (testFactory && !prod) return testFactory(p);
  if (p.authMode === 'test') {
    if (prod) throw new AppError('invalid_state', 'Test source connections are not available in production.');
    // Lazy import keeps the fake out of the live path.
    return demoTransport(p.source);
  }
  liveTransport ??= new LiveSourceTransport();
  return liveTransport;
}

let demoFactory: ((source: 'google' | 'notion') => SourceTransport) | null = null;
/** Registered by fakes.ts (non-production demo data for 'test' connections). */
export function registerDemoTransport(f: (source: 'google' | 'notion') => SourceTransport): void {
  demoFactory = f;
}
function demoTransport(source: 'google' | 'notion'): SourceTransport {
  if (!demoFactory) throw new AppError('invalid_state', 'Test source transport is not loaded.');
  return demoFactory(source);
}

// ------------------------------------------------------------------ helpers
export function jsonBody<T>(r: SourceResponse): T {
  try {
    return JSON.parse(r.body.toString('utf8')) as T;
  } catch {
    throw new SourceAccessError('The source returned an unreadable response.', 'unavailable', r.status);
  }
}
