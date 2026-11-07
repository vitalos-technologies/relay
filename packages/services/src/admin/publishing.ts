// V3.1 Admin §8 — publishing operations: one list of per-destination deliveries across all brands and all ten
// networks, a detail read with the evidence an operator needs, and the dead-letter (outbox) recovery list.
// Reads only; every recovery action is the EXISTING service behind its existing route (retryDelivery, resolveDelivery,
// cancelSchedule, reschedule, adoptPublication, connection/brand/workspace pause) so admin can't bypass approval,
// authority, duplicate-risk or brand-rule checks. `recovery` here only explains which of them apply and why not.
import { z } from 'zod';
import { AppError, notFound, PROVIDERS } from '@social-lite/core';
import {
  ADMIN_DELIVERY_FILTERS, type AdminDeliveryDetail, type AdminDeliveryItem, type AdminDeliveryList, type AdminDeliveryState, type DeadLetterItem,
  type RecoveryOption,
} from '@social-lite/core/contracts/v31-admin';
import { getPool, many, maybeOne, one, withTx, type Queryable } from '@social-lite/db';
import type { Ctx } from '../context.js';
import { audit } from '../audit.js';
import { assertUuid, authorizeCtx, brandAllowed, requireAction } from '../tenancy.js';
import { attemptsFor } from '../engine/manual.js';
import { AUTHORITY_HOLD } from '../engine/authority.js';
import { excerpt } from '../posts/shared.js';

const DISPLAY = `CASE
  WHEN s.status = 'pending_approval' THEN 'awaiting_approval'
  WHEN d.scheduling_owner = 'provider' AND d.state IN ('scheduled','processing') THEN 'provider_scheduled'
  WHEN d.state = 'scheduled' AND d.next_attempt_at <= now() THEN 'queued'
  WHEN d.state IN ('preparing','publishing','processing') THEN 'processing'
  WHEN d.state = 'retry_wait' THEN 'retrying'
  ELSE d.state::text END`;

/** URL filter → SQL predicate on the same columns the display state is derived from. */
const FILTER_SQL: Record<string, string> = {
  attention: `d.state IN ('failed','unknown','blocked','handoff','expired') AND s.status <> 'pending_approval'`,
  awaiting_approval: `s.status = 'pending_approval'`,
  provider_scheduled: `d.scheduling_owner = 'provider' AND d.state IN ('scheduled','processing')`,
  queued: `d.state = 'scheduled' AND d.next_attempt_at <= now() AND s.status <> 'pending_approval'`,
  scheduled: `d.state = 'scheduled' AND d.next_attempt_at > now() AND s.status <> 'pending_approval' AND d.scheduling_owner IS DISTINCT FROM 'provider'`,
  processing: `d.state IN ('preparing','publishing','processing') AND d.scheduling_owner IS DISTINCT FROM 'provider'`,
  retrying: `d.state = 'retry_wait'`,
  published: `d.state = 'published'`, failed: `d.state = 'failed'`, unknown: `d.state = 'unknown'`, cancelled: `d.state = 'cancelled'`,
  expired: `d.state = 'expired'`, paused: `d.state = 'paused'`, blocked: `d.state = 'blocked' AND s.status <> 'pending_approval'`, handoff: `d.state = 'handoff'`,
};

export const adminDeliveryQuery = z.object({
  state: z.enum(ADMIN_DELIVERY_FILTERS).optional().nullable(),
  provider: z.enum(PROVIDERS as unknown as [string, ...string[]]).optional().nullable(),
  brand_id: z.string().uuid().optional().nullable(),
  connection_id: z.string().uuid().optional().nullable(),
  window: z.enum(['24h', '7d', '30d']).optional().nullable(),
  mode: z.enum(['live', 'simulated']).optional().nullable(),
  q: z.string().trim().max(80).optional().nullable(),
  cursor: z.string().max(200).optional().nullable(),
  limit: z.coerce.number().int().min(1).max(100).optional().nullable(),
});

type ItemRow = Omit<AdminDeliveryItem, 'due_at' | 'updated_at' | 'published_at'> & { due_at: Date; updated_at: Date; published_at: Date | null };
const ITEM_SELECT = `d.id, d.post_id, d.schedule_id, d.brand_id, b.name brand_name, d.connection_id, c.display_name destination, d.provider::text provider, d.is_mock,
  d.state::text state, ${DISPLAY} display_state, p.title, d.due_at, d.updated_at, d.published_at, d.attempt_count, d.last_error_code error_code`;
const FROM = `FROM deliveries d JOIN schedules s ON s.id=d.schedule_id JOIN posts p ON p.id=d.post_id JOIN brands b ON b.id=d.brand_id JOIN connections c ON c.id=d.connection_id`;
const itemJson = (r: ItemRow): AdminDeliveryItem => ({ ...r, due_at: r.due_at.toISOString(), updated_at: r.updated_at.toISOString(), published_at: r.published_at?.toISOString() ?? null });

export async function adminDeliveries(ctx: Ctx, raw: unknown, db: Queryable = getPool()): Promise<AdminDeliveryList> {
  requireAction(ctx, 'content.read');
  const q = adminDeliveryQuery.parse(raw ?? {});
  const limit = q.limit ?? 50;
  const params: unknown[] = [ctx.access.workspaceId];
  const where = ['d.workspace_id = $1'];
  if (ctx.access.brandIds !== null) { params.push(ctx.access.brandIds); where.push(`d.brand_id = ANY($${params.length}::uuid[])`); }
  if (q.brand_id) { params.push(q.brand_id); where.push(`d.brand_id = $${params.length}`); }
  if (q.connection_id) { params.push(q.connection_id); where.push(`d.connection_id = $${params.length}`); }
  if (q.provider) { params.push(q.provider); where.push(`d.provider = $${params.length}::provider_kind`); }
  if (q.mode) where.push(q.mode === 'live' ? 'NOT d.is_mock' : 'd.is_mock');
  if (q.window) { params.push(q.window === '24h' ? '24 hours' : q.window === '7d' ? '7 days' : '30 days'); where.push(`d.updated_at > now() - $${params.length}::interval`); }
  if (q.q) { params.push(`%${q.q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`); where.push(`(p.title ILIKE $${params.length} OR c.display_name ILIKE $${params.length})`); }
  const base = [...where];
  const baseParams = [...params];
  if (q.state) where.push(FILTER_SQL[q.state]!);
  if (q.cursor) {
    const [ts, id] = Buffer.from(q.cursor, 'base64url').toString().split('|');
    if (!ts || !id || Number.isNaN(Date.parse(ts))) throw new AppError('validation_failed', 'Invalid cursor');
    params.push(ts, id); where.push(`(d.due_at, d.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
  }
  params.push(limit + 1);
  const rows = await many<ItemRow>(db, `SELECT ${ITEM_SELECT} ${FROM} WHERE ${where.join(' AND ')} ORDER BY d.due_at DESC, d.id DESC LIMIT $${params.length}`, params);
  // Counts for the three operational groups only (index-backed; whole-history counts would grow with the library).
  const counts = await one<{ attention: number; queued: number; processing: number; awaiting_approval: number }>(db,
    `SELECT count(*) FILTER (WHERE ${FILTER_SQL.attention} AND d.updated_at > now() - interval '7 days')::int attention,
            count(*) FILTER (WHERE ${FILTER_SQL.queued})::int queued,
            count(*) FILTER (WHERE ${FILTER_SQL.processing})::int processing,
            count(*) FILTER (WHERE ${FILTER_SQL.awaiting_approval})::int awaiting_approval
       ${FROM} WHERE ${base.join(' AND ')} AND (d.state IN ('failed','unknown','blocked','handoff','expired','scheduled','preparing','publishing','processing') )
         AND (d.updated_at > now() - interval '7 days' OR d.state IN ('scheduled','preparing','publishing','processing','blocked'))`, baseParams);
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    items: page.map(itemJson), counts,
    next_cursor: rows.length > limit && last ? Buffer.from(`${last.due_at.toISOString()}|${last.id}`).toString('base64url') : null,
  };
}

export async function adminDeliveryDetail(ctx: Ctx, deliveryId: string, db: Queryable = getPool()): Promise<AdminDeliveryDetail> {
  requireAction(ctx, 'content.read');
  assertUuid(deliveryId, 'Delivery');
  const r = await maybeOne<ItemRow & {
    base_text: string; revision_number: number; s_status: string; generation: number; input_local_time: string; input_timezone: string; publish_before: Date;
    approval_required: boolean; provider_ids: string[]; provider_url: string | null; error_message: string | null; needs_reconcile: boolean; unknown_since: Date | null;
    remote_schedule: { publishAt?: string; state?: string } | null; c_status: string; c_paused: boolean; c_disconnected: boolean; lease_owner: string | null;
    post_generation: number;
  }>(db,
    `SELECT ${ITEM_SELECT}, r.base_text, r.revision_number, s.status s_status, s.generation, s.input_local_time, s.input_timezone, d.publish_before,
            b.approval_required, d.provider_ids, d.provider_url, d.last_error_message error_message, d.needs_reconcile, d.unknown_since, d.remote_schedule,
            c.status::text c_status, c.paused c_paused, (c.disconnected_at IS NOT NULL) c_disconnected, d.lease_owner, p.schedule_generation post_generation
       ${FROM} JOIN post_revisions r ON r.id=d.revision_id WHERE d.id=$1 AND d.workspace_id=$2`, [deliveryId, ctx.access.workspaceId]);
  if (!r || !brandAllowed(ctx, r.brand_id)) throw notFound('Delivery');
  const approval = await maybeOne<{ decision: string; decided_at: Date | null; email: string | null }>(db,
    `SELECT a.decision, a.decided_at, u.email::text FROM approvals a LEFT JOIN users u ON u.id=a.reviewer_id WHERE a.schedule_id=$1 ORDER BY a.requested_at DESC LIMIT 1`, [r.schedule_id]);
  const auth = await maybeOne<{ status: string; hold_code: string | null; email: string | null }>(db,
    `SELECT a.status, a.hold_code, u.email::text FROM publication_authorizations a LEFT JOIN users u ON u.id=a.principal_user_id WHERE a.schedule_id=$1 ORDER BY a.created_at DESC LIMIT 1`, [r.schedule_id]);
  const attempts = await attemptsFor(r.id);

  const brand = { brandId: r.brand_id };
  const mayRetry = authorizeCtx(ctx, 'publishing.retry', brand).allowed;
  const maySchedule = authorizeCtx(ctx, 'content.schedule', brand).allowed;
  const mayConn = authorizeCtx(ctx, 'connections.manage', { brandId: r.brand_id, connectionId: r.connection_id }).allowed;
  const current = r.generation === r.post_generation && ['active', 'completed'].includes(r.s_status);
  const connOk = !r.c_disconnected && ['ready', 'expiring'].includes(r.c_status);
  const opt = (action: RecoveryOption['action'], ok: boolean, reason: string | null): RecoveryOption => ({ action, available: ok && !reason, reason: ok ? reason : reason ?? 'You don’t have permission for this brand' });
  const why = (checks: Array<[boolean, string]>) => checks.find(([bad]) => bad)?.[1] ?? null;
  const authorityHold = r.state === 'blocked' && r.error_code === AUTHORITY_HOLD;
  const recovery: RecoveryOption[] = [
    opt('retry', mayRetry, why([
      [r.state === 'published', 'Already published — never sent twice'],
      [r.state === 'unknown', 'Outcome unknown — check the channel and resolve, or retry accepting duplicate risk'],
      [authorityHold, 'Held for authority — adopt it instead'],
      [!['failed', 'expired', 'blocked'].includes(r.state), `Not retryable while ${r.display_state.replace(/_/g, ' ')}`],
      [!!r.lease_owner, 'Being processed right now'],
      [!current, 'Schedule was replaced or cancelled'],
      [!connOk, 'Fix the connection first'],
    ])),
    ...(r.state === 'unknown' ? [opt('retry_with_risk', mayRetry, why([[!!r.lease_owner, 'Being processed right now'], [!connOk, 'Fix the connection first']]))] : []),
    opt('resolve', mayRetry, why([[!['unknown', 'handoff'].includes(r.state), 'Only for Unknown or Manual handoff'], [!!r.lease_owner, 'An automatic check is running']])),
    opt('cancel', maySchedule, why([
      [!['active', 'pending_approval'].includes(r.s_status), `Schedule is ${r.s_status}`],
      [r.state === 'published', 'Published content can’t be recalled from here'],
    ])),
    opt('reschedule', maySchedule, why([
      [r.s_status !== 'active', `Schedule is ${r.s_status.replace(/_/g, ' ')}`],
      [['preparing', 'publishing', 'processing', 'published'].includes(r.state), 'Already sending or sent'],
    ])),
    ...(authorityHold ? [opt('adopt', maySchedule, null)] : []),
    r.c_paused ? opt('resume_connection', mayConn, null) : opt('pause_connection', mayConn, r.c_disconnected ? 'Connection is disconnected' : null),
  ];
  return {
    ...itemJson(r), excerpt: excerpt(r.base_text, 160), revision_number: r.revision_number,
    schedule: { status: r.s_status, generation: r.generation, input_local_time: r.input_local_time, input_timezone: r.input_timezone, publish_before: r.publish_before.toISOString() },
    approval: r.approval_required || approval ? { required: r.approval_required, decision: approval?.decision ?? null, decided_at: approval?.decided_at?.toISOString() ?? null, decided_by: approval?.email ?? null } : null,
    authority: auth ? { status: auth.status, scheduled_by: auth.email, hold_code: auth.hold_code } : null,
    provider_ids: r.provider_ids ?? [], provider_url: r.provider_url, error_message: r.error_message,
    reconcile: { needs_reconcile: r.needs_reconcile, unknown_since: r.unknown_since?.toISOString() ?? null },
    remote_schedule: r.remote_schedule ? { publish_at: r.remote_schedule.publishAt ?? null, state: r.remote_schedule.state ?? null } : null,
    connection: { status: r.c_status, paused: r.c_paused, disconnected: r.c_disconnected },
    attempts: attempts.map((a) => ({ attempt_number: a.attempt_number, kind: a.kind, phase: a.phase, outcome: a.outcome, safe_code: a.safe_code, safe_message: a.safe_message,
      started_at: a.started_at, ended_at: a.ended_at, actor_email: a.actor_email })),
    recovery,
  };
}

// ------------------------------------------------------------------ dead letters (outbox rows that failed 10 dispatches)
/** Event types whose consumers reload state and are idempotent; anything else could repeat an email or external write. */
export const REQUEUE_SAFE = new Set(['delivery.due', 'asset.uploaded', 'source.import_requested', 'export.requested', 'bulk.requested']);

export async function deadLetters(ctx: Ctx, db: Queryable = getPool()): Promise<{ items: DeadLetterItem[] }> {
  requireAction(ctx, 'workspace.manage');
  const rows = await many<{ id: string; event_type: string; aggregate_type: string; aggregate_id: string; attempts: number; last_error: string | null; created_at: Date }>(db,
    `SELECT id::text, event_type, aggregate_type, aggregate_id, attempts, last_error, created_at FROM outbox WHERE workspace_id=$1 AND dispatch_state='dead' ORDER BY id DESC LIMIT 100`,
    [ctx.access.workspaceId]);
  return {
    items: rows.map((r) => ({
      ...r, created_at: r.created_at.toISOString(), last_error: r.last_error ? r.last_error.replace(/(token|secret|key|password)=\S+/gi, '$1=<redacted>').slice(0, 200) : null,
      requeue_allowed: REQUEUE_SAFE.has(r.event_type),
      reason: REQUEUE_SAFE.has(r.event_type) ? null : 'Could repeat a notification or external write',
    })),
  };
}

/** Requeue one dead outbox row (conditional update ⇒ repeated clicks requeue once). */
export async function requeueDeadLetter(ctx: Ctx, id: string): Promise<{ ok: true; requeued: boolean }> {
  requireAction(ctx, 'workspace.manage');
  if (!/^\d{1,19}$/.test(id)) throw notFound('Event');
  return withTx(async (tx) => {
    const r = await maybeOne<{ event_type: string; dispatch_state: string }>(tx, `SELECT event_type, dispatch_state FROM outbox WHERE id=$1 AND workspace_id=$2 FOR UPDATE`, [id, ctx.access.workspaceId]);
    if (!r) throw notFound('Event');
    if (r.dispatch_state !== 'dead') return { ok: true as const, requeued: false };
    if (!REQUEUE_SAFE.has(r.event_type)) throw new AppError('invalid_state', 'This event type is not safe to requeue.');
    await tx.query(`UPDATE outbox SET dispatch_state='pending', attempts=0, available_at=now(), last_error=NULL WHERE id=$1`, [id]);
    await audit(tx, { workspaceId: ctx.access.workspaceId, actorUserId: ctx.actor.userId, action: 'outbox.requeued', resourceType: 'outbox', resourceId: id,
      diff: { event_type: r.event_type }, correlationId: ctx.correlationId });
    return { ok: true as const, requeued: true };
  });
}

export type { AdminDeliveryState };
