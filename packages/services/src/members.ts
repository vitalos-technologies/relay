// Workspace members on the V2 model: scoped_role_grants are the authority; memberships.role is only a
// legacy summary (grants.syncLegacyMembership). Every change: server-derived scope, delegation ceiling
// (core canDelegate), no self-grant, bumpPolicyVersion + audit in the same transaction.
// Lifecycle (suspend/remove/scope reduction/handover/ownership transfer) lives in lifecycle.ts.
import { AppError, ROLES, forbidden, notFound, type Role, type RolePreset } from '@social-lite/core';
import { getPool, many, maybeOne, withTx, type Queryable } from '@social-lite/db';
import { audit } from './audit.js';
import { listInvitations, type InvitationDto } from './auth/invitations.js';
import type { Ctx } from './context.js';
import { canAnywhere } from './access.js';
import {
  actorIsOwner, activeOwnerIds, assertDelegable, commitPolicyChange, grantsForUsers, isPermission, lockWorkspace, mayDelegate, needsStepUp,
  normalizeGrants, upsertGrant, type GrantDto, type GrantInput,
} from './grants.js';
import { assertUuid, isUuid, requireAction } from './tenancy.js';

export interface MemberDto {
  user_id: string; email: string; name: string | null;
  /** Legacy summary derived from grants (V1 UI). */
  role: Role; brand_ids: string[] | null; joined_at: string;
  status: 'active' | 'suspended'; status_reason: string | null; suspended_at: string | null; last_sign_in_at: string | null;
  is_owner: boolean; is_guest: boolean; access_expires_at: string | null;
  grants: GrantDto[]; teams: Array<{ id: string; name: string; is_manager: boolean }>; restrictions: number;
}

interface MemberRow {
  user_id: string; email: string; name: string | null; role: Role; brand_restricted: boolean; created_at: Date; brand_ids: string[] | null;
  status: 'active' | 'suspended' | 'removed'; status_reason: string | null; suspended_at: Date | null; last_login_at: Date | null; restrictions: number;
}

const MEMBER_SQL = `SELECT m.user_id, u.email, u.name, m.role, m.brand_restricted, m.created_at, m.status, m.status_reason, m.suspended_at, u.last_login_at,
    (SELECT array_agg(g.brand_id ORDER BY g.brand_id) FROM membership_brand_grants g WHERE g.workspace_id=m.workspace_id AND g.user_id=m.user_id) AS brand_ids,
    (SELECT count(*)::int FROM access_restrictions r WHERE r.workspace_id=m.workspace_id AND r.user_id=m.user_id AND r.revoked_at IS NULL
        AND (r.expires_at IS NULL OR r.expires_at > now())) AS restrictions
  FROM memberships m JOIN users u ON u.id=m.user_id
 WHERE m.workspace_id=$1 AND m.status <> 'removed' AND m.removed_at IS NULL`;

async function toDtos(db: Queryable, ctx: Ctx, rows: MemberRow[]): Promise<MemberDto[]> {
  const ids = rows.map((r) => r.user_id);
  const grants = await grantsForUsers(db, ctx, ids);
  const teams = ids.length ? await many<{ user_id: string; id: string; name: string; is_manager: boolean }>(db,
    `SELECT tm.user_id, t.id, t.name, tm.is_manager FROM team_memberships tm JOIN teams t ON t.id=tm.team_id AND t.archived_at IS NULL
      WHERE tm.workspace_id=$1 AND tm.user_id = ANY($2::uuid[]) ORDER BY t.name`, [ctx.access.workspaceId, ids]) : [];
  return rows.map((m) => {
    const gs = grants.get(m.user_id) ?? [];
    const live = gs.filter((g) => !g.expired);
    const expiries = live.map((g) => g.expires_at).filter((e): e is string => !!e).sort();
    const isOwner = live.some((g) => g.role === 'owner' && g.via === 'direct');
    return {
      user_id: m.user_id, email: m.email, name: m.name, role: m.role,
      brand_ids: m.brand_restricted && m.role !== 'owner' && m.role !== 'admin' ? (m.brand_ids ?? []) : null,
      joined_at: m.created_at.toISOString(), status: m.status === 'suspended' ? 'suspended' : 'active', status_reason: m.status_reason,
      suspended_at: m.suspended_at?.toISOString() ?? null, last_sign_in_at: m.last_login_at?.toISOString() ?? null,
      is_owner: isOwner, is_guest: live.length > 0 && live.every((g) => g.role === 'guest'),
      access_expires_at: live.length && live.every((g) => g.expires_at) ? expiries[expiries.length - 1]! : null,
      grants: gs, teams: teams.filter((t) => t.user_id === m.user_id).map((t) => ({ id: t.id, name: t.name, is_manager: t.is_manager })),
      restrictions: m.restrictions,
    };
  });
}

export interface MemberFilters { q?: string; status?: 'active' | 'suspended'; team_id?: string; role?: string }

export async function listMembers(ctx: Ctx, filters: MemberFilters = {}, db: Queryable = getPool()): Promise<{ members: MemberDto[]; invitations: InvitationDto[]; policy_version: number }> {
  requireAction(ctx, 'members.read');
  const params: unknown[] = [ctx.access.workspaceId];
  let where = '';
  if (filters.q) { params.push(`%${filters.q.slice(0, 100).replace(/[\\%_]/g, (c) => `\\${c}`)}%`); where += ` AND (u.email ILIKE $${params.length} OR u.name ILIKE $${params.length})`; }
  if (filters.status === 'active' || filters.status === 'suspended') { params.push(filters.status); where += ` AND m.status = $${params.length}`; }
  if (filters.team_id && isUuid(filters.team_id)) { params.push(filters.team_id); where += ` AND EXISTS (SELECT 1 FROM team_memberships tm WHERE tm.team_id=$${params.length} AND tm.user_id=m.user_id)`; }
  const rows = await many<MemberRow>(db, `${MEMBER_SQL}${where} ORDER BY lower(u.email) LIMIT 1000`, params);
  let members = await toDtos(db, ctx, rows);
  if (filters.role) members = members.filter((m) => m.grants.some((g) => g.role === filters.role && !g.expired));
  members.sort((a, b) => Number(b.is_owner) - Number(a.is_owner) || a.email.localeCompare(b.email));
  const invitations = canAnywhere(ctx, 'members.invite') ? await listInvitations(ctx, db) : [];
  return { members, invitations, policy_version: ctx.access.authz?.policyVersion ?? 0 };
}

export async function loadMemberRow(db: Queryable, ctx: Ctx, userId: string, lock = false): Promise<MemberRow> {
  assertUuid(userId, 'Member');
  if (lock) await db.query(`SELECT 1 FROM memberships WHERE workspace_id=$1 AND user_id=$2 FOR UPDATE`, [ctx.access.workspaceId, userId]);
  const m = await maybeOne<MemberRow>(db, `${MEMBER_SQL} AND m.user_id=$2`, [ctx.access.workspaceId, userId]);
  if (!m) throw notFound('Member');
  return m;
}

export async function getMember(ctx: Ctx, userId: string, db: Queryable = getPool()): Promise<MemberDto> {
  if (userId !== ctx.actor.userId) requireAction(ctx, 'members.read');
  return (await toDtos(db, ctx, [await loadMemberRow(db, ctx, userId)]))[0]!;
}

async function isOwnerUser(db: Queryable, workspaceId: string, userId: string): Promise<boolean> {
  return !!(await maybeOne(db, `SELECT 1 FROM scoped_role_grants WHERE workspace_id=$1 AND user_id=$2 AND role='owner' AND revoked_at IS NULL`, [workspaceId, userId]));
}

/** Changes to an owner's access require an owner actor (admins cannot touch owners). */
export async function assertMayActOn(db: Queryable, ctx: Ctx, userId: string): Promise<{ targetIsOwner: boolean }> {
  if (userId === ctx.actor.userId) throw forbidden('You cannot change your own access');
  const targetIsOwner = await isOwnerUser(db, ctx.access.workspaceId, userId);
  if (targetIsOwner && !actorIsOwner(ctx)) throw forbidden('Only an owner can change an owner’s access.');
  return { targetIsOwner };
}

// ------------------------------------------------------------------ grants

/** Add a scoped role grant to a member (server derives scope; delegation ceiling; step-up for sensitive roles). */
export async function addMemberGrant(ctx: Ctx, userId: string, input: GrantInput): Promise<MemberDto> {
  requireAction(ctx, 'members.manage');
  return withTx(async (tx) => {
    const target = await loadMemberRow(tx, ctx, userId, true);
    await assertMayActOn(tx, ctx, userId);
    if (target.status !== 'active') throw new AppError('invalid_state', 'Reactivate this member before changing their access.');
    const [g] = await normalizeGrants(tx, ctx.access.workspaceId, [input]);
    assertDelegable(ctx, [g!], userId);
    if (needsStepUp([g!])) requireAction(ctx, 'members.manage', { stepUp: true });
    const r = await upsertGrant(tx, { workspaceId: ctx.access.workspaceId, principal: { userId }, grant: g!, grantedBy: ctx.actor.userId, source: 'manual' });
    const pc = await commitPolicyChange(tx, ctx.access.workspaceId, [userId]);
    await audit(tx, { workspaceId: ctx.access.workspaceId, brandId: g!.brandId, actorUserId: ctx.actor.userId, action: 'grant.added', resourceType: 'member', resourceId: userId,
      diff: { grant_id: r.id, role: g!.role, scope: g!.scopeType, brand_id: g!.brandId, connection_id: g!.connectionId, expires_at: g!.expiresAt?.toISOString() ?? null, created: r.created, policy_version: pc.policyVersion },
      correlationId: ctx.correlationId });
    return (await toDtos(tx, ctx, [await loadMemberRow(tx, ctx, userId)]))[0]!;
  });
}

/** Revoke a user grant (you may revoke only what you could grant; owner grants only via owner + last-owner rule). */
export async function revokeGrant(ctx: Ctx, grantId: string): Promise<{ ok: true; policy_version: number }> {
  requireAction(ctx, 'members.manage');
  assertUuid(grantId, 'Grant');
  return withTx(async (tx) => {
    await lockWorkspace(tx, ctx.access.workspaceId);
    const g = await maybeOne<{ id: string; user_id: string | null; team_id: string | null; role: RolePreset; brand_id: string | null; connection_id: string | null; principal_type: string }>(tx,
      `SELECT id, user_id, team_id, role, brand_id, connection_id, principal_type FROM scoped_role_grants
        WHERE id=$1 AND workspace_id=$2 AND revoked_at IS NULL FOR UPDATE`, [grantId, ctx.access.workspaceId]);
    if (!g || g.principal_type !== 'user' || !g.user_id) throw notFound('Grant');
    if (g.brand_id && ctx.access.brandIds !== null && !ctx.access.brandIds.includes(g.brand_id)) throw notFound('Grant');
    if (g.role === 'owner') {
      if (!actorIsOwner(ctx)) throw forbidden('Only an owner can change ownership.');
      const owners = await activeOwnerIds(tx, ctx.access.workspaceId);
      if (owners.length <= 1 && owners.includes(g.user_id)) throw new AppError('invalid_state', 'A workspace needs at least one owner. Transfer ownership first.');
    } else {
      if (g.user_id === ctx.actor.userId) throw forbidden('You cannot change your own access');
      if (await isOwnerUser(tx, ctx.access.workspaceId, g.user_id) && !actorIsOwner(ctx)) throw forbidden('Only an owner can change an owner’s access.');
      if (!mayDelegate(ctx, { role: g.role, brandId: g.brand_id, connectionId: g.connection_id })) throw forbidden('You cannot remove a role you could not grant.');
    }
    await tx.query(`UPDATE scoped_role_grants SET revoked_at=now(), revoked_by=$2, revoke_reason='manual' WHERE id=$1`, [g.id, ctx.actor.userId]);
    const pc = await commitPolicyChange(tx, ctx.access.workspaceId, [g.user_id]);
    await audit(tx, { workspaceId: ctx.access.workspaceId, brandId: g.brand_id, actorUserId: ctx.actor.userId, action: 'grant.revoked', resourceType: 'member', resourceId: g.user_id,
      diff: { grant_id: g.id, role: g.role, brand_id: g.brand_id, connection_id: g.connection_id, held_publications: pc.held, policy_version: pc.policyVersion }, correlationId: ctx.correlationId });
    return { ok: true as const, policy_version: pc.policyVersion };
  });
}

// ------------------------------------------------------------------ restrictions (explicit deny)

export async function addRestriction(ctx: Ctx, userId: string, input: { brand_id?: string | null; actions: string[]; reason?: string | null; expires_at?: string | null }): Promise<MemberDto> {
  requireAction(ctx, 'members.manage');
  const actions = [...new Set(input.actions ?? [])];
  if (!actions.length || actions.length > 40 || actions.some((a) => a !== '*' && !isPermission(a))) {
    throw new AppError('validation_failed', 'Choose the actions to deny', { actions: 'Unknown action' });
  }
  const expires = input.expires_at ? new Date(input.expires_at) : null;
  if (expires && (Number.isNaN(expires.getTime()) || expires.getTime() <= Date.now())) throw new AppError('validation_failed', 'Expiry must be in the future', { expires_at: 'Must be in the future' });
  return withTx(async (tx) => {
    await loadMemberRow(tx, ctx, userId, true);
    await assertMayActOn(tx, ctx, userId);
    if (input.brand_id) {
      const b = isUuid(input.brand_id) ? await maybeOne(tx, `SELECT 1 FROM brands WHERE id=$1 AND workspace_id=$2`, [input.brand_id, ctx.access.workspaceId]) : null;
      if (!b || (ctx.access.brandIds !== null && !ctx.access.brandIds.includes(input.brand_id))) throw new AppError('validation_failed', 'Unknown brand', { brand_id: 'Unknown brand' });
    }
    const r = await maybeOne<{ id: string }>(tx,
      `INSERT INTO access_restrictions(workspace_id, user_id, brand_id, actions, reason, expires_at, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [ctx.access.workspaceId, userId, input.brand_id ?? null, actions, input.reason?.trim().slice(0, 300) || null, expires, ctx.actor.userId]);
    const pc = await commitPolicyChange(tx, ctx.access.workspaceId, [userId]);
    await audit(tx, { workspaceId: ctx.access.workspaceId, brandId: input.brand_id ?? null, actorUserId: ctx.actor.userId, action: 'restriction.added', resourceType: 'member', resourceId: userId,
      diff: { restriction_id: r!.id, actions, brand_id: input.brand_id ?? null, expires_at: expires?.toISOString() ?? null, held_publications: pc.held, policy_version: pc.policyVersion },
      correlationId: ctx.correlationId });
    return (await toDtos(tx, ctx, [await loadMemberRow(tx, ctx, userId)]))[0]!;
  });
}

export async function revokeRestriction(ctx: Ctx, restrictionId: string): Promise<{ ok: true }> {
  requireAction(ctx, 'members.manage');
  assertUuid(restrictionId, 'Restriction');
  return withTx(async (tx) => {
    const r = await maybeOne<{ id: string; user_id: string; brand_id: string | null }>(tx,
      `SELECT id, user_id, brand_id FROM access_restrictions WHERE id=$1 AND workspace_id=$2 AND revoked_at IS NULL FOR UPDATE`, [restrictionId, ctx.access.workspaceId]);
    if (!r || (r.brand_id && ctx.access.brandIds !== null && !ctx.access.brandIds.includes(r.brand_id))) throw notFound('Restriction');
    await assertMayActOn(tx, ctx, r.user_id);
    await tx.query(`UPDATE access_restrictions SET revoked_at=now(), revoked_by=$2 WHERE id=$1`, [r.id, ctx.actor.userId]);
    // Loosening: bump the version, but never auto-release held publications (adoption is explicit).
    const pc = await commitPolicyChange(tx, ctx.access.workspaceId, [r.user_id]);
    await audit(tx, { workspaceId: ctx.access.workspaceId, brandId: r.brand_id, actorUserId: ctx.actor.userId, action: 'restriction.revoked', resourceType: 'member', resourceId: r.user_id,
      diff: { restriction_id: r.id, policy_version: pc.policyVersion }, correlationId: ctx.correlationId });
    return { ok: true as const };
  });
}

export async function listRestrictions(ctx: Ctx, userId: string, db: Queryable = getPool()) {
  requireAction(ctx, 'members.read');
  await loadMemberRow(db, ctx, userId);
  const rows = await many<{ id: string; brand_id: string | null; brand_name: string | null; actions: string[]; reason: string | null; expires_at: Date | null; created_at: Date; created_by_email: string | null }>(db,
    `SELECT r.id, r.brand_id, b.name AS brand_name, r.actions, r.reason, r.expires_at, r.created_at, u.email AS created_by_email
       FROM access_restrictions r LEFT JOIN brands b ON b.id=r.brand_id LEFT JOIN users u ON u.id=r.created_by
      WHERE r.workspace_id=$1 AND r.user_id=$2 AND r.revoked_at IS NULL AND (r.expires_at IS NULL OR r.expires_at > now()) ORDER BY r.created_at`,
    [ctx.access.workspaceId, userId]);
  return { items: rows.filter((r) => !r.brand_id || ctx.access.brandIds === null || ctx.access.brandIds.includes(r.brand_id))
    .map((r) => ({ ...r, expires_at: r.expires_at?.toISOString() ?? null, created_at: r.created_at.toISOString() })) };
}

// ------------------------------------------------------------------ legacy PATCH {role, brand_ids}

const PRIMARY_ROLES: readonly RolePreset[] = ['admin', 'editor', 'approver', 'viewer'];

/**
 * V1-compatible "set role" (PATCH /api/members/:id): replaces the member's direct primary grant
 * (admin/editor/approver/viewer) with role@workspace or role@each brand. Other V2 grants (publisher,
 * brand manager, guest, team grants…) are untouched. Owners are changed only via ownership transfer.
 */
export async function updateMember(ctx: Ctx, userId: string, patch: { role?: Role; brand_ids?: string[] | null }): Promise<MemberDto> {
  requireAction(ctx, 'members.change_role');
  if (patch.role !== undefined && !(ROLES as readonly string[]).includes(patch.role)) throw new AppError('validation_failed', 'Unknown role', { role: 'Unknown role' });
  if (patch.role === 'owner') throw new AppError('validation_failed', 'Ownership moves only through an ownership transfer', { role: 'Use ownership transfer' });
  const brandIds = patch.brand_ids === undefined ? undefined : patch.brand_ids === null ? null : [...new Set(patch.brand_ids)];
  if (brandIds && brandIds.some((b) => !isUuid(b))) throw new AppError('validation_failed', 'Unknown brand', { brand_ids: 'Unknown brand' });
  return withTx(async (tx) => {
    await lockWorkspace(tx, ctx.access.workspaceId);
    const target = await loadMemberRow(tx, ctx, userId, true);
    const { targetIsOwner } = await assertMayActOn(tx, ctx, userId);
    if (targetIsOwner) throw new AppError('invalid_state', 'Use ownership transfer to change an owner’s role.');
    const current = await many<{ id: string; role: RolePreset; brand_id: string | null; connection_id: string | null }>(tx,
      `SELECT id, role, brand_id, connection_id FROM scoped_role_grants WHERE workspace_id=$1 AND user_id=$2 AND revoked_at IS NULL AND role = ANY($3::text[]) FOR UPDATE`,
      [ctx.access.workspaceId, userId, PRIMARY_ROLES]);
    const newRole = (patch.role ?? (PRIMARY_ROLES.includes(target.role as RolePreset) ? target.role : 'viewer')) as RolePreset;
    const scope = brandIds !== undefined ? brandIds : (target.brand_restricted ? (target.brand_ids ?? []) : null);
    if (newRole === 'admin' && scope && scope.length) {
      throw new AppError('validation_failed', 'Admins always have access to every brand', { brand_ids: 'Brand restrictions do not apply to this role' });
    }
    const wanted = await normalizeGrants(tx, ctx.access.workspaceId,
      newRole === 'admin' || !scope || !scope.length ? [{ role: newRole }] : scope.map((b) => ({ role: newRole, brand_id: b })));
    for (const c of current) if (!mayDelegate(ctx, { role: c.role, brandId: c.brand_id, connectionId: c.connection_id })) throw forbidden('You cannot remove a role you could not grant.');
    assertDelegable(ctx, wanted, userId);
    if (needsStepUp(wanted)) requireAction(ctx, 'members.manage', { stepUp: true });
    const keep = new Set<string>();
    for (const g of wanted) keep.add((await upsertGrant(tx, { workspaceId: ctx.access.workspaceId, principal: { userId }, grant: g, grantedBy: ctx.actor.userId, source: 'manual' })).id);
    const revoked = current.filter((c) => !keep.has(c.id));
    if (revoked.length) {
      await tx.query(`UPDATE scoped_role_grants SET revoked_at=now(), revoked_by=$2, revoke_reason='role_changed' WHERE id = ANY($1::uuid[])`, [revoked.map((r) => r.id), ctx.actor.userId]);
    }
    const pc = await commitPolicyChange(tx, ctx.access.workspaceId, [userId]);
    await audit(tx, { workspaceId: ctx.access.workspaceId, actorUserId: ctx.actor.userId, action: 'member.updated', resourceType: 'member', resourceId: userId,
      diff: { role: { from: target.role, to: newRole }, brand_ids: { from: target.brand_restricted ? target.brand_ids : null, to: scope && scope.length ? scope : null },
        revoked: revoked.length, policy_version: pc.policyVersion }, correlationId: ctx.correlationId });
    return (await toDtos(tx, ctx, [await loadMemberRow(tx, ctx, userId)]))[0]!;
  });
}
