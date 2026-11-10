// Full OIDC login flow against the local Keycloak realm (real HTTP), driven programmatically:
// startLogin() → Keycloak /auth → login form(s) → callback params → completeLogin().
// Also: assurance (acr/amr/auth_time) from the verified ID token, step-up bound to the current session,
// token rotation, subject-mismatch refusal and back-channel logout against the real IdP.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resetConfigCache, resolveSession, type EncryptedBlob } from '@social-lite/services';
import { createInvitation } from '../../packages/services/src/auth/invitations.js';
import { completeLogin, safeReturnTo, startIdpAction, startLogin, startStepUp } from '../../packages/services/src/auth/oidc.js';
import { sha256, type SessionRecord } from '../../packages/services/src/auth/session.js';
import { LoginError } from '../../packages/services/src/auth/users.js';
import { resetIdpAdminCache } from '../../packages/services/src/auth/idp-admin.js';
import { closeTestPool, tenant, testPool } from './helpers.js';
import { KC_ISSUER, KcBrowser, OIDC_ENV, kcResetSecondFactors } from './keycloak.js';

const saved: Record<string, string | undefined> = {};

beforeAll(async () => {
  testPool();
  for (const [k, v] of Object.entries(OIDC_ENV)) { saved[k] = process.env[k]; process.env[k] = v; }
  resetConfigCache();
  resetIdpAdminCache();
  // Requires the local Keycloak from infra/compose.yaml (fails loudly when it is not running).
  expect((await fetch(`${KC_ISSUER}/.well-known/openid-configuration`)).ok).toBe(true);
  // analyst@ is the "email sign-in only" fixture; an interrupted E2E enrolment run may have left factors behind.
  await kcResetSecondFactors('analyst@demo.social-lite.test');
});
afterAll(async () => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  resetConfigCache();
  await closeTestPool();
});

/** Drive Keycloak's login and return the query string it sends to our callback. */
async function kcLogin(authorizationUrl: string, email: string, browser = new KcBrowser()): Promise<URLSearchParams> {
  return (await browser.authorize(authorizationUrl, email)).params;
}

async function loginAs(email: string, opts: { returnTo?: string; invite?: string; browser?: KcBrowser } = {}) {
  const start = await startLogin(opts);
  const params = await kcLogin(start.authorizationUrl, email, opts.browser);
  return { start, params, result: await completeLogin(params, { binding: start.binding, userAgent: 'vitest', ip: '127.0.0.1' }) };
}

async function loginError(p: Promise<unknown>): Promise<string> {
  const e = await p.then(() => null, (err: unknown) => err);
  expect(e).toBeInstanceOf(LoginError);
  return (e as LoginError).code;
}

describe('OIDC login against Keycloak', () => {
  it('logs in with PKCE + nonce, creates the user by (issuer, subject) and a usable session', async () => {
    const start = await startLogin({ returnTo: '/planner?view=week' });
    const authz = new URL(start.authorizationUrl);
    expect(authz.origin + authz.pathname).toBe(`${KC_ISSUER}/protocol/openid-connect/auth`);
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

    const params = await kcLogin(start.authorizationUrl, 'owner@demo.social-lite.test');
    // Wrong browser binding is refused (and does not consume a usable login for an attacker).
    expect(await loginError(completeLogin(params, { binding: 'attacker-binding' }))).toBe('invalid_state');
    // The state was consumed by that attempt: single use.
    expect(await loginError(completeLogin(params, { binding: start.binding }))).toBe('invalid_state');

    const { result } = await loginAs('owner@demo.social-lite.test', { returnTo: '/planner?view=week' });
    expect(result.redirectTo).toBe('/planner?view=week');
    const user = (await testPool().query<{ oidc_issuer: string; oidc_subject: string; email_verified: boolean }>(
      `SELECT oidc_issuer, oidc_subject, email_verified FROM users WHERE id=$1`, [result.userId])).rows[0]!;
    expect(user).toMatchObject({ oidc_issuer: KC_ISSUER, email_verified: true });
    expect(user.oidc_subject).toBeTruthy();
    const resolved = await resolveSession(result.token);
    expect(resolved?.actor).toMatchObject({ userId: result.userId, email: 'owner@demo.social-lite.test' });
    const stored = (await testPool().query<{ token_hash: Buffer }>(`SELECT token_hash FROM sessions WHERE id=$1`, [result.session.id])).rows[0]!;
    expect(stored.token_hash.equals(sha256(result.token))).toBe(true);

    // Second login: same user (identified by issuer+subject).
    const again = await loginAs('owner@demo.social-lite.test');
    expect(again.result.userId).toBe(result.userId);
    expect(again.result.redirectTo).toBe('/overview'); // V5 (D23): default post-login destination
  });

  it('refuses expired login states', async () => {
    const start = await startLogin({});
    const state = new URL(start.authorizationUrl).searchParams.get('state')!;
    await testPool().query(`UPDATE oauth_states SET expires_at = now() - interval '1 second' WHERE state_hash=$1`, [sha256(state)]);
    const params = await kcLogin(start.authorizationUrl, 'owner@demo.social-lite.test');
    expect(await loginError(completeLogin(params, { binding: start.binding }))).toBe('invalid_state');
  });

  it('binds a pre-provisioned (pending) user on first verified login and never re-binds', async () => {
    const db = testPool();
    const pending = (await db.query<{ id: string }>(
      `INSERT INTO users(oidc_issuer, oidc_subject, email, name) VALUES ('pending', gen_random_uuid()::text, 'admin@demo.social-lite.test', 'Seeded Admin') RETURNING id`)).rows[0]!.id;
    const { result } = await loginAs('ADMIN@demo.social-lite.test'.toLowerCase());
    expect(result.userId).toBe(pending);
    const bound = (await db.query<{ oidc_issuer: string; oidc_subject: string; name: string }>(`SELECT oidc_issuer, oidc_subject, name FROM users WHERE id=$1`, [pending])).rows[0]!;
    expect(bound.oidc_issuer).toBe(KC_ISSUER);
    expect(bound.name).toBe('Seeded Admin');

    // An already-bound account with the same email but another identity is never re-bound.
    await db.query(`INSERT INTO users(oidc_issuer, oidc_subject, email, email_verified) VALUES ('https://other-idp.example', 'someone', 'editor@demo.social-lite.test', true)`);
    const start = await startLogin({});
    const params = await kcLogin(start.authorizationUrl, 'editor@demo.social-lite.test');
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
    expect((result.session as SessionRecord).activeWorkspaceId).toBe(t.workspaceId);
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

describe('assurance, step-up and session rotation (real Keycloak)', () => {
  const asSession = (r: { session: unknown }) => r.session as SessionRecord;
  const sessionRow = async (id: string) => (await testPool().query<{ acr: string | null; amr: string[]; mfa_verified: boolean; auth_time: Date | null; idp_session_id: string | null; idp_subject: string | null; revoked_at: Date | null }>(
    `SELECT acr, amr, mfa_verified, auth_time, idp_session_id, idp_subject, revoked_at FROM sessions WHERE id=$1`, [id])).rows[0]!;

  it('email sign-in (D34) records acr/amr/auth_time/sid from the verified ID token; customers are not asked for the second factor, staff are', { timeout: 120_000 }, async () => {
    const browser = new KcBrowser();
    const { result } = await loginAs('owner@demo.social-lite.test', { browser, returnTo: '/planner' });
    const s = await sessionRow(result.session.id);
    expect(s).toMatchObject({ acr: 'password', amr: ['email'], mfa_verified: false }); // LoA 1 (acr label kept) = email sign-in
    expect(s.idp_session_id).toBeTruthy();
    expect(s.idp_subject).toBeTruthy();
    expect(Math.abs(s.auth_time!.getTime() - Date.now())).toBeLessThan(60_000);
    // The owner has an authenticator app, but ordinary customer sign-in does not ask for it.
    expect(result.needsSecondFactor).toBe(false);
    // Relay staff (a platform operator row) are asked right after sign-in.
    await testPool().query(`INSERT INTO platform_operators(user_id, role, granted_via) VALUES ($1, 'support', 'cli') ON CONFLICT (user_id) DO UPDATE SET revoked_at = NULL`, [result.userId]);
    try {
      const staff = await loginAs('owner@demo.social-lite.test', { browser: new KcBrowser() });
      expect(staff.result.needsSecondFactor).toBe(true);
    } finally {
      await testPool().query(`UPDATE platform_operators SET revoked_at = now() WHERE user_id = $1`, [result.userId]);
    }

    // Second-factor hop on the same IdP session: only the TOTP code is asked; same app session, rotated token.
    const hop = await startStepUp(asSession(result), { returnTo: '/planner', mode: 'mfa' });
    if ('setupRequired' in hop) throw new Error('expected a step-up');
    expect(new URL(hop.authorizationUrl).searchParams.get('acr_values')).toBe('mfa');
    const { params, steps } = await browser.authorize(hop.authorizationUrl, 'owner@demo.social-lite.test');
    expect(steps).toEqual(['otp']);
    const done = await completeLogin(params, { binding: hop.binding, currentSession: asSession(result) });
    expect(done.purpose).toBe('step_up');
    expect(done.redirectTo).toBe('/planner?verified=1');
    expect(await sessionRow(result.session.id)).toMatchObject({ acr: 'mfa', amr: ['email', 'otp'], mfa_verified: true, revoked_at: null });
    expect(await resolveSession(result.token)).toBeNull(); // old cookie value stops working
    const now = await resolveSession(done.token);
    expect(now?.session).toMatchObject({ id: result.session.id, mfaVerified: true, acr: 'mfa' });

    // A user without a second factor never gets the hop.
    const analyst = await loginAs('analyst@demo.social-lite.test');
    expect(analyst.result.needsSecondFactor).toBe(false);
    expect(await startStepUp(asSession(analyst.result), {})).toEqual({ setupRequired: true });
  });

  it('fresh step-up (acr_values=mfa) asks only the second factor, refreshes auth_time and binds to the same subject + session', { timeout: 120_000 }, async () => {
    const browser = new KcBrowser();
    const { result } = await loginAs('admin@demo.social-lite.test', { browser });
    await testPool().query(`UPDATE sessions SET auth_time = now() - interval '2 hours' WHERE id=$1`, [result.session.id]);
    const before = await resolveSession(result.token);
    const up = await startStepUp(before!.session, { returnTo: '/settings' });
    if ('setupRequired' in up) throw new Error('expected a step-up');
    const q = new URL(up.authorizationUrl).searchParams;
    expect(q.get('max_age')).toBeNull();
    expect(q.get('prompt')).toBeNull();
    expect(q.get('acr_values')).toBe('mfa');
    const { params, steps } = await browser.authorize(up.authorizationUrl, 'admin@demo.social-lite.test');
    expect(steps).toEqual(['otp']); // LoA 2 always re-asks the code (loa-max-age 0); no second email round trip
    // Completing from another session is refused (and the state is single-use).
    const other = await loginAs('viewer@demo.social-lite.test');
    expect(await loginError(completeLogin(params, { binding: up.binding, currentSession: asSession(other.result) }))).toBe('session_mismatch');

    const up2 = await startStepUp(before!.session, { returnTo: '/settings' });
    if ('setupRequired' in up2) throw new Error('expected a step-up');
    const r2 = await browser.authorize(up2.authorizationUrl, 'admin@demo.social-lite.test');
    const done = await completeLogin(r2.params, { binding: up2.binding, currentSession: before!.session });
    const s = await sessionRow(result.session.id);
    expect(s.mfa_verified).toBe(true);
    expect(Date.now() - s.auth_time!.getTime()).toBeLessThan(60_000);
    expect((await resolveSession(done.token))?.session.authTime?.getTime()).toBe(s.auth_time!.getTime());
  });

  it('a step-up for someone without a second factor enrols an authenticator app, and that counts as a fresh verification', { timeout: 120_000 }, async () => {
    await kcResetSecondFactors('analyst@demo.social-lite.test');
    const browser = new KcBrowser();
    const { result } = await loginAs('analyst@demo.social-lite.test', { browser });
    const session = asSession(result);
    expect(await startStepUp(session, {})).toEqual({ setupRequired: true });
    try {
      const enrol = await startIdpAction(session, 'CONFIGURE_TOTP', { returnTo: '/settings/workspace/billing' });
      const { params, steps } = await browser.authorize(enrol.authorizationUrl, 'analyst@demo.social-lite.test');
      expect(steps).toEqual(['configure_totp']);
      const done = await completeLogin(params, { binding: enrol.binding, currentSession: session });
      expect(done.redirectTo).toBe('/settings/workspace/billing?verified=1');
      const s = await sessionRow(session.id);
      expect(s.mfa_verified).toBe(true);
      expect(Date.now() - s.auth_time!.getTime()).toBeLessThan(60_000);
      const a = await testPool().query(`SELECT diff FROM audit_events WHERE action='auth.factor_action' AND resource_id=$1 ORDER BY created_at DESC LIMIT 1`, [session.id]);
      expect(a.rows[0]?.diff).toMatchObject({ action: 'CONFIGURE_TOTP', mfa: true, method: 'totp_enrolment' });
    } finally {
      await kcResetSecondFactors('analyst@demo.social-lite.test');
    }
  });

  it('refuses a step-up completed by a different identity', { timeout: 120_000 }, async () => {
    const analyst = await loginAs('analyst@demo.social-lite.test');
    // Pretend the analyst has a second factor so a step-up starts, then authenticate as the publisher instead.
    const session = { ...asSession(analyst.result), idpSubject: null };
    const up = await startStepUp(session, {});
    if ('setupRequired' in up) throw new Error('expected a step-up');
    const { params } = await new KcBrowser().authorize(up.authorizationUrl, 'publisher@demo.social-lite.test');
    expect(await loginError(completeLogin(params, { binding: up.binding, currentSession: session }))).toBe('account_mismatch');
    expect(await sessionRow(session.id)).toMatchObject({ mfa_verified: false, acr: 'password' });
    const audit = await testPool().query(`SELECT 1 FROM audit_events WHERE action='auth.step_up_subject_mismatch' AND resource_id=$1`, [session.id]);
    expect(audit.rowCount).toBe(1);
  });

  it('login revokes the session cookie the browser already carried (rotation on login)', async () => {
    const first = await loginAs('viewer@demo.social-lite.test');
    const start = await startLogin({});
    const params = await kcLogin(start.authorizationUrl, 'viewer@demo.social-lite.test');
    const second = await completeLogin(params, { binding: start.binding, currentSession: asSession(first.result) });
    expect(await resolveSession(first.result.token)).toBeNull();
    expect((await sessionRow(first.result.session.id)).revoked_at).not.toBeNull();
    expect(await resolveSession(second.token)).not.toBeNull();
  });
});

describe('returnTo validation', () => {
  it('accepts only same-site relative paths', () => {
    expect(safeReturnTo('/posts/1?tab=a#x')).toBe('/posts/1?tab=a#x');
    for (const bad of ['//evil.example/x', 'https://evil.example/', '/\\evil.example', 'javascript:alert(1)', '/api/auth/login', '', null, 'posts', `/${'a'.repeat(600)}`, '/\nx']) {
      expect(safeReturnTo(bad as string | null), String(bad)).toBe('/overview');
    }
    // V5: the public marketing page is never a post-login destination; the app home is.
    expect(safeReturnTo('/')).toBe('/overview');
    expect(safeReturnTo('/overview')).toBe('/overview');
  });
});
