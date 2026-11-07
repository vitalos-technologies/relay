// Teams (spec §3/§4): directory, team memberships, team managers, team grants and delegation ceilings.
//  - Team membership is separate from grants, but joining a team that holds grants IS a privilege grant:
//    it is ceiling-checked (actor must be able to delegate every team grant) and audited (privileged=true);
//    adding to a publishing team (content.publish) additionally requires fresh authentication for admins.
//  - Team managers (team_memberships.is_manager + a workspace 'team_manager' grant) may add/remove members
//    of THEIR team only when every team grant fits the team's delegation_limits (roles + brands). They can
//    never add themselves, appoint managers, change team grants or ceilings.
//  - Teams never span workspaces: composite FKs (workspace_id, team_id) / (workspace_id, user_id).
import { AppError, forbidden, notFound, type RolePreset } from '@social-lite/core';
import { getPool, many, maybeOne, withTx, type Queryable } from '@social-lite/db';
import { audit } from './audit.js';
import type { Ctx } from './context.js';
import { canAnywhere } from './access.js';
import {
  TEAM_ROLES, assertDelegable, commitPolicyChange, isPublishingRole, isRolePreset, mayDelegate, needsStepUp, normalizeGrants, upsertGrant, type GrantInput,
} from './grants.js';
import { assertUuid, authorizeCtx, isUuid, requireAction } from './tenancy.js';

export interface TeamGrantDto { id: string; role: RolePreset; scope_type: string; brand_id: string | null; brand_name: string | null; connection_id: string | null; connection_name: string | null }
export interface TeamDto {
  id: string; name: string; description: string | null; created_at: string; archived_at: string | null;
  member_count: number; managers: Array<{ user_id: string; email: string; name: string | null }>;
  grants: TeamGrantDto[]; publishing: boolean;
  delegation: { grantable_roles: string[]; brand_ids: string[] } | null;
  /** Caller may add/remove members of this team (admin, or manager within the ceiling). */
  can_manage_members: boolean; can_edit: boolean;
}
export interface TeamMemberDto { user_id: string; email: string; name: string | null; is_manager: boolean; status: string; added_at: string }

interface TeamRow { id: string; name: string; description: string | null; created_at: Date; archived_at: Date | null; member_count: number }

const visibleBrand = (ctx: Ctx, b: string | null) => !b || ctx.access.brandIds === null || ctx.access.brandIds.includes(b);

async function teamGrants(db: Queryable, workspaceId: string, teamIds: string[]) {
  if (!teamIds.length) return [];
  return many<TeamGrantDto & { team_id: string }>(db,
    `SELECT g.id, g.team_id, g.role, g.scope_type, g.brand_id, b.name AS brand_name, g.connection_id, c.display_name AS connection_name
       FROM scoped_role_grants g LEFT JOIN brands b ON b.id=g.brand_id LEFT JOIN connections c ON c.id=g.connection_id
      WHERE g.workspace_id=$1 AND g.team_id = ANY($2::uuid[]) AND g.revoked_at IS NULL ORDER BY b.name NULLS FIRST, g.role`, [workspaceId, teamIds]);
}

async function delegationFor(db: Queryable, workspaceId: string, teamIds: string[]) {
  if (!teamIds.length) return [];
  return many<{ team_id: string; grantable_roles: string[]; brand_ids: string[] }>(db,
    `SELECT team_id, grantable_roles, brand_ids FROM delegation_limits WHERE workspace_id=$1 AND team_id = ANY($2::uuid[])`, [workspaceId, teamIds]);
}

async function managedTeamIds(db: Queryable, ctx: Ctx): Promise<Set<string>> {
  if (!authorizeCtx(ctx, 'teams.read').allowed) return new Set();
  const rows = await many<{ team_id: string }>(db, `SELECT team_id FROM team_memberships WHERE workspace_id=$1 AND user_id=$2 AND is_manager`, [ctx.access.workspaceId, ctx.actor.userId]);
  return new Set(rows.map((r) => r.team_id));
}

/** Every team grant fits the ceiling (roles AND brands; workspace-wide grants never fit a manager ceiling). */
function withinCeiling(grants: Array<{ role: string; brand_id: string | null }>, ceiling: { grantable_roles: string[]; brand_ids: string[] } | undefined): boolean {
  if (!ceiling) return grants.length === 0;
  return grants.every((g) => ceiling.grantable_roles.includes(g.role) && !!g.brand_id && ceiling.brand_ids.includes(g.brand_id));
}

async function buildDtos(db: Queryable, ctx: Ctx, rows: TeamRow[]): Promise<TeamDto[]> {
  const ids = rows.map((r) => r.id);
  const grants = await teamGrants(db, ctx.access.workspaceId, ids);
  const limits = await delegationFor(db, ctx.access.workspaceId, ids);
  const managers = ids.length ? await many<{ team_id: string; user_id: string; email: string; name: string | null }>(db,
    `SELECT tm.team_id, tm.user_id, u.email, u.name FROM team_memberships tm JOIN users u ON u.id=tm.user_id WHERE tm.workspace_id=$1 AND tm.team_id = ANY($2::uuid[]) AND tm.is_manager ORDER BY u.email`,
    [ctx.access.workspaceId, ids]) : [];
  const admin = authorizeCtx(ctx, 'teams.manage').allowed || authorizeCtx(ctx, 'teams.manage').reason === 'mfa_required';
  const mine = await managedTeamIds(db, ctx);
  return rows.map((t) => {
    const tg = grants.filter((g) => g.team_id === t.id);
    const lim = limits.find((l) => l.team_id === t.id);
    return {
      id: t.id, name: t.name, description: t.description, created_at: t.created_at.toISOString(), archived_at: t.archived_at?.toISOString() ?? null,
      member_count: t.member_count, managers: managers.filter((m) => m.team_id === t.id).map(({ user_id, email, name }) => ({ user_id, email, name })),
      grants: tg.filter((g) => visibleBrand(ctx, g.brand_id)).map(({ team_id: _t, ...g }) => g),
      publishing: tg.some((g) => isPublishingRole(g.role)),
      delegation: lim ? { grantable_roles: lim.grantable_roles, brand_ids: lim.brand_ids.filter((b) => visibleBrand(ctx, b)) } : null,
      can_manage_members: !t.archived_at && (admin || (mine.has(t.id) && withinCeiling(tg, lim))),
      can_edit: !t.archived_at && admin,
    };
  });
}

const TEAM_SQL = `SELECT t.id, t.name, t.description, t.created_at, t.archived_at,
    (SELECT count(*)::int FROM team_memberships tm JOIN memberships m ON m.workspace_id=tm.workspace_id AND m.user_id=tm.user_id AND m.status <> 'removed'
      WHERE tm.team_id=t.id) AS member_count
  FROM teams t WHERE t.workspace_id=$1`;

export async function listTeams(ctx: Ctx, opts: { archived?: boolean; q?: string } = {}, db: Queryable = getPool()): Promise<{ items: TeamDto[] }> {
  requireAction(ctx, 'teams.read');
  const params: unknown[] = [ctx.access.workspaceId];
  let where = opts.archived ? ' AND t.archived_at IS NOT NULL' : ' AND t.archived_at IS NULL';
  if (opts.q) { params.push(`%${opts.q.slice(0, 80).replace(/[\\%_]/g, (c) => `\\${c}`)}%`); where += ` AND t.name ILIKE $${params.length}`; }
  const rows = await many<TeamRow>(db, `${TEAM_SQL}${where} ORDER BY lower(t.name) LIMIT 500`, params);
  return { items: await buildDtos(db, ctx, rows) };
}

async function loadTeam(db: Queryable, ctx: Ctx, teamId: string, lock = false): Promise<TeamRow> {
  assertUuid(teamId, 'Team');
  if (lock) await db.query(`SELECT 1 FROM teams WHERE id=$1 AND workspace_id=$2 FOR UPDATE`, [teamId, ctx.access.workspaceId]);
  const t = await maybeOne<TeamRow>(db, `${TEAM_SQL} AND t.id=$2`, [ctx.access.workspaceId, teamId]);
  if (!t) throw notFound('Team');
  return t;
}

export async function getTeam(ctx: Ctx, teamId: string, db: Queryable = getPool()): Promise<TeamDto & { members: TeamMemberDto[] }> {
  requireAction(ctx, 'teams.read');
  const t = await loadTeam(db, ctx, teamId);
  const [dto] = await buildDtos(db, ctx, [t]);
  const members = await many<{ user_id: string; email: string; name: string | null; is_manager: boolean; status: string; created_at: Date }>(db,
    `SELECT tm.user_id, u.email, u.name, tm.is_manager, m.status, tm.created_at FROM team_memberships tm JOIN users u ON u.id=tm.user_id
       JOIN memberships m ON m.workspace_id=tm.workspace_id AND m.user_id=tm.user_id AND m.status <> 'removed'
      WHERE tm.team_id=$1 ORDER BY tm.is_manager DESC, lower(u.email)`, [teamId]);
  return { ...dto!, members: members.map((m) => ({ user_id: m.user_id, email: m.email, name: m.name, is_manager: m.is_manager, status: m.status, added_at: m.created_at.toISOString() })) };
}

function validName(name: unknown): string {
  const n = typeof name === 'string' ? name.trim() : '';
  if (n.length < 1 || n.length > 80) throw new AppError('validation_failed', 'Name must be 1-80 characters', { name: '1-80 characters' });
  return n;
}

export async function createTeam(ctx: Ctx, input: { name: string; description?: string | null }): Promise<TeamDto> {
  requireAction(ctx, 'teams.manage');
  const name = validName(input.name);
  return withTx(async (tx) => {
    const dup = await maybeOne(tx, `SELECT 1 FROM teams WHERE workspace_id=$1 AND lower(name)=lower($2)`, [ctx.access.workspaceId, name]);
    if (dup) throw new AppError('conflict', 'A team with this name already exists', { name: 'Already used' });
    const r = await maybeOne<{ id: string }>(tx, `INSERT INTO teams(workspace_id, name, description, created_by) VALUES ($1,$2,$3,$4) RETURNING id`,
      [ctx.access.workspaceId, name, input.description?.trim().slice(0, 300) || null, ctx.actor.userId]);
    const pc = await commitPolicyChange(tx, ctx.access.workspaceId, []);
    await audit(tx, { workspaceId: ctx.access.workspaceId, actorUserId: ctx.actor.userId, action: 'team.created', resourceType: 'team', resourceId: r!.id, diff: { name, policy_version: pc.policyVersion }, correlationId: ctx.correlationId });
    return (await buildDtos(tx, ctx, [await loadTeam(tx, ctx, r!.id)]))[0]!;
  });
}

async function teamMemberIds(db: Queryable, teamId: string): Promise<string[]> {
  return (await many<{ user_id: string }>(db, `SELECT user_id FROM team_memberships WHERE team_id=$1`, [teamId])).map((r) => r.user_id);
}

export async function updateTeam(ctx: Ctx, teamId: string, patch: { name?: string; description?: string | null; archived?: boolean }): Promise<TeamDto> {
  requireAction(ctx, 'teams.manage');
  return withTx(async (tx) => {
    const t = await loadTeam(tx, ctx, teamId, true);
    const name = patch.name !== undefined ? validName(patch.name) : t.name;
    if (name.toLowerCase() !== t.name.toLowerCase()) {
      const dup = await maybeOne(tx, `SELECT 1 FROM teams WHERE workspace_id=$1 AND lower(name)=lower($2) AND id<>$3`, [ctx.access.workspaceId, name, teamId]);
      if (dup) throw new AppError('conflict', 'A team with this name already exists', { name: 'Already used' });
    }
    const archive = patch.archived === undefined ? null : patch.archived;
    await tx.query(`UPDATE teams SET name=$2, description=CASE WHEN $3::boolean THEN $4 ELSE description END,
                      archived_at=CASE WHEN $5::boolean IS NULL THEN archived_at WHEN $5 THEN coalesce(archived_at, now()) ELSE NULL END WHERE id=$1`,
      [teamId, name, patch.description !== undefined, patch.description?.trim().slice(0, 300) || null, archive]);
    // Archiving removes the team's grants from every member (loadUserAuthz ignores archived teams).
    const pc = await commitPolicyChange(tx, ctx.access.workspaceId, archive !== null ? await teamMemberIds(tx, teamId) : []);
    await audit(tx, { workspaceId: ctx.access.workspaceId, actorUserId: ctx.actor.userId, action: archive === true ? 'team.archived' : archive === false ? 'team.restored' : 'team.updated',
      resourceType: 'team', resourceId: teamId, diff: { name: name !== t.name ? { from: t.name, to: name } : undefined, held_publications: pc.held, policy_version: pc.policyVersion },
      correlationId: ctx.correlationId });
    return (await buildDtos(tx, ctx, [await loadTeam(tx, ctx, teamId)]))[0]!;
  });
}

// ------------------------------------------------------------------ team grants & ceilings (admins/owners)

export async function addTeamGrant(ctx: Ctx, teamId: string, input: GrantInput): Promise<TeamDto> {
  requireAction(ctx, 'teams.manage');
  return withTx(async (tx) => {
    const t = await loadTeam(tx, ctx, teamId, true);
    if (t.archived_at) throw new AppError('invalid_state', 'Restore this team first.');
    const [g] = await normalizeGrants(tx, ctx.access.workspaceId, [input], { allowed: TEAM_ROLES });
    assertDelegable(ctx, [g!]);
    const members = await teamMemberIds(tx, teamId);
    if (members.includes(ctx.actor.userId) && !authorizeCtx(ctx, 'workspace.transfer_owner').allowed) {
      // No self-escalation through your own team (owners excepted: they already hold everything).
      throw forbidden('You cannot add access to a team you belong to. Ask another admin.');
    }
    if (needsStepUp([g!])) requireAction(ctx, 'teams.manage', { stepUp: true });
    const r = await upsertGrant(tx, { workspaceId: ctx.access.workspaceId, principal: { teamId }, grant: g!, grantedBy: ctx.actor.userId, source: 'manual' });
    const pc = await commitPolicyChange(tx, ctx.access.workspaceId, members);
    await audit(tx, { workspaceId: ctx.access.workspaceId, brandId: g!.brandId, actorUserId: ctx.actor.userId, action: 'team.grant_added', resourceType: 'team', resourceId: teamId,
      diff: { grant_id: r.id, role: g!.role, brand_id: g!.brandId, connection_id: g!.connectionId, members: members.length, policy_version: pc.policyVersion }, correlationId: ctx.correlationId });
    return (await buildDtos(tx, ctx, [await loadTeam(tx, ctx, teamId)]))[0]!;
  });
}

export async function revokeTeamGrant(ctx: Ctx, teamId: string, grantId: string): Promise<TeamDto> {
  requireAction(ctx, 'teams.manage');
  assertUuid(grantId, 'Grant');
  return withTx(async (tx) => {
    await loadTeam(tx, ctx, teamId, true);
    const g = await maybeOne<{ id: string; role: RolePreset; brand_id: string | null; connection_id: string | null }>(tx,
      `SELECT id, role, brand_id, connection_id FROM scoped_role_grants WHERE id=$1 AND team_id=$2 AND workspace_id=$3 AND revoked_at IS NULL FOR UPDATE`,
      [grantId, teamId, ctx.access.workspaceId]);
    if (!g || !visibleBrand(ctx, g.brand_id)) throw notFound('Grant');
    if (!mayDelegate(ctx, { role: g.role, brandId: g.brand_id, connectionId: g.connection_id })) throw forbidden('You cannot remove a role you could not grant.');
    await tx.query(`UPDATE scoped_role_grants SET revoked_at=now(), revoked_by=$2, revoke_reason='manual' WHERE id=$1`, [g.id, ctx.actor.userId]);
    const members = await teamMemberIds(tx, teamId);
    const pc = await commitPolicyChange(tx, ctx.access.workspaceId, members);
    await audit(tx, { workspaceId: ctx.access.workspaceId, brandId: g.brand_id, actorUserId: ctx.actor.userId, action: 'team.grant_revoked', resourceType: 'team', resourceId: teamId,
      diff: { grant_id: g.id, role: g.role, brand_id: g.brand_id, held_publications: pc.held, policy_version: pc.policyVersion }, correlationId: ctx.correlationId });
    return (await buildDtos(tx, ctx, [await loadTeam(tx, ctx, teamId)]))[0]!;
  });
}

/** Ceiling for this team's managers. Only roles/brands the admin could delegate themselves. */
export async function setDelegationLimits(ctx: Ctx, teamId: string, input: { grantable_roles: string[]; brand_ids: string[] }): Promise<TeamDto> {
  requireAction(ctx, 'teams.manage');
  const roles = [...new Set(input.grantable_roles ?? [])];
  const brands = [...new Set(input.brand_ids ?? [])];
  if (roles.some((r) => !isRolePreset(r) || !TEAM_ROLES.includes(r))) throw new AppError('validation_failed', 'Unknown role', { grantable_roles: 'Team roles only' });
  if (brands.some((b) => !isUuid(b))) throw new AppError('validation_failed', 'Unknown brand', { brand_ids: 'Unknown brand' });
  return withTx(async (tx) => {
    await loadTeam(tx, ctx, teamId, true);
    if (brands.length) {
      const found = await many<{ id: string }>(tx, `SELECT id FROM brands WHERE workspace_id=$1 AND id = ANY($2::uuid[])`, [ctx.access.workspaceId, brands]);
      if (found.length !== brands.length || brands.some((b) => !visibleBrand(ctx, b))) throw new AppError('validation_failed', 'Unknown brand', { brand_ids: 'Unknown brand' });
    }
    for (const r of roles) for (const b of brands) {
      if (!mayDelegate(ctx, { role: r as RolePreset, brandId: b, connectionId: null })) throw forbidden('The ceiling cannot exceed what you can delegate yourself.');
    }
    await tx.query(
      `INSERT INTO delegation_limits(workspace_id, team_id, grantable_roles, brand_ids, updated_by) VALUES ($1,$2,$3,$4::uuid[],$5)
       ON CONFLICT (team_id) DO UPDATE SET grantable_roles=EXCLUDED.grantable_roles, brand_ids=EXCLUDED.brand_ids, updated_by=EXCLUDED.updated_by, updated_at=now()`,
      [ctx.access.workspaceId, teamId, roles, brands, ctx.actor.userId]);
    const pc = await commitPolicyChange(tx, ctx.access.workspaceId, []);
    await audit(tx, { workspaceId: ctx.access.workspaceId, actorUserId: ctx.actor.userId, action: 'team.delegation_set', resourceType: 'team', resourceId: teamId,
      diff: { grantable_roles: roles, brand_ids: brands, policy_version: pc.policyVersion }, correlationId: ctx.correlationId });
    return (await buildDtos(tx, ctx, [await loadTeam(tx, ctx, teamId)]))[0]!;
  });
}

// ------------------------------------------------------------------ team membership (admins, or managers within the ceiling)

interface Authority { kind: 'admin' | 'manager'; grants: Array<{ role: RolePreset; brand_id: string | null; connection_id: string | null }> }

async function memberAuthority(tx: Queryable, ctx: Ctx, teamId: string): Promise<Authority> {
  const grants = await many<{ role: RolePreset; brand_id: string | null; connection_id: string | null }>(tx,
    `SELECT role, brand_id, connection_id FROM scoped_role_grants WHERE team_id=$1 AND workspace_id=$2 AND revoked_at IS NULL`, [teamId, ctx.access.workspaceId]);
  const asAdmin = authorizeCtx(ctx, 'teams.manage');
  if (asAdmin.allowed) {
    // Adding to a team is granting its access: the admin must be able to delegate every team grant.
    if (grants.some((g) => !mayDelegate(ctx, { role: g.role, brandId: g.brand_id, connectionId: g.connection_id }))) {
      throw forbidden('You cannot add people to a team whose access you could not grant yourself.');
    }
    return { kind: 'admin', grants };
  }
  if (asAdmin.reason === 'mfa_required') requireAction(ctx, 'teams.manage'); // throws mfa_required
  const isManager = (await managedTeamIds(tx, ctx)).has(teamId);
  if (!isManager) throw forbidden('Only workspace admins or this team’s managers can change its members.');
  const ceiling = (await delegationFor(tx, ctx.access.workspaceId, [teamId]))[0];
  if (!withinCeiling(grants, ceiling)) {
    throw forbidden('This team’s access exceeds your delegation limit. Ask a workspace admin.');
  }
  // …and must personally hold what they hand out (core canDelegate + not restricted), per PERMISSIONS_MATRIX.
  if (grants.some((g) => !mayDelegate(ctx, { role: g.role, brandId: g.brand_id, connectionId: g.connection_id }))) {
    throw forbidden('This team’s access exceeds what you can delegate.');
  }
  return { kind: 'manager', grants };
}

export async function addTeamMember(ctx: Ctx, teamId: string, input: { user_id: string; is_manager?: boolean }): Promise<TeamDto & { members: TeamMemberDto[] }> {
  if (!isUuid(input.user_id)) throw new AppError('validation_failed', 'Choose a member', { user_id: 'Required' });
  if (!canAnywhere(ctx, 'teams.read')) throw forbidden();
  await withTx(async (tx) => {
    const t = await loadTeam(tx, ctx, teamId, true);
    if (t.archived_at) throw new AppError('invalid_state', 'Restore this team first.');
    const auth = await memberAuthority(tx, ctx, teamId);
    if (input.user_id === ctx.actor.userId && auth.kind === 'manager') throw forbidden('You cannot add yourself to a team.');
    if (input.user_id === ctx.actor.userId && auth.grants.length && !authorizeCtx(ctx, 'workspace.transfer_owner').allowed) throw forbidden('You cannot add yourself to a team that grants access. Ask another admin.');
    if (input.is_manager && auth.kind !== 'admin') throw forbidden('Only workspace admins can appoint team managers.');
    // Same workspace + active membership (composite FK is the backstop for cross-workspace ids).
    const m = await maybeOne<{ status: string }>(tx, `SELECT status FROM memberships WHERE workspace_id=$1 AND user_id=$2`, [ctx.access.workspaceId, input.user_id]);
    if (!m || m.status !== 'active') throw new AppError('validation_failed', 'Choose an active member of this workspace', { user_id: 'Not an active member' });
    const publishing = auth.grants.some((g) => isPublishingRole(g.role));
    if (publishing && auth.kind === 'admin' && needsStepUp(auth.grants)) requireAction(ctx, 'teams.manage', { stepUp: true });
    const ins = await tx.query(
      `INSERT INTO team_memberships(workspace_id, team_id, user_id, is_manager, added_by) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (team_id, user_id) DO UPDATE SET is_manager = team_memberships.is_manager OR EXCLUDED.is_manager RETURNING (xmax = 0) AS inserted`,
      [ctx.access.workspaceId, teamId, input.user_id, !!input.is_manager, ctx.actor.userId]);
    if (input.is_manager) await ensureManagerGrant(tx, ctx, input.user_id);
    const pc = await commitPolicyChange(tx, ctx.access.workspaceId, [input.user_id]);
    await audit(tx, { workspaceId: ctx.access.workspaceId, actorUserId: ctx.actor.userId, action: 'team.member_added', resourceType: 'team', resourceId: teamId,
      diff: { user_id: input.user_id, is_manager: !!input.is_manager, via: auth.kind, privileged: auth.grants.length > 0, publishing_team: publishing,
        grants: auth.grants.map((g) => `${g.role}@${g.brand_id ?? 'workspace'}`), inserted: (ins.rows[0] as { inserted: boolean } | undefined)?.inserted ?? false, policy_version: pc.policyVersion },
      correlationId: ctx.correlationId });
  });
  return getTeam(ctx, teamId);
}

export async function removeTeamMember(ctx: Ctx, teamId: string, userId: string): Promise<TeamDto & { members: TeamMemberDto[] }> {
  assertUuid(userId, 'Member');
  if (!canAnywhere(ctx, 'teams.read')) throw forbidden();
  await withTx(async (tx) => {
    await loadTeam(tx, ctx, teamId, true);
    const auth = await memberAuthority(tx, ctx, teamId);
    const tm = await maybeOne<{ is_manager: boolean }>(tx, `SELECT is_manager FROM team_memberships WHERE team_id=$1 AND user_id=$2 AND workspace_id=$3 FOR UPDATE`, [teamId, userId, ctx.access.workspaceId]);
    if (!tm) throw notFound('Team member');
    if (tm.is_manager && auth.kind !== 'admin') throw forbidden('Only workspace admins can remove a team manager.');
    await tx.query(`DELETE FROM team_memberships WHERE team_id=$1 AND user_id=$2`, [teamId, userId]);
    if (tm.is_manager) await dropManagerGrantIfUnused(tx, ctx, userId);
    const pc = await commitPolicyChange(tx, ctx.access.workspaceId, [userId]);
    await audit(tx, { workspaceId: ctx.access.workspaceId, actorUserId: ctx.actor.userId, action: 'team.member_removed', resourceType: 'team', resourceId: teamId,
      diff: { user_id: userId, was_manager: tm.is_manager, via: auth.kind, held_publications: pc.held, policy_version: pc.policyVersion }, correlationId: ctx.correlationId });
  });
  return getTeam(ctx, teamId);
}

export async function setTeamManager(ctx: Ctx, teamId: string, userId: string, isManager: boolean): Promise<TeamDto & { members: TeamMemberDto[] }> {
  requireAction(ctx, 'teams.manage');
  assertUuid(userId, 'Member');
  await withTx(async (tx) => {
    await loadTeam(tx, ctx, teamId, true);
    if (userId === ctx.actor.userId) throw forbidden('You cannot change your own access');
    const tm = await maybeOne(tx, `SELECT 1 FROM team_memberships WHERE team_id=$1 AND user_id=$2 AND workspace_id=$3 FOR UPDATE`, [teamId, userId, ctx.access.workspaceId]);
    if (!tm) throw notFound('Team member');
    await tx.query(`UPDATE team_memberships SET is_manager=$3 WHERE team_id=$1 AND user_id=$2`, [teamId, userId, isManager]);
    if (isManager) await ensureManagerGrant(tx, ctx, userId);
    else await dropManagerGrantIfUnused(tx, ctx, userId);
    const pc = await commitPolicyChange(tx, ctx.access.workspaceId, [userId]);
    await audit(tx, { workspaceId: ctx.access.workspaceId, actorUserId: ctx.actor.userId, action: isManager ? 'team.manager_added' : 'team.manager_removed', resourceType: 'team', resourceId: teamId,
      diff: { user_id: userId, policy_version: pc.policyVersion }, correlationId: ctx.correlationId });
  });
  return getTeam(ctx, teamId);
}

/** Team managers hold a workspace 'team_manager' grant (workspace.read, members.read, teams.read). */
async function ensureManagerGrant(tx: Queryable, ctx: Ctx, userId: string) {
  await upsertGrant(tx, { workspaceId: ctx.access.workspaceId, principal: { userId }, grantedBy: ctx.actor.userId, source: 'team_manager',
    grant: { role: 'team_manager', scopeType: 'workspace', brandId: null, connectionId: null, expiresAt: null } });
}

async function dropManagerGrantIfUnused(tx: Queryable, ctx: Ctx, userId: string) {
  const still = await maybeOne(tx, `SELECT 1 FROM team_memberships tm JOIN teams t ON t.id=tm.team_id AND t.archived_at IS NULL WHERE tm.workspace_id=$1 AND tm.user_id=$2 AND tm.is_manager`, [ctx.access.workspaceId, userId]);
  if (!still) {
    await tx.query(`UPDATE scoped_role_grants SET revoked_at=now(), revoked_by=$3, revoke_reason='no_longer_team_manager'
                     WHERE workspace_id=$1 AND user_id=$2 AND role='team_manager' AND source='team_manager' AND revoked_at IS NULL`, [ctx.access.workspaceId, userId, ctx.actor.userId]);
  }
}

/** Members the caller may add to a team (for pickers): active workspace members not already in it. */
export async function teamCandidates(ctx: Ctx, teamId: string, db: Queryable = getPool()) {
  requireAction(ctx, 'teams.read');
  await loadTeam(db, ctx, teamId);
  const rows = await many<{ user_id: string; email: string; name: string | null }>(db,
    `SELECT m.user_id, u.email, u.name FROM memberships m JOIN users u ON u.id=m.user_id
      WHERE m.workspace_id=$1 AND m.status='active' AND NOT EXISTS (SELECT 1 FROM team_memberships tm WHERE tm.team_id=$2 AND tm.user_id=m.user_id)
      ORDER BY lower(u.email) LIMIT 500`, [ctx.access.workspaceId, teamId]);
  return { items: rows.filter((r) => r.user_id !== ctx.actor.userId) };
}
