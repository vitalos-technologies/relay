import { expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';

export const PASSWORD = 'socialite-demo';

/** Real OIDC sign-in through the local Dex provider. */
export async function signIn(page: Page, email: string): Promise<void> {
  await page.goto('/');
  await page.waitForURL(/\/login/);
  await page.locator('a[href^="/api/auth/login"]').first().click();
  await page.waitForURL(/localhost:5556/);
  await page.fill('input[name=login]', email);
  await page.fill('input[name=password]', PASSWORD);
  await page.click('button[type=submit]');
  await page.waitForURL((u) => u.port === '3000' && !u.pathname.startsWith('/login') && !u.pathname.startsWith('/api/auth'), { timeout: 45_000 });
}

export interface Api {
  get<T = any>(path: string): Promise<{ status: number; body: T }>;
  send<T = any>(method: string, path: string, body?: unknown, opts?: { idem?: string; csrf?: boolean }): Promise<{ status: number; body: T }>;
}

/** API calls from inside the signed-in browser context (same cookie, CSRF token, Origin). */
export async function api(page: Page): Promise<Api> {
  const session = await page.request.get('/api/session');
  expect(session.status()).toBe(200);
  const csrf = (await session.json()).csrf_token as string;
  const origin = new URL(page.url()).origin;
  return {
    async get(path) { const r = await page.request.get(path); return { status: r.status(), body: await r.json().catch(() => null) }; },
    async send(method, path, body, opts = {}) {
      const headers: Record<string, string> = { 'content-type': 'application/json', origin };
      if (opts.csrf !== false) headers['x-csrf-token'] = csrf;
      headers['idempotency-key'] = opts.idem ?? randomUUID();
      const r = await page.request.fetch(path, { method, headers, data: body === undefined ? undefined : JSON.stringify(body) });
      return { status: r.status(), body: await r.json().catch(() => null) };
    },
  };
}

export async function demoBrand(a: Api, name: RegExp) {
  const s = await a.get('/api/session');
  return s.body.brands.find((b: { name: string }) => name.test(b.name));
}
