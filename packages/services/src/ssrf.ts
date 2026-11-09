// SSRF-safe fetch for untrusted URLs (spec §14). Not a general proxy: callers pass strict
// size/time budgets and, where possible, an allowlist of approved hosts.
//  - https only (http only for explicitly allow-listed hosts outside production)
//  - every hop: DNS resolved, ALL addresses must be public; the socket connects to the vetted IP
//    (no second lookup ⇒ no DNS-rebinding window)
//  - redirects followed manually (max 3) and re-validated at every hop
//  - response size and total time bounded
import { lookup as dnsLookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import net, { BlockList, type LookupFunction } from 'node:net';
import { AppError } from '@social-lite/core';
import { config } from './config.js';

export interface SafeFetchOptions {
  maxBytes: number;
  timeoutMs: number;
  /** Lower-case hostnames. When given, only these hosts may be contacted (at every hop). */
  allowHosts?: string[];
  maxRedirects?: number;
  headers?: Record<string, string>;
  method?: 'GET' | 'HEAD';
}

export interface SafeFetchResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
  url: string;
  contentType: string | null;
}

export class SsrfBlockedError extends AppError {
  constructor(message: string, readonly reason: string) {
    super('validation_failed', message, undefined, { reason });
    this.name = 'SsrfBlockedError';
  }
}

const blocked = new BlockList();
for (const [net4, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) blocked.addSubnet(net4, prefix, 'ipv4');
for (const [net6, prefix] of [
  ['::', 128], ['::1', 128], ['100::', 64], ['2001::', 32], ['2001:db8::', 32], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
] as const) blocked.addSubnet(net6, prefix, 'ipv6');

function expandV6(ip: string): number[] | null {
  // Returns 8 hextets, handling embedded IPv4 tails.
  let s = ip.toLowerCase();
  const zone = s.indexOf('%');
  if (zone >= 0) s = s.slice(0, zone);
  const v4 = s.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (v4) {
    const p = v4[1]!.split('.').map(Number);
    s = s.slice(0, -v4[1]!.length) + ((p[0]! << 8) | p[1]!).toString(16) + ':' + ((p[2]! << 8) | p[3]!).toString(16);
  }
  const [head, tail] = s.split('::');
  const h = head ? head.split(':') : [];
  const t = tail !== undefined ? (tail ? tail.split(':') : []) : [];
  if (s.includes('::') ? h.length + t.length > 7 : h.length !== 8) return null;
  const fill = s.includes('::') ? new Array(8 - h.length - t.length).fill('0') : [];
  const parts = [...h, ...fill, ...t].map((x) => parseInt(x, 16));
  return parts.length === 8 && parts.every((n) => Number.isInteger(n) && n >= 0 && n <= 0xffff) ? parts : null;
}

const v4FromHextets = (a: number, b: number) => `${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`;

/** true when the address is loopback/private/link-local/CGNAT/metadata/reserved or otherwise non-public. */
export function isBlockedAddress(ip: string): boolean {
  const fam = net.isIP(ip);
  if (fam === 4) return blocked.check(ip, 'ipv4');
  if (fam !== 6) return true;
  const h = expandV6(ip);
  if (!h) return true;
  // IPv4-mapped (::ffff:a.b.c.d), IPv4-compatible (::a.b.c.d), NAT64 (64:ff9b::/96): judge the embedded IPv4.
  if (h.slice(0, 5).every((x) => x === 0) && (h[5] === 0xffff || h[5] === 0)) {
    if (h[5] === 0 && h[6] === 0 && (h[7] === 0 || h[7] === 1)) return true; // :: and ::1
    return isBlockedAddress(v4FromHextets(h[6]!, h[7]!));
  }
  if (h[0] === 0x64 && h[1] === 0xff9b && h.slice(2, 6).every((x) => x === 0)) return isBlockedAddress(v4FromHextets(h[6]!, h[7]!));
  // 6to4 (2002::/16) embeds an IPv4 address in hextets 1-2.
  if (h[0] === 0x2002) return isBlockedAddress(v4FromHextets(h[1]!, h[2]!));
  return blocked.check(ip.split('%')[0]!, 'ipv6');
}

function normalizeHost(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '');
}

interface Vetted { url: URL; address: string; family: 4 | 6 }

async function vet(url: URL, opts: SafeFetchOptions): Promise<Vetted> {
  const host = normalizeHost(url.hostname);
  const allow = opts.allowHosts?.map((h) => h.toLowerCase());
  const allowListed = !!allow?.includes(host);
  if (allow && !allowListed) throw new SsrfBlockedError('That address is not on the list of allowed hosts.', 'host_not_allowed');
  const devAllowed = allowListed && config().APP_ENV !== 'production';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && devAllowed)) {
    throw new SsrfBlockedError('Only https:// addresses can be fetched.', 'scheme');
  }
  if (url.username || url.password) throw new SsrfBlockedError('Addresses with credentials are not allowed.', 'credentials');
  if (url.port && !['443', '80'].includes(url.port) && !devAllowed) throw new SsrfBlockedError('Non-standard ports are not allowed.', 'port');

  let addresses: Array<{ address: string; family: number }>;
  if (net.isIP(host)) {
    addresses = [{ address: host, family: net.isIP(host) }];
  } else {
    try {
      addresses = await dnsLookup(host, { all: true, verbatim: true });
    } catch {
      throw new SsrfBlockedError('The address could not be resolved.', 'dns');
    }
  }
  if (!addresses.length) throw new SsrfBlockedError('The address could not be resolved.', 'dns');
  // Private destinations are refused unless the host was explicitly allow-listed in development.
  if (!devAllowed && addresses.some((a) => isBlockedAddress(a.address))) {
    throw new SsrfBlockedError('That address points to a private or reserved network and cannot be fetched.', 'private_address');
  }
  const first = addresses[0]!;
  return { url, address: first.address, family: first.family === 6 ? 6 : 4 };
}

function request(v: Vetted, opts: SafeFetchOptions, deadline: number): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const pinned: LookupFunction = (_hostname, options, cb) => {
      if ((options as { all?: boolean }).all) (cb as unknown as (e: null, a: Array<{ address: string; family: number }>) => void)(null, [{ address: v.address, family: v.family }]);
      else cb(null, v.address, v.family);
    };
    const mod = v.url.protocol === 'https:' ? https : http;
    const remaining = Math.max(1, deadline - Date.now());
    const req = mod.request({
      protocol: v.url.protocol,
      hostname: normalizeHost(v.url.hostname),
      port: v.url.port || undefined,
      path: `${v.url.pathname}${v.url.search}`,
      method: opts.method ?? 'GET',
      headers: { 'user-agent': 'SocialLite/1.0 (+safe-fetch)', accept: '*/*', ...opts.headers },
      lookup: pinned,
      servername: net.isIP(normalizeHost(v.url.hostname)) ? undefined : normalizeHost(v.url.hostname),
      agent: false,
      timeout: remaining,
    }, (res) => {
      const declared = Number(res.headers['content-length'] ?? '0');
      if (declared > opts.maxBytes) {
        res.destroy();
        reject(new AppError('payload_too_large', 'The remote file is too large.'));
        return;
      }
      const chunks: Buffer[] = [];
      let total = 0;
      res.on('data', (c: Buffer) => {
        total += c.length;
        if (total > opts.maxBytes) {
          res.destroy();
          req.destroy();
          reject(new AppError('payload_too_large', 'The remote file is too large.'));
          return;
        }
        chunks.push(c);
      });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks, total) }));
      res.on('error', reject);
    });
    const timer = setTimeout(() => req.destroy(new AppError('provider_error', 'The remote server took too long to respond.')), remaining);
    req.on('timeout', () => req.destroy(new AppError('provider_error', 'The remote server took too long to respond.')));
    req.on('error', (err) => reject(err instanceof AppError ? err : new AppError('provider_error', 'Couldn’t reach the remote server. Try again.')));
    req.on('close', () => clearTimeout(timer));
    req.end();
  });
}

export async function safeFetch(rawUrl: string, opts: SafeFetchOptions): Promise<SafeFetchResponse> {
  const deadline = Date.now() + opts.timeoutMs;
  const maxRedirects = Math.min(opts.maxRedirects ?? 3, 3);
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new SsrfBlockedError('That is not a valid address.', 'invalid_url');
  }
  for (let hop = 0; ; hop++) {
    const vetted = await vet(url, opts);
    const res = await request(vetted, opts, deadline);
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const loc = res.headers.location;
      if (!loc) throw new AppError('provider_error', 'The remote server sent an invalid redirect.');
      if (hop >= maxRedirects) throw new SsrfBlockedError('Too many redirects.', 'too_many_redirects');
      try {
        url = new URL(loc, url);
      } catch {
        throw new SsrfBlockedError('The remote server redirected to an invalid address.', 'invalid_url');
      }
      continue;
    }
    const ct = res.headers['content-type'];
    return { status: res.status, headers: res.headers, body: res.body, url: url.toString(), contentType: typeof ct === 'string' ? ct : null };
  }
}
