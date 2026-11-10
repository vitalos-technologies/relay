// D34 passwordless sign-in against the real local Keycloak image (infra/keycloak: keycloak-magic-link + relay-auth + theme):
// one email with a single-use link AND a 6-digit code; wrong codes; unknown emails; no password anywhere.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { KC_ADMIN, KC_ISSUER, KcBrowser, kcMasterToken } from './keycloak.js';
import { MAILPIT, waitForSignInEmail } from '../support/mailpit.js';

const CALLBACK = 'http://localhost:3000/api/auth/callback';
function authUrl(extra: Record<string, string> = {}): string {
  const u = new URL(`${KC_ISSUER}/protocol/openid-connect/auth`);
  u.search = new URLSearchParams({ client_id: 'social-lite-local', redirect_uri: CALLBACK, response_type: 'code', scope: 'openid email profile',
    state: randomUUID(), nonce: randomUUID(), code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM', code_challenge_method: 'S256', ...extra }).toString();
  return u.toString();
}
const formAction = (html: string) => /<form[^>]*action="([^"]+)"/.exec(html)![1]!.replace(/&amp;/g, '&');
const fieldError = (html: string) => /id="input-error-code"[^>]*>([\s\S]*?)<\/p>/.exec(html)?.[1]?.trim() ?? null;

/** POST a form and follow Keycloak's redirect-after-post back to the page. */
async function submit(b: KcBrowser, html: string, form: Record<string, string>): Promise<{ status: number; html: string; location: string | null }> {
  let res = await b.post(formAction(html), form);
  if (res.status === 302) {
    const loc = res.headers.get('location')!;
    if (loc.startsWith(CALLBACK)) return { status: 302, html: '', location: loc };
    res = await b.get(new URL(loc, KC_ISSUER).toString());
  }
  return { status: res.status, html: await res.text(), location: res.headers.get('location') };
}

async function startEmail(email: string, extra: Record<string, string> = {}) {
  const b = new KcBrowser();
  const page = await (await b.get(authUrl(extra))).text();
  const since = Date.now();
  const sent = await submit(b, page, { username: email });
  return { b, page, sent, since };
}

async function setRegistration(on: boolean) {
  const t = await kcMasterToken();
  await fetch(KC_ADMIN, { method: 'PUT', headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' }, body: JSON.stringify({ registrationAllowed: on }) });
}

async function clearLockout(email: string) {
  const t = await kcMasterToken();
  const id = ((await (await fetch(`${KC_ADMIN}/users?exact=true&email=${encodeURIComponent(email)}`, { headers: { authorization: `Bearer ${t}` } })).json()) as Array<{ id: string }>)[0]!.id;
  await fetch(`${KC_ADMIN}/attack-detection/brute-force/users/${id}`, { method: 'DELETE', headers: { authorization: `Bearer ${t}` } });
}

beforeAll(async () => {
  expect((await fetch(`${KC_ISSUER}/.well-known/openid-configuration`)).ok).toBe(true);
  expect((await fetch(`${MAILPIT}/api/v1/info`)).ok).toBe(true);
});
afterAll(async () => { await setRegistration(true); });

describe('passwordless sign-in (Keycloak, D34)', () => {
  it('the sign-in page has Google-ready layout and an email field, never a password field; sign-up mode changes the heading', async () => {
    const b = new KcBrowser();
    const html = await (await b.get(authUrl())).text();
    expect(html).toContain('Sign in to Relay');
    expect(html).toContain('name="username"');
    expect(html).toContain('Continue with email');
    expect(html).not.toMatch(/type="password"|name="password"/);
    const signup = await (await new KcBrowser().get(authUrl({ relay_mode: 'signup' }))).text();
    expect(signup).toContain('Create your Relay account');
  });

  it('sends ONE email with a single-use link and a 6-digit code; the code signs in', async () => {
    const email = 'viewer@demo.social-lite.test';
    const { b, sent, since } = await startEmail(email);
    expect(sent.html).toContain('Check your email');
    const mail = await waitForSignInEmail(email, since);
    expect(mail.code).toMatch(/^\d{6}$/);
    expect(mail.subject).toContain(mail.code);
    expect(mail.html).toContain('Sign in to Relay');
    expect(mail.html).toContain(mail.link.replace(/&/g, '&amp;'));
    const all = (await (await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${email}"`)}`)).json()) as { messages: Array<{ Created: string }> };
    expect(all.messages.filter((m) => Date.parse(m.Created) >= since - 1000)).toHaveLength(1);
    const done = await submit(b, sent.html, { code: mail.code });
    expect(done.location).toMatch(/^http:\/\/localhost:3000\/api\/auth\/callback\?.*code=/);
  });

  it('the link signs the clicking browser in once; a second use is refused', async () => {
    const email = 'approver@demo.social-lite.test';
    const { since } = await startEmail(email);
    const mail = await waitForSignInEmail(email, since);
    const other = new KcBrowser();
    let res = await other.get(mail.link);
    for (let i = 0; i < 4 && res.status === 302 && !res.headers.get('location')!.startsWith(CALLBACK); i++) res = await other.get(new URL(res.headers.get('location')!, KC_ISSUER).toString());
    expect(res.headers.get('location')).toMatch(/^http:\/\/localhost:3000\/api\/auth\/callback\?.*code=/);
    const again = await new KcBrowser().get(mail.link);
    expect(again.status).toBe(400);
    expect(await again.text()).toMatch(/expired/);
  });

  it('wrong codes: five tries, then a new code is needed; the old code no longer works', async () => {
    const email = 'guest@demo.social-lite.test';
    await clearLockout(email);
    const { b, sent, since } = await startEmail(email);
    const mail = await waitForSignInEmail(email, since);
    let page = sent.html;
    const seen: Array<string | null> = [];
    for (let i = 0; i < 5; i++) {
      await new Promise((x) => setTimeout(x, 1_200)); // faster than 1 s per try trips Keycloak's quick-login lockout
      const r = await submit(b, page, { code: mail.code === '000000' ? '111111' : '000000' });
      page = r.html; seen.push(fieldError(page) ?? `status=${r.status} loc=${r.location}`);
    }
    expect(seen.slice(0, 4)).toEqual(Array(4).fill(expect.stringMatching(/isn’t right/)));
    expect(seen[4]).toMatch(/Too many tries/);
    await new Promise((x) => setTimeout(x, 1_200));
    const late = await submit(b, page, { code: mail.code });
    expect(late.location).toBeNull();
    expect(fieldError(late.html)).toMatch(/expired/);
    await clearLockout(email); // the wrong codes counted towards the realm's brute-force protection
  });

  it('unknown email with self-registration off: same page and same answers, nothing sent, no account created', async () => {
    await setRegistration(false);
    try {
      const email = `nobody-${randomUUID().slice(0, 8)}@demo.social-lite.test`;
      const { b, sent } = await startEmail(email);
      expect(sent.html).toContain('Check your email');
      expect(sent.html).toContain('has a Relay account, we sent it');
      const r = await submit(b, sent.html, { code: '123456' });
      expect(fieldError(r.html)).toMatch(/isn’t right/);
      await new Promise((x) => setTimeout(x, 1500));
      const m = (await (await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${email}"`)}`)).json()) as { messages_count: number };
      expect(m.messages_count).toBe(0);
      const t = await kcMasterToken();
      const users = (await (await fetch(`${KC_ADMIN}/users?exact=true&email=${encodeURIComponent(email)}`, { headers: { authorization: `Bearer ${t}` } })).json()) as unknown[];
      expect(users).toHaveLength(0);
    } finally {
      await setRegistration(true);
    }
  });

  it('new email with self-registration on: the account is created and verified by the code', async () => {
    const email = `new-${randomUUID().slice(0, 8)}@test.social-lite.test`;
    const { b, sent, since } = await startEmail(email);
    expect(sent.html).toContain('We sent a sign-in link and a 6-digit code to');
    const mail = await waitForSignInEmail(email, since);
    const done = await submit(b, sent.html, { code: mail.code });
    expect(done.location).toMatch(/code=/);
    const t = await kcMasterToken();
    const u = ((await (await fetch(`${KC_ADMIN}/users?exact=true&email=${encodeURIComponent(email)}`, { headers: { authorization: `Bearer ${t}` } })).json()) as Array<{ id: string; emailVerified: boolean }>)[0]!;
    expect(u.emailVerified).toBe(true);
    const creds = (await (await fetch(`${KC_ADMIN}/users/${u.id}/credentials`, { headers: { authorization: `Bearer ${t}` } })).json()) as unknown[];
    expect(creds).toHaveLength(0); // no password, ever
    await fetch(`${KC_ADMIN}/users/${u.id}`, { method: 'DELETE', headers: { authorization: `Bearer ${t}` } });
  });
});
