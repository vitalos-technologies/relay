// Atomic claims, leases, fencing and sweepers for the delivery queue (spec §11 steps 5-6, "Races and leases").
import type { DeliveryState, Provider } from '@social-lite/core';
import { getPool, many, maybeOne, withTx, type Pool, type Queryable } from '@social-lite/db';
import { writeOutbox } from '../outbox.js';
import { selectFairCandidate } from './fairness.js';

export const LEASE_MS = 90_000;

export interface ClaimedDelivery {
  id: string; workspace_id: string; brand_id: string; post_id: string; schedule_id: string; generation: number;
  revision_id: string; variant_id: string; connection_id: string; provider: Provider; is_mock: boolean;
  state: DeliveryState; prior_state: DeliveryState; phase: string; due_at: Date; publish_before: Date; next_attempt_at: Date;
  attempt_count: number; max_attempts: number; lease_owner: string; lease_expires_at: Date; fence: string;
  preparation: { step: string; data: Record<string, unknown>; expiresAt?: string | null } | null;
  provider_ids: string[]; unknown_since: Date | null;
}

export async function dispatchEnabled(db: Queryable = getPool()): Promise<boolean> {
  const r = await maybeOne<{ value: unknown }>(db, `SELECT value FROM system_flags WHERE key='dispatch_enabled'`);
  return r?.value !== false;
}

const CLAIM_RETURNING = `id, workspace_id, brand_id, post_id, schedule_id, generation, revision_id, variant_id, connection_id, provider, is_mock,
  state, phase, due_at, publish_before, next_attempt_at, attempt_count, max_attempts, lease_owner, lease_expires_at, fence::text AS fence,
  preparation, provider_ids, unknown_since`;

/**
 * Claim the next due delivery (or a specific one). Eligible: Scheduled/RetryWait due now, or Processing due a status check.
 * Per-connection serialization: skips connections with another live lease, throttled connections and open provider circuits.
 * V2: per-workspace concurrency cap and fair ordering across workspaces (see fairness.ts).
 * The claim increments the fencing token; every later write must match it.
 */
export async function claimDelivery(workerId: string, opts: { deliveryId?: string } = {}, db = getPool()): Promise<ClaimedDelivery | null> {
  return withTx(async (tx) => {
    // V2 fairness: per-workspace concurrency cap + fair ordering across workspaces (engine/fairness.ts).
    const cand = await selectFairCandidate(tx, opts.deliveryId ?? null);
    if (!cand) return null;
    const isPoll = cand.state === 'processing';
    const row = await maybeOne<ClaimedDelivery>(tx,
      `UPDATE deliveries SET
          state = CASE WHEN state='processing' THEN 'processing'::delivery_state ELSE 'preparing'::delivery_state END,
          phase = CASE WHEN state='processing' THEN 'awaiting_provider' ELSE 'preparing' END,
          lease_owner=$2, lease_expires_at=now() + ($3 || ' milliseconds')::interval, fence=fence+1,
          attempt_count = attempt_count + CASE WHEN $4 THEN 0 ELSE 1 END, updated_at=now()
        WHERE id=$1 RETURNING ${CLAIM_RETURNING}`, [cand.id, workerId, String(LEASE_MS), isPoll]);
    if (!row) return null;
    row.prior_state = cand.state;
    if (!isPoll) await tx.query(
      `INSERT INTO delivery_attempts(workspace_id, delivery_id, attempt_number, fence, worker_id, kind, phase)
       VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (delivery_id, attempt_number) DO UPDATE SET fence=EXCLUDED.fence, worker_id=EXCLUDED.worker_id, phase=EXCLUDED.phase, started_at=now(), ended_at=NULL`,
      [row.workspace_id, row.id, Math.max(row.attempt_count, 1), row.fence, workerId, isPoll ? 'reconcile' : 'automatic', isPoll ? 'awaiting_provider' : 'preparing']);
    return row;
  }, db);
}

/** Fenced update: applies only if this worker still holds the claim. Returns true on success. */
export async function fencedUpdate(db: Queryable, d: Pick<ClaimedDelivery, 'id' | 'fence' | 'lease_owner'>, set: string, params: unknown[] = [], extraWhere = ''): Promise<boolean> {
  const r = await db.query(
    `UPDATE deliveries SET ${set}, updated_at=now() WHERE id=$1 AND fence=$2::bigint AND lease_owner=$3 ${extraWhere}`,
    [d.id, d.fence, d.lease_owner, ...params]);
  return (r.rowCount ?? 0) === 1;
}

export async function heartbeat(db: Queryable, d: ClaimedDelivery): Promise<boolean> {
  return fencedUpdate(db, d, `lease_expires_at = now() + ($4 || ' milliseconds')::interval`, [String(LEASE_MS)]);
}

/**
 * Expired leases: if the worker died before sending, the job is safely returned to Scheduled.
 * If it died while SENDING, the outcome is ambiguous: move to Unknown and reconcile (never resend blindly).
 */
export async function sweepExpiredLeases(db: Pool = getPool()): Promise<{ requeued: number; unknown: number; released: number }> {
  return withTx(async (tx) => {
    const requeued = await tx.query(
      `UPDATE deliveries SET state='scheduled', phase='idle', lease_owner=NULL, lease_expires_at=NULL, next_attempt_at=now(), updated_at=now()
        WHERE lease_owner IS NOT NULL AND lease_expires_at < now() AND state='preparing' AND phase='preparing' RETURNING id`);
    const unknown = await tx.query<{ id: string; workspace_id: string }>(
      `UPDATE deliveries SET state='unknown', phase='idle', lease_owner=NULL, lease_expires_at=NULL, needs_reconcile=true,
              unknown_since=now(), next_attempt_at=now() + interval '30 seconds',
              last_error_code='worker_lost_during_send', last_error_message='The worker stopped while sending. The post may or may not exist; checking with the provider.', updated_at=now()
        WHERE lease_owner IS NOT NULL AND lease_expires_at < now() AND phase='sending' RETURNING id, workspace_id`);
    for (const r of unknown.rows) {
      await writeOutbox(tx, { workspaceId: r.workspace_id, aggregateType: 'delivery', aggregateId: r.id, eventType: 'delivery.state_changed', payload: { state: 'unknown' } });
    }
    const released = await tx.query(
      `UPDATE deliveries SET lease_owner=NULL, lease_expires_at=NULL, updated_at=now()
        WHERE lease_owner IS NOT NULL AND lease_expires_at < now() AND phase='awaiting_provider'`);
    return { requeued: requeued.rowCount ?? 0, unknown: unknown.rowCount ?? 0, released: released.rowCount ?? 0 };
  }, db);
}

/** SC-06/SC-07: jobs past their publish-before deadline are expired for review, never flooded out later. */
export async function sweepDeadlines(db: Pool = getPool()): Promise<number> {
  return withTx(async (tx) => {
    const r = await tx.query<{ id: string; workspace_id: string }>(
      `UPDATE deliveries SET state='expired', phase='idle', last_error_code='deadline_passed',
              last_error_message='Missed: the publish-before deadline passed before this could be sent (for example during downtime or a pause). Review and reschedule if still relevant.',
              updated_at=now()
        WHERE state IN ('scheduled','retry_wait','paused','blocked') AND lease_owner IS NULL AND publish_before <= now()
        RETURNING id, workspace_id`);
    for (const row of r.rows) {
      await writeOutbox(tx, { workspaceId: row.workspace_id, aggregateType: 'delivery', aggregateId: row.id, eventType: 'delivery.state_changed', payload: { state: 'expired' } });
    }
    return r.rowCount ?? 0;
  }, db);
}

export async function dueCount(db: Queryable = getPool()): Promise<number> {
  const r = await many<{ n: number }>(db, `SELECT count(*)::int n FROM deliveries WHERE state IN ('scheduled','retry_wait') AND next_attempt_at <= now()`);
  return r[0]?.n ?? 0;
}
