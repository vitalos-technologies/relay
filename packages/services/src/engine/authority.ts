// Publication authority (spec §4 "Queued publication after permission changes").
//  1. When a schedule becomes active we RECORD who authorised it: immutable revision, destinations,
//     workspace/brand, approval ids + approvers, the scheduling principal and the policy version.
//  2. At dispatch (engine gate, before preparing AND again inside the send transaction) we REVALIDATE
//     against the current policy: the scheduler still holds content.schedule/content.publish on the
//     brand + destination; recorded approvers still hold content.approve. Failure ⇒ HOLD: not-started
//     deliveries become 'blocked' with last_error_code 'authority_hold' — never silently cancelled or sent.
//  3. A held publication stays held until an authorised publisher ADOPTS it (adoption_events): adoption
//     revalidates and re-queues. Policy loosening (re-granting) never auto-releases a hold.
//  4. Boundary: a delivery already in 'publishing' (external call started) completes; holds apply only to
//     deliveries that have not begun sending. Removing a draft AUTHOR alone does not hold anything:
//     only the scheduling principal and approvers are revalidated.
import { AppError, notFound, type Permission } from '@social-lite/core';
import { getPool, many, maybeOne, withTx, type Queryable } from '@social-lite/db';
import type { Ctx } from '../context.js';
import { audit } from '../audit.js';
import { writeOutbox } from '../outbox.js';
import { authorize, loadUserAuthz, type AuthzState } from '../authz.js';
import { assertUuid, authorizeCtx, brandFilter, requireAction } from '../tenancy.js';

export const AUTHORITY_HOLD = 'authority_hold';

export interface AuthorityRow {
  id: string; workspace_id: string; brand_id: string; schedule_id: string; post_id: string; revision_id: string; connection_ids: string[];
  basis: 'scheduler' | 'approval'; principal_user_id: string | null; principal_permission: Permission; approval_ids: string[];
  approver_user_ids: string[]; policy_version: string; status: 'active' | 'held'; hold_code: string | null; hold_detail: string | null;
  held_at: Date | null; adopted_by: string | null; adopted_at: Date | null; created_at: Date;
}

/** Record at schedule/approval time (same transaction that activates the schedule). */
export async function recordPublicationAuthority(tx: Queryable, ctx: Ctx, p: {
  scheduleId: string; postId: string; brandId: string; revisionId: string; connectionIds: string[];
  basis: 'scheduler' | 'approval'; principalUserId?: string | null; permission: Permission; approvalIds?: string[]; approverUserIds?: string[];
}): Promise<void> {
  const pv = ctx.access.authz?.policyVersion ?? Number((await maybeOne<{ v: string }>(tx, `SELECT policy_version v FROM workspaces WHERE id=$1`, [ctx.access.workspaceId]))?.v ?? 0);
  await tx.query(
    `INSERT INTO publication_authorizations(workspace_id, brand_id, schedule_id, post_id, revision_id, connection_ids, basis, principal_user_id,
        principal_permission, approval_ids, approver_user_ids, policy_version, last_validated_at, last_validated_policy_version)
     VALUES ($1,$2,$3,$4,$5,$6::uuid[],$7,$8,$9,$10::uuid[],$11::uuid[],$12,now(),$12)
     ON CONFLICT (schedule_id) DO NOTHING`,
    [ctx.access.workspaceId, p.brandId, p.scheduleId, p.postId, p.revisionId, [...new Set(p.connectionIds)].sort(), p.basis,
      p.principalUserId === undefined ? ctx.actor.userId : p.principalUserId, p.permission, p.approvalIds ?? [], p.approverUserIds ?? [], pv]);
}

type Check = { ok: true } | { ok: false; code: string; detail: string; message: string };

const MESSAGES: Record<string, string> = {
  authority_missing: 'Held: no publication authority was recorded for this schedule. An authorised publisher must adopt it.',
  scheduler_unauthorized: 'Held: the person who scheduled this no longer has publishing rights for this brand. An authorised publisher must adopt it.',
  approver_unauthorized: 'Held: an approver of this post no longer has approval rights. Submit it for review again.',
  approval_withdrawn: 'Held: the recorded approval is no longer valid. Submit it for review again.',
  destination_not_authorized: 'Held: this destination was not part of the authorised schedule.',
  revision_mismatch: 'Held: the content differs from the authorised revision.',
  held: 'Held for adoption by an authorised publisher.',
};

/** Pure-ish revalidation against current grants (no writes). Assurance is not re-required in the background. */
export async function evaluateAuthority(db: Queryable, a: AuthorityRow, delivery?: { connection_id: string; revision_id: string }): Promise<Check> {
  const fail = (code: string, detail: string): Check => ({ ok: false, code, detail, message: MESSAGES[code] ?? MESSAGES.held! });
  if (delivery && !a.connection_ids.includes(delivery.connection_id)) return fail('destination_not_authorized', 'connection not in authorisation');
  if (delivery && delivery.revision_id !== a.revision_id) return fail('revision_mismatch', 'delivery revision differs');
  const cache = new Map<string, AuthzState>();
  const stateFor = async (userId: string) => {
    if (!cache.has(userId)) cache.set(userId, await loadUserAuthz(userId, a.workspace_id, null, db));
    return cache.get(userId)!;
  };
  const conns = delivery ? [delivery.connection_id] : a.connection_ids;
  if (a.basis === 'scheduler') {
    if (!a.principal_user_id) return fail('scheduler_unauthorized', 'no principal');
    const s = await stateFor(a.principal_user_id);
    for (const c of conns) {
      const r = authorize(s, a.principal_permission, { brandId: a.brand_id, connectionId: c });
      if (!r.allowed) return fail('scheduler_unauthorized', `${a.principal_permission}:${r.reason}`);
    }
  } else {
    const live = await many<{ id: string }>(db, `SELECT id FROM approvals WHERE id = ANY($1::uuid[]) AND decision='approved'`, [a.approval_ids]);
    if (live.length !== a.approval_ids.length || !a.approval_ids.length) return fail('approval_withdrawn', 'approval not approved');
  }
  for (const u of a.approver_user_ids) {
    const r = authorize(await stateFor(u), 'content.approve', { brandId: a.brand_id });
    if (!r.allowed) return fail('approver_unauthorized', `content.approve:${r.reason}`);
  }
  return { ok: true };
}

const NOT_STARTED = `('scheduled','retry_wait','paused','blocked')`;

/** Mark the authority held and hold every not-yet-started delivery of the schedule. */
export async function holdPublication(db: Queryable, a: Pick<AuthorityRow, 'id' | 'workspace_id' | 'schedule_id'>, code: string, detail: string): Promise<number> {
  const message = MESSAGES[code] ?? MESSAGES.held!;
  await db.query(
    `UPDATE publication_authorizations SET status='held', hold_code=$2, hold_detail=$3, held_at=coalesce(held_at, now())
      WHERE id=$1 AND status='active'`, [a.id, code, detail.slice(0, 300)]);
  const r = await db.query<{ id: string }>(
    `UPDATE deliveries SET state='blocked', blocked_reason=$2, last_error_code='${AUTHORITY_HOLD}', last_error_message=$2, updated_at=now()
      WHERE schedule_id=$1 AND state IN ${NOT_STARTED} AND lease_owner IS NULL RETURNING id`, [a.schedule_id, message]);
  for (const row of r.rows) {
    await writeOutbox(db, { workspaceId: a.workspace_id, aggregateType: 'delivery', aggregateId: row.id, eventType: 'delivery.state_changed', payload: { state: 'blocked', reason: AUTHORITY_HOLD } });
  }
  return r.rowCount ?? 0;
}

/**
 * Dispatch gate hook (engine/process.ts). Fails CLOSED: a missing record or an evaluation error holds.
 * A record already held stays held (loosening never auto-releases).
 */
export async function checkPublicationAuthority(db: Queryable, d: { schedule_id: string; connection_id: string; revision_id: string; workspace_id: string }): Promise<Check> {
  let a: AuthorityRow | null = null;
  try {
    a = await maybeOne<AuthorityRow>(db, `SELECT * FROM publication_authorizations WHERE schedule_id=$1 AND workspace_id=$2`, [d.schedule_id, d.workspace_id]);
    if (!a) return { ok: false, code: AUTHORITY_HOLD, detail: 'authority_missing', message: MESSAGES.authority_missing! };
    if (a.status === 'held') return { ok: false, code: AUTHORITY_HOLD, detail: a.hold_code ?? 'held', message: MESSAGES[a.hold_code ?? 'held'] ?? MESSAGES.held! };
    const r = await evaluateAuthority(db, a, d);
    if (r.ok) {
      await db.query(`UPDATE publication_authorizations SET last_validated_at=now(),
                        last_validated_policy_version=(SELECT policy_version FROM workspaces WHERE id=$2) WHERE id=$1`, [a.id, a.workspace_id]);
      return r;
    }
    await holdPublication(db, a, r.code, r.detail);
    return { ok: false, code: AUTHORITY_HOLD, detail: r.code, message: r.message };
  } catch {
    // Policy evaluation failure: fail closed (hold), never fall back to sending.
    return { ok: false, code: AUTHORITY_HOLD, detail: 'evaluation_failed', message: MESSAGES.held! };
  }
}

/**
 * Proactive revalidation after a policy change (same transaction as the grant/membership change), so the
 * UI shows holds immediately. The dispatch gate is the backstop. Bounded to live schedules in the workspace.
 */
export async function revalidateAuthorities(tx: Queryable, workspaceId: string, userIds?: string[]): Promise<number> {
  const rows = await many<AuthorityRow>(tx,
    `SELECT a.* FROM publication_authorizations a JOIN schedules s ON s.id=a.schedule_id
      WHERE a.workspace_id=$1 AND a.status='active' AND s.status='active'
        AND ($2::uuid[] IS NULL OR a.principal_user_id = ANY($2::uuid[]) OR a.approver_user_ids && $2::uuid[])
        AND EXISTS (SELECT 1 FROM deliveries d WHERE d.schedule_id=a.schedule_id AND d.state IN ${NOT_STARTED})
      LIMIT 500`, [workspaceId, userIds ?? null]);
  let held = 0;
  for (const a of rows) {
    const r = await evaluateAuthority(tx, a);
    if (!r.ok) { await holdPublication(tx, a, r.code, r.detail); held++; }
  }
  return held;
}

// ------------------------------------------------------------------ adoption queue

export interface HeldPublicationDto {
  schedule_id: string; post_id: string; title: string | null; brand_id: string; brand_name: string; due_at: string; publish_before: string;
  hold_code: string | null; message: string; held_at: string | null; scheduled_by_email: string | null; destinations: number; held_deliveries: number;
  can_adopt: boolean; adoptable: boolean;
}

export async function listHeldPublications(ctx: Ctx, db: Queryable = getPool()): Promise<{ items: HeldPublicationDto[] }> {
  const f = brandFilter(ctx, 'a.brand_id', 2);
  const rows = await many<{ schedule_id: string; post_id: string; title: string | null; brand_id: string; brand_name: string; due_at: Date; publish_before: Date;
    hold_code: string | null; held_at: Date | null; email: string | null; n: number; held: number }>(db,
    `SELECT a.schedule_id, a.post_id, p.title, a.brand_id, b.name AS brand_name, s.due_at, s.publish_before, a.hold_code, a.held_at, u.email,
            cardinality(a.connection_ids) AS n,
            (SELECT count(*)::int FROM deliveries d WHERE d.schedule_id=a.schedule_id AND d.last_error_code='${AUTHORITY_HOLD}' AND d.state='blocked') AS held
       FROM publication_authorizations a JOIN schedules s ON s.id=a.schedule_id JOIN posts p ON p.id=a.post_id JOIN brands b ON b.id=a.brand_id
       LEFT JOIN users u ON u.id=a.principal_user_id
      WHERE a.workspace_id=$1 AND a.status='held' AND s.status='active' AND ${f.sql}
      ORDER BY s.due_at LIMIT 200`, [ctx.access.workspaceId, ...f.params]);
  const items = rows.filter((r) => authorizeCtx(ctx, 'content.read', { brandId: r.brand_id }).allowed).map((r) => {
    const adoptable = !['approver_unauthorized', 'approval_withdrawn', 'revision_mismatch'].includes(r.hold_code ?? '');
    return {
      schedule_id: r.schedule_id, post_id: r.post_id, title: r.title, brand_id: r.brand_id, brand_name: r.brand_name, due_at: r.due_at.toISOString(),
      publish_before: r.publish_before.toISOString(), hold_code: r.hold_code, message: MESSAGES[r.hold_code ?? 'held'] ?? MESSAGES.held!,
      held_at: r.held_at?.toISOString() ?? null, scheduled_by_email: r.email, destinations: r.n, held_deliveries: r.held, adoptable,
      can_adopt: adoptable && authorizeCtx(ctx, 'content.schedule', { brandId: r.brand_id }).allowed,
    };
  });
  return { items };
}

/**
 * Adopt a held publication: the caller (an authorised publisher on the brand; MFA policy applies) becomes
 * the scheduling principal, the approval/approvers are revalidated, and held deliveries are re-queued
 * (or expired when their publish-before deadline has passed). Idempotent: adopting an active one is a no-op.
 */
export async function adoptPublication(ctx: Ctx, scheduleId: string): Promise<{ schedule_id: string; requeued: number; expired: number; already_active: boolean }> {
  assertUuid(scheduleId, 'Schedule');
  return withTx(async (tx) => {
    const a = await maybeOne<AuthorityRow>(tx, `SELECT * FROM publication_authorizations WHERE schedule_id=$1 AND workspace_id=$2 FOR UPDATE`, [scheduleId, ctx.access.workspaceId]);
    if (!a || !authorizeCtx(ctx, 'content.read', { brandId: a.brand_id }).allowed) throw notFound('Schedule');
    requireAction(ctx, a.principal_permission === 'content.publish' ? 'content.publish' : 'content.schedule', { brandId: a.brand_id });
    for (const c of a.connection_ids) requireAction(ctx, 'content.schedule', { brandId: a.brand_id, connectionId: c });
    const s = await maybeOne<{ status: string; generation: number; post_generation: number; fingerprint: string; approval_required: boolean }>(tx,
      `SELECT s.status, s.generation, p.schedule_generation post_generation, s.fingerprint, b.approval_required
         FROM schedules s JOIN posts p ON p.id=s.post_id JOIN brands b ON b.id=s.brand_id WHERE s.id=$1 FOR UPDATE OF s`, [scheduleId]);
    if (!s || s.status !== 'active' || s.generation !== s.post_generation) throw new AppError('invalid_state', 'This schedule was cancelled or replaced. Nothing to adopt.');
    if (a.status === 'active') return { schedule_id: scheduleId, requeued: 0, expired: 0, already_active: true };
    if (s.approval_required) {
      const ok = await maybeOne(tx, `SELECT 1 FROM approvals WHERE schedule_id=$1 AND decision='approved' AND fingerprint=$2`, [scheduleId, s.fingerprint]);
      if (!ok) throw new AppError('invalid_state', 'The approval for this post is no longer valid. Submit it for review again.', undefined, { reason: 'approval_no_longer_valid' });
    }
    // Revalidate the approvers (an adopter cannot replace a withdrawn approval).
    const asAdopted: AuthorityRow = { ...a, basis: 'scheduler', principal_user_id: ctx.actor.userId };
    const check = await evaluateAuthority(tx, asAdopted);
    if (!check.ok) {
      throw new AppError('invalid_state', check.code === 'scheduler_unauthorized' ? 'You do not have publishing rights for every destination of this post.' : check.message, undefined, { reason: check.code });
    }
    const pv = ctx.access.authz?.policyVersion ?? 0;
    await tx.query(
      `UPDATE publication_authorizations SET principal_user_id=$2, status='active', hold_code=NULL, hold_detail=NULL, held_at=NULL,
              adopted_by=$2, adopted_at=now(), policy_version=$3, last_validated_at=now(), last_validated_policy_version=$3 WHERE id=$1`,
      [a.id, ctx.actor.userId, pv]);
    const expired = await tx.query<{ id: string }>(
      `UPDATE deliveries SET state='expired', last_error_code='deadline_passed', blocked_reason=NULL,
              last_error_message='The publish-before deadline passed while this was held for adoption. Reschedule if still relevant.', updated_at=now()
        WHERE schedule_id=$1 AND state='blocked' AND last_error_code='${AUTHORITY_HOLD}' AND publish_before <= now() RETURNING id`, [scheduleId]);
    const requeued = await tx.query<{ id: string }>(
      `UPDATE deliveries SET state='scheduled', blocked_reason=NULL, last_error_code=NULL, last_error_message=NULL,
              next_attempt_at=greatest(next_attempt_at, now()), updated_at=now()
        WHERE schedule_id=$1 AND state='blocked' AND last_error_code='${AUTHORITY_HOLD}' RETURNING id`, [scheduleId]);
    for (const r of [...expired.rows, ...requeued.rows]) {
      await writeOutbox(tx, { workspaceId: ctx.access.workspaceId, aggregateType: 'delivery', aggregateId: r.id, eventType: requeued.rows.includes(r) ? 'delivery.due' : 'delivery.state_changed', payload: { state: requeued.rows.includes(r) ? 'scheduled' : 'expired' } });
    }
    await tx.query(
      `INSERT INTO adoption_events(workspace_id, brand_id, schedule_id, authorization_id, from_user_id, to_user_id, hold_code, policy_version, requeued, expired, correlation_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [ctx.access.workspaceId, a.brand_id, scheduleId, a.id, a.principal_user_id, ctx.actor.userId, a.hold_code, pv, requeued.rowCount ?? 0, expired.rowCount ?? 0, ctx.correlationId]);
    await audit(tx, { workspaceId: ctx.access.workspaceId, brandId: a.brand_id, actorUserId: ctx.actor.userId, action: 'publication.adopted', resourceType: 'schedule', resourceId: scheduleId,
      diff: { from_user_id: a.principal_user_id, hold_code: a.hold_code, requeued: requeued.rowCount ?? 0, expired: expired.rowCount ?? 0, policy_version: pv }, correlationId: ctx.correlationId });
    return { schedule_id: scheduleId, requeued: requeued.rowCount ?? 0, expired: expired.rowCount ?? 0, already_active: false };
  });
}

/** Reassign (offboarding): transfer held/active authorities of `fromUserId` to an authorised member, per brand. */
export async function transferAuthorities(tx: Queryable, ctx: Ctx, fromUserId: string, toUserId: string, brandIds: string[] | null): Promise<{ transferred: number; skipped: number }> {
  const rows = await many<AuthorityRow>(tx,
    `SELECT a.* FROM publication_authorizations a JOIN schedules s ON s.id=a.schedule_id
      WHERE a.workspace_id=$1 AND a.principal_user_id=$2 AND a.basis='scheduler' AND s.status='active'
        AND ($3::uuid[] IS NULL OR a.brand_id = ANY($3::uuid[])) FOR UPDATE OF a`, [ctx.access.workspaceId, fromUserId, brandIds]);
  const target = await loadUserAuthz(toUserId, ctx.access.workspaceId, null, tx);
  let transferred = 0;
  let skipped = 0;
  for (const a of rows) {
    if (ctx.access.brandIds !== null && !ctx.access.brandIds.includes(a.brand_id)) { skipped++; continue; }
    const ok = a.connection_ids.every((c) => authorize(target, a.principal_permission, { brandId: a.brand_id, connectionId: c }).allowed);
    const approversOk = (await evaluateAuthority(tx, { ...a, principal_user_id: toUserId })).ok;
    if (!ok || !approversOk) { skipped++; continue; }
    await tx.query(
      `UPDATE publication_authorizations SET principal_user_id=$2, status='active', hold_code=NULL, hold_detail=NULL, held_at=NULL,
              adopted_by=$2, adopted_at=now(), policy_version=$3, last_validated_at=now() WHERE id=$1`, [a.id, toUserId, target.policyVersion]);
    const requeued = await tx.query(
      `UPDATE deliveries SET state='scheduled', blocked_reason=NULL, last_error_code=NULL, last_error_message=NULL, next_attempt_at=greatest(next_attempt_at, now()), updated_at=now()
        WHERE schedule_id=$1 AND state='blocked' AND last_error_code='${AUTHORITY_HOLD}' AND publish_before > now()`, [a.schedule_id]);
    await tx.query(
      `INSERT INTO adoption_events(workspace_id, brand_id, schedule_id, authorization_id, from_user_id, to_user_id, hold_code, policy_version, requeued, correlation_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [ctx.access.workspaceId, a.brand_id, a.schedule_id, a.id, fromUserId, toUserId, a.hold_code ?? 'reassigned', target.policyVersion, requeued.rowCount ?? 0, ctx.correlationId]);
    transferred++;
  }
  return { transferred, skipped };
}
