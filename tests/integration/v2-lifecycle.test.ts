// V2 stream B: invitations v2, suspension/removal/scope reduction, handover + reassignment, last owner,
// ownership transfer — through the REAL policy path (v2Ctx). Spec §12 cases 4, 5, 6, 7, 8.
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { withTx } from '@social-lite/db';
import { authorize, loadAccess } from '@social-lite/services';
import {
  acceptInvitation, acceptInvitationForUser, bulkInvite, createInvitation, listInvitations, previewInvitation, resendInvitation, revokeInvitation,
} from '../../packages/services/src/auth/invitations.js';
import { sha256, createSession } from '../../packages/services/src/auth/session.js';
import { LoginError } from '../../packages/services/src/auth/users.js';
import { addMemberGrant, listMembers, revokeGrant } from '../../packages/services/src/members.js';
import {
  acceptOwnershipTransfer, cancelOwnershipTransfer, handoverPreview, listOwnershipTransfers, proposeOwnershipTransfer, reassignWork, reduceScope,
  removeMember, suspendMember,
} from '../../packages/services/src/lifecycle.js';
import { addTeamGrant, addTeamMember, createTeam } from '../../packages/services/src/teams.js';
import { addMember, closeTestPool, createBrand, createUser, createWorkspace, grant, testPool, v2Ctx } from './helpers.js';

afterAll(closeTestPool);

const key = () => `idem-${randomUUID()}`;
const tokenOf = (url: string) => decodeURIComponent(url.split('/invite/')[1]!);
const accept = (token: string, user: { id: string; email: string }) => withTx((tx) => acceptInvitation(tx, sha256(token), user), testPool());

async function loginError(p: Promise<unknown>): Promise<string> {
  const e = await p.then(() => null, (x: unknown) => x);
  expect(e).toBeInstanceOf(LoginError);
  return (e as LoginError).code;
}

async function agency() {
  const ws = await createWorkspace('Agency');
  const brandA = await createBrand(ws, 'Brand A');
  const brandB = await createBrand(ws, 'Brand B');
  const owner = await createUser();
  await addMember(ws, owner.id, 'owner');
  const admin = await createUser();
  await addMember(ws, admin.id, 'admin');
  return { ws, brandA, brandB, owner, admin, own: () => v2Ctx(owner.id, ws), adm: () => v2Ctx(admin.id, ws) };
}

async function member(ws: string, role?: string, brandId?: string) {
  const u = await createUser();
  await testPool().query(`INSERT INTO memberships(workspace_id, user_id, role) VALUES ($1,$2,'viewer')`, [ws, u.id]);
  if (role) await grant(ws, u.id, role, brandId);
  return u;
}

describe('invitations v2 (§12.4, §12.5)', () => {
  it('carries scoped grants + teams; 72 h default; accepted once by the verified identity', async () => {
    const t = await agency();
    const team = await createTeam(await t.adm(), { name: 'Editorial' });
    await addTeamGrant(await t.adm(), team.id, { role: 'editor', brand_id: t.brandB });
    const email = `inv-${randomUUID().slice(0, 8)}@example.test`;
    const r = await createInvitation(await t.adm(), { email, grants: [{ role: 'publisher', brand_id: t.brandA }], team_ids: [team.id] }, key());
    expect(r.body).toMatchObject({ email, kind: 'member', grants: [{ role: 'publisher', scope_type: 'brand', brand_id: t.brandA, brand_name: 'Brand A' }], teams: [{ id: team.id }] });
    expect(new Date(r.body.expires_at).getTime() - Date.now()).toBeLessThanOrEqual(72 * 3600_000 + 5000);
    expect(new Date(r.body.expires_at).getTime() - Date.now()).toBeGreaterThan(71.9 * 3600_000);
    const token = tokenOf(r.body.accept_url!);
    // Different verified identity, unverified email, or a pre-provisioned (unbound) account cannot accept.
    expect(await loginError(accept(token, await createUser()))).toBe('email_mismatch');
    const unverified = await createUser(`unv-${randomUUID().slice(0, 6)}@example.test`);
    await testPool().query(`UPDATE users SET email_verified=false WHERE id=$1`, [unverified.id]);
    expect(await loginError(accept(token, { id: unverified.id, email }))).toBe('email_mismatch');
    const pending = (await testPool().query<{ id: string }>(`INSERT INTO users(oidc_issuer, oidc_subject, email, email_verified) VALUES ('pending',$1,$2,false) RETURNING id`,
      [`pending:${email}`, email])).rows[0]!.id;
    expect(await loginError(accept(token, { id: pending, email }))).toBe('email_mismatch');
    await testPool().query(`DELETE FROM users WHERE id=$1`, [pending]);
    // Concurrent acceptance by the right identity succeeds exactly once.
    const right = await createUser(email.toUpperCase());
    const results = await Promise.allSettled([accept(token, right), accept(token, right), accept(token, right)]);
    expect(results.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    for (const x of results.filter((y) => y.status === 'rejected')) expect(((x as PromiseRejectedResult).reason as LoginError).code).toBe('invitation_used');
    const ctx = await v2Ctx(right.id, t.ws);
    expect(authorize(ctx.access.authz!, 'content.publish', { brandId: t.brandA }).allowed).toBe(true);
    expect(authorize(ctx.access.authz!, 'content.edit', { brandId: t.brandB }).allowed).toBe(true); // via team
    expect(authorize(ctx.access.authz!, 'content.edit', { brandId: t.brandA }).allowed).toBe(false);
    const row = (await testPool().query(`SELECT accepted_by, accepted_issuer, accepted_subject FROM invitations WHERE id=$1`, [r.body.id])).rows[0];
    expect(row).toMatchObject({ accepted_by: right.id, accepted_issuer: 'test' });
    expect(row.accepted_subject).toBeTruthy();
    expect((await previewInvitation(token)).status).toBe('accepted');
  });

  it('resend rotates the token; revoked/expired are unusable; preview never enumerates users', async () => {
    const t = await agency();
    const email = `rs-${randomUUID().slice(0, 8)}@example.test`;
    const r = await createInvitation(await t.adm(), { email, role: 'viewer' }, key());
    const old = tokenOf(r.body.accept_url!);
    const again = await resendInvitation(await t.adm(), r.body.id);
    expect(again.resent_count).toBe(1);
    const fresh = tokenOf(again.accept_url!);
    expect(fresh).not.toBe(old);
    const u = await createUser(email);
    expect(await loginError(accept(old, u))).toBe('invitation_invalid');
    await expect(previewInvitation(old)).rejects.toMatchObject({ code: 'not_found' });
    const p = await previewInvitation(fresh);
    expect(Object.keys(p).sort()).toEqual(['email_hint', 'expires_at', 'kind', 'role', 'status', 'workspace_name']);
    expect(p.email_hint).not.toContain(email.split('@')[0]);
    // Revoke ⇒ unusable; resend of a revoked invitation is refused.
    await revokeInvitation(await t.adm(), r.body.id);
    expect(await loginError(accept(fresh, u))).toBe('invitation_revoked');
    await expect(resendInvitation(await t.adm(), r.body.id)).rejects.toMatchObject({ code: 'invalid_state' });
    // Expired ⇒ unusable.
    const r2 = await createInvitation(await t.adm(), { email: `ex-${randomUUID().slice(0, 6)}@example.test`, role: 'viewer' }, key());
    await testPool().query(`UPDATE invitations SET expires_at=now() - interval '1 minute' WHERE id=$1`, [r2.body.id]);
    expect(await loginError(accept(tokenOf(r2.body.accept_url!), await createUser(r2.body.email)))).toBe('invitation_expired');
  });

  it('guest invites require an expiry (default 30 d, max policy) and are brand-scoped; inviter ceilings apply at create AND accept', async () => {
    const t = await agency();
    const g = await createInvitation(await t.adm(), { email: `guest-${randomUUID().slice(0, 6)}@client.test`, grants: [{ role: 'guest', brand_id: t.brandA }] }, key());
    expect(g.body.kind).toBe('guest');
    const days = (new Date(g.body.access_expires_at!).getTime() - Date.now()) / 86400_000;
    expect(days).toBeGreaterThan(29.9);
    expect(days).toBeLessThan(30.1);
    await expect(createInvitation(await t.adm(), { email: 'g2@client.test', grants: [{ role: 'guest', brand_id: t.brandA }],
      access_expires_at: new Date(Date.now() + 120 * 86400_000).toISOString() }, key())).rejects.toMatchObject({ code: 'validation_failed' });
    await expect(createInvitation(await t.adm(), { email: 'g3@client.test', grants: [{ role: 'guest' }] }, key())).rejects.toMatchObject({ code: 'validation_failed' });
    await expect(createInvitation(await t.adm(), { email: 'g4@client.test', grants: [{ role: 'guest', brand_id: t.brandA }, { role: 'editor', brand_id: t.brandA }] }, key()))
      .rejects.toMatchObject({ code: 'validation_failed' });
    const guest = await createUser(g.body.email);
    await accept(tokenOf(g.body.accept_url!), guest);
    const gr = (await testPool().query(`SELECT role, expires_at FROM scoped_role_grants WHERE workspace_id=$1 AND user_id=$2 AND revoked_at IS NULL`, [t.ws, guest.id])).rows;
    expect(gr).toEqual([{ role: 'guest', expires_at: expect.any(Date) }]);
    // Guests see no brand library (review portal only) and nothing of Brand B.
    expect((await v2Ctx(guest.id, t.ws)).access.brandIds).toEqual([]);
    // Delegation at create: admins cannot invite admins; non-admins cannot invite.
    await expect(createInvitation(await t.adm(), { email: 'a@x.test', role: 'admin' }, key())).rejects.toMatchObject({ code: 'forbidden' });
    const ed = await member(t.ws, 'editor', t.brandA);
    await expect(createInvitation(await v2Ctx(ed.id, t.ws), { email: 'b@x.test', role: 'viewer' }, key())).rejects.toMatchObject({ code: 'forbidden' });
    // …and at accept: an invitation from an admin who has since been demoted is dead.
    const r = await createInvitation(await t.adm(), { email: `late-${randomUUID().slice(0, 6)}@x.test`, role: 'editor' }, key());
    const adminGrant = (await listMembers(await t.own())).members.find((m) => m.user_id === t.admin.id)!.grants.find((x) => x.role === 'admin')!;
    await revokeGrant(await t.own(), adminGrant.id);
    expect(await loginError(accept(tokenOf(r.body.accept_url!), await createUser(r.body.email)))).toBe('invitation_invalid');
  });

  it('bulk invites validate each row, report per-row results and resist duplicates and replays', async () => {
    const t = await agency();
    const existing = await member(t.ws, 'viewer');
    const a = `bulk-a-${randomUUID().slice(0, 6)}@x.test`;
    const b = `bulk-b-${randomUUID().slice(0, 6)}@x.test`;
    const k = key();
    const rows = [
      { email: a, role: 'editor', brand_ids: [t.brandA] },
      { email: a.toUpperCase(), role: 'viewer' },
      { email: existing.email, role: 'viewer' },
      { email: 'not-an-email', role: 'viewer' },
      { email: b, grants: [{ role: 'publisher', brand_id: randomUUID() }] },
      { email: `bulk-c-${randomUUID().slice(0, 6)}@x.test`, role: 'approver' },
    ];
    const res = await bulkInvite(await t.adm(), { rows }, k);
    expect(res.results.map((x) => x.status)).toEqual(['invited', 'duplicate', 'already_member', 'error', 'error', 'invited']);
    expect(res.results[0]!.accept_url).toMatch(/\/invite\//);
    expect(res.results[3]).toMatchObject({ code: 'validation_failed' });
    // Replay with the same key: same batch, no re-send, no token disclosure.
    const replay = await bulkInvite(await t.adm(), { rows }, k);
    expect(replay).toMatchObject({ replayed: true, batch_id: res.batch_id });
    expect(JSON.stringify(replay)).not.toContain('/invite/');
    // A new batch with the same people does not duplicate invitations.
    const second = await bulkInvite(await t.adm(), { rows: [{ email: a, role: 'editor' }] }, key());
    expect(second.results[0]!.status).toBe('already_invited');
    expect((await listInvitations(await t.adm())).filter((i) => i.email.toLowerCase() === a.toLowerCase())).toHaveLength(1);
  });

  it('a signed-in user of another workspace joins by session identity (no account linking)', async () => {
    const t = await agency();
    const other = await agency();
    const u = await member(other.ws, 'editor', other.brandA);
    const r = await createInvitation(await t.adm(), { email: u.email, role: 'viewer' }, key());
    const res = await acceptInvitationForUser(u.id, tokenOf(r.body.accept_url!));
    expect(res.workspaceId).toBe(t.ws);
    expect(await loadAccess(u.id, other.ws, testPool())).not.toBeNull();
    expect(await loadAccess(u.id, t.ws, testPool())).toMatchObject({ role: 'viewer', brandIds: null });
  });
});

describe('suspension, removal, scope reduction, handover (§12.6, §12.7)', () => {
  it('removal blocks the next request from any open tab, keeps other workspaces and sessions, history, and flags connections', async () => {
    const t = await agency();
    const other = await agency();
    const u = await member(t.ws, 'editor', t.brandA);
    await grant(t.ws, u.id, 'publisher', t.brandA);
    await testPool().query(`INSERT INTO memberships(workspace_id, user_id, role) VALUES ($1,$2,'viewer')`, [other.ws, u.id]);
    await grant(other.ws, u.id, 'viewer');
    const { session } = await createSession(testPool(), u.id, { workspaceId: t.ws });
    const openTab = await v2Ctx(u.id, t.ws); // a tab opened before removal
    expect(openTab.access.brandIds).toEqual([t.brandA]);
    const conn = (await testPool().query<{ id: string }>(`INSERT INTO connections(workspace_id, brand_id, provider, provider_account_id, display_name, status, is_mock, created_by)
      VALUES ($1,$2,'telegram',$3,'TG','ready',true,$4) RETURNING id`, [t.ws, t.brandA, `mock_${randomUUID()}`, u.id])).rows[0]!.id;
    const post = (await testPool().query<{ id: string }>(`INSERT INTO posts(workspace_id, brand_id, created_by) VALUES ($1,$2,$3) RETURNING id`, [t.ws, t.brandA, u.id])).rows[0]!.id;
    const preview = await handoverPreview(await t.adm(), u.id);
    expect(preview).toMatchObject({ drafts: { count: 1 }, connections: [{ id: conn }], other_workspaces: 1 });
    const res = await removeMember(await t.adm(), u.id, { reason: 'left the agency' });
    expect(res.flagged_connections).toBe(1);
    // Next request from the open tab reloads access ⇒ refused. Cached state never survives.
    await expect(v2Ctx(u.id, t.ws)).rejects.toMatchObject({ code: 'forbidden' });
    expect(await loadAccess(u.id, t.ws, testPool())).toBeNull();
    // Other workspace unaffected; the session is NOT revoked (only this workspace stops being active).
    expect(await loadAccess(u.id, other.ws, testPool())).not.toBeNull();
    const s = (await testPool().query(`SELECT revoked_at, active_workspace_id FROM sessions WHERE id=$1`, [session.id])).rows[0];
    expect(s).toEqual({ revoked_at: null, active_workspace_id: null });
    // History kept: post, grants (revoked, not deleted), status history, audit; connection flagged.
    expect((await testPool().query(`SELECT 1 FROM posts WHERE id=$1`, [post])).rowCount).toBe(1);
    expect((await testPool().query(`SELECT count(*)::int n FROM scoped_role_grants WHERE workspace_id=$1 AND user_id=$2 AND revoke_reason='membership_removed'`, [t.ws, u.id])).rows[0].n).toBe(2);
    expect((await testPool().query(`SELECT to_status FROM membership_status_history WHERE workspace_id=$1 AND user_id=$2`, [t.ws, u.id])).rows).toEqual([{ to_status: 'removed' }]);
    expect((await testPool().query(`SELECT verification_requested_at FROM connections WHERE id=$1`, [conn])).rows[0].verification_requested_at).not.toBeNull();
    expect((await listMembers(await t.adm())).members.map((m) => m.user_id)).not.toContain(u.id);
  });

  it('suspension and scope reduction are distinct operations; team access is reported, not silently kept', async () => {
    const t = await agency();
    const u = await member(t.ws, 'editor', t.brandA);
    await grant(t.ws, u.id, 'editor', t.brandB);
    const team = await createTeam(await t.adm(), { name: 'B team' });
    await addTeamGrant(await t.adm(), team.id, { role: 'viewer', brand_id: t.brandB });
    await addTeamMember(await t.adm(), team.id, { user_id: u.id });
    const r = await reduceScope(await t.adm(), u.id, { brand_ids: [t.brandB] });
    expect(r).toMatchObject({ revoked: 1, still_via_teams: [t.brandB] });
    const ctx = await v2Ctx(u.id, t.ws);
    expect(authorize(ctx.access.authz!, 'content.edit', { brandId: t.brandB }).allowed).toBe(false);
    expect(authorize(ctx.access.authz!, 'content.read', { brandId: t.brandB }).allowed).toBe(true); // via team (reported)
    expect(authorize(ctx.access.authz!, 'content.edit', { brandId: t.brandA }).allowed).toBe(true);
    // Suspension keeps grants (reactivation restores them) but denies everything meanwhile.
    await suspendMember(await t.adm(), u.id, { reason: 'investigation' });
    await expect(v2Ctx(u.id, t.ws)).rejects.toMatchObject({ code: 'forbidden' });
    expect((await testPool().query(`SELECT count(*)::int n FROM scoped_role_grants WHERE workspace_id=$1 AND user_id=$2 AND revoked_at IS NULL`, [t.ws, u.id])).rows[0].n).toBe(1);
    // Admins cannot suspend owners; nobody suspends themselves.
    await expect(suspendMember(await t.adm(), t.owner.id, {})).rejects.toMatchObject({ code: 'forbidden' });
    await expect(suspendMember(await t.adm(), t.admin.id, {})).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('handover reassigns drafts and scheduled authority only to authorised members, never exposing other brands', async () => {
    const t = await agency();
    const leaver = await member(t.ws, 'brand_manager', t.brandA);
    await grant(t.ws, leaver.id, 'editor', t.brandB);
    const a = await member(t.ws, 'brand_manager', t.brandA); // authorised on A only
    const pA = (await testPool().query<{ id: string }>(`INSERT INTO posts(workspace_id, brand_id, created_by) VALUES ($1,$2,$3) RETURNING id`, [t.ws, t.brandA, leaver.id])).rows[0]!.id;
    const pB = (await testPool().query<{ id: string }>(`INSERT INTO posts(workspace_id, brand_id, created_by) VALUES ($1,$2,$3) RETURNING id`, [t.ws, t.brandB, leaver.id])).rows[0]!.id;
    const pv = await handoverPreview(await t.adm(), leaver.id);
    expect(pv.drafts.count).toBe(2);
    expect(pv.candidates.find((c) => c.user_id === a.id)).toMatchObject({ can_edit: [t.brandA] });
    const r = await reassignWork(await t.adm(), leaver.id, { to_user_id: a.id, items: ['drafts'] });
    expect(r).toMatchObject({ drafts: 1, skipped_unauthorized: 1 });
    const rows = (await testPool().query(`SELECT id, assignee_user_id, created_by FROM posts WHERE id = ANY($1::uuid[])`, [[pA, pB]])).rows;
    expect(rows.find((x) => x.id === pA)).toMatchObject({ assignee_user_id: a.id, created_by: leaver.id }); // author kept
    expect(rows.find((x) => x.id === pB)).toMatchObject({ assignee_user_id: null });
    // A brand-A-only team manager sees no brand-B detail in the preview.
    await expect(reassignWork(await t.adm(), leaver.id, { to_user_id: leaver.id })).rejects.toMatchObject({ code: 'validation_failed' });
    const stranger = (await agency()).admin;
    await expect(reassignWork(await t.adm(), leaver.id, { to_user_id: stranger.id })).rejects.toMatchObject({ code: 'validation_failed' });
  });
});

describe('last owner and ownership transfer (§12.8)', () => {
  it('concurrent owner removals can never remove the last owner', async () => {
    const t = await agency();
    const second = await createUser();
    await addMember(t.ws, second.id, 'owner');
    const c1 = await v2Ctx(t.owner.id, t.ws);
    const c2 = await v2Ctx(second.id, t.ws);
    const res = await Promise.allSettled([removeMember(c1, second.id), removeMember(c2, t.owner.id)]);
    expect(res.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    const owners = (await testPool().query(`SELECT DISTINCT g.user_id FROM scoped_role_grants g JOIN memberships m ON m.workspace_id=g.workspace_id AND m.user_id=g.user_id
      WHERE g.workspace_id=$1 AND g.role='owner' AND g.revoked_at IS NULL AND m.status='active'`, [t.ws])).rows;
    expect(owners).toHaveLength(1);
    // And the remaining sole owner cannot be removed, suspended or demoted.
    const remaining = owners[0].user_id as string;
    await expect(removeMember(await v2Ctx(remaining, t.ws), remaining)).rejects.toMatchObject({ code: 'invalid_state' });
    await expect(suspendMember(await t.adm(), remaining, {})).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('transfer needs fresh assurance on both sides and acceptance by the new owner; atomic; notified', async () => {
    const t = await agency();
    const target = await member(t.ws, 'editor', t.brandA);
    await expect(proposeOwnershipTransfer(await t.adm(), { to_user_id: target.id })).rejects.toMatchObject({ code: 'forbidden' });
    const stale = await v2Ctx(t.owner.id, t.ws, { authTime: new Date(Date.now() - 3600_000).toISOString() });
    await expect(proposeOwnershipTransfer(stale, { to_user_id: target.id })).rejects.toMatchObject({ code: 'step_up_required' });
    const noMfa = await v2Ctx(t.owner.id, t.ws, { mfaVerified: false });
    await expect(proposeOwnershipTransfer(noMfa, { to_user_id: target.id })).rejects.toMatchObject({ code: 'mfa_required' });
    const tr = await proposeOwnershipTransfer(await t.own(), { to_user_id: target.id, keep_previous_owner_as: 'admin' });
    await expect(proposeOwnershipTransfer(await t.own(), { to_user_id: t.admin.id })).rejects.toMatchObject({ code: 'conflict' });
    expect((await listOwnershipTransfers(await v2Ctx(target.id, t.ws))).items.map((x) => x.id)).toEqual([tr.id]);
    // Nothing changes until the new owner accepts; only they can, and only with fresh authentication.
    expect(authorize((await v2Ctx(target.id, t.ws)).access.authz!, 'members.manage').allowed).toBe(false);
    await expect(acceptOwnershipTransfer(await t.adm(), tr.id)).rejects.toMatchObject({ code: 'not_found' });
    await expect(acceptOwnershipTransfer(await v2Ctx(target.id, t.ws, { authTime: new Date(Date.now() - 3600_000).toISOString() }), tr.id))
      .rejects.toMatchObject({ code: 'step_up_required' });
    const done = await acceptOwnershipTransfer(await v2Ctx(target.id, t.ws), tr.id);
    expect(done.status).toBe('accepted');
    expect(await loadAccess(target.id, t.ws, testPool())).toMatchObject({ role: 'owner', brandIds: null });
    expect(await loadAccess(t.owner.id, t.ws, testPool())).toMatchObject({ role: 'admin' });
    await expect(acceptOwnershipTransfer(await v2Ctx(target.id, t.ws), tr.id)).rejects.toMatchObject({ code: 'invalid_state' });
    const notes = (await testPool().query(`SELECT user_id FROM notifications WHERE workspace_id=$1 AND kind='ownership.transferred'`, [t.ws])).rows.map((r) => r.user_id);
    expect(notes).toEqual(expect.arrayContaining([t.owner.id, target.id]));
    expect((await testPool().query(`SELECT count(*)::int n FROM audit_events WHERE workspace_id=$1 AND action='ownership.transferred'`, [t.ws])).rows[0].n).toBe(1);
    // A declined/cancelled transfer changes nothing.
    const tr2 = await proposeOwnershipTransfer(await v2Ctx(target.id, t.ws), { to_user_id: t.admin.id });
    await cancelOwnershipTransfer(await t.adm(), tr2.id);
    expect(await loadAccess(t.admin.id, t.ws, testPool())).toMatchObject({ role: 'admin' });
    // Granting owner through the grants API is impossible.
    await expect(addMemberGrant(await v2Ctx(target.id, t.ws), t.admin.id, { role: 'owner' })).rejects.toMatchObject({ code: 'validation_failed' });
  });
});
