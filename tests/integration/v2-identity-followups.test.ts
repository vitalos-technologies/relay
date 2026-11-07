// V2 identity follow-ups (docs review): recovery-code / factor-change follow-up (revoke other sessions + audit +
// email), step-up for credential changes, the owner-only workspace security policy, and service accounts on
// owner removal. All through the real policy path (v2Ctx).
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authorizeCtx } from '@social-lite/services';
import { reactivateMember, removeMember, suspendMember } from '../../packages/services/src/lifecycle.js';
import { createSession } from '../../packages/services/src/auth/session.js';
import { afterSensitiveAuthEvent } from '../../packages/services/src/auth/security-events.js';
import { authenticateApiKey, createServiceAccount } from '../../packages/services/src/service-accounts.js';
import { getSecurityPolicy, updateSecurityPolicy } from '../../packages/services/src/security-policy.js';
import { connectMock, disconnectConnection } from '../../packages/services/src/connections/manage.js';
import { addMember, closeTestPool, createBrand, createUser, createWorkspace, testPool, v2Ctx } from './helpers.js';

beforeAll(() => { testPool(); });
afterAll(closeTestPool);

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

async function mailTo(email: string): Promise<string | null> {
  for (let i = 0; i < 20; i++) {
    const res = await fetch(`http://localhost:8025/api/v1/search?query=${encodeURIComponent(`to:"${email}"`)}`);
    const found = (await res.json()) as { messages: Array<{ ID: string; Subject: string }> };
    if (found.messages?.length) return found.messages[0]!.Subject;
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}

describe('recovery-code sign-in / factor change follow-up', () => {
  it('revokes every other session, keeps the current one, audits and emails the verified address', async () => {
    const db = testPool();
    const u = await createUser(`rc-${randomUUID().slice(0, 8)}@test.social-lite.test`);
    const sessions = [];
    for (let i = 0; i < 3; i++) sessions.push((await createSession(db, u.id, { userAgent: 'vitest', ip: null, workspaceId: null, acr: 'mfa', amr: ['pwd', 'otp'], authTime: new Date(), mfaVerified: true })).session);
    const keep = sessions[0]!;
    const r = await afterSensitiveAuthEvent(db, { userId: u.id, keepSessionId: keep.id, kind: 'recovery_code' });
    expect(r).toEqual({ revoked: 2, notified: true });
    const rows = (await db.query<{ id: string; revoked_at: Date | null }>(`SELECT id, revoked_at FROM sessions WHERE user_id=$1`, [u.id])).rows;
    expect(rows.find((x) => x.id === keep.id)!.revoked_at).toBeNull();
    expect(rows.filter((x) => x.revoked_at).length).toBe(2);
    const a = (await db.query(`SELECT action, diff FROM audit_events WHERE actor_user_id=$1 ORDER BY created_at DESC LIMIT 1`, [u.id])).rows[0];
    expect(a).toMatchObject({ action: 'auth.recovery_code_used', diff: { sessions: 2, status: 'notified' } });
    expect(await mailTo(u.email)).toMatch(/security alert: a recovery code was used to sign in/i);

    const f = await afterSensitiveAuthEvent(db, { userId: u.id, keepSessionId: keep.id, kind: 'factor_change', action: 'delete_credential' });
    expect(f.revoked).toBe(0);
    const last = (await db.query(`SELECT action, diff FROM audit_events WHERE actor_user_id=$1 ORDER BY created_at DESC LIMIT 1`, [u.id])).rows[0];
    expect(last).toMatchObject({ action: 'auth.factor_changed_followup', diff: { action: 'delete_credential' } });
  });
});

describe('credential changes need a fresh verification', () => {
  it('connect / disconnect refuse an MFA session older than the step-up window; service-account creation too', async () => {
    const ws = await createWorkspace();
    const brand = await createBrand(ws);
    const owner = await createUser(); await addMember(ws, owner.id, 'owner');
    const stale = await v2Ctx(owner.id, ws, { mfaVerified: true, authTime: minutesAgo(30) });
    expect(authorizeCtx(stale, 'connections.manage', { brandId: brand }).allowed).toBe(true); // MFA alone is enough to view/manage …
    await expect(connectMock(stale, brand, { provider: 'telegram', display_name: 'Stale' })).rejects.toMatchObject({ code: 'step_up_required' });
    await expect(createServiceAccount(stale, { name: 'Bot', brand_id: brand, role: 'integration' })).rejects.toMatchObject({ code: 'step_up_required' });
    const fresh = await v2Ctx(owner.id, ws);
    const c = await connectMock(fresh, brand, { provider: 'telegram', display_name: 'Fresh' });
    await expect(disconnectConnection(stale, c.id)).rejects.toMatchObject({ code: 'step_up_required' });
    await expect(disconnectConnection(fresh, c.id)).resolves.toBeTruthy();
  });
});

describe('workspace security policy (owner only)', () => {
  it('reads defaults, tightens without step-up, needs step-up to weaken, bumps policy version, audits, owner always required', async () => {
    const db = testPool();
    const ws = await createWorkspace();
    const owner = await createUser(); await addMember(ws, owner.id, 'owner');
    const admin = await createUser(); await addMember(ws, admin.id, 'admin');
    await expect(getSecurityPolicy(await v2Ctx(admin.id, ws))).rejects.toMatchObject({ code: 'forbidden' });
    await expect(updateSecurityPolicy(await v2Ctx(admin.id, ws), { mfa_required_all: true })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(getSecurityPolicy(await v2Ctx(owner.id, ws, { mfaVerified: false }))).rejects.toMatchObject({ code: 'mfa_required' });

    const g = await getSecurityPolicy(await v2Ctx(owner.id, ws));
    expect(g.policy).toMatchObject({ mfa_required_all: false, step_up_seconds: 300, invite_ttl_hours: 72 });
    const stale = await v2Ctx(owner.id, ws, { authTime: minutesAgo(30) });
    // Tightening: MFA is enough.
    const t = await updateSecurityPolicy(stale, { mfa_required_all: true, step_up_seconds: 120, mfa_required_for: ['publisher', 'admin', 'brand_manager', 'editor'] });
    expect(t.policy).toMatchObject({ mfa_required_all: true, step_up_seconds: 120, mfa_required_for: ['owner', 'admin', 'brand_manager', 'editor', 'publisher'] });
    // Dropping a role from the list is weakening.
    await expect(updateSecurityPolicy(stale, { mfa_required_for: ['admin'] })).rejects.toMatchObject({ code: 'step_up_required' });
    expect(t.policy_version).toBeGreaterThan(g.policy_version);
    // An editor without MFA is now blocked from sensitive actions.
    const ed = await createUser(); await addMember(ws, ed.id, 'editor');
    const brand = await createBrand(ws);
    expect(authorizeCtx(await v2Ctx(ed.id, ws, { mfaVerified: false }), 'content.edit', { brandId: brand }, { stepUp: true }).reason).toBe('mfa_required');
    expect(authorizeCtx(await v2Ctx(ed.id, ws, { mfaVerified: true }), 'content.edit', { brandId: brand }, { stepUp: true }).allowed).toBe(true);
    // Weakening needs a fresh verification (now within 120 s).
    await expect(updateSecurityPolicy(await v2Ctx(owner.id, ws, { authTime: minutesAgo(5) }), { mfa_required_all: false })).rejects.toMatchObject({ code: 'step_up_required' });
    await expect(updateSecurityPolicy(stale, { invite_ttl_hours: 200 })).rejects.toMatchObject({ code: 'step_up_required' });
    const w = await updateSecurityPolicy(await v2Ctx(owner.id, ws), { mfa_required_all: false, guest_max_days: 10, guest_default_days: 5 });
    expect(w.policy).toMatchObject({ mfa_required_all: false, guest_max_days: 10, guest_default_days: 5 });
    await expect(updateSecurityPolicy(await v2Ctx(owner.id, ws), { guest_default_days: 30 })).rejects.toMatchObject({ code: 'validation_failed' });
    await expect(updateSecurityPolicy(await v2Ctx(owner.id, ws), { step_up_seconds: 5 })).rejects.toBeTruthy();
    await expect(updateSecurityPolicy(await v2Ctx(owner.id, ws), { mfa_required_all: true, expected_policy_version: 1 })).rejects.toMatchObject({ code: 'conflict' });
    const audits = (await db.query(`SELECT diff FROM audit_events WHERE workspace_id=$1 AND action='workspace.security_policy_updated' ORDER BY created_at`, [ws])).rows;
    expect(audits.length).toBe(2);
    expect(audits[0].diff).toMatchObject({ before: { mfa_required_all: false }, after: { mfa_required_all: true }, weakening: false });
    expect(audits[1].diff).toMatchObject({ weakening: true });
  });
});

describe('service accounts on owner offboarding', () => {
  it('suspending the owner pauses the keys; removing the owner disables the account (audited) unless reassigned', async () => {
    const db = testPool();
    const ws = await createWorkspace();
    const brand = await createBrand(ws);
    const owner = await createUser(); await addMember(ws, owner.id, 'owner');
    const admin = await createUser(); await addMember(ws, admin.id, 'admin');
    const own = await v2Ctx(owner.id, ws);
    const a = await createServiceAccount(own, { name: `Bot ${randomUUID().slice(0, 4)}`, brand_id: brand, role: 'integration', owner_user_id: admin.id });
    const b = await createServiceAccount(own, { name: `Bot ${randomUUID().slice(0, 4)}`, brand_id: brand, role: 'integration', owner_user_id: admin.id });
    const bearer = (k: string) => `Bearer ${k}`;
    expect(await authenticateApiKey(bearer(a.key.secret))).not.toBeNull();

    await suspendMember(own, admin.id, { reason: 'leave' });
    expect(await authenticateApiKey(bearer(a.key.secret))).toBeNull(); // owner not active → key refused
    await reactivateMember(await v2Ctx(owner.id, ws), admin.id);
    expect(await authenticateApiKey(bearer(a.key.secret))).not.toBeNull();

    // Reassign one explicitly, then remove the admin: the other is disabled + keys revoked + audited.
    await db.query(`UPDATE service_accounts SET owner_user_id=$2 WHERE id=$1`, [b.service_account.id, owner.id]);
    const r = await removeMember(await v2Ctx(owner.id, ws), admin.id, { reason: 'left' });
    expect(r.ok).toBe(true);
    const rows = (await db.query<{ id: string; disabled_at: Date | null }>(`SELECT id, disabled_at FROM service_accounts WHERE workspace_id=$1`, [ws])).rows;
    expect(rows.find((x) => x.id === a.service_account.id)!.disabled_at).not.toBeNull();
    expect(rows.find((x) => x.id === b.service_account.id)!.disabled_at).toBeNull();
    expect(await authenticateApiKey(bearer(a.key.secret))).toBeNull();
    expect(await authenticateApiKey(bearer(b.key.secret))).not.toBeNull();
    const audit = (await db.query(`SELECT diff FROM audit_events WHERE workspace_id=$1 AND action='service_account.disabled' AND resource_id=$2`, [ws, a.service_account.id])).rows[0];
    expect(audit.diff).toMatchObject({ reason: 'owner_removed', owner_user_id: admin.id, keys_revoked: 1 });
    const removed = (await db.query(`SELECT diff FROM audit_events WHERE workspace_id=$1 AND action='member.removed'`, [ws])).rows[0];
    expect(removed.diff.service_accounts_disabled).toBe(1);
  });

  it('removal with reassign_to hands the accounts over instead (audited as reassigned)', async () => {
    const ws = await createWorkspace();
    const brand = await createBrand(ws);
    const owner = await createUser(); await addMember(ws, owner.id, 'owner');
    const admin = await createUser(); await addMember(ws, admin.id, 'admin');
    const own = await v2Ctx(owner.id, ws);
    const a = await createServiceAccount(own, { name: `Bot ${randomUUID().slice(0, 4)}`, brand_id: brand, role: 'integration', owner_user_id: admin.id });
    const r = await removeMember(await v2Ctx(owner.id, ws), admin.id, { reassign_to: owner.id });
    expect(r.reassigned?.service_accounts).toBe(1);
    const row = (await testPool().query(`SELECT owner_user_id, disabled_at FROM service_accounts WHERE id=$1`, [a.service_account.id])).rows[0];
    expect(row).toMatchObject({ owner_user_id: owner.id, disabled_at: null });
    expect(await authenticateApiKey(`Bearer ${a.key.secret}`)).not.toBeNull();
  });
});
