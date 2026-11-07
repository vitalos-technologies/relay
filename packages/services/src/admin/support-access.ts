// V3.1 Admin §13 — support access. The ONLY way a platform operator sees a workspace's private content.
//  1. Operator requests: workspace, reason (10+ chars), optional ticket, duration (15 min – 24 h). Request lapses in 24 h.
//  2. A workspace owner/admin (members.manage, fresh sign-in) approves or declines. Approval creates an ordinary
//     read-only `viewer` grant at workspace scope with expires_at = now + duration (plus a membership if the operator
//     had none), so every read goes through the normal authorize() path and expiry is enforced by the policy itself.
//  3. Either side can end it at any time; expiry ends it automatically (lazy sweep on every read + grant expiry).
// Nothing here is "log in as": the operator acts as themself, every request is attributed to them, and the
// workspace sees an active-support banner. Both audits record request, decision, start and end.
import { z } from 'zod';
import { AppError, notFound } from '@social-lite/core';
import type { SupportAccessDto } from '@social-lite/core/contracts/v31-admin';
import { getPool, many, maybeOne, one, withTx, type Pool, type Queryable } from '@social-lite/db';
import type { Ctx } from '../context.js';
import { audit } from '../audit.js';
import { bumpPolicyVersion } from '../authz.js';
import { assertUuid, requireAction } from '../tenancy.js';
import { platformAudit, requirePlatform, type PlatformCtx } from './platform.js';

const REQUEST_TTL_HOURS = 24;

type Row = {
  id: string; workspace_id: string; workspace_name: string | null; operator_user_id: string; operator_email: string; operator_name: string | null;
  reason: string; ticket_ref: string | null; access: 'read'; duration_minutes: number; status: SupportAccessDto['status'];
  requested_at: Date; request_expires_at: Date; decided_at: Date | null; decided_by_email: string | null; starts_at: Date | null; expires_at: Date | null;
  ended_at: Date | null; end_reason: string | null;
};

const SELECT = `SELECT g.id, g.workspace_id, w.name workspace_name, g.operator_user_id, u.email::text operator_email, u.name operator_name, g.reason, g.ticket_ref,
  g.access, g.duration_minutes, g.status, g.requested_at, g.request_expires_at, g.decided_at, d.email::text decided_by_email, g.starts_at, g.expires_at,
  g.ended_at, g.end_reason
  FROM support_access_grants g JOIN users u ON u.id=g.operator_user_id LEFT JOIN users d ON d.id=g.decided_by LEFT JOIN workspaces w ON w.id=g.workspace_id`;

const iso = (d: Date | null) => d?.toISOString() ?? null;
function toDto(r: Row): SupportAccessDto {
  return {
    id: r.id, workspace_id: r.workspace_id, workspace_name: r.workspace_name, operator: { id: r.operator_user_id, email: r.operator_email, name: r.operator_name },
    reason: r.reason, ticket_ref: r.ticket_ref, access: r.access, duration_minutes: r.duration_minutes, status: r.status,
    requested_at: r.requested_at.toISOString(), request_expires_at: r.request_expires_at.toISOString(), decided_at: iso(r.decided_at), decided_by: r.decided_by_email,
    starts_at: iso(r.starts_at), expires_at: iso(r.expires_at), ended_at: iso(r.ended_at), end_reason: r.end_reason,
  };
}

/** End one grant inside a transaction: revoke the viewer grant, remove a membership created for it, record both audits. */
export async function endSupportAccessTx(tx: Queryable, id: string, by: { userId: string | null; reason: string; correlationId?: string | null }): Promise<boolean> {
  const g = await maybeOne<{ id: string; workspace_id: string; operator_user_id: string; status: string; grant_id: string | null; created_membership: boolean }>(tx,
    `SELECT id, workspace_id, operator_user_id, status, grant_id, created_membership FROM support_access_grants WHERE id=$1 FOR UPDATE`, [id]);
  if (!g || !['requested', 'active'].includes(g.status)) return false;
  if (g.status === 'requested') {
    await tx.query(`UPDATE support_access_grants SET status=$2, ended_at=now(), ended_by=$3, end_reason=$4 WHERE id=$1`,
      [id, by.reason === 'request_expired' ? 'lapsed' : 'cancelled', by.userId, by.reason]);
  } else {
    if (g.grant_id) await tx.query(`UPDATE scoped_role_grants SET revoked_at=now(), revoked_by=$2, revoke_reason='support_access_ended' WHERE id=$1 AND revoked_at IS NULL`, [g.grant_id, by.userId]);
    if (g.created_membership) {
      await tx.query(`UPDATE memberships SET status='removed', removed_at=now(), removed_by=$3, status_reason='support_access_ended'
                       WHERE workspace_id=$1 AND user_id=$2 AND status='active'`, [g.workspace_id, g.operator_user_id, by.userId]);
    }
    await tx.query(`UPDATE support_access_grants SET status='ended', ended_at=now(), ended_by=$2, end_reason=$3 WHERE id=$1`, [id, by.userId, by.reason]);
    await bumpPolicyVersion(tx, g.workspace_id);
  }
  const action = g.status === 'requested' ? 'support_access.cancelled' : 'support_access.ended';
  await tx.query(
    `INSERT INTO platform_audit_events(actor_user_id, actor_service, action, target_type, target_id, workspace_id, reason, diff, correlation_id)
     VALUES ($1,$2,$3,'support_access',$4,$5,$6,'{}'::jsonb,$7)`, [by.userId, by.userId ? null : 'support-access-expiry', action, id, g.workspace_id, by.reason, by.correlationId ?? null]);
  await audit(tx, { workspaceId: g.workspace_id, actorUserId: by.userId, actorService: by.userId ? null : 'support-access-expiry', action, resourceType: 'support_access', resourceId: id,
    diff: { reason: by.reason }, correlationId: by.correlationId ?? null });
  return true;
}

/** Lapse unanswered requests and end expired grants (idempotent; called before every read). */
export async function sweepSupportAccess(db: Pool = getPool(), workspaceId?: string): Promise<number> {
  const due = await many<{ id: string; status: string }>(db,
    `SELECT id, status FROM support_access_grants
      WHERE status IN ('requested','active') AND ((status='requested' AND request_expires_at <= now()) OR (status='active' AND expires_at <= now()))
        AND ($1::uuid IS NULL OR workspace_id=$1) LIMIT 100`, [workspaceId ?? null]);
  let n = 0;
  for (const d of due) {
    if (await withTx((tx) => endSupportAccessTx(tx, d.id, { userId: null, reason: d.status === 'requested' ? 'request_expired' : 'expired' }), db)) n++;
  }
  return n;
}

export async function listSupportAccessFor(db: Queryable, f: { workspaceId?: string; operatorId?: string; open?: boolean; limit?: number }): Promise<SupportAccessDto[]> {
  await sweepSupportAccess(getPool(), f.workspaceId);
  const params: unknown[] = [];
  const where: string[] = [];
  if (f.workspaceId) { params.push(f.workspaceId); where.push(`g.workspace_id=$${params.length}`); }
  if (f.operatorId) { params.push(f.operatorId); where.push(`g.operator_user_id=$${params.length}`); }
  if (f.open) where.push(`g.status IN ('requested','active')`);
  params.push(f.limit ?? 50);
  const rows = await many<Row>(db, `${SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY g.requested_at DESC LIMIT $${params.length}`, params);
  return rows.map(toDto);
}

// ------------------------------------------------------------------ operator side
const requestSchema = z.object({
  workspace_id: z.string().uuid(),
  reason: z.string().trim().min(10, 'Give a reason (10+ characters)').max(500),
  ticket_ref: z.string().trim().max(80).optional().nullable(),
  duration_minutes: z.number().int().min(15).max(1440),
}).strict();

export async function requestSupportAccess(p: PlatformCtx, raw: unknown): Promise<SupportAccessDto> {
  requirePlatform(p, 'support');
  const input = requestSchema.parse(raw);
  await sweepSupportAccess(getPool(), input.workspace_id);
  const id = await withTx(async (tx) => {
    const w = await maybeOne<{ state: string }>(tx, `SELECT state FROM workspaces WHERE id=$1`, [input.workspace_id]);
    if (!w) throw notFound('Workspace');
    const open = await maybeOne(tx, `SELECT 1 FROM support_access_grants WHERE workspace_id=$1 AND operator_user_id=$2 AND status IN ('requested','active')`, [input.workspace_id, p.actor.userId]);
    if (open) throw new AppError('conflict', 'You already have an open request or active access for this workspace.');
    const r = await one<{ id: string }>(tx,
      `INSERT INTO support_access_grants(workspace_id, operator_user_id, reason, ticket_ref, duration_minutes, request_expires_at, correlation_id)
       VALUES ($1,$2,$3,$4,$5, now() + make_interval(hours => $6), $7) RETURNING id`,
      [input.workspace_id, p.actor.userId, input.reason, input.ticket_ref ?? null, input.duration_minutes, REQUEST_TTL_HOURS, p.correlationId]);
    await platformAudit(tx, p, { action: 'support_access.requested', targetType: 'support_access', targetId: r.id, workspaceId: input.workspace_id, reason: input.reason,
      diff: { duration_minutes: input.duration_minutes, ticket_ref: input.ticket_ref ?? null } });
    await audit(tx, { workspaceId: input.workspace_id, actorUserId: p.actor.userId, action: 'support_access.requested', resourceType: 'support_access', resourceId: r.id,
      diff: { reason: input.reason, duration_minutes: input.duration_minutes }, correlationId: p.correlationId });
    return r.id;
  });
  return (await listSupportAccessFor(getPool(), { operatorId: p.actor.userId, limit: 50 })).find((g) => g.id === id)!;
}

export async function myOperatorSupportAccess(p: PlatformCtx): Promise<{ items: SupportAccessDto[] }> {
  requirePlatform(p, 'support');
  return { items: await listSupportAccessFor(getPool(), { operatorId: p.actor.userId, limit: 50 }) };
}

/** Operator ends (or cancels) their own request/grant. */
export async function operatorEndSupportAccess(p: PlatformCtx, id: string): Promise<{ ok: true }> {
  requirePlatform(p, 'support');
  assertUuid(id, 'Support access');
  await withTx(async (tx) => {
    const g = await maybeOne<{ operator_user_id: string }>(tx, `SELECT operator_user_id FROM support_access_grants WHERE id=$1`, [id]);
    if (!g || g.operator_user_id !== p.actor.userId) throw notFound('Support access');
    if (!(await endSupportAccessTx(tx, id, { userId: p.actor.userId, reason: 'ended_by_operator', correlationId: p.correlationId }))) {
      throw new AppError('invalid_state', 'This access is not open.');
    }
  });
  return { ok: true };
}

// ------------------------------------------------------------------ workspace side
export async function listWorkspaceSupportAccess(ctx: Ctx): Promise<{ items: SupportAccessDto[]; can_decide: boolean }> {
  requireAction(ctx, 'members.read');
  const items = await listSupportAccessFor(getPool(), { workspaceId: ctx.access.workspaceId, limit: 50 });
  const { canAnywhere } = await import('../access.js');
  return { items, can_decide: canAnywhere(ctx, 'members.manage') };
}

/** Cheap active/pending counts for the shell banner (no sweep: grants expire in the policy regardless). */
export async function supportAccessIndicator(workspaceId: string, db: Queryable = getPool()): Promise<{ active: number; pending: number; until: string | null }> {
  const r = await one<{ active: number; pending: number; until: Date | null }>(db,
    `SELECT count(*) FILTER (WHERE status='active' AND expires_at > now())::int active, count(*) FILTER (WHERE status='requested' AND request_expires_at > now())::int pending,
            max(expires_at) FILTER (WHERE status='active' AND expires_at > now()) until
       FROM support_access_grants WHERE workspace_id=$1 AND status IN ('requested','active')`, [workspaceId]);
  return { active: r.active, pending: r.pending, until: iso(r.until) };
}

const decideSchema = z.object({ decision: z.enum(['approve', 'decline']), note: z.string().trim().max(500).optional().nullable() }).strict();

/** Owner/admin decision (members.manage + fresh sign-in). Approval starts the clock. */
export async function decideSupportAccess(ctx: Ctx, id: string, raw: unknown): Promise<SupportAccessDto> {
  requireAction(ctx, 'members.manage', { stepUp: true });
  assertUuid(id, 'Support access');
  const input = decideSchema.parse(raw);
  await sweepSupportAccess(getPool(), ctx.access.workspaceId);
  await withTx(async (tx) => {
    const g = await maybeOne<{ id: string; workspace_id: string; operator_user_id: string; status: string; duration_minutes: number; reason: string }>(tx,
      `SELECT id, workspace_id, operator_user_id, status, duration_minutes, reason FROM support_access_grants WHERE id=$1 AND workspace_id=$2 FOR UPDATE`, [id, ctx.access.workspaceId]);
    if (!g) throw notFound('Support access');
    if (g.status !== 'requested') throw new AppError('invalid_state', 'This request was already decided.');
    if (g.operator_user_id === ctx.actor.userId) throw new AppError('forbidden', 'You cannot approve your own support access.');
    const operator = await maybeOne(tx, `SELECT 1 FROM platform_operators WHERE user_id=$1 AND revoked_at IS NULL`, [g.operator_user_id]);
    if (!operator) throw new AppError('invalid_state', 'The requester is no longer a platform operator.');
    if (input.decision === 'decline') {
      await tx.query(`UPDATE support_access_grants SET status='declined', decided_by=$2, decided_at=now(), decision_note=$3 WHERE id=$1`, [id, ctx.actor.userId, input.note ?? null]);
    } else {
      const m = await maybeOne<{ status: string }>(tx, `SELECT status FROM memberships WHERE workspace_id=$1 AND user_id=$2 FOR UPDATE`, [g.workspace_id, g.operator_user_id]);
      if (m?.status === 'suspended') throw new AppError('invalid_state', 'This person’s membership here is suspended.');
      let created = false;
      if (!m) {
        await tx.query(`INSERT INTO memberships(workspace_id, user_id, role, status) VALUES ($1,$2,'viewer','active')`, [g.workspace_id, g.operator_user_id]);
        created = true;
      } else if (m.status === 'removed') {
        await tx.query(`UPDATE memberships SET status='active', removed_at=NULL, removed_by=NULL, role='viewer', status_reason='support_access' WHERE workspace_id=$1 AND user_id=$2`, [g.workspace_id, g.operator_user_id]);
        created = true;
      }
      const grant = await one<{ id: string; expires_at: Date }>(tx,
        `INSERT INTO scoped_role_grants(workspace_id, principal_type, user_id, role, scope_type, expires_at, granted_by, source)
         VALUES ($1,'user',$2,'viewer','workspace', now() + make_interval(mins => $3), $4, 'support_access')
         ON CONFLICT DO NOTHING RETURNING id, expires_at`, [g.workspace_id, g.operator_user_id, g.duration_minutes, ctx.actor.userId])
        .catch(() => { throw new AppError('conflict', 'This person already holds a viewer grant here; support access is not needed.'); });
      await tx.query(`UPDATE support_access_grants SET status='active', decided_by=$2, decided_at=now(), decision_note=$3, starts_at=now(), expires_at=$4, grant_id=$5, created_membership=$6 WHERE id=$1`,
        [id, ctx.actor.userId, input.note ?? null, grant.expires_at, grant.id, created]);
      await bumpPolicyVersion(tx, g.workspace_id);
    }
    const action = input.decision === 'approve' ? 'support_access.approved' : 'support_access.declined';
    await audit(tx, { workspaceId: g.workspace_id, actorUserId: ctx.actor.userId, action, resourceType: 'support_access', resourceId: id,
      diff: { duration_minutes: g.duration_minutes, note: input.note ?? null }, correlationId: ctx.correlationId });
    await tx.query(`INSERT INTO platform_audit_events(actor_user_id, action, target_type, target_id, workspace_id, reason, diff, correlation_id)
                    VALUES ($1,$2,'support_access',$3,$4,$5,$6,$7)`,
      [ctx.actor.userId, action, id, g.workspace_id, input.note ?? null, JSON.stringify({ duration_minutes: g.duration_minutes }), ctx.correlationId]);
  });
  return (await listSupportAccessFor(getPool(), { workspaceId: ctx.access.workspaceId })).find((x) => x.id === id)!;
}

export async function workspaceEndSupportAccess(ctx: Ctx, id: string): Promise<{ ok: true }> {
  requireAction(ctx, 'members.manage');
  assertUuid(id, 'Support access');
  await withTx(async (tx) => {
    const g = await maybeOne(tx, `SELECT 1 FROM support_access_grants WHERE id=$1 AND workspace_id=$2`, [id, ctx.access.workspaceId]);
    if (!g) throw notFound('Support access');
    if (!(await endSupportAccessTx(tx, id, { userId: ctx.actor.userId, reason: 'ended_by_workspace', correlationId: ctx.correlationId }))) {
      throw new AppError('invalid_state', 'This access is not open.');
    }
  });
  return { ok: true };
}
