// Content-Security-Policy and security headers (apps/web/lib/csp.ts, apps/web/next.config.ts, apps/web/proxy.ts).
// The browser-level check (no violations during sign-in, composer, presigned upload, sign-out) is tests/e2e/security.spec.ts.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildCsp, originOf } from '../../apps/web/lib/csp.js';

const directives = (csp: string) => Object.fromEntries(csp.split('; ').map((d) => { const [k, ...v] = d.split(' '); return [k!, v.join(' ')]; }));

describe('page CSP', () => {
  const storage = ['http://localhost:8333', 'https://cdn.example.com'];
  it('is nonce-based with strict-dynamic, no inline script, no framing, and allows the storage origin for uploads/previews', () => {
    const d = directives(buildCsp('abc123', { dev: false, production: true, storageOrigins: storage }));
    expect(d['script-src']).toBe("'self' 'nonce-abc123' 'strict-dynamic'");
    expect(d['frame-ancestors']).toBe("'none'");
    expect(d['object-src']).toBe("'none'");
    expect(d['base-uri']).toBe("'self'");
    expect(d['form-action']).toBe("'self'");
    expect(d['connect-src']).toBe("'self' http://localhost:8333 https://cdn.example.com");
    expect(d['img-src']).toContain('https://cdn.example.com');
    expect(d['media-src']).toContain('https://cdn.example.com');
    expect('upgrade-insecure-requests' in d).toBe(true);
  });
  it('development adds only what the dev server needs (eval for React refresh, websockets for HMR)', () => {
    const d = directives(buildCsp('n', { dev: true, production: false, storageOrigins: [] }));
    expect(d['script-src']).toBe("'self' 'nonce-n' 'strict-dynamic' 'unsafe-eval'");
    expect(d['connect-src']).toBe("'self' ws: wss:");
    expect('upgrade-insecure-requests' in d).toBe(false);
  });
  it('dedupes and ignores invalid storage origins', () => {
    expect(originOf('http://localhost:8333/bucket/key?x=1')).toBe('http://localhost:8333');
    expect(originOf('not a url')).toBe('');
    expect(originOf(undefined)).toBe('');
    const d = directives(buildCsp('n', { dev: false, production: false, storageOrigins: ['http://a.test', 'http://a.test', ''] }));
    expect(d['connect-src']).toBe("'self' http://a.test");
  });
});

describe('response headers (next.config.ts)', () => {
  const saved = process.env.APP_ENV;
  afterEach(() => { if (saved === undefined) delete process.env.APP_ENV; else process.env.APP_ENV = saved; });
  const CONFIG = '../../apps/web/next.config.ts';
  async function headers(appEnv: string) {
    process.env.APP_ENV = appEnv;
    vi.resetModules();
    const cfg = (await import(/* @vite-ignore */ CONFIG)).default as { headers: () => Promise<Array<{ source: string; headers: Array<{ key: string; value: string }> }>> };
    const all = await cfg.headers();
    const of = (source: string) => Object.fromEntries(all.find((r) => r.source === source)!.headers.map((h) => [h.key, h.value]));
    return { page: of('/:path*'), api: of('/api/:path*') };
  }
  it('production: HSTS, no framing, nosniff, referrer and permissions policy; API responses forbid everything', async () => {
    const h = await headers('production');
    expect(h.page['Strict-Transport-Security']).toBe('max-age=63072000; includeSubDomains');
    expect(h.page['X-Frame-Options']).toBe('DENY');
    expect(h.page['X-Content-Type-Options']).toBe('nosniff');
    expect(h.page['Referrer-Policy']).toBe('strict-origin-when-cross-origin');
    expect(h.page['Permissions-Policy']).toMatch(/camera=\(\).*microphone=\(\).*geolocation=\(\)/);
    expect(h.api['Content-Security-Policy']).toBe("default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
  });
  it('never sends HSTS on local http', async () => {
    expect((await headers('development')).page['Strict-Transport-Security']).toBeUndefined();
  });
  it('Content Hub Google Picker origins are opt-in and limited to Google picker/identity hosts', () => {
    const d = directives(buildCsp('n', { dev: false, production: true, storageOrigins: [], googlePicker: true }));
    expect(d['frame-src']).toBe('https://docs.google.com https://accounts.google.com https://content.googleapis.com');
    expect(d['connect-src']).toContain('https://www.googleapis.com');
    expect(d['frame-ancestors']).toBe("'none'");
    expect(directives(buildCsp('n', { dev: false, production: true, storageOrigins: [] }))['frame-src']).toBe("'none'");
  });
});
