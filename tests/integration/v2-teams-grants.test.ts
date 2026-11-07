// V2 stream B: teams, scoped grants, restrictions, delegation ceilings, effective access, workspace
// switching and fail-closed behaviour — all through the REAL policy path (v2Ctx → loadAccess → authorize).
// Spec §12 cases 1, 2, 3, 16, 22.
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { authorize, loadAccess, type AuthzState } from '@social-lite/services';
import { addMemberGrant, addRestriction, listMembers, revokeGrant, revokeRestriction } from '../../packages/services/src/members.js';
import { reactivateMember, suspendMember } from '../../packages/services/src/lifecycle.js';
import {
  addTeamGrant, addTeamMember, createTeam, getTeam, listTeams, removeTeamMember, setDelegationLimits, setTeamManager, updateTeam,
} from '../../packages/services/src/teams.js';
import { effectiveAccess, type PermissionAccess } from '../../packages/services/src/access.js';
import { assertExpectedWorkspace, sessionInfo, switchWorkspace } from '../../packages/services/src/workspaces.js';
import { createSession } from '../../packages/services/src/auth/session.js';
import { addMember, closeTestPool, createBrand, createUser, createWorkspace, grant, testPool, v2Ctx } from './helpers.js';

afterAll(closeTestPool);

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

/** A member with no grants (or the given one). */
async function member(ws: string, role?: string, brandId?: string, expiresAt?: Date) {
  const u = await createUser();
  await testPool().query(`INSERT INTO memberships(workspace_id, user_id, role) VALUES ($1,$2,'viewer')`, [ws, u.id]);
  if (role) await grant(ws, u.id, role, brandId, expiresAt);
  return u;
}

const perm = (list: PermissionAccess[], p: string) => list.find((x) => x.permission === p);
const policyVersion = async (ws: string) => Number((await testPool().query(`SELECT policy_version FROM workspaces WHERE id=$1`, [ws])).rows[0].policy_version);
const auditCount = async (ws: string, action: string) => (await testPool().query(`SELECT count(*)::int n FROM audit_events WHERE workspace_id=$1 AND action=$2`, [ws, action])).rows[0].n as number;

describe('teams + grants (§12.3): union of direct and team grants; deny/suspension/expiry override', () => {
  it('combines direct + team grants with sources, and every change bumps the policy version and is audited', async () => {
    const t = await agency();
    const u = await member(t.ws, 'editor', t.brandA);
    const v0 = await policyVersion(t.ws);
    const team = await createTeam(await t.adm(), { name: 'Publishing' });
    await addTeamGrant(await t.adm(), team.id, { role: 'publisher', brand_id: t.brandA });
    const after = await addTeamMember(await t.adm(), team.id, { user_id: u.id });
    expect(after.publishing).toBe(true);
    expect(after.members.map((m) => m.user_id)).toEqual([u.id]);
    expect(await policyVersion(t.ws)).toBeGreaterThanOrEqual(v0 + 3);
    expect(await auditCount(t.ws, 'team.member_added')).toBe(1);
    const added = await testPool().query(`SELECT diff FROM audit_events WHERE workspace_id=$1 AND action='team.member_added'`, [t.ws]);
    expect(added.rows[0].diff).toMatchObject({ privileged: true, publishing_team: true });

    const ea = await effectiveAccess(await t.adm(), u.id);
    expect(ea.policy_version).toBe(await policyVersion(t.ws));
    const a = ea.brands.find((b) => b.brand_id === t.brandA)!;
    expect(perm(a.permissions, 'content.edit')!.sources[0]).toMatchObject({ role: 'editor', via: 'direct' });
    expect(perm(a.permissions, 'content.publish')!.sources[0]).toMatchObject({ role: 'publisher', via: 'team', team_name: 'Publishing' });
    expect(ea.brands.find((b) => b.brand_id === t.brandB)).toBeUndefined();
    expect(ea.workspace).toEqual([]);
    // The member's request context reflects both.
    const ctx = await v2Ctx(u.id, t.ws);
    expect(authorize(ctx.access.authz!, 'content.publish', { brandId: t.brandA }).allowed).toBe(true);
    expect(authorize(ctx.access.authz!, 'content.publish', { brandId: t.brandB }).allowed).toBe(false);

    // Explicit restriction overrides the team allow.
    const m = await addRestriction(await t.adm(), u.id, { brand_id: t.brandA, actions: ['content.publish'], reason: 'review' });
    expect(m.restrictions).toBe(1);
    const ea2 = await effectiveAccess(await t.adm(), u.id);
    expect(perm(ea2.brands.find((b) => b.brand_id === t.brandA)!.permissions, 'content.publish')).toMatchObject({ allowed: false, reason: 'restricted' });
    expect(ea2.restrictions).toHaveLength(1);
    await revokeRestriction(await t.adm(), ea2.restrictions[0]!.id);
    expect(perm((await effectiveAccess(await t.adm(), u.id)).brands.find((b) => b.brand_id === t.brandA)!.permissions, 'content.publish')!.allowed).toBe(true);

    // Suspension overrides everything; reactivation restores; both are history rows.
    await suspendMember(await t.adm(), u.id, { reason: 'leave' });
    await expect(v2Ctx(u.id, t.ws)).rejects.toMatchObject({ code: 'forbidden' });
    expect((await listMembers(await t.adm(), { status: 'suspended' })).members.map((x) => x.user_id)).toEqual([u.id]);
    await reactivateMember(await t.adm(), u.id);
    await v2Ctx(u.id, t.ws);
    const hist = await testPool().query(`SELECT to_status FROM membership_status_history WHERE workspace_id=$1 AND user_id=$2 ORDER BY id`, [t.ws, u.id]);
    expect(hist.rows.map((r) => r.to_status)).toEqual(['suspended', 'active']);

    // Removing from the team removes the team-derived permission.
    await removeTeamMember(await t.adm(), team.id, u.id);
    expect(authorize((await v2Ctx(u.id, t.ws)).access.authz!, 'content.publish', { brandId: t.brandA }).allowed).toBe(false);
    // Archived teams grant nothing.
    await addTeamMember(await t.adm(), team.id, { user_id: u.id });
    await updateTeam(await t.adm(), team.id, { archived: true });
    expect(authorize((await v2Ctx(u.id, t.ws)).access.authz!, 'content.publish', { brandId: t.brandA }).allowed).toBe(false);
    expect((await listTeams(await t.adm())).items.map((x) => x.id)).not.toContain(team.id);
  });

  it('expired grants give nothing at access time; revocation is immediate', async () => {
    const t = await agency();
    const u = await member(t.ws, 'publisher', t.brandA, new Date(Date.now() - 1000));
    await expect(v2Ctx(u.id, t.ws)).resolves.toMatchObject({ access: { brandIds: [] } });
    // Re-granting the same role reuses (and extends) the expired row: one active grant per scope.
    const m = await addMemberGrant(await t.adm(), u.id, { role: 'publisher', brand_id: t.brandA });
    expect(m.grants).toHaveLength(1);
    expect(m.grants[0]!.expires_at).toBeNull();
    expect((await v2Ctx(u.id, t.ws)).access.brandIds).toEqual([t.brandA]);
    await revokeGrant(await t.adm(), m.grants[0]!.id);
    expect((await v2Ctx(u.id, t.ws)).access.brandIds).toEqual([]);
    expect(await auditCount(t.ws, 'grant.revoked')).toBe(1);
  });
});

describe('delegation (§12.2): ceilings, no self-grant, no escalation, no mass assignment', () => {
  it('team managers act only within their delegation ceiling and never on themselves', async () => {
    const t = await agency();
    const mgr = await member(t.ws);
    const team = await createTeam(await t.adm(), { name: 'Editorial' });
    await addTeamGrant(await t.adm(), team.id, { role: 'editor', brand_id: t.brandA });
    await addTeamMember(await t.adm(), team.id, { user_id: mgr.id, is_manager: true });
    // Appointment gives the workspace team_manager grant (members.read / teams.read).
    expect((await listMembers(await t.adm())).members.find((m) => m.user_id === mgr.id)!.grants.map((g) => g.role).sort()).toEqual(['editor', 'team_manager']);
    const m = () => v2Ctx(mgr.id, t.ws);
    const target = await member(t.ws);
    // No ceiling yet → refused.
    await expect(addTeamMember(await m(), team.id, { user_id: target.id })).rejects.toMatchObject({ code: 'forbidden' });
    await setDelegationLimits(await t.adm(), team.id, { grantable_roles: ['editor'], brand_ids: [t.brandA] });
    const ok = await addTeamMember(await m(), team.id, { user_id: target.id });
    expect(ok.members.map((x) => x.user_id)).toContain(target.id);
    expect(authorize((await v2Ctx(target.id, t.ws)).access.authz!, 'content.edit', { brandId: t.brandA }).allowed).toBe(true);
    // Managers cannot appoint managers, add themselves, edit team grants or manage another team.
    const other = await member(t.ws);
    await expect(addTeamMember(await m(), team.id, { user_id: other.id, is_manager: true })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(addTeamMember(await m(), team.id, { user_id: mgr.id })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(addTeamGrant(await m(), team.id, { role: 'publisher', brand_id: t.brandA })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(setDelegationLimits(await m(), team.id, { grantable_roles: ['publisher'], brand_ids: [t.brandA] })).rejects.toMatchObject({ code: 'forbidden' });
    const team2 = await createTeam(await t.adm(), { name: 'Other team' });
    await setDelegationLimits(await t.adm(), team2.id, { grantable_roles: ['editor'], brand_ids: [t.brandA] });
    await expect(addTeamMember(await m(), team2.id, { user_id: other.id })).rejects.toMatchObject({ code: 'forbidden' });
    // Once the team holds more than the ceiling (publisher on A), the manager can no longer add people.
    await addTeamGrant(await t.adm(), team.id, { role: 'publisher', brand_id: t.brandA });
    await expect(addTeamMember(await m(), team.id, { user_id: other.id })).rejects.toMatchObject({ code: 'forbidden' });
    // A ceiling on Brand B does not cover Brand A grants.
    await setDelegationLimits(await t.adm(), team.id, { grantable_roles: ['editor', 'publisher'], brand_ids: [t.brandB] });
    await expect(addTeamMember(await m(), team.id, { user_id: other.id })).rejects.toMatchObject({ code: 'forbidden' });
    // Removing the manager flag removes the team_manager grant.
    await setTeamManager(await t.adm(), team.id, mgr.id, false);
    expect((await v2Ctx(mgr.id, t.ws)).access.authz!.subject.grants.some((g) => g.role === 'team_manager')).toBe(false);
  });

  it('nobody grants owner; only owners grant admin; no self-grant; editors cannot grant; ceilings cannot exceed the grantor', async () => {
    const t = await agency();
    const target = await member(t.ws);
    await expect(addMemberGrant(await t.own(), target.id, { role: 'owner' })).rejects.toMatchObject({ code: 'validation_failed' });
    await expect(addMemberGrant(await t.adm(), target.id, { role: 'admin' })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(addMemberGrant(await t.adm(), t.admin.id, { role: 'publisher', brand_id: t.brandA })).rejects.toMatchObject({ code: 'forbidden' });
    const ed = await member(t.ws, 'editor', t.brandA);
    await expect(addMemberGrant(await v2Ctx(ed.id, t.ws), target.id, { role: 'viewer', brand_id: t.brandA })).rejects.toMatchObject({ code: 'forbidden' });
    // Owner grants admin only with fresh authentication (sensitive role ⇒ step-up).
    const stale = await v2Ctx(t.owner.id, t.ws, { authTime: new Date(Date.now() - 3600_000).toISOString() });
    await expect(addMemberGrant(stale, target.id, { role: 'admin' })).rejects.toMatchObject({ code: 'step_up_required' });
    const noMfa = await v2Ctx(t.admin.id, t.ws, { mfaVerified: false });
    await expect(addMemberGrant(noMfa, target.id, { role: 'viewer' })).rejects.toMatchObject({ code: 'mfa_required' });
    const done = await addMemberGrant(await t.own(), target.id, { role: 'admin' });
    expect(done.grants.map((g) => g.role)).toContain('admin');
    expect(done.role).toBe('admin'); // legacy summary follows grants
    // Admins cannot revoke owner grants or touch owners.
    const ownerGrant = (await listMembers(await t.adm())).members.find((x) => x.user_id === t.owner.id)!.grants.find((g) => g.role === 'owner')!;
    await expect(revokeGrant(await t.adm(), ownerGrant.id)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(addRestriction(await t.adm(), t.owner.id, { actions: ['*'] })).rejects.toMatchObject({ code: 'forbidden' });
    // Last owner's grant cannot be revoked even by the owner.
    await expect(revokeGrant(await t.own(), ownerGrant.id)).rejects.toMatchObject({ code: 'invalid_state' });
  });

  it('server derives scope from ids (no mass assignment); cross-workspace brand/team/user ids are rejected (§12.1)', async () => {
    const t = await agency();
    const other = await agency();
    const target = await member(t.ws);
    // Cross-workspace brand id ⇒ same validation error as an unknown id.
    await expect(addMemberGrant(await t.adm(), target.id, { role: 'editor', brand_id: other.brandA })).rejects.toMatchObject({ code: 'validation_failed' });
    await expect(addMemberGrant(await t.adm(), target.id, { role: 'editor', brand_id: randomUUID() })).rejects.toMatchObject({ code: 'validation_failed' });
    // A connection id implies its brand; a mismatching brand is refused (scope is never client-asserted).
    const conn = (await testPool().query<{ id: string }>(`INSERT INTO connections(workspace_id, brand_id, provider, provider_account_id, display_name, status, is_mock) VALUES ($1,$2,'x',$3,'X','ready',true) RETURNING id`,
      [t.ws, t.brandA, `mock_${randomUUID()}`])).rows[0]!.id;
    await expect(addMemberGrant(await t.adm(), target.id, { role: 'publisher', brand_id: t.brandB, connection_id: conn })).rejects.toMatchObject({ code: 'validation_failed' });
    const g = await addMemberGrant(await t.adm(), target.id, { role: 'publisher', connection_id: conn });
    expect(g.grants[0]).toMatchObject({ role: 'publisher', scope_type: 'connection', brand_id: t.brandA, connection_id: conn, granted_by_email: t.admin.email });
    // Teams never span workspaces.
    const team = await createTeam(await t.adm(), { name: 'Team' });
    await expect(addTeamMember(await t.adm(), team.id, { user_id: other.admin.id })).rejects.toMatchObject({ code: 'validation_failed' });
    await expect(addTeamMember(await other.adm(), team.id, { user_id: other.admin.id })).rejects.toMatchObject({ code: 'not_found' });
    await expect(getTeam(await other.adm(), team.id)).rejects.toMatchObject({ code: 'not_found' });
    await expect(addTeamGrant(await t.adm(), team.id, { role: 'editor', brand_id: other.brandA })).rejects.toMatchObject({ code: 'validation_failed' });
    await expect(addTeamGrant(await t.adm(), team.id, { role: 'admin' })).rejects.toMatchObject({ code: 'validation_failed' });
    await expect(testPool().query(`INSERT INTO team_memberships(workspace_id, team_id, user_id) VALUES ($1,$2,$3)`, [t.ws, team.id, other.admin.id])).rejects.toThrow(/foreign key/);
    await expect(testPool().query(`INSERT INTO team_memberships(workspace_id, team_id, user_id) VALUES ($1,$2,$3)`, [other.ws, team.id, other.admin.id])).rejects.toThrow(/foreign key/);
    await expect(testPool().query(`INSERT INTO scoped_role_grants(workspace_id, principal_type, user_id, role, scope_type, brand_id) VALUES ($1,'user',$2,'editor','brand',$3)`,
      [t.ws, target.id, other.brandA])).rejects.toThrow(/foreign key/);
    // Effective access / member lookups of another workspace's user are not found.
    await expect(effectiveAccess(await t.adm(), other.admin.id)).rejects.toMatchObject({ code: 'not_found' });
    // Brand-scoped members cannot read the member directory at all.
    const ed = await member(t.ws, 'editor', t.brandA);
    await expect(listMembers(await v2Ctx(ed.id, t.ws))).rejects.toMatchObject({ code: 'forbidden' });
    await expect(effectiveAccess(await v2Ctx(ed.id, t.ws), target.id)).rejects.toMatchObject({ code: 'forbidden' });
    // …but may see their own effective access.
    expect((await effectiveAccess(await v2Ctx(ed.id, t.ws), ed.id)).brands.map((b) => b.brand_id)).toEqual([t.brandA]);
  });
});

describe('workspace switching (§12.16) and fail-closed policy (§12.22)', () => {
  it('switching returns only the new workspace’s brands/permissions; stale tabs are refused; suspended workspaces are not listed', async () => {
    const a = await agency();
    const b = await agency();
    const u = await member(a.ws, 'editor', a.brandA);
    await testPool().query(`INSERT INTO memberships(workspace_id, user_id, role) VALUES ($1,$2,'viewer')`, [b.ws, u.id]);
    await grant(b.ws, u.id, 'publisher', b.brandB);
    const { session } = await createSession(testPool(), u.id, { workspaceId: a.ws, mfaVerified: true, authTime: new Date() });
    const actor = { userId: u.id, email: u.email, name: null, sessionId: session.id };
    const inA = await sessionInfo(session, actor);
    expect(inA.brands.map((x) => x.id)).toEqual([a.brandA]);
    expect(inA.v2.permissions['content.edit']).toBe(true);
    expect(inA.v2.permissions['content.publish']).toBe(false);
    expect(inA.v2.brands[a.brandA]).toContain('content.edit');
    expect(inA.permissions['drafts.edit']).toBe(true);
    expect(inA.workspaces.map((w) => w.id).sort()).toEqual([a.ws, b.ws].sort());
    const inB = await switchWorkspace(session, actor, b.ws);
    expect(inB.workspace!.id).toBe(b.ws);
    expect(inB.brands.map((x) => x.id)).toEqual([b.brandB]);
    expect(inB.v2.permissions['content.edit']).toBe(false);
    expect(inB.v2.permissions['content.publish']).toBe(true);
    expect(JSON.stringify(inB)).not.toContain(a.brandA);
    // A tab still showing workspace A is refused after the switch (it must reload, never mix data).
    expect(() => assertExpectedWorkspace(b.ws, a.ws)).toThrow(expect.objectContaining({ code: 'conflict', details: expect.objectContaining({ reason: 'workspace_changed' }) }));
    expect(() => assertExpectedWorkspace(b.ws, b.ws)).not.toThrow();
    // The supplied id is never authority: switching to a workspace without membership is not found.
    const c = await agency();
    await expect(switchWorkspace(session, actor, c.ws)).rejects.toMatchObject({ code: 'not_found' });
    // Suspended in B ⇒ B disappears from the switcher and cannot be selected.
    await suspendMember(await b.adm(), u.id, {});
    const after = await sessionInfo({ ...session, activeWorkspaceId: a.ws }, actor);
    expect(after.workspaces.map((w) => w.id)).toEqual([a.ws]);
    await expect(switchWorkspace(session, actor, b.ws)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('authorization fails closed: broken policy state denies, missing membership denies, no owner fallback', async () => {
    const t = await agency();
    const ctx = await t.own();
    const broken = { ...ctx.access.authz!, subject: { ...ctx.access.authz!.subject, grants: null } } as unknown as AuthzState;
    expect(authorize(broken, 'content.read', { brandId: t.brandA })).toMatchObject({ allowed: false });
    const stranger = await createUser();
    expect(await loadAccess(stranger.id, t.ws, testPool())).toBeNull();
    await expect(v2Ctx(stranger.id, t.ws)).rejects.toMatchObject({ code: 'forbidden' });
    // A legacy V1 owner role without V2 grants gets nothing (no fallback to memberships.role).
    const legacyOwner = await createUser();
    await testPool().query(`INSERT INTO memberships(workspace_id, user_id, role) VALUES ($1,$2,'owner')`, [t.ws, legacyOwner.id]);
    const lc = await v2Ctx(legacyOwner.id, t.ws);
    expect(authorize(lc.access.authz!, 'members.manage').allowed).toBe(false);
    expect(lc.access.brandIds).toEqual([]);
  });
});
