// Full OIDC login flow against the local Dex provider (real HTTP), driven programmatically:
// startLogin() → Dex /auth → local login form → callback params → completeLogin().
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resetConfigCache, resolveSession, type EncryptedBlob } from '@social-lite/services';
import { createInvitation } from '../../packages/services/src/auth/invitations.js';
import { completeLogin, safeReturnTo, startLogin } from '../../packages/services/src/auth/oidc.js';
import { sha256 } from '../../packages/services/src/auth/session.js';
import { LoginError } from '../../packages/services/src/auth/users.js';
import { closeTestPool, tenant, testPool } from './helpers.js';

const DEX = 'http://localhost:5556/dex';
const PASSWORD = 'socialite-demo';
const OIDC_ENV = {
  OIDC_ISSUER: DEX,
  OIDC_CLIENT_ID: 'social-lite-local',
  OIDC_CLIENT_SECRET: 'social-lite-local-client-secret',
  OIDC_ALLOW_INSECURE_HTTP: 'true',
};
const saved: Record<string, string | undefined> = {};

beforeAll(async () => {
  testPool();
  for (const [k, v] of Object.entries(OIDC_ENV)) { saved[k] = process.env[k]; process.env[k] = v; }
  resetConfigCache();
  // Requires the local Dex from infra/compose.yaml (fails loudly when it is not running).
  expect((await fetch(`${DEX}/.well-known/openid-configuration`)).ok).toBe(true);
});
afterAll(async () => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  resetConfigCache();
  await closeTestPool();
});

/** Drive Dex's password login and return the query string Dex sends to our callback. */
async function dexLogin(authorizationUrl: string, email: string): Promise<URLSearchParams> {
  let url = authorizationUrl;
  for (let i = 0; i < 5; i++) {
    const res = await fetch(url, { redirect: 'manual' });
    const loc = res.headers.get('location');
    await res.arrayBuffer();
    if (!loc) break;
    url = new URL(loc, url).toString();
    if (url.includes('/auth/local/login')) break;
  }
  expect(url).toContain('/auth/local/login');
  const res = await fetch(url, {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ login: email, password: PASSWORD }),
  });
  await res.arrayBuffer();
  let loc = res.headers.get('location');
  expect(loc, 'Dex login should redirect').toBeTruthy();
  // With skipApprovalScreen Dex redirects to the callback directly; follow an approval hop if present.
  if (!loc!.startsWith('http://localhost:3000/')) {
    const r2 = await fetch(new URL(loc!, url), { redirect: 'manual' });
    await r2.arrayBuffer();
    loc = r2.headers.get('location');
  }
  const cb = new URL(loc!);
  expect(cb.origin + cb.pathname).toBe('http://localhost:3000/api/auth/callback');
  return cb.searchParams;
}

async function loginAs(email: string, opts: { returnTo?: string; invite?: string } = {}) {
  const start = await startLogin(opts);
  const params = await dexLogin(start.authorizationUrl, email);
  return { start, params, result: await completeLogin(params, { binding: start.binding, userAgent: 'vitest', ip: '127.0.0.1' }) };
}

async function loginError(p: Promise<unknown>): Promise<string> {
  const e = await p.then(() => null, (err: unknown) => err);
  expect(e).toBeInstanceOf(LoginError);
  return (e as LoginError).code;
}

describe('OIDC login against Dex', () => {
  it('logs in with PKCE + nonce, creates the user by (issuer, subject) and a usable session', async () => {
    const start = await startLogin({ returnTo: '/planner?view=week' });
    const authz = new URL(start.authorizationUrl);
    expect(authz.origin + authz.pathname).toBe(`${DEX}/auth`);
    expect(authz.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authz.searchParams.get('nonce')).toBeTruthy();
    const state = authz.searchParams.get('state')!;
    // Stored state: hashed, encrypted verifier, 10-minute expiry, single purpose.
    const row = (await testPool().query<{ purpose: string; code_verifier_enc: EncryptedBlob; expires_at: Date; redirect_after: string }>(
      `SELECT purpose, code_verifier_enc, expires_at, redirect_after FROM oauth_states WHERE state_hash=$1`, [sha256(state)])).rows[0]!;
    expect(row.purpose).toBe('login');
    expect(row.code_verifier_enc.aad).toBe('oauth-state');
    expect(row.redirect_after).toBe('/planner?view=week');
    const ttl = row.expires_at.getTime() - Date.now();
    expect(ttl).toBeGreaterThan(9 * 60_000);
    expect(ttl).toBeLessThanOrEqual(10 * 60_000);
    expect((await testPool().query(`SELECT 1 FROM oauth_states WHERE state_hash=$1`, [Buffer.from(state)])).rowCount).toBe(0);

    const params = await dexLogin(start.authorizationUrl, 'owner@demo.social-lite.test');
    // Wrong browser binding is refused (and does not consume a usable login for an attacker).
    expect(await loginError(completeLogin(params, { binding: 'attacker-binding' }))).toBe('invalid_state');
    // The state was consumed by that attempt: single use.
    expect(await loginError(completeLogin(params, { binding: start.binding }))).toBe('invalid_state');

    const { result } = await loginAs('owner@demo.social-lite.test', { returnTo: '/planner?view=week' });
    expect(result.redirectTo).toBe('/planner?view=week');
    const user = (await testPool().query<{ oidc_issuer: string; oidc_subject: string; email_verified: boolean }>(
      `SELECT oidc_issuer, oidc_subject, email_verified FROM users WHERE id=$1`, [result.userId])).rows[0]!;
    expect(user).toMatchObject({ oidc_issuer: DEX, email_verified: true });
    expect(user.oidc_subject).toBeTruthy();
    const resolved = await resolveSession(result.token);
    expect(resolved?.actor).toMatchObject({ userId: result.userId, email: 'owner@demo.social-lite.test' });
    const stored = (await testPool().query<{ token_hash: Buffer }>(`SELECT token_hash FROM sessions WHERE id=$1`, [result.session.id])).rows[0]!;
    expect(stored.token_hash.equals(sha256(result.token))).toBe(true);

    // Second login: same user (identified by issuer+subject).
    const again = await loginAs('owner@demo.social-lite.test');
    expect(again.result.userId).toBe(result.userId);
    expect(again.result.redirectTo).toBe('/');
  });

  it('refuses expired login states', async () => {
    const start = await startLogin({});
    const state = new URL(start.authorizationUrl).searchParams.get('state')!;
    await testPool().query(`UPDATE oauth_states SET expires_at = now() - interval '1 second' WHERE state_hash=$1`, [sha256(state)]);
    const params = await dexLogin(start.authorizationUrl, 'owner@demo.social-lite.test');
    expect(await loginError(completeLogin(params, { binding: start.binding }))).toBe('invalid_state');
  });

  it('binds a pre-provisioned (pending) user on first verified login and never re-binds', async () => {
    const db = testPool();
    const pending = (await db.query<{ id: string }>(
      `INSERT INTO users(oidc_issuer, oidc_subject, email, name) VALUES ('pending', gen_random_uuid()::text, 'admin@demo.social-lite.test', 'Seeded Admin') RETURNING id`)).rows[0]!.id;
    const { result } = await loginAs('ADMIN@demo.social-lite.test'.toLowerCase());
    expect(result.userId).toBe(pending);
    const bound = (await db.query<{ oidc_issuer: string; oidc_subject: string; name: string }>(`SELECT oidc_issuer, oidc_subject, name FROM users WHERE id=$1`, [pending])).rows[0]!;
    expect(bound.oidc_issuer).toBe(DEX);
    expect(bound.name).toBe('Seeded Admin');

    // An already-bound account with the same email but another identity is never re-bound.
    await db.query(`INSERT INTO users(oidc_issuer, oidc_subject, email, email_verified) VALUES ('https://other-idp.example', 'someone', 'editor@demo.social-lite.test', true)`);
    const start = await startLogin({});
    const params = await dexLogin(start.authorizationUrl, 'editor@demo.social-lite.test');
    expect(await loginError(completeLogin(params, { binding: start.binding }))).toBe('account_conflict');
    const still = (await db.query<{ oidc_subject: string }>(`SELECT oidc_subject FROM users WHERE email='editor@demo.social-lite.test'`)).rows[0]!;
    expect(still.oidc_subject).toBe('someone');
  });

  it('accepts an invitation during the callback when the verified email matches', async () => {
    const t = await tenant();
    const inv = await createInvitation(t.ownerCtx, { email: 'Invitee@demo.social-lite.test', role: 'editor' }, `idem-auth-${Date.now()}`);
    const token = decodeURIComponent(inv.body.accept_url!.split('/invite/')[1]!);
    const { result } = await loginAs('invitee@demo.social-lite.test', { invite: token, returnTo: '/' });
    expect(result.invitation).toEqual({ accepted: true, workspaceId: t.workspaceId });
    expect(result.session.activeWorkspaceId).toBe(t.workspaceId);
    const m = await testPool().query(`SELECT role FROM memberships WHERE workspace_id=$1 AND user_id=$2 AND removed_at IS NULL`, [t.workspaceId, result.userId]);
    expect(m.rows[0]?.role).toBe('editor');
    // The invite token is not stored in plaintext in the login state.
    const dump = JSON.stringify((await testPool().query(`SELECT * FROM oauth_states`)).rows);
    expect(dump).not.toContain(token);
  });

  it('redirects back to the invitation with an error when the email does not match', async () => {
    const t = await tenant();
    const inv = await createInvitation(t.ownerCtx, { email: 'someone-else@demo.social-lite.test', role: 'viewer' }, `idem-auth2-${Date.now()}`);
    const token = decodeURIComponent(inv.body.accept_url!.split('/invite/')[1]!);
    const { result } = await loginAs('viewer@demo.social-lite.test', { invite: token });
    expect(result.invitation).toEqual({ accepted: false, error: 'email_mismatch' });
    expect(result.redirectTo).toBe(`/invite/${encodeURIComponent(token)}?error=email_mismatch`);
    const m = await testPool().query(`SELECT 1 FROM memberships WHERE workspace_id=$1 AND user_id=$2`, [t.workspaceId, result.userId]);
    expect(m.rowCount).toBe(0);
    const open = await testPool().query(`SELECT accepted_at FROM invitations WHERE id=$1`, [inv.body.id]);
    expect(open.rows[0].accepted_at).toBeNull();
  });
});

describe('returnTo validation', () => {
  it('accepts only same-site relative paths', () => {
    expect(safeReturnTo('/posts/1?tab=a#x')).toBe('/posts/1?tab=a#x');
    for (const bad of ['//evil.example/x', 'https://evil.example/', '/\\evil.example', 'javascript:alert(1)', '/api/auth/login', '', null, 'posts', `/${'a'.repeat(600)}`, '/\nx']) {
      expect(safeReturnTo(bad as string | null), String(bad)).toBe('/');
    }
  });
});
