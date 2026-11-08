// V3.5 stream C — HTTP transport for business connectors (Asana, monday.com, HubSpot, Google Business Profile,
// Cloud Translation, Slack, Mailchimp).
//  - Live: https only, per-connector allow-listed hosts (no arbitrary fetch / SSRF surface), manual redirects, bounded
//    time and response size. Network failures say whether the request may have reached the provider, so callers can
//    treat a lost write as "unknown" (reconcile) instead of blindly retrying.
//  - Simulated: routes the clients' REAL requests to an in-process simulation of the provider API (sim.ts). Only for
//    mock_ installations, never in production (enforced by the service layer).
// Logs never include tokens, bodies or token-bearing URLs.

export type BizMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface BizRequest {
  method: BizMethod;
  url: string;
  headers?: Record<string, string>;
  body?: string;
  /** Operation label for logs/tests, e.g. 'asana.tasks.create'. */
  op: string;
  timeoutMs?: number;
  /** true when the request may create/change an external record (a lost response ⇒ unknown, not retry). */
  mutating?: boolean;
}

export interface BizResponse { status: number; headers: Record<string, string>; body: string }

export interface BizTransport {
  readonly mode: 'live' | 'simulated';
  send(req: BizRequest): Promise<BizResponse>;
}

/** Network-level failure. `mayHaveReached` ⇒ the provider might have acted on a write. */
export class BizTransportError extends Error {
  constructor(message: string, readonly kind: 'connect' | 'timeout' | 'reset' | 'host' | 'too_large', readonly mayHaveReached: boolean) {
    super(message);
    this.name = 'BizTransportError';
  }
}

export type BizErrorKind = 'auth' | 'forbidden' | 'not_found' | 'rate_limited' | 'unavailable' | 'invalid' | 'conflict' | 'server';

/** Non-success provider response, classified. `message` is safe to show (no tokens, no customer content). */
export class BizApiError extends Error {
  constructor(
    message: string,
    readonly kind: BizErrorKind,
    readonly status: number,
    readonly code: string | null = null,
    readonly retryAfterMs: number | null = null,
  ) {
    super(message);
    this.name = 'BizApiError';
  }
}

export function retryAfterMs(headers: Record<string, string>): number | null {
  const v = headers['retry-after'];
  if (!v) return null;
  if (/^\d+$/.test(v)) return Number(v) * 1000;
  const t = Date.parse(v);
  return Number.isFinite(t) ? Math.max(0, t - Date.now()) : null;
}

/** Default HTTP status classification (connectors refine with their own error codes). */
export function classifyStatus(status: number): BizErrorKind {
  if (status === 401) return 'auth';
  if (status === 403) return 'forbidden';
  if (status === 404 || status === 410) return 'not_found';
  if (status === 409) return 'conflict';
  if (status === 429) return 'rate_limited';
  if (status === 502 || status === 503 || status === 504) return 'unavailable';
  if (status >= 500) return 'server';
  return 'invalid';
}

export function apiError(res: BizResponse, message: string, code: string | null = null): BizApiError {
  return new BizApiError(message, classifyStatus(res.status), res.status, code, retryAfterMs(res.headers));
}

export function parseJson<T = Record<string, unknown>>(body: string): T | null {
  try { return JSON.parse(body) as T; } catch { return null; }
}

export const form = (o: Record<string, string | null | undefined>) =>
  new URLSearchParams(Object.entries(o).filter((e): e is [string, string] => typeof e[1] === 'string')).toString();

export function redactUrl(url: string): string {
  return url.replace(/([?&](?:access_token|client_secret|code|refresh_token|token|key|assertion)=)[^&#]*/gi, '$1<redacted>')
    .replace(/(\/access-tokens\/)[^/?#]+/i, '$1<redacted>');
}

const MAX_BYTES = 4 * 1024 * 1024;
const PRE_CONNECT = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT', 'ENETUNREACH', 'EHOSTUNREACH']);

export interface LiveBizTransportOptions {
  /** Exact hosts this connector may call. */
  hosts: readonly string[];
  timeoutMs?: number;
  onLog?: (e: { op: string; method: string; url: string; status?: number; ms: number; error?: string }) => void;
}

export class LiveBizTransport implements BizTransport {
  readonly mode = 'live' as const;
  private readonly hosts: Set<string>;
  constructor(private readonly opts: LiveBizTransportOptions) { this.hosts = new Set(opts.hosts.map((h) => h.toLowerCase())); }

  async send(req: BizRequest): Promise<BizResponse> {
    const u = new URL(req.url);
    if (u.protocol !== 'https:' || !this.hosts.has(u.hostname.toLowerCase())) throw new BizTransportError(`host not allowed: ${u.hostname}`, 'host', false);
    const started = Date.now();
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), req.timeoutMs ?? this.opts.timeoutMs ?? 20_000);
    try {
      const res = await fetch(u, { method: req.method, headers: req.headers, body: req.body, signal: ac.signal, redirect: 'manual' });
      const declared = Number(res.headers.get('content-length') ?? '0');
      if (declared > MAX_BYTES) { await res.body?.cancel().catch(() => undefined); throw new BizTransportError('response too large', 'too_large', !!req.mutating); }
      const text = await res.text();
      if (text.length > MAX_BYTES) throw new BizTransportError('response too large', 'too_large', !!req.mutating);
      const headers: Record<string, string> = {};
      res.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
      this.opts.onLog?.({ op: req.op, method: req.method, url: redactUrl(req.url), status: res.status, ms: Date.now() - started });
      return { status: res.status, headers, body: text };
    } catch (err) {
      if (err instanceof BizTransportError) throw err;
      const e = err as Error & { cause?: { code?: string }; code?: string };
      const code = e.cause?.code ?? e.code;
      this.opts.onLog?.({ op: req.op, method: req.method, url: redactUrl(req.url), ms: Date.now() - started, error: code ?? e.name });
      if (code && PRE_CONNECT.has(code)) throw new BizTransportError(`connection failed (${code})`, 'connect', false);
      if (e.name === 'AbortError') throw new BizTransportError('request timed out', 'timeout', !!req.mutating);
      throw new BizTransportError(`network error (${code ?? e.name})`, 'reset', !!req.mutating);
    } finally {
      clearTimeout(timer);
    }
  }
}
