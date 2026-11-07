// Drives the local Keycloak realm (infra/keycloak/social-lite-realm.json) programmatically over real HTTP:
// authorization URL → login form(s) → redirect to our callback. Cookies are kept in a tiny jar (Keycloak marks
// them Secure; this helper talks to http://localhost directly, as browsers do for localhost).
import { createHmac } from 'node:crypto';
import { expect } from 'vitest';

export const KC_ISSUER = 'http://localhost:5556/realms/social-lite';
export const KC_ADMIN = 'http://localhost:5556/admin/realms/social-lite';
export const PASSWORD = 'socialite-demo';
export const OIDC_ENV = {
  OIDC_ISSUER: KC_ISSUER,
  OIDC_CLIENT_ID: 'social-lite-local',
  OIDC_CLIENT_SECRET: 'social-lite-local-client-secret',
  OIDC_ALLOW_INSECURE_HTTP: 'true',
};
/** Pre-seeded demo TOTP secrets (local only; Keycloak HMAC key = UTF-8 bytes of the value). */
export const DEMO_TOTP: Record<string, string> = {
  'owner@demo.social-lite.test': 'socialite-demo-totp-owner',
  'admin@demo.social-lite.test': 'socialite-demo-totp-admin',
  'publisher@demo.social-lite.test': 'socialite-demo-totp-publisher',
  'owner@other.social-lite.test': 'socialite-demo-totp-other-owner',
};

export function totp(secret: string | Buffer, at = Date.now()): string {
  const c = Buffer.alloc(8);
  c.writeBigUInt64BE(BigInt(Math.floor(at / 1000 / 30)));
  const h = createHmac('sha1', typeof secret === 'string' ? Buffer.from(secret, 'utf8') : secret).update(c).digest();
  const o = h[h.length - 1]! & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

const used = new Map<string, number>();
/** A TOTP code not yet used by this process in the current 30 s step (Keycloak rejects reuse). */
export async function freshTotp(email: string): Promise<string> {
  if (used.get(email) === Math.floor(Date.now() / 30_000)) await new Promise((r) => setTimeout(r, 30_000 - (Date.now() % 30_000) + 300));
  used.set(email, Math.floor(Date.now() / 30_000));
  return totp(DEMO_TOTP[email]!);
}

export class KcBrowser {
  private jar = new Map<string, string>();
  private cookieHeader() { return [...this.jar].map(([k, v]) => `${k}=${v}`).join('; '); }
  private store(res: Response) {
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const i = pair!.indexOf('=');
      const name = pair!.slice(0, i).trim(); const value = pair!.slice(i + 1).trim();
      if (/max-age=0|expires=thu, 01 jan 1970/i.test(c) || value === '') this.jar.delete(name); else this.jar.set(name, value);
    }
  }
  async get(url: string): Promise<Response> {
    const res = await fetch(url, { redirect: 'manual', headers: { cookie: this.cookieHeader() } });
    this.store(res);
    return res;
  }
  async post(url: string, form: Record<string, string>): Promise<Response> {
    const res = await fetch(url, { method: 'POST', redirect: 'manual', headers: { cookie: this.cookieHeader(), 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form) });
    this.store(res);
    return res;
  }

  /**
   * Follow the authorization URL, answer password/OTP prompts and return the callback query string.
   * `steps` records what Keycloak asked for.
   */
  async authorize(authorizationUrl: string, email: string, opts: { otp?: () => Promise<string> } = {}): Promise<{ params: URLSearchParams; steps: string[] }> {
    const steps: string[] = [];
    let res = await this.get(authorizationUrl);
    for (let i = 0; i < 10; i++) {
      const loc = res.headers.get('location');
      if (loc) {
        const next = new URL(loc, res.url || authorizationUrl);
        await res.arrayBuffer();
        if (next.origin === 'http://localhost:3000') {
          expect(next.pathname).toBe('/api/auth/callback');
          return { params: next.searchParams, steps };
        }
        res = await this.get(next.toString());
        continue;
      }
      const html = await res.text();
      const action = /<form[^>]*action="([^"]+)"/.exec(html)?.[1]?.replace(/&amp;/g, '&');
      if (!action) throw new Error(`Keycloak page without a form (HTTP ${res.status}): ${html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 300)}`);
      if (/name="otp"/.test(html)) {
        // A code already used in this 30 s step (e.g. by a previous test run) is refused: wait for the next step.
        if (steps[steps.length - 1] === 'otp') used.set(email, Math.floor(Date.now() / 30_000));
        else steps.push('otp');
        const code = opts.otp ? await opts.otp() : await freshTotp(email);
        res = await this.post(action, { otp: code });
      } else if (/name="password"/.test(html)) {
        steps.push('password');
        res = await this.post(action, /name="username"/.test(html) ? { username: email, password: PASSWORD } : { password: PASSWORD });
      } else {
        throw new Error(`Unexpected Keycloak page: ${html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 300)}`);
      }
    }
    throw new Error('Keycloak login did not finish');
  }
}

/** Master-realm admin token for test setup/teardown only (local Keycloak bootstrap admin). */
export async function kcMasterToken(): Promise<string> {
  const r = await fetch('http://localhost:5556/realms/master/protocol/openid-connect/token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'password', client_id: 'admin-cli', username: 'admin', password: 'socialite-kc-admin-local-only' }),
  });
  return ((await r.json()) as { access_token: string }).access_token;
}

export async function kcUserId(email: string): Promise<string> {
  const t = await kcMasterToken();
  const r = await fetch(`${KC_ADMIN}/users?exact=true&email=${encodeURIComponent(email)}`, { headers: { authorization: `Bearer ${t}` } });
  return ((await r.json()) as Array<{ id: string }>)[0]!.id;
}

/**
 * Test setup only: return a demo identity to "password only" (removes OTP/passkey/recovery credentials and any
 * brute-force lockout). Makes tests independent of factors left behind by an interrupted E2E enrolment run.
 */
export async function kcResetSecondFactors(email: string): Promise<void> {
  const t = await kcMasterToken();
  const id = await kcUserId(email);
  const h = { authorization: `Bearer ${t}` };
  const creds = (await (await fetch(`${KC_ADMIN}/users/${id}/credentials`, { headers: h })).json()) as Array<{ id: string; type: string }>;
  for (const c of creds.filter((x) => x.type !== 'password')) await fetch(`${KC_ADMIN}/users/${id}/credentials/${c.id}`, { method: 'DELETE', headers: h });
  await fetch(`${KC_ADMIN}/attack-detection/brute-force/users/${id}`, { method: 'DELETE', headers: h });
}
