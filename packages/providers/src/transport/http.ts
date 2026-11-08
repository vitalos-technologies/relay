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
  // V3 (docs/providers/<provider>.md). Upload hosts come from provider responses and are still allow-listed.
  'open.tiktokapis.com', 'open-upload.tiktokapis.com',
  'www.googleapis.com', 'oauth2.googleapis.com', 'youtubeanalytics.googleapis.com',
  'api.linkedin.com', 'www.linkedin.com',
  'graph.threads.com', 'graph.threads.net',
  'api.pinterest.com', 'pinterest-media-upload.s3-accelerate.amazonaws.com',
  'bsky.social', 'public.api.bsky.app',
]);

/** Operator-supplied hostnames: lower-case DNS names only (no IPs, ports, wildcards or schemes). */
export function parseExtraHosts(raw: string | undefined | null): string[] {
  if (!raw) return [];
  return [...new Set(raw.split(',').map((h) => h.trim().toLowerCase()).filter((h) =>
    /^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(h) && h !== 'localhost'))];
}

/** V3: host suffixes (Bluesky-hosted PDS instances, e.g. morel.us-east.host.bsky.network). */
export const PROVIDER_HOST_SUFFIXES = ['.host.bsky.network'];

function hostAllowed(host: string, allow: Set<string>, suffixes: readonly string[]): boolean {
  return allow.has(host) || suffixes.some((s) => host.endsWith(s) && host.length > s.length);
}

/** Whether the default live transport (plus operator extra hosts) may call this host. */
export function isProviderHostAllowed(host: string, extraHosts: readonly string[] = []): boolean {
  return hostAllowed(host.toLowerCase(), PROVIDER_HOSTS, PROVIDER_HOST_SUFFIXES) || extraHosts.includes(host.toLowerCase());
}

const PRE_CONNECT_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT', 'ENETUNREACH', 'EHOSTUNREACH']);

export function redactProviderUrl(url: string): string {
  return url
    .replace(/\/bot\d+:[A-Za-z0-9_-]+/g, '/bot<redacted>')
    .replace(/([?&](?:access_token|client_secret|code|refresh_token|input_token|appsecret_proof|fb_exchange_token|upload_token|ut|sau|x-amz-signature|x-amz-security-token)=)[^&#]*/gi, '$1<redacted>');
}

export interface HttpTransportOptions {
  allowHosts?: Set<string>;
  /**
   * Extra exact hostnames added to the default allow-list by the OPERATOR (e.g. self-hosted Bluesky servers,
   * BLUESKY_SELF_HOSTED_HOSTS). Never taken from user input.
   */
  extraHosts?: readonly string[];
  defaultTimeoutMs?: number;
  onLog?: (entry: { op: string; method: string; url: string; status?: number; ms: number; error?: string }) => void;
}

export class HttpTransport implements Transport {
  readonly mode = 'live' as const;
  private readonly allow: Set<string>;
  private readonly timeout: number;

  constructor(private readonly opts: HttpTransportOptions = {}) {
    this.allow = opts.allowHosts ?? (opts.extraHosts?.length ? new Set([...PROVIDER_HOSTS, ...opts.extraHosts]) : PROVIDER_HOSTS);
    this.timeout = opts.defaultTimeoutMs ?? 30_000;
  }

  async send(req: HttpRequest): Promise<HttpResponse> {
    const u = new URL(req.url);
    if (u.protocol !== 'https:' || !hostAllowed(u.hostname, this.allow, this.opts.allowHosts ? [] : PROVIDER_HOST_SUFFIXES)) {
      throw new TransportError(`host not allowed: ${u.hostname}`, 'connect', false);
    }
    const started = Date.now();
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), req.timeoutMs ?? this.timeout);
    try {
      const res = await fetch(req.url, {
        method: req.method,
        headers: req.headers,
        body: req.body as RequestInit['body'], // string | FormData | Uint8Array (V3 binary uploads)
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
