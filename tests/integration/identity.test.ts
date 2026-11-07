// V2 identity: assurance gating through the REAL policy path (v2Ctx), step-up freshness, session lifetime,
// listing/revocation, and back-channel logout token verification (signature, claims, replay).
import { generateKeyPairSync, randomUUID, sign, type KeyObject } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authorizeCtx, requireAction, resolveSession } from '@social-lite/services';
import {
  IDLE_TIMEOUT_MS, SESSION_TTL_MS, createSession, listUserSessions, revokeOtherSessions, revokeUserSession, rotateSession,
} from '../../packages/services/src/auth/session.js';
import { assuranceFromClaims, handleBackchannelLogout } from '../../packages/services/src/auth/oidc.js';
import { addMember, closeTestPool, createBrand, createUser, createWorkspace, grant, testPool, v2Ctx } from './helpers.js';

afterAll(closeTestPool);
beforeAll(() => { testPool(); });

describe('assurance gating (policy path)', () => {
  it('owner/admin/publisher need verified MFA for sensitive actions; non-sensitive actions do not', async () => {
    const ws = await createWorkspace();
    const brand = await createBrand(ws);
    const owner = await createUser(); await addMember(ws, owner.id, 'owner');
    const pub = await createUser(); await addMember(ws, pub.id, 'viewer', [brand]); await grant(ws, pub.id, 'publisher', brand);
    const editor = await createUser(); await addMember(ws, editor.id, 'editor');

    const ownerNoMfa = await v2Ctx(owner.id, ws, { mfaVerified: false });
    expect(authorizeCtx(ownerNoMfa, 'members.invite').reason).toBe('mfa_required');
    expect(authorizeCtx(ownerNoMfa, 'service_accounts.manage').reason).toBe('mfa_required');
    expect(authorizeCtx(ownerNoMfa, 'content.read', { brandId: brand }).allowed).toBe(true);
    expect(() => requireAction(ownerNoMfa, 'members.invite')).toThrow(expect.objectContaining({ code: 'mfa_required' }));
    expect(authorizeCtx(await v2Ctx(owner.id, ws, { mfaVerified: true }), 'members.invite').allowed).toBe(true);

    const pubNoMfa = await v2Ctx(pub.id, ws, { mfaVerified: false });
    expect(authorizeCtx(pubNoMfa, 'content.publish', { brandId: brand }).reason).toBe('mfa_required');
    expect(authorizeCtx(await v2Ctx(pub.id, ws), 'content.publish', { brandId: brand }).allowed).toBe(true);

    // Editors are not in the default MFA-required set …
    expect(authorizeCtx(await v2Ctx(editor.id, ws, { mfaVerified: false }), 'content.edit', { brandId: brand }).allowed).toBe(true);
    // … unless the workspace requires MFA for everyone (and only for sensitive / step-up actions).
    await testPool().query(`UPDATE workspaces SET security_policy = security_policy || '{"mfa_required_all":true}' WHERE id=$1`, [ws]);
    const ed = await v2Ctx(editor.id, ws, { mfaVerified: false });
    expect(authorizeCtx(ed, 'content.edit', { brandId: brand }, { stepUp: true }).reason).toBe('mfa_required');
  });

  it('step-up actions require authentication within the freshness window (default 300 s), enforced server-side', async () => {
    const ws = await createWorkspace();
    const owner = await createUser(); await addMember(ws, owner.id, 'owner');
    const fresh = await v2Ctx(owner.id, ws, { authTime: new Date(Date.now() - 60_000).toISOString() });
    expect(authorizeCtx(fresh, 'service_accounts.manage', {}, { stepUp: true }).allowed).toBe(true);
    const stale = await v2Ctx(owner.id, ws, { authTime: new Date(Date.now() - 301_000).toISOString() });
    expect(authorizeCtx(stale, 'service_accounts.manage', {}, { stepUp: true }).reason).toBe('step_up_required');
    expect(() => requireAction(stale, 'service_accounts.manage', { stepUp: true })).toThrow(expect.objectContaining({ code: 'step_up_required' }));
    const unknown = await v2Ctx(owner.id, ws, { authTime: null });
    expect(authorizeCtx(unknown, 'service_accounts.manage', {}, { stepUp: true }).reason).toBe('step_up_required');
    // Configurable window.
    await testPool().query(`UPDATE workspaces SET security_policy = security_policy || '{"step_up_seconds":30}' WHERE id=$1`, [ws]);
    expect(authorizeCtx(await v2Ctx(owner.id, ws, { authTime: new Date(Date.now() - 60_000).toISOString() }), 'service_accounts.manage', {}, { stepUp: true }).reason).toBe('step_up_required');
  });

  it('assurance comes only from verified ID-token claims: acr "mfa" AND a second-factor amr', () => {
    expect(assuranceFromClaims({ acr: 'mfa', amr: ['pwd', 'otp'], auth_time: 1_800_000_000, sid: 's' })).toMatchObject({ mfaVerified: true, acr: 'mfa', sid: 's' });
    expect(assuranceFromClaims({ acr: 'mfa', amr: ['pwd'] }).mfaVerified).toBe(false);          // LoA claim without a factor
    expect(assuranceFromClaims({ acr: 'password', amr: ['pwd', 'otp'] }).mfaVerified).toBe(false);
    expect(assuranceFromClaims({ acr: 'mfa', amr: 'otp' }).mfaVerified).toBe(false);            // malformed amr
    expect(assuranceFromClaims({ acr: 'mfa', amr: ['hwk'] }).mfaVerified).toBe(true);           // passkey / security key
    expect(assuranceFromClaims({ acr: 'mfa', amr: ['pwd', 'rc'] }).mfaVerified).toBe(true);     // recovery code
  });
});

describe('sessions', () => {
  it('30-minute idle and 12-hour absolute limits are enforced server-side', async () => {
    expect(IDLE_TIMEOUT_MS).toBe(30 * 60_000);
    expect(SESSION_TTL_MS).toBe(12 * 3_600_000);
    const u = await createUser();
    const a = await createSession(testPool(), u.id, {});
    expect(a.session.expiresAt.getTime() - Date.now()).toBeGreaterThan(SESSION_TTL_MS - 5_000);
    await testPool().query(`UPDATE sessions SET last_seen_at = now() - interval '31 minutes' WHERE id=$1`, [a.session.id]);
    expect(await resolveSession(a.token)).toBeNull();
    const r = await testPool().query(`SELECT revoked_reason FROM sessions WHERE id=$1`, [a.session.id]);
    expect(r.rows[0].revoked_reason).toBe('idle_timeout');
    const b = await createSession(testPool(), u.id, {});
    await testPool().query(`UPDATE sessions SET expires_at = now() - interval '1 second' WHERE id=$1`, [b.session.id]);
    expect(await resolveSession(b.token)).toBeNull();
  });

  it('lists only the caller’s live sessions; revoke one / all others takes effect on the next request', async () => {
    const u = await createUser(); const other = await createUser();
    const cur = await createSession(testPool(), u.id, { userAgent: 'Mozilla/5.0 (Macintosh) Firefox/140.0' });
    const s2 = await createSession(testPool(), u.id, { userAgent: 'Mozilla/5.0 (iPhone) Safari/18' });
    const s3 = await createSession(testPool(), u.id, {});
    const foreign = await createSession(testPool(), other.id, {});
    const list = await listUserSessions(testPool(), u.id, cur.session.id);
    expect(list.map((s) => s.id).sort()).toEqual([cur.session.id, s2.session.id, s3.session.id].sort());
    expect(list[0]).toMatchObject({ id: cur.session.id, current: true });
    expect(Object.keys(list[0]!).filter((k) => /token|csrf|^ip$/i.test(k))).toEqual([]);
    // Cannot revoke another user's session (not found for this user).
    expect(await revokeUserSession(testPool(), u.id, foreign.session.id)).toBe(false);
    expect(await resolveSession(foreign.token)).not.toBeNull();
    expect(await revokeUserSession(testPool(), u.id, s2.session.id)).toBe(true);
    expect(await resolveSession(s2.token)).toBeNull();
    expect(await revokeOtherSessions(testPool(), u.id, cur.session.id)).toBe(1);
    expect(await resolveSession(s3.token)).toBeNull();
    expect(await resolveSession(cur.token)).not.toBeNull();
  });

  it('rotation replaces the cookie value and CSRF token and records new assurance', async () => {
    const u = await createUser();
    const s = await createSession(testPool(), u.id, { acr: 'password', amr: ['pwd'] });
    const at = new Date();
    const r = await rotateSession(testPool(), s.session.id, { mfaVerified: true, acr: 'mfa', amr: ['pwd', 'otp'], authTime: at });
    expect(await resolveSession(s.token)).toBeNull();
    const now = await resolveSession(r.token);
    expect(now?.session).toMatchObject({ id: s.session.id, mfaVerified: true, acr: 'mfa', amr: ['pwd', 'otp'] });
    expect(now?.session.csrfToken).not.toBe(s.session.csrfToken);
    await revokeUserSession(testPool(), u.id, s.session.id);
    await expect(rotateSession(testPool(), s.session.id, { mfaVerified: true, acr: 'mfa', amr: [], authTime: at })).rejects.toThrow();
  });
});

describe('back-channel logout token verification', () => {
  const ISS = 'https://idp.test/realms/x';
  const AUD = 'social-lite-local';
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const keys = async (kid: string | undefined) => (kid === 'k1' ? publicKey : kid === 'k2' ? other.publicKey : null);
  const jwt = (claims: Record<string, unknown>, opts: { key?: KeyObject; kid?: string; alg?: string } = {}) => {
    const h = Buffer.from(JSON.stringify({ alg: opts.alg ?? 'RS256', kid: opts.kid ?? 'k1', typ: 'logout+jwt' })).toString('base64url');
    const p = Buffer.from(JSON.stringify(claims)).toString('base64url');
    const sig = sign('sha256', Buffer.from(`${h}.${p}`), opts.key ?? privateKey).toString('base64url');
    return `${h}.${p}.${sig}`;
  };
  const base = (sid: string, sub?: string) => ({ iss: ISS, aud: AUD, iat: Math.floor(Date.now() / 1000), jti: randomUUID(), sid, ...(sub ? { sub } : {}),
    events: { 'http://schemas.openid.net/event/backchannel-logout': {} } });
  const handle = (t: string) => handleBackchannelLogout(t, testPool(), { keys, issuer: ISS, audience: AUD });

  it('revokes exactly the sessions bound to the IdP session id; rejects forged, wrong-audience, replayed or malformed tokens', async () => {
    const u = await createUser();
    await testPool().query(`UPDATE users SET oidc_issuer=$2, oidc_subject=$3 WHERE id=$1`, [u.id, ISS, `sub-${u.id}`]);
    const sid = `sid-${randomUUID()}`;
    const a = await createSession(testPool(), u.id, { idpSessionId: sid });
    const b = await createSession(testPool(), u.id, { idpSessionId: `sid-${randomUUID()}` });

    const reject = async (t: string) => expect(handle(t)).rejects.toMatchObject({ code: 'validation_failed' });
    await reject(jwt(base(sid), { key: other.privateKey }));                       // signature by another key
    await reject(jwt(base(sid), { kid: 'unknown' }));                              // unknown key id
    await reject(jwt({ ...base(sid), aud: 'someone-else' }));                      // wrong audience
    await reject(jwt({ ...base(sid), iss: 'https://evil.test' }));                 // wrong issuer
    await reject(jwt({ ...base(sid), events: {} }));                               // not a logout event
    await reject(jwt({ ...base(sid), nonce: 'n' }));                               // nonce forbidden
    await reject(jwt({ ...base(sid), iat: Math.floor(Date.now() / 1000) - 3600 })); // stale
    const noneAlg = `${Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url')}.${Buffer.from(JSON.stringify(base(sid))).toString('base64url')}.`;
    await reject(noneAlg);
    await reject('not-a-jwt');
    expect(await resolveSession(a.token)).not.toBeNull();

    const good = jwt(base(sid, `sub-${u.id}`));
    expect(await handle(good)).toEqual({ revoked: 1 });
    expect(await resolveSession(a.token)).toBeNull();
    expect(await resolveSession(b.token)).not.toBeNull();     // other IdP session untouched
    await reject(good);                                        // single use (jti)
    const r = await testPool().query(`SELECT revoked_reason FROM sessions WHERE id=$1`, [a.session.id]);
    expect(r.rows[0].revoked_reason).toBe('idp_logout');

    // A sid with a mismatching sub revokes nothing.
    const c = await createSession(testPool(), u.id, { idpSessionId: `sid-c-${u.id}` });
    expect(await handle(jwt(base(`sid-c-${u.id}`, 'someone-else')))).toEqual({ revoked: 0 });
    expect(await resolveSession(c.token)).not.toBeNull();
    // sub without sid: every session of that subject.
    const { sid: _drop, ...noSid } = base('x', `sub-${u.id}`);
    expect((await handle(jwt(noSid))).revoked).toBe(2);
    expect(await resolveSession(b.token)).toBeNull();
    expect(await resolveSession(c.token)).toBeNull();
  });
});
