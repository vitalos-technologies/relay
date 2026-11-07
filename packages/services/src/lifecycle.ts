// Member lifecycle (spec §4): suspension, removal and scope reduction are DISTINCT operations recorded in
// membership_status_history; handover preview + reassignment; last-owner protection; ownership transfer.
//  - Effect is immediate: every request reloads membership/grants (loadAccess), so open tabs fail on their
//    next call; the policy version is bumped in the same transaction.
//  - Removal never revokes the person's sessions: other workspaces keep working (only this workspace's
//    "active workspace" pointer is cleared). History (posts, revisions, approvals, audit) is never deleted.
//  - Queued work scheduled by a suspended/removed member is HELD (engine/authority.ts) for adoption.
//  - Connections the departing member authorised are flagged for verification/reconnect; we do not claim
//    a local reassignment moves provider-side ownership.
//  - Owner-affecting operations serialise on the workspace row and re-verify the actor under the lock, so
//    concurrent removals/demotions can never remove the last active owner.
import { AppError, forbidden, notFound, type Permission } from '@social-lite/core';
import { getPool, many, maybeOne, withTx, type Queryable } from '@social-lite/db';
import { audit } from './audit.js';
import type { Ctx } from './context.js';
import { authorize, loadUserAuthz } from './authz.js';
import { actorIsOwner, activeOwnerIds, commitPolicyChange, lockWorkspace, mayDelegate, upsertGrant } from './grants.js';
import { assertMayActOn, loadMemberRow } from './members.js';
import { transferAuthorities } from './engine/authority.js';
import { disableServiceAccountsOwnedBy } from './service-accounts.js';
import { assertUuid, isUuid, requireAction } from './tenancy.js';

const columnCache = new Map<string, boolean>();
async function hasColumn(db: Queryable, table: string, column: string): Promise<boolean> {
  const k = `${table}.${column}`;
  if (!columnCache.has(k)) {
    const r = await maybeOne(db, `SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 AND column_name=$2`, [table, column]);
    columnCache.set(k, !!r);
  }
  return columnCache.get(k)!;
}

/** Re-verify the actor under the workspace lock (a concurrent change may have removed their authority). */
async function assertActorStill(tx: Queryable, ctx: Ctx, perm: Permission, opts: { owner?: boolean } = {}): Promise<void> {
  if (!ctx.access.authz) return; // legacy test contexts
  const fresh = await loadUserAuthz(ctx.actor.userId, ctx.access.workspaceId, ctx.access.authz.subject.assurance, tx);
  const ok = authorize(fresh, perm).allowed && (!opts.owner || fresh.subject.grants.some((g) => g.role === 'owner' && g.via === 'direct'));
  if (!ok) throw forbidden('You no longer have permission to do that');
}

async function history(tx: Queryable, ctx: Ctx, userId: string, from: string | null, to: string, reason: string | null) {
  await tx.query(`INSERT INTO membership_status_history(workspace_id, user_id, from_status, to_status, actor_user_id, reason) VALUES ($1,$2,$3,$4,$5,$6)`,
    [ctx.access.workspaceId, userId, from, to, ctx.actor.userId, reason?.slice(0, 300) ?? null]);
}

async function notifyUsers(tx: Queryable, workspaceId: string, userIds: string[], n: { kind: string; title: string; body?: string; severity?: 'info' | 'warning' | 'critical'; ref?: string; dedupe: string }) {
  for (const u of [...new Set(userIds)]) {
    await tx.query(
      `INSERT INTO notifications(workspace_id, user_id, severity, kind, title, body, reference_type, reference_id, dedupe_key)
       VALUES ($1,$2,$3,$4,$5,$6,'workspace',$7,$8) ON CONFLICT (user_id, dedupe_key) DO NOTHING`,
      [workspaceId, u, n.severity ?? 'info', n.kind, n.title, n.body ?? null, n.ref ?? workspaceId, n.dedupe]);
  }
}

async function assertNotLastOwner(tx: Queryable, workspaceId: string, userId: string, msg: string) {
  const owners = await activeOwnerIds(tx, workspaceId);
  if (owners.includes(userId) && owners.length <= 1) throw new AppError('invalid_state', msg, undefined, { reason: 'last_owner' });
}

// ------------------------------------------------------------------ suspension

export async function suspendMember(ctx: Ctx, userId: string, input: { reason?: string | null } = {}): Promise<{ ok: true; held_publications: number; policy_version: number }> {
  requireAction(ctx, 'members.manage');
  return withTx(async (tx) => {
    await lockWorkspace(tx, ctx.access.workspaceId);
    await assertActorStill(tx, ctx, 'members.manage');
    const m = await loadMemberRow(tx, ctx, userId, true);
    await assertMayActOn(tx, ctx, userId);
    await assertNotLastOwner(tx, ctx.access.workspaceId, userId, 'You cannot suspend the last owner of a workspace.');
    if (m.status === 'suspended') return { ok: true as const, held_publications: 0, policy_version: ctx.access.authz?.policyVersion ?? 0 };
    const reason = input.reason?.trim().slice(0, 300) || null;
    await tx.query(`UPDATE memberships SET status='suspended', suspended_at=now(), suspended_by=$3, status_reason=$4 WHERE workspace_id=$1 AND user_id=$2`,
      [ctx.access.workspaceId, userId, ctx.actor.userId, reason]);
    await history(tx, ctx, userId, m.status, 'suspended', reason);
    const pc = await commitPolicyChange(tx, ctx.access.workspaceId, [userId]);
    await audit(tx, { workspaceId: ctx.access.workspaceId, actorUserId: ctx.actor.userId, action: 'member.suspended', resourceType: 'member', resourceId: userId,
      diff: { reason, held_publications: pc.held, policy_version: pc.policyVersion }, correlationId: ctx.correlationId });
    return { ok: true as const, held_publications: pc.held, policy_version: pc.policyVersion };
  });
}

/** Reactivation restores access. It never auto-releases publications held while suspended (adoption is explicit). */
export async function reactivateMember(ctx: Ctx, userId: string): Promise<{ ok: true; policy_version: number }> {
  requireAction(ctx, 'members.manage');
  return withTx(async (tx) => {
    await lockWorkspace(tx, ctx.access.workspaceId);
    const m = await loadMemberRow(tx, ctx, userId, true);
    await assertMayActOn(tx, ctx, userId);
    if (m.status === 'active') return { ok: true as const, policy_version: ctx.access.authz?.policyVersion ?? 0 };
    await tx.query(`UPDATE memberships SET status='active', suspended_at=NULL, suspended_by=NULL, status_reason=NULL WHERE workspace_id=$1 AND user_id=$2`, [ctx.access.workspaceId, userId]);
    await history(tx, ctx, userId, m.status, 'active', 'reactivated');
    const pc = await commitPolicyChange(tx, ctx.access.workspaceId, [userId]);
    await audit(tx, { workspaceId: ctx.access.workspaceId, actorUserId: ctx.actor.userId, action: 'member.reactivated', resourceType: 'member', resourceId: userId,
      diff: { policy_version: pc.policyVersion }, correlationId: ctx.correlationId });
    return { ok: true as const, policy_version: pc.policyVersion };
  });
}

// ------------------------------------------------------------------ scope reduction

/** Remove a member's DIRECT grants on the given brands (membership stays). Team-derived access is reported. */
export async function reduceScope(ctx: Ctx, userId: string, input: { brand_ids: string[] }): Promise<{ revoked: number; still_via_teams: string[]; policy_version: number }> {
  requireAction(ctx, 'members.manage');
  const brandIds = [...new Set(input.brand_ids ?? [])];
  if (!brandIds.length || brandIds.some((b) => !isUuid(b))) throw new AppError('validation_failed', 'Choose brands', { brand_ids: 'Unknown brand' });
  if (ctx.access.brandIds !== null && brandIds.some((b) => !ctx.access.brandIds!.includes(b))) throw new AppError('validation_failed', 'Unknown brand', { brand_ids: 'Unknown brand' });
  return withTx(async (tx) => {
    await loadMemberRow(tx, ctx, userId, true);
    await assertMayActOn(tx, ctx, userId);
    const grants = await many<{ id: string; role: string; brand_id: string; connection_id: string | null }>(tx,
      `SELECT id, role, brand_id, connection_id FROM scoped_role_grants WHERE workspace_id=$1 AND user_id=$2 AND revoked_at IS NULL AND brand_id = ANY($3::uuid[]) FOR UPDATE`,
      [ctx.access.workspaceId, userId, brandIds]);
    for (const g of grants) if (!mayDelegate(ctx, { role: g.role as never, brandId: g.brand_id, connectionId: g.connection_id })) throw forbidden('You cannot remove a role you could not grant.');
    if (grants.length) await tx.query(`UPDATE scoped_role_grants SET revoked_at=now(), revoked_by=$2, revoke_reason='scope_reduced' WHERE id = ANY($1::uuid[])`, [grants.map((g) => g.id), ctx.actor.userId]);
    const viaTeams = await many<{ brand_id: string }>(tx,
      `SELECT DISTINCT g.brand_id FROM scoped_role_grants g JOIN team_memberships tm ON tm.team_id=g.team_id AND tm.user_id=$2 JOIN teams t ON t.id=g.team_id AND t.archived_at IS NULL
        WHERE g.workspace_id=$1 AND g.principal_type='team' AND g.revoked_at IS NULL AND g.brand_id = ANY($3::uuid[])`, [ctx.access.workspaceId, userId, brandIds]);
    const pc = await commitPolicyChange(tx, ctx.access.workspaceId, [userId]);
    await audit(tx, { workspaceId: ctx.access.workspaceId, actorUserId: ctx.actor.userId, action: 'member.scope_reduced', resourceType: 'member', resourceId: userId,
      diff: { brand_ids: brandIds, revoked: grants.length, still_via_teams: viaTeams.map((v) => v.brand_id), held_publications: pc.held, policy_version: pc.policyVersion },
      correlationId: ctx.correlationId });
    return { revoked: grants.length, still_via_teams: viaTeams.map((v) => v.brand_id), policy_version: pc.policyVersion };
  });
}

// ------------------------------------------------------------------ handover

export interface HandoverPreview {
  user: { id: string; email: string; name: string | null; status: string };
  drafts: { count: number; items: Array<{ post_id: string; title: string | null; brand_id: string; brand_name: string; updated_at: string }> };
  pending_approvals: { requested: number; assigned: number };
  scheduled: { count: number; held: number; items: Array<{ schedule_id: string; post_id: string; title: string | null; brand_id: string; brand_name: string; due_at: string; status: string }> };
  service_accounts: Array<{ id: string; name: string }>;
  connections: Array<{ id: string; name: string; provider: string; brand_id: string; brand_name: string }>;
  other_workspaces: number;
  candidates: Array<{ user_id: string; email: string; name: string | null; can_edit: string[]; can_schedule: string[]; can_own_service_accounts: boolean }>;
  /** V1 field names kept for the existing removal dialog. */
  approved_schedules_remaining: number; drafts_losing_access: number;
}

/** What is affected if this member leaves — only for brands the viewer can see (no unrelated-brand exposure). */
export async function handoverPreview(ctx: Ctx, userId: string, db: Queryable = getPool()): Promise<HandoverPreview> {
  requireAction(ctx, 'members.manage');
  assertUuid(userId, 'Member');
  const u = await maybeOne<{ id: string; email: string; name: string | null; status: string }>(db,
    `SELECT u.id, u.email, u.name, m.status FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.workspace_id=$1 AND m.user_id=$2 AND m.status <> 'removed'`,
    [ctx.access.workspaceId, userId]);
  if (!u) throw notFound('Member');
  const ws = ctx.access.workspaceId;
  const vis = ctx.access.brandIds;
  const assignee = await hasColumn(db, 'posts', 'assignee_user_id');
  const drafts = await many<{ post_id: string; title: string | null; brand_id: string; brand_name: string; updated_at: Date }>(db,
    `SELECT p.id AS post_id, p.title, p.brand_id, b.name AS brand_name, p.updated_at FROM posts p JOIN brands b ON b.id=p.brand_id
      WHERE p.workspace_id=$1 AND p.archived_at IS NULL AND ($3::uuid[] IS NULL OR p.brand_id = ANY($3::uuid[]))
        AND (${assignee ? 'p.assignee_user_id=$2 OR (p.assignee_user_id IS NULL AND p.created_by=$2)' : 'p.created_by=$2'})
        AND NOT EXISTS (SELECT 1 FROM schedules s WHERE s.post_id=p.id AND s.status IN ('active','pending_approval','completed'))
      ORDER BY p.updated_at DESC`, [ws, userId, vis]);
  const approvalAssignee = await hasColumn(db, 'approvals', 'assignee_user_id');
  const appr = (await maybeOne<{ requested: number; assigned: number }>(db,
    `SELECT count(*) FILTER (WHERE a.requested_by=$2)::int AS requested, ${approvalAssignee ? 'count(*) FILTER (WHERE a.assignee_user_id=$2)::int' : '0'} AS assigned
       FROM approvals a WHERE a.workspace_id=$1 AND a.decision='pending' AND ($3::uuid[] IS NULL OR a.brand_id = ANY($3::uuid[]))`, [ws, userId, vis]))!;
  const sched = await many<{ schedule_id: string; post_id: string; title: string | null; brand_id: string; brand_name: string; due_at: Date; status: string }>(db,
    `SELECT a.schedule_id, a.post_id, p.title, a.brand_id, b.name AS brand_name, s.due_at, a.status
       FROM publication_authorizations a JOIN schedules s ON s.id=a.schedule_id JOIN posts p ON p.id=a.post_id JOIN brands b ON b.id=a.brand_id
      WHERE a.workspace_id=$1 AND a.principal_user_id=$2 AND a.basis='scheduler' AND s.status='active' AND ($3::uuid[] IS NULL OR a.brand_id = ANY($3::uuid[]))
        AND EXISTS (SELECT 1 FROM deliveries d WHERE d.schedule_id=a.schedule_id AND d.state IN ('scheduled','retry_wait','paused','blocked'))
      ORDER BY s.due_at`, [ws, userId, vis]);
  const sas = await many<{ id: string; name: string }>(db, `SELECT id, name FROM service_accounts WHERE workspace_id=$1 AND owner_user_id=$2 AND disabled_at IS NULL ORDER BY name`, [ws, userId]);
  const conns = await many<{ id: string; name: string; provider: string; brand_id: string; brand_name: string }>(db,
    `SELECT c.id, c.display_name AS name, c.provider, c.brand_id, b.name AS brand_name FROM connections c JOIN brands b ON b.id=c.brand_id
      WHERE c.workspace_id=$1 AND c.created_by=$2 AND c.disconnected_at IS NULL AND ($3::uuid[] IS NULL OR c.brand_id = ANY($3::uuid[])) ORDER BY c.display_name`, [ws, userId, vis]);
  const other = (await maybeOne<{ n: number }>(db, `SELECT count(*)::int n FROM memberships WHERE user_id=$1 AND workspace_id<>$2 AND status='active'`, [userId, ws]))!.n;
  // Candidates: active members other than the departing one, with the affected brands they are authorised for.
  const affected = [...new Set([...drafts.map((d) => d.brand_id), ...sched.map((s) => s.brand_id)])];
  const members = await many<{ user_id: string; email: string; name: string | null }>(db,
    `SELECT m.user_id, u.email, u.name FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.workspace_id=$1 AND m.status='active' AND m.user_id<>$2 ORDER BY u.email LIMIT 200`, [ws, userId]);
  const candidates: HandoverPreview['candidates'] = [];
  for (const m of members) {
    const s = await loadUserAuthz(m.user_id, ws, null, db);
    const canEdit = affected.filter((b) => authorize(s, 'content.edit', { brandId: b }).allowed);
    const canSchedule = affected.filter((b) => authorize(s, 'content.schedule', { brandId: b }).allowed);
    const canOwn = authorize(s, 'service_accounts.manage').allowed;
    if (canEdit.length || canSchedule.length || (sas.length && canOwn)) candidates.push({ ...m, can_edit: canEdit, can_schedule: canSchedule, can_own_service_accounts: canOwn });
  }
  return {
    user: u,
    drafts: { count: drafts.length, items: drafts.slice(0, 50).map((d) => ({ ...d, updated_at: d.updated_at.toISOString() })) },
    pending_approvals: appr,
    scheduled: { count: sched.length, held: sched.filter((s) => s.status === 'held').length,
      items: sched.slice(0, 50).map((s) => ({ ...s, due_at: s.due_at.toISOString() })) },
    service_accounts: sas, connections: conns, other_workspaces: other, candidates,
    approved_schedules_remaining: sched.length, drafts_losing_access: drafts.length,
  };
}

export interface ReassignResult { drafts: number; approvals: number; scheduled: { transferred: number; skipped: number }; service_accounts: number; skipped_unauthorized: number }

async function reassignTx(tx: Queryable, ctx: Ctx, fromUserId: string, toUserId: string, what: Set<string>): Promise<ReassignResult> {
  if (fromUserId === toUserId) throw new AppError('validation_failed', 'Choose someone else', { to_user_id: 'Choose someone else' });
  const ws = ctx.access.workspaceId;
  const target = await maybeOne(tx, `SELECT 1 FROM memberships WHERE workspace_id=$1 AND user_id=$2 AND status='active'`, [ws, toUserId]);
  if (!target) throw new AppError('validation_failed', 'Choose an active member', { to_user_id: 'Not an active member' });
  const t = await loadUserAuthz(toUserId, ws, null, tx);
  const vis = ctx.access.brandIds;
  const out: ReassignResult = { drafts: 0, approvals: 0, scheduled: { transferred: 0, skipped: 0 }, service_accounts: 0, skipped_unauthorized: 0 };
  const brands = (await many<{ id: string }>(tx, `SELECT id FROM brands WHERE workspace_id=$1 AND ($2::uuid[] IS NULL OR id = ANY($2::uuid[]))`, [ws, vis])).map((b) => b.id);
  const editable = brands.filter((b) => authorize(t, 'content.edit', { brandId: b }).allowed);
  if (what.has('drafts') && await hasColumn(tx, 'posts', 'assignee_user_id')) {
    const r = await tx.query(
      `UPDATE posts SET assignee_user_id=$3 WHERE workspace_id=$1 AND archived_at IS NULL AND brand_id = ANY($4::uuid[])
          AND (assignee_user_id=$2 OR (assignee_user_id IS NULL AND created_by=$2))`, [ws, fromUserId, toUserId, editable]);
    out.drafts = r.rowCount ?? 0;
    const left = await maybeOne<{ n: number }>(tx,
      `SELECT count(*)::int n FROM posts WHERE workspace_id=$1 AND archived_at IS NULL AND brand_id = ANY($3::uuid[]) AND (assignee_user_id=$2 OR (assignee_user_id IS NULL AND created_by=$2))`,
      [ws, fromUserId, brands]);
    out.skipped_unauthorized += left?.n ?? 0;
  }
  if (what.has('approvals') && await hasColumn(tx, 'approvals', 'assignee_user_id')) {
    const approvable = brands.filter((b) => authorize(t, 'content.approve', { brandId: b }).allowed);
    const r = await tx.query(`UPDATE approvals SET assignee_user_id=$3 WHERE workspace_id=$1 AND decision='pending' AND assignee_user_id=$2 AND brand_id = ANY($4::uuid[])`,
      [ws, fromUserId, toUserId, approvable]);
    out.approvals = r.rowCount ?? 0;
  }
  if (what.has('scheduled')) out.scheduled = await transferAuthorities(tx, ctx, fromUserId, toUserId, vis);
  if (what.has('service_accounts')) {
    if (authorize(t, 'service_accounts.manage').allowed) {
      const r = await tx.query(`UPDATE service_accounts SET owner_user_id=$3 WHERE workspace_id=$1 AND owner_user_id=$2 AND disabled_at IS NULL`, [ws, fromUserId, toUserId]);
      out.service_accounts = r.rowCount ?? 0;
    } else {
      const n = await maybeOne<{ n: number }>(tx, `SELECT count(*)::int n FROM service_accounts WHERE workspace_id=$1 AND owner_user_id=$2 AND disabled_at IS NULL`, [ws, fromUserId]);
      out.skipped_unauthorized += n?.n ?? 0;
    }
  }
  return out;
}

/** Reassign a member's open work to an authorised member. Items the assignee is not authorised for are skipped (reported). */
export async function reassignWork(ctx: Ctx, fromUserId: string, input: { to_user_id: string; items?: string[] }): Promise<ReassignResult> {
  requireAction(ctx, 'members.manage');
  assertUuid(fromUserId, 'Member');
  if (!isUuid(input.to_user_id)) throw new AppError('validation_failed', 'Choose an active member', { to_user_id: 'Required' });
  const what = new Set(input.items?.length ? input.items : ['drafts', 'approvals', 'scheduled', 'service_accounts']);
  return withTx(async (tx) => {
    const exists = await maybeOne(tx, `SELECT 1 FROM memberships WHERE workspace_id=$1 AND user_id=$2`, [ctx.access.workspaceId, fromUserId]);
    if (!exists) throw notFound('Member');
    const r = await reassignTx(tx, ctx, fromUserId, input.to_user_id, what);
    await audit(tx, { workspaceId: ctx.access.workspaceId, actorUserId: ctx.actor.userId, action: 'member.work_reassigned', resourceType: 'member', resourceId: fromUserId,
      diff: { to_user_id: input.to_user_id, ...r }, correlationId: ctx.correlationId });
    return r;
  });
}

// ------------------------------------------------------------------ removal

/** Kept for the V1 removal dialog route. */
export async function removalImpact(ctx: Ctx, userId: string): Promise<HandoverPreview> {
  return handoverPreview(ctx, userId);
}

export async function removeMember(ctx: Ctx, userId: string, opts: { reassign_to?: string | null; reason?: string | null } = {}): Promise<{ ok: true; impact: HandoverPreview; reassigned: ReassignResult | null; held_publications: number; flagged_connections: number }> {
  requireAction(ctx, 'members.manage');
  const impact = await handoverPreview(ctx, userId);
  return withTx(async (tx) => {
    await lockWorkspace(tx, ctx.access.workspaceId);
    await assertActorStill(tx, ctx, 'members.manage');
    const m = await loadMemberRow(tx, ctx, userId, true);
    // Leaving yourself is allowed (except as the last owner); acting on others follows the owner rule.
    if (userId !== ctx.actor.userId) await assertMayActOn(tx, ctx, userId);
    await assertNotLastOwner(tx, ctx.access.workspaceId, userId, 'You cannot remove the last owner of a workspace.');
    const ws = ctx.access.workspaceId;
    const reassigned = opts.reassign_to ? await reassignTx(tx, ctx, userId, opts.reassign_to, new Set(['drafts', 'approvals', 'scheduled', 'service_accounts'])) : null;
    await tx.query(`UPDATE memberships SET status='removed', removed_at=now(), removed_by=$3, status_reason=$4 WHERE workspace_id=$1 AND user_id=$2`,
      [ws, userId, ctx.actor.userId, opts.reason?.trim().slice(0, 300) || null]);
    const revoked = await tx.query(`UPDATE scoped_role_grants SET revoked_at=now(), revoked_by=$3, revoke_reason='membership_removed'
                                     WHERE workspace_id=$1 AND user_id=$2 AND revoked_at IS NULL`, [ws, userId, ctx.actor.userId]);
    const teams = await many<{ team_id: string }>(tx, `DELETE FROM team_memberships WHERE workspace_id=$1 AND user_id=$2 RETURNING team_id`, [ws, userId]);
    await tx.query(`DELETE FROM membership_brand_grants WHERE workspace_id=$1 AND user_id=$2`, [ws, userId]);
    // Service accounts not reassigned above stop now (disabled + keys revoked + audited); never left ownerless.
    const serviceAccountsDisabled = await disableServiceAccountsOwnedBy(tx, ctx, userId, 'owner_removed');
    const flagged = await tx.query(
      `UPDATE connections SET verification_requested_at=now(),
              verification_reason='Connected by a member who left this workspace. Check the account still works for this brand, or reconnect it.'
        WHERE workspace_id=$1 AND created_by=$2 AND disconnected_at IS NULL`, [ws, userId]);
    await tx.query(`UPDATE ownership_transfers SET status='cancelled', decided_at=now(), decided_by=$3 WHERE workspace_id=$1 AND status='pending' AND (from_user_id=$2 OR to_user_id=$2)`,
      [ws, userId, ctx.actor.userId]);
    // Sessions stay valid (other workspaces keep working); only this workspace stops being their active one.
    await tx.query(`UPDATE sessions SET active_workspace_id=NULL WHERE user_id=$1 AND active_workspace_id=$2`, [userId, ws]);
    await history(tx, ctx, userId, m.status, 'removed', opts.reason ?? null);
    const pc = await commitPolicyChange(tx, ws, [userId]);
    await audit(tx, { workspaceId: ws, actorUserId: ctx.actor.userId, action: 'member.removed', resourceType: 'member', resourceId: userId,
      diff: { email: m.email, role: m.role, grants_revoked: revoked.rowCount ?? 0, teams: teams.map((t) => t.team_id), drafts: impact.drafts.count,
        scheduled: impact.scheduled.count, held_publications: pc.held, flagged_connections: flagged.rowCount ?? 0, reassigned, service_accounts_disabled: serviceAccountsDisabled, policy_version: pc.policyVersion },
      correlationId: ctx.correlationId });
    return { ok: true as const, impact, reassigned, held_publications: pc.held, flagged_connections: flagged.rowCount ?? 0 };
  });
}

// ------------------------------------------------------------------ ownership transfer

export interface OwnershipTransferDto {
  id: string; from_user_id: string; from_email: string; to_user_id: string; to_email: string; status: string;
  keep_previous_owner_as: string | null; created_at: string; expires_at: string; decided_at: string | null;
}

const TRANSFER_SQL = `SELECT t.*, fu.email AS from_email, tu.email AS to_email FROM ownership_transfers t
  JOIN users fu ON fu.id=t.from_user_id JOIN users tu ON tu.id=t.to_user_id`;

type TransferRow = Omit<OwnershipTransferDto, 'created_at' | 'expires_at' | 'decided_at'> & { workspace_id: string; created_at: Date; expires_at: Date; decided_at: Date | null };
const transferDto = (t: TransferRow): OwnershipTransferDto => ({
  id: t.id, from_user_id: t.from_user_id, from_email: t.from_email, to_user_id: t.to_user_id, to_email: t.to_email, status: t.status,
  keep_previous_owner_as: t.keep_previous_owner_as, created_at: t.created_at.toISOString(), expires_at: t.expires_at.toISOString(), decided_at: t.decided_at?.toISOString() ?? null,
});

export const TRANSFER_TTL_MS = 7 * 86400_000;

/** Step 1 (current owner, fresh authentication): propose. The new owner must accept. */
export async function proposeOwnershipTransfer(ctx: Ctx, input: { to_user_id: string; keep_previous_owner_as?: 'admin' | 'none' }): Promise<OwnershipTransferDto> {
  requireAction(ctx, 'workspace.transfer_owner', { stepUp: true });
  if (!actorIsOwner(ctx)) throw forbidden('Only an owner can transfer ownership.');
  if (!isUuid(input.to_user_id) || input.to_user_id === ctx.actor.userId) throw new AppError('validation_failed', 'Choose another member', { to_user_id: 'Choose another member' });
  const keep = input.keep_previous_owner_as === 'none' ? 'none' : 'admin';
  return withTx(async (tx) => {
    await lockWorkspace(tx, ctx.access.workspaceId);
    await assertActorStill(tx, ctx, 'workspace.transfer_owner', { owner: true });
    const target = await maybeOne<{ status: string }>(tx, `SELECT status FROM memberships WHERE workspace_id=$1 AND user_id=$2`, [ctx.access.workspaceId, input.to_user_id]);
    if (!target || target.status !== 'active') throw new AppError('validation_failed', 'Choose an active member', { to_user_id: 'Not an active member' });
    if ((await activeOwnerIds(tx, ctx.access.workspaceId)).includes(input.to_user_id)) throw new AppError('invalid_state', 'This person is already an owner.');
    await tx.query(`UPDATE ownership_transfers SET status='expired' WHERE workspace_id=$1 AND status='pending' AND expires_at <= now()`, [ctx.access.workspaceId]);
    let id: string;
    try {
      await tx.query('SAVEPOINT transfer_insert');
      id = (await maybeOne<{ id: string }>(tx,
        `INSERT INTO ownership_transfers(workspace_id, from_user_id, to_user_id, keep_previous_owner_as, expires_at) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [ctx.access.workspaceId, ctx.actor.userId, input.to_user_id, keep, new Date(Date.now() + TRANSFER_TTL_MS)]))!.id;
      await tx.query('RELEASE SAVEPOINT transfer_insert');
    } catch (err) {
      await tx.query('ROLLBACK TO SAVEPOINT transfer_insert');
      if ((err as { code?: string }).code === '23505') throw new AppError('conflict', 'An ownership transfer is already pending. Cancel it first.');
      throw err;
    }
    await notifyUsers(tx, ctx.access.workspaceId, [input.to_user_id], { kind: 'ownership.transfer_requested', severity: 'warning',
      title: 'You have been asked to become the workspace owner', body: `${ctx.actor.email} wants to transfer ownership to you. Accept it in Team.`, dedupe: `ownership:${id}:requested` });
    await audit(tx, { workspaceId: ctx.access.workspaceId, actorUserId: ctx.actor.userId, action: 'ownership.transfer_proposed', resourceType: 'workspace', resourceId: ctx.access.workspaceId,
      diff: { transfer_id: id, to_user_id: input.to_user_id, keep_previous_owner_as: keep }, correlationId: ctx.correlationId });
    return transferDto((await maybeOne<TransferRow>(tx, `${TRANSFER_SQL} WHERE t.id=$1`, [id]))!);
  });
}

/** Fresh, MFA-verified authentication of the CURRENT session (server-side; never client-asserted). */
function assertFreshAssurance(ctx: Ctx): void {
  const a = ctx.access.authz;
  const s = a?.subject.assurance;
  if (!a || !s) throw new AppError('step_up_required', 'Confirm it’s you to continue.', undefined, { reason: 'step_up_required' });
  if (!s.mfaVerified && (a.policy.mfa_required_all || a.policy.mfa_required_for.includes('owner'))) {
    throw new AppError('mfa_required', 'Verify with your second factor to do this.', undefined, { reason: 'mfa_required' });
  }
  const age = s.authTime ? (Date.now() - new Date(s.authTime).getTime()) / 1000 : Infinity;
  if (age > a.policy.step_up_seconds) throw new AppError('step_up_required', 'Confirm it’s you to continue.', undefined, { reason: 'step_up_required' });
}

/** Step 2 (the proposed owner, fresh authentication): atomic swap of ownership. */
export async function acceptOwnershipTransfer(ctx: Ctx, transferId: string): Promise<OwnershipTransferDto> {
  assertUuid(transferId, 'Transfer');
  assertFreshAssurance(ctx);
  return withTx(async (tx) => {
    await lockWorkspace(tx, ctx.access.workspaceId);
    const t = await maybeOne<TransferRow>(tx, `${TRANSFER_SQL} WHERE t.id=$1 AND t.workspace_id=$2 FOR UPDATE OF t`, [transferId, ctx.access.workspaceId]);
    if (!t || t.to_user_id !== ctx.actor.userId) throw notFound('Transfer');
    if (t.status !== 'pending') throw new AppError('invalid_state', `This transfer was already ${t.status}.`);
    if (t.expires_at.getTime() <= Date.now()) {
      await tx.query(`UPDATE ownership_transfers SET status='expired' WHERE id=$1`, [t.id]);
      throw new AppError('invalid_state', 'This transfer has expired. Ask the owner to start a new one.');
    }
    const owners = await activeOwnerIds(tx, ctx.access.workspaceId);
    if (!owners.includes(t.from_user_id)) throw new AppError('invalid_state', 'The proposing owner is no longer an owner. This transfer is not valid.');
    const me = await maybeOne<{ status: string }>(tx, `SELECT status FROM memberships WHERE workspace_id=$1 AND user_id=$2`, [ctx.access.workspaceId, ctx.actor.userId]);
    if (me?.status !== 'active') throw forbidden('You no longer have access to this workspace');
    const ws = ctx.access.workspaceId;
    await upsertGrant(tx, { workspaceId: ws, principal: { userId: t.to_user_id }, grantedBy: t.from_user_id, source: 'ownership_transfer',
      grant: { role: 'owner', scopeType: 'workspace', brandId: null, connectionId: null, expiresAt: null } });
    await tx.query(`UPDATE scoped_role_grants SET revoked_at=now(), revoked_by=$3, revoke_reason='ownership_transferred'
                     WHERE workspace_id=$1 AND user_id=$2 AND role='owner' AND revoked_at IS NULL`, [ws, t.from_user_id, ctx.actor.userId]);
    if (t.keep_previous_owner_as === 'admin') {
      await upsertGrant(tx, { workspaceId: ws, principal: { userId: t.from_user_id }, grantedBy: ctx.actor.userId, source: 'ownership_transfer',
        grant: { role: 'admin', scopeType: 'workspace', brandId: null, connectionId: null, expiresAt: null } });
    }
    await tx.query(`UPDATE ownership_transfers SET status='accepted', decided_at=now(), decided_by=$2 WHERE id=$1`, [t.id, ctx.actor.userId]);
    const pc = await commitPolicyChange(tx, ws, [t.from_user_id, t.to_user_id]);
    const admins = await many<{ user_id: string }>(tx, `SELECT DISTINCT user_id FROM scoped_role_grants WHERE workspace_id=$1 AND role IN ('owner','admin') AND revoked_at IS NULL AND user_id IS NOT NULL`, [ws]);
    await notifyUsers(tx, ws, [t.from_user_id, t.to_user_id, ...admins.map((a) => a.user_id)], { kind: 'ownership.transferred', severity: 'warning',
      title: 'Workspace ownership changed', body: `${t.to_email} is now the owner (previously ${t.from_email}).`, dedupe: `ownership:${t.id}:accepted` });
    await audit(tx, { workspaceId: ws, actorUserId: ctx.actor.userId, action: 'ownership.transferred', resourceType: 'workspace', resourceId: ws,
      diff: { transfer_id: t.id, from_user_id: t.from_user_id, to_user_id: t.to_user_id, previous_owner_now: t.keep_previous_owner_as, policy_version: pc.policyVersion },
      correlationId: ctx.correlationId });
    return transferDto((await maybeOne<TransferRow>(tx, `${TRANSFER_SQL} WHERE t.id=$1`, [t.id]))!);
  });
}

/** Cancel (proposer) or decline (proposed owner). */
export async function cancelOwnershipTransfer(ctx: Ctx, transferId: string): Promise<OwnershipTransferDto> {
  assertUuid(transferId, 'Transfer');
  return withTx(async (tx) => {
    const t = await maybeOne<TransferRow>(tx, `${TRANSFER_SQL} WHERE t.id=$1 AND t.workspace_id=$2 FOR UPDATE OF t`, [transferId, ctx.access.workspaceId]);
    if (!t || (t.from_user_id !== ctx.actor.userId && t.to_user_id !== ctx.actor.userId && !actorIsOwner(ctx))) throw notFound('Transfer');
    if (t.status !== 'pending') throw new AppError('invalid_state', `This transfer was already ${t.status}.`);
    const status = t.to_user_id === ctx.actor.userId ? 'declined' : 'cancelled';
    await tx.query(`UPDATE ownership_transfers SET status=$2, decided_at=now(), decided_by=$3 WHERE id=$1`, [t.id, status, ctx.actor.userId]);
    await audit(tx, { workspaceId: ctx.access.workspaceId, actorUserId: ctx.actor.userId, action: `ownership.transfer_${status}`, resourceType: 'workspace', resourceId: ctx.access.workspaceId,
      diff: { transfer_id: t.id }, correlationId: ctx.correlationId });
    return transferDto((await maybeOne<TransferRow>(tx, `${TRANSFER_SQL} WHERE t.id=$1`, [t.id]))!);
  });
}

export async function listOwnershipTransfers(ctx: Ctx, db: Queryable = getPool()): Promise<{ items: OwnershipTransferDto[] }> {
  const rows = await many<TransferRow>(db,
    `${TRANSFER_SQL} WHERE t.workspace_id=$1 AND t.status='pending' AND t.expires_at > now() AND ($3 OR t.from_user_id=$2 OR t.to_user_id=$2) ORDER BY t.created_at DESC`,
    [ctx.access.workspaceId, ctx.actor.userId, actorIsOwner(ctx)]);
  return { items: rows.map(transferDto) };
}

export async function membershipHistory(ctx: Ctx, userId: string, db: Queryable = getPool()) {
  requireAction(ctx, 'members.read');
  assertUuid(userId, 'Member');
  const rows = await many<{ from_status: string | null; to_status: string; reason: string | null; created_at: Date; actor_email: string | null }>(db,
    `SELECT h.from_status, h.to_status, h.reason, h.created_at, u.email AS actor_email FROM membership_status_history h LEFT JOIN users u ON u.id=h.actor_user_id
      WHERE h.workspace_id=$1 AND h.user_id=$2 ORDER BY h.created_at DESC, h.id DESC LIMIT 100`, [ctx.access.workspaceId, userId]);
  return { items: rows.map((r) => ({ ...r, created_at: r.created_at.toISOString() })) };
}
