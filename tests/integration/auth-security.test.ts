// SSRF-safe fetch (spec §14) and the in-process rate limiter used on auth/upload routes.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resetConfigCache } from '@social-lite/services';
import { RateLimiter, enforceRateLimit, clientIp } from '../../packages/services/src/ratelimit.js';
import { isBlockedAddress, safeFetch } from '../../packages/services/src/ssrf.js';
import { testEnv } from './helpers.js';

let server: http.Server;
let port = 0;

beforeAll(async () => {
  testEnv();
  server = http.createServer((req, res) => {
    const u = new URL(req.url!, 'http://localhost');
    if (u.pathname === '/ok') { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('hello'); return; }
    if (u.pathname === '/to-loopback') { res.writeHead(302, { location: `http://127.0.0.1:${port}/ok` }); res.end(); return; }
    if (u.pathname === '/to-metadata') { res.writeHead(301, { location: 'http://169.254.169.254/latest/meta-data/' }); res.end(); return; }
    if (u.pathname === '/to-private-https') { res.writeHead(307, { location: 'https://10.0.0.5/admin' }); res.end(); return; }
    if (u.pathname.startsWith('/loop/')) {
      const n = Number(u.pathname.split('/')[2]);
      res.writeHead(302, { location: `/loop/${n + 1}` }); res.end(); return;
    }
    if (u.pathname === '/big') { res.writeHead(200); res.end(Buffer.alloc(10_000, 1)); return; }
    if (u.pathname === '/slow') { setTimeout(() => { res.writeHead(200); res.end('late'); }, 2000); return; }
    res.writeHead(404); res.end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  resetConfigCache();
});

const reasonOf = async (p: Promise<unknown>) => {
  const e = (await p.then(() => null, (err: unknown) => err)) as { code?: string; details?: { reason?: string } } | null;
  expect(e, 'expected the fetch to be refused').not.toBeNull();
  return e!.details?.reason ?? e!.code;
};

describe('isBlockedAddress', () => {
  it('blocks loopback, private, link-local, CGNAT, metadata and reserved ranges (v4 and v6)', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0',
      '224.0.0.1', '255.255.255.255', '198.18.0.1', '::1', '::', 'fd00::1', 'fc00::1', 'fe80::1', 'ff02::1', '::ffff:127.0.0.1',
      '::ffff:169.254.169.254', '::ffff:a9fe:a9fe', '64:ff9b::a9fe:a9fe', '2002:7f00:1::', 'not-an-ip']) {
      expect(isBlockedAddress(ip), ip).toBe(true);
    }
    for (const ip of ['93.184.216.34', '8.8.8.8', '172.32.0.1', '2606:4700:4700::1111', '::ffff:8.8.8.8']) {
      expect(isBlockedAddress(ip), ip).toBe(false);
    }
  });
});

describe('safeFetch', () => {
  it('refuses loopback and cloud metadata destinations', async () => {
    expect(await reasonOf(safeFetch('https://127.0.0.1/', { maxBytes: 1000, timeoutMs: 2000 }))).toBe('private_address');
    expect(await reasonOf(safeFetch('https://169.254.169.254/latest/meta-data/', { maxBytes: 1000, timeoutMs: 2000 }))).toBe('private_address');
    expect(await reasonOf(safeFetch('https://[::1]/', { maxBytes: 1000, timeoutMs: 2000 }))).toBe('private_address');
    expect(await reasonOf(safeFetch('https://[::ffff:127.0.0.1]/', { maxBytes: 1000, timeoutMs: 2000 }))).toBe('private_address');
    expect(await reasonOf(safeFetch('https://localhost/', { maxBytes: 1000, timeoutMs: 2000 }))).toBe('private_address');
    expect(await reasonOf(safeFetch(`https://2130706433/`, { maxBytes: 1000, timeoutMs: 2000 }))).toBe('private_address'); // 127.0.0.1 as integer
  });

  it('allows only https unless an allow-listed host in development', async () => {
    expect(await reasonOf(safeFetch('http://169.254.169.254/', { maxBytes: 1000, timeoutMs: 2000 }))).toBe('scheme');
    expect(await reasonOf(safeFetch(`http://localhost:${port}/ok`, { maxBytes: 1000, timeoutMs: 2000 }))).toBe('scheme');
    expect(await reasonOf(safeFetch('ftp://example.com/', { maxBytes: 1000, timeoutMs: 2000 }))).toBe('scheme');
    expect(await reasonOf(safeFetch('https://user:pw@example.com/', { maxBytes: 1000, timeoutMs: 2000 }))).toBe('credentials');
    expect(await reasonOf(safeFetch('https://example.com/', { maxBytes: 1000, timeoutMs: 2000, allowHosts: ['images.example.org'] }))).toBe('host_not_allowed');
    const ok = await safeFetch(`http://localhost:${port}/ok`, { maxBytes: 1000, timeoutMs: 2000, allowHosts: ['localhost'] });
    expect(ok).toMatchObject({ status: 200, contentType: 'text/plain' });
    expect(ok.body.toString()).toBe('hello');
  });

  it('re-validates every redirect hop: redirects to private/metadata addresses are refused', async () => {
    const opts = { maxBytes: 1000, timeoutMs: 2000, allowHosts: ['localhost'] };
    expect(await reasonOf(safeFetch(`http://localhost:${port}/to-loopback`, opts))).toBe('host_not_allowed');
    expect(await reasonOf(safeFetch(`http://localhost:${port}/to-metadata`, opts))).toBe('host_not_allowed');
    expect(await reasonOf(safeFetch(`http://localhost:${port}/to-private-https`, opts))).toBe('host_not_allowed');
    expect(await reasonOf(safeFetch(`http://localhost:${port}/to-private-https`, { maxBytes: 1000, timeoutMs: 2000, allowHosts: ['localhost', '10.0.0.6'] })))
      .toBe('host_not_allowed');
  });

  it('limits redirects, size and time', async () => {
    const opts = { maxBytes: 1000, timeoutMs: 3000, allowHosts: ['localhost'] };
    expect(await reasonOf(safeFetch(`http://localhost:${port}/loop/0`, opts))).toBe('too_many_redirects');
    expect(await reasonOf(safeFetch(`http://localhost:${port}/big`, opts))).toBe('payload_too_large');
    const started = Date.now();
    expect(await reasonOf(safeFetch(`http://localhost:${port}/slow`, { ...opts, timeoutMs: 300 }))).toBe('provider_error');
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it('in production, allow-listed hosts get no http or private-address exemption', async () => {
    const prodEnv: Record<string, string> = {
      APP_ENV: 'production', APP_BASE_URL: 'https://app.example.com', SESSION_SECRET: 'x'.repeat(40),
      KEY_ENCRYPTION_KEYS: `prod-1:${Buffer.alloc(32, 3).toString('base64')}`, OIDC_ISSUER: 'https://id.example.com',
      OIDC_CLIENT_ID: 'c', OIDC_CLIENT_SECRET: 's', OIDC_ALLOW_INSECURE_HTTP: 'false', ENABLE_MOCK_PROVIDERS: 'false',
      S3_ENDPOINT: 'https://s3.example.com', S3_ACCESS_KEY_ID: 'a', S3_SECRET_ACCESS_KEY: 'b', SMTP_URL: 'smtps://mail.example.com:465',
    };
    const saved = Object.fromEntries(Object.keys(prodEnv).map((k) => [k, process.env[k]]));
    Object.assign(process.env, prodEnv);
    resetConfigCache();
    try {
      const opts = { maxBytes: 1000, timeoutMs: 2000, allowHosts: ['localhost'] };
      expect(await reasonOf(safeFetch(`http://localhost:${port}/ok`, opts))).toBe('scheme');
      expect(await reasonOf(safeFetch(`https://localhost:${port}/ok`, opts))).toBe('port');
      expect(await reasonOf(safeFetch('https://localhost/ok', opts))).toBe('private_address');
    } finally {
      for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
      testEnv();
    }
  });
});

describe('rate limiter (per process)', () => {
  it('allows a burst, then refuses until tokens refill', () => {
    let now = 1_000_000;
    const rl = new RateLimiter(() => now);
    const policy = { capacity: 3, refillPerSecond: 1 };
    expect([1, 2, 3].map(() => rl.take('ip:1', policy).allowed)).toEqual([true, true, true]);
    const denied = rl.take('ip:1', policy);
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterMs).toBe(1000);
    expect(rl.take('ip:2', policy).allowed).toBe(true); // keys are independent
    now += 1000;
    expect(rl.take('ip:1', policy).allowed).toBe(true);
    expect(rl.take('ip:1', policy).allowed).toBe(false);
    now += 60_000;
    expect([1, 2, 3, 4].map(() => rl.take('ip:1', policy).allowed)).toEqual([true, true, true, false]); // capped at capacity
  });

  it('enforceRateLimit throws 429 rate_limited with retry_after', () => {
    const key = `test-${Math.random()}`;
    const policy = { capacity: 2, refillPerSecond: 0.01 };
    enforceRateLimit('custom', key, policy);
    enforceRateLimit('custom', key, policy);
    try {
      enforceRateLimit('custom', key, policy);
      expect.unreachable();
    } catch (e) {
      expect(e).toMatchObject({ code: 'rate_limited', status: 429 });
      expect((e as { details: { retry_after_seconds: number } }).details.retry_after_seconds).toBeGreaterThan(0);
    }
  });

  it('derives the client IP from the first X-Forwarded-For hop', () => {
    expect(clientIp(new Headers({ 'x-forwarded-for': '203.0.113.9, 10.0.0.1' }))).toBe('203.0.113.9');
    expect(clientIp(new Headers())).toBe('unknown');
  });
});
