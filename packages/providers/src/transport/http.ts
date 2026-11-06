// Live HTTP transport for provider APIs.
//  - Only allow-listed provider hosts (no arbitrary fetch / SSRF surface).
//  - Bounded timeouts. Network failures are classified by whether the request may have
//    reached the provider: only pre-connection failures are safely retryable for publishes.
//  - Logs never include token-bearing URLs or bodies.
import { TransportError, type HttpRequest, type HttpResponse, type Transport } from '@social-lite/core';

export const PROVIDER_HOSTS = new Set([
  'api.telegram.org',
  'graph.facebook.com',
  'www.facebook.com',
  'graph.instagram.com',
  'api.x.com',
  'api.twitter.com',
  'upload.twitter.com',
  'x.com',
  'twitter.com',
]);

const PRE_CONNECT_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT', 'ENETUNREACH', 'EHOSTUNREACH']);

export function redactProviderUrl(url: string): string {
  return url
    .replace(/\/bot\d+:[A-Za-z0-9_-]+/g, '/bot<redacted>')
    .replace(/([?&](?:access_token|client_secret|code|refresh_token|input_token|appsecret_proof|fb_exchange_token)=)[^&#]*/gi, '$1<redacted>');
}

export interface HttpTransportOptions {
  allowHosts?: Set<string>;
  defaultTimeoutMs?: number;
  onLog?: (entry: { op: string; method: string; url: string; status?: number; ms: number; error?: string }) => void;
}

export class HttpTransport implements Transport {
  readonly mode = 'live' as const;
  private readonly allow: Set<string>;
  private readonly timeout: number;

  constructor(private readonly opts: HttpTransportOptions = {}) {
    this.allow = opts.allowHosts ?? PROVIDER_HOSTS;
    this.timeout = opts.defaultTimeoutMs ?? 30_000;
  }

  async send(req: HttpRequest): Promise<HttpResponse> {
    const u = new URL(req.url);
    if (u.protocol !== 'https:' || !this.allow.has(u.hostname)) {
      throw new TransportError(`host not allowed: ${u.hostname}`, 'connect', false);
    }
    const started = Date.now();
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), req.timeoutMs ?? this.timeout);
    try {
      const res = await fetch(req.url, {
        method: req.method,
        headers: req.headers,
        body: req.body,
        signal: ac.signal,
        redirect: 'manual', // never follow redirects to unvetted hosts
      });
      const body = await res.text();
      const headers: Record<string, string> = {};
      res.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
      this.opts.onLog?.({ op: req.op, method: req.method, url: redactProviderUrl(req.url), status: res.status, ms: Date.now() - started });
      return { status: res.status, headers, body };
    } catch (err) {
      const e = err as Error & { cause?: { code?: string } };
      const code = e.cause?.code ?? (e as { code?: string }).code;
      this.opts.onLog?.({ op: req.op, method: req.method, url: redactProviderUrl(req.url), ms: Date.now() - started, error: code ?? e.name });
      if (code && PRE_CONNECT_CODES.has(code)) throw new TransportError(`connection failed (${code})`, 'connect', false);
      if (e.name === 'AbortError') throw new TransportError('request timed out', 'timeout', true);
      throw new TransportError(`network error (${code ?? e.name})`, 'reset', true);
    } finally {
      clearTimeout(timer);
    }
  }
}
