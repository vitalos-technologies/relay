import { expect, type Page } from '@playwright/test';
import { createHmac, randomUUID } from 'node:crypto';
import { waitForSignInEmail } from '../support/mailpit';

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

/**
 * Complete whatever the sign-in server asks for (D34, passwordless): the email page (types the address), "Check your email"
 * (reads the 6-digit code from the sign-in email in Mailpit and types it), then a TOTP code when a second factor is asked
 * (privileged demo users / step-up). Returns when the browser has left Keycloak.
 */
export async function completeKeycloak(page: Page, email: string, opts: { totpKey?: Buffer; viaLink?: boolean } = {}): Promise<void> {
  const key = opts.totpKey ?? (DEMO_TOTP[email] ? Buffer.from(DEMO_TOTP[email]!, 'utf8') : undefined);
  let requestedAt = Date.now();
  for (let i = 0; i < 6; i++) {
    await page.waitForLoadState();
    const url = new URL(page.url());
    if (url.port !== '5556') return;
    const otp = page.locator('input[name=otp]');
    const code = page.locator('input[name=code]');
    const user = page.locator('input[name=username]');
    await expect(otp.or(code).or(user).first()).toBeVisible({ timeout: 20_000 });
    if (await otp.isVisible()) {
      if (!key) throw new Error(`Keycloak asked ${email} for a one-time code but no TOTP secret is known`);
      await otp.fill(await freshTotp(key, email));
      await page.locator('#kc-login').click();
    } else if (await code.isVisible()) {
      const mail = await waitForSignInEmail(email, requestedAt);
      if (opts.viaLink) { await page.goto(mail.link); }
      else { await code.fill(mail.code); await page.locator('#relay-verify').click(); }
    } else {
      requestedAt = Date.now();
      await user.fill(email);
      await page.locator('#kc-login').click();
    }
    await page.waitForURL((u) => u.port !== '5556' || u.pathname !== url.pathname || u.search !== url.search, { timeout: 30_000 }).catch(() => undefined);
  }
}

/**
 * Real OIDC sign-in through the local Keycloak realm: email → code from Mailpit (D34). Customers are not asked for a second
 * factor at sign-in; demo users with a known authenticator app then verify it once (step-up, `mfa` mode) so the suite keeps
 * running sensitive actions in an MFA-verified session as before. `mfa: false` keeps the plain email sign-in.
 */
export async function signIn(page: Page, email: string, opts: { totpKey?: Buffer; mfa?: boolean } = {}): Promise<void> {
  await page.goto('/overview'); // V5: `/` is the public marketing page; the app home is /overview
  // /login forwards straight to the sign-in page (an IdP session that is still alive may bring the browser straight back).
  await expect.poll(async () => {
    const u = new URL(page.url());
    if (u.port === '5556') return true;
    if (u.pathname.startsWith('/login') || u.pathname.startsWith('/api/auth')) return false;
    return (await page.request.get('/api/session')).ok();
  }, { timeout: 45_000 }).toBe(true);
  await completeKeycloak(page, email, opts);
  await page.waitForURL((u) => u.port !== '5556' && !u.pathname.startsWith('/login') && !u.pathname.startsWith('/api/auth'), { timeout: 45_000 });
  const key = opts.totpKey ?? (DEMO_TOTP[email] ? Buffer.from(DEMO_TOTP[email]!, 'utf8') : undefined);
  if (key && opts.mfa !== false) await verifySecondFactor(page, email, key);
  await useE2EWorkspace(page);
}

/** Step-up to an MFA-verified session (the authenticator-app code only; no new email). */
export async function verifySecondFactor(page: Page, email: string, key?: Buffer): Promise<void> {
  const s = await page.request.get('/api/session');
  if (s.ok() && (await s.json() as { v2?: { mfa_verified?: boolean } }).v2?.mfa_verified) return;
  await page.goto('/api/auth/step-up?mode=mfa&returnTo=%2Foverview');
  if (new URL(page.url()).port === '5556') await completeKeycloak(page, email, { totpKey: key });
  await page.waitForURL((u) => u.port !== '5556' && !u.pathname.startsWith('/api/auth'), { timeout: 45_000 });
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
