import { expect, type Page } from '@playwright/test';
import { createHmac, randomUUID } from 'node:crypto';

export const PASSWORD = 'socialite-demo';
export const KEYCLOAK = process.env.E2E_KEYCLOAK_URL ?? 'http://localhost:5556';

/**
 * Pre-seeded TOTP secrets of privileged demo identities (infra/keycloak/social-lite-realm.json; local only).
 * Keycloak uses the UTF-8 bytes of the stored secret value as the HMAC key.
 */
export const DEMO_TOTP: Record<string, string> = {
  'owner@demo.social-lite.test': 'socialite-demo-totp-owner',
  'admin@demo.social-lite.test': 'socialite-demo-totp-admin',
  'publisher@demo.social-lite.test': 'socialite-demo-totp-publisher',
  'owner@other.social-lite.test': 'socialite-demo-totp-other-owner',
};

/** RFC 6238 TOTP (SHA-1, 6 digits, 30 s) — test helper only. */
export function totp(key: Buffer, at = Date.now()): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 1000 / 30)));
  const h = createHmac('sha1', key).update(counter).digest();
  const o = h[h.length - 1]! & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

export function base32Decode(s: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0; let value = 0; const out: number[] = [];
  for (const c of s.replace(/[\s=]/g, '').toUpperCase()) {
    value = (value << 5) | alphabet.indexOf(c); bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

// Keycloak refuses a TOTP code that was already used in the same time step: wait for a fresh one.
const lastCode = new Map<string, number>();
export async function freshTotp(key: Buffer, id: string): Promise<string> {
  const step = Math.floor(Date.now() / 30_000);
  if (lastCode.get(id) === step) await new Promise((r) => setTimeout(r, 30_000 - (Date.now() % 30_000) + 300));
  lastCode.set(id, Math.floor(Date.now() / 30_000));
  return totp(key);
}

/** Complete whatever Keycloak asks for (password, then a TOTP code for users with a second factor). */
export async function completeKeycloak(page: Page, email: string, opts: { totpKey?: Buffer } = {}): Promise<void> {
  const key = opts.totpKey ?? (DEMO_TOTP[email] ? Buffer.from(DEMO_TOTP[email]!, 'utf8') : undefined);
  for (let i = 0; i < 4; i++) {
    await page.waitForLoadState();
    const url = new URL(page.url());
    if (url.port !== '5556') return;
    const otp = page.locator('input[name=otp]');
    const pwd = page.locator('input[name=password]');
    await expect(otp.or(pwd).first()).toBeVisible({ timeout: 20_000 });
    if (await otp.isVisible()) {
      if (!key) throw new Error(`Keycloak asked ${email} for a one-time code but no TOTP secret is known`);
      await otp.fill(await freshTotp(key, email));
      await page.locator('#kc-login, [type=submit]').first().click();
    } else {
      const user = page.locator('input[name=username]');
      if (await user.isVisible().catch(() => false) && await user.isEditable().catch(() => false)) await user.fill(email);
      await pwd.fill(PASSWORD);
      await page.locator('#kc-login, [type=submit]').first().click();
    }
    await page.waitForURL((u) => u.port !== '5556' || u.pathname !== url.pathname || u.search !== url.search, { timeout: 30_000 }).catch(() => undefined);
  }
}

/** Real OIDC sign-in through the local Keycloak realm (password, then TOTP for privileged demo users). */
export async function signIn(page: Page, email: string, opts: { totpKey?: Buffer } = {}): Promise<void> {
  await page.goto('/overview'); // V5: `/` is the public marketing page; the app home is /overview
  await page.waitForURL(/\/login/);
  await page.locator('a[href^="/api/auth/login"]').first().click();
  await page.waitForURL(/localhost:5556/);
  await completeKeycloak(page, email, opts);
  await page.waitForURL((u) => u.port === '3000' && !u.pathname.startsWith('/login') && !u.pathname.startsWith('/api/auth'), { timeout: 45_000 });
  await useE2EWorkspace(page);
}

/** Playwright works in its own workspace (scripts/seed-e2e.ts) so its fixtures never land in Demo Workspace (V3 §2.7). */
export const E2E_WORKSPACE = process.env.E2E_WORKSPACE ?? 'E2E Workspace';

/** Switch the signed-in session to the E2E workspace when the user belongs to it (others, e.g. outsider@, stay put). */
export async function useE2EWorkspace(page: Page): Promise<void> {
  const res = await page.request.get('/api/session');
  if (!res.ok()) return;
  const s = await res.json() as { csrf_token: string; workspace: { id: string } | null; workspaces: Array<{ id: string; name: string }> };
  const target = s.workspaces?.find((w) => w.name === E2E_WORKSPACE);
  if (!target || s.workspace?.id === target.id) return;
  // Leave the app page first: its polling would notice the workspace change and reload itself, racing our navigation.
  await page.goto('/api/session');
  const r = await page.request.post('/api/session/workspace', {
    headers: { 'content-type': 'application/json', origin: new URL(page.url()).origin, 'x-csrf-token': s.csrf_token, 'idempotency-key': randomUUID() },
    data: JSON.stringify({ workspace_id: target.id }),
  });
  expect(r.status(), 'switch to the E2E workspace').toBeLessThan(300);
  await page.goto('/overview');
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
