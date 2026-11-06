// Workspace members: list, change role / brand grants, remove (with impact preview).
// Admins cannot change or remove owners (core canChangeMember); the last owner cannot be demoted/removed.
import { AppError, ROLES, canChangeMember, forbidden, notFound, type Role } from '@social-lite/core';
import { getPool, many, maybeOne, withTx, type Queryable } from '@social-lite/db';
import { audit } from './audit.js';
import { listInvitations, type InvitationDto } from './auth/invitations.js';
import type { Ctx } from './context.js';
import { assertUuid, isUuid, requireAction } from './tenancy.js';

export interface MemberDto { user_id: string; email: string; name: string | null; role: Role; brand_ids: string[] | null; joined_at: string }

interface MemberRow { user_id: string; email: string; name: string | null; role: Role; brand_restricted: boolean; created_at: Date; brand_ids: string[] | null }

const MEMBER_SQL = `SELECT m.user_id, u.email, u.name, m.role, m.brand_restricted, m.created_at,
    (SELECT array_agg(g.brand_id ORDER BY g.brand_id) FROM membership_brand_grants g WHERE g.workspace_id=m.workspace_id AND g.user_id=m.user_id) AS brand_ids
  FROM memberships m JOIN users u ON u.id=m.user_id
 WHERE m.workspace_id=$1 AND m.removed_at IS NULL`;

const dto = (m: MemberRow): MemberDto => ({
  user_id: m.user_id, email: m.email, name: m.name, role: m.role,
  brand_ids: m.brand_restricted && m.role !== 'owner' && m.role !== 'admin' ? (m.brand_ids ?? []) : null,
  joined_at: m.created_at.toISOString(),
});

export async function listMembers(ctx: Ctx, db: Queryable = getPool()): Promise<{ members: MemberDto[]; invitations: InvitationDto[] }> {
  const rows = await many<MemberRow>(db, `${MEMBER_SQL} ORDER BY array_position(ARRAY['owner','admin','editor','approver','viewer']::member_role[], m.role), lower(u.email)`, [ctx.access.workspaceId]);
  return { members: rows.map(dto), invitations: await listInvitations(ctx, db) };
}

async function loadMember(db: Queryable, ctx: Ctx, userId: string, lock = false): Promise<MemberRow> {
  assertUuid(userId, 'Member');
  if (lock) await db.query(`SELECT 1 FROM memberships WHERE workspace_id=$1 AND user_id=$2 FOR UPDATE`, [ctx.access.workspaceId, userId]);
  const m = await maybeOne<MemberRow>(db, `${MEMBER_SQL} AND m.user_id=$2`, [ctx.access.workspaceId, userId]);
  if (!m) throw notFound('Member');
  return m;
}

async function ownerCount(db: Queryable, workspaceId: string): Promise<number> {
  // Lock owner rows so concurrent demotions cannot remove the last owner.
  const r = await many<{ user_id: string }>(db,
    `SELECT user_id FROM memberships WHERE workspace_id=$1 AND role='owner' AND removed_at IS NULL FOR UPDATE`, [workspaceId]);
  return r.length;
}

export async function getMember(ctx: Ctx, userId: string): Promise<MemberDto> {
  return dto(await loadMember(getPool(), ctx, userId));
}

export async function updateMember(ctx: Ctx, userId: string, patch: { role?: Role; brand_ids?: string[] | null }): Promise<MemberDto> {
  requireAction(ctx, 'members.change_role');
  if (patch.role !== undefined && !(ROLES as readonly string[]).includes(patch.role)) throw new AppError('validation_failed', 'Unknown role', { role: 'Unknown role' });
  const brandIds = patch.brand_ids === undefined ? undefined : patch.brand_ids === null ? null : [...new Set(patch.brand_ids)];
  if (brandIds && brandIds.some((b) => !isUuid(b))) throw new AppError('validation_failed', 'Unknown brand', { brand_ids: 'Unknown brand' });

  await withTx(async (tx) => {
    const target = await loadMember(tx, ctx, userId, true);
    const newRole = patch.role ?? target.role;
    if (!canChangeMember(ctx.access.role, target.role, patch.role)) {
      throw forbidden(target.role === 'owner' || newRole === 'owner' ? 'Only an owner can change ownership.' : undefined);
    }
    if (target.role === 'owner' && newRole !== 'owner' && (await ownerCount(tx, ctx.access.workspaceId)) <= 1) {
      throw new AppError('invalid_state', 'A workspace needs at least one owner. Make someone else an owner first.');
    }
    const unrestrictedRole = newRole === 'owner' || newRole === 'admin';
    if (brandIds && brandIds.length && unrestrictedRole) {
      throw new AppError('validation_failed', 'Owners and admins always have access to every brand', { brand_ids: 'Brand restrictions do not apply to this role' });
    }
    if (brandIds && brandIds.length) {
      const found = await many<{ id: string }>(tx, `SELECT id FROM brands WHERE workspace_id=$1 AND id = ANY($2::uuid[]) AND archived_at IS NULL`, [ctx.access.workspaceId, brandIds]);
      if (found.length !== brandIds.length) throw new AppError('validation_failed', 'Unknown brand', { brand_ids: 'Unknown brand' });
    }
    // brand_ids: undefined ⇒ unchanged; null or [] ⇒ unrestricted; list ⇒ restricted to those brands.
    const restricted = unrestrictedRole ? false : brandIds === undefined ? target.brand_restricted : !!(brandIds && brandIds.length);
    await tx.query(`UPDATE memberships SET role=$3, brand_restricted=$4 WHERE workspace_id=$1 AND user_id=$2`,
      [ctx.access.workspaceId, userId, newRole, restricted]);
    if (brandIds !== undefined || unrestrictedRole) {
      await tx.query(`DELETE FROM membership_brand_grants WHERE workspace_id=$1 AND user_id=$2`, [ctx.access.workspaceId, userId]);
      if (restricted && brandIds) {
        await tx.query(`INSERT INTO membership_brand_grants(workspace_id, user_id, brand_id) SELECT $1, $2, unnest($3::uuid[])`,
          [ctx.access.workspaceId, userId, brandIds]);
      }
    }
    await audit(tx, { workspaceId: ctx.access.workspaceId, actorUserId: ctx.actor.userId, action: 'member.updated', resourceType: 'member', resourceId: userId,
      diff: { role: patch.role !== undefined ? { from: target.role, to: newRole } : undefined, brand_ids: brandIds !== undefined ? { from: dto(target).brand_ids, to: restricted ? brandIds : null } : undefined },
      correlationId: ctx.correlationId });
  });
  return getMember(ctx, userId);
}

export interface RemovalImpact { approved_schedules_remaining: number; drafts_losing_access: number; pending_approvals: number }

/** What happens when this member is removed (shown in the removal flow, spec §6). */
export async function removalImpact(ctx: Ctx, userId: string, db: Queryable = getPool()): Promise<RemovalImpact> {
  requireAction(ctx, 'members.remove');
  await loadMember(db, ctx, userId);
  const r = (await maybeOne<RemovalImpact>(db,
    `SELECT
       (SELECT count(*) FROM schedules s WHERE s.workspace_id=$1 AND s.created_by=$2 AND s.status='active')::int AS approved_schedules_remaining,
       (SELECT count(*) FROM posts p WHERE p.workspace_id=$1 AND p.created_by=$2 AND p.archived_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM schedules s WHERE s.post_id=p.id AND s.status IN ('active','pending_approval','completed')))::int AS drafts_losing_access,
       (SELECT count(*) FROM approvals a WHERE a.workspace_id=$1 AND a.requested_by=$2 AND a.decision='pending')::int AS pending_approvals`,
    [ctx.access.workspaceId, userId]))!;
  return r;
}

/**
 * Remove a member: blocks all new actions immediately (loadAccess ignores removed memberships).
 * Previously approved schedules remain; the impact is returned for the UI.
 */
export async function removeMember(ctx: Ctx, userId: string): Promise<{ ok: true; impact: RemovalImpact }> {
  requireAction(ctx, 'members.remove');
  const impact = await removalImpact(ctx, userId);
  await withTx(async (tx) => {
    const target = await loadMember(tx, ctx, userId, true);
    if (!canChangeMember(ctx.access.role, target.role)) throw forbidden('Only an owner can remove an owner.');
    if (target.role === 'owner' && (await ownerCount(tx, ctx.access.workspaceId)) <= 1) {
      throw new AppError('invalid_state', 'You cannot remove the last owner of a workspace.');
    }
    await tx.query(`UPDATE memberships SET removed_at=now(), removed_by=$3 WHERE workspace_id=$1 AND user_id=$2`, [ctx.access.workspaceId, userId, ctx.actor.userId]);
    await tx.query(`DELETE FROM membership_brand_grants WHERE workspace_id=$1 AND user_id=$2`, [ctx.access.workspaceId, userId]);
    await audit(tx, { workspaceId: ctx.access.workspaceId, actorUserId: ctx.actor.userId, action: 'member.removed', resourceType: 'member', resourceId: userId,
      diff: { email: target.email, role: target.role, ...impact }, correlationId: ctx.correlationId });
  });
  return { ok: true, impact };
}
