// Reconciliation of Unknown outcomes (spec §11): ask the provider, read-only, whether the post exists.
// Unknown is never treated as Failed. Providers without lookup (Telegram) require manual resolution.
import type { Checkpoint } from '@social-lite/core';
import { getPool, maybeOne, one, withTx, type Pool } from '@social-lite/db';
import { writeOutbox } from '../outbox.js';
import { log } from '../log.js';
import { checkAndConsumeBudget } from './budget.js';
import { completeScheduleIfDone, type EngineDeps } from './process.js';

const MAX_AUTO_RECONCILES = 10;

interface UnknownRow {
  id: string; workspace_id: string; schedule_id: string; post_id: string; connection_id: string; provider: 'instagram' | 'facebook' | 'telegram' | 'x';
  is_mock: boolean; variant_id: string; provider_ids: string[]; preparation: Checkpoint | null; unknown_since: Date | null; fence: string;
}

/** Claim one Unknown delivery due for reconciliation (lease prevents concurrent reconcilers). */
async function claimUnknown(pool: Pool, workerId: string, deliveryId: string | null = null): Promise<UnknownRow | null> {
  return withTx(async (tx) => {
    const row = await maybeOne<UnknownRow>(tx,
      `UPDATE deliveries SET lease_owner=$1, lease_expires_at=now() + interval '60 seconds', fence=fence+1, updated_at=now()
        WHERE id = (SELECT id FROM deliveries WHERE state IN ('unknown','handoff') AND needs_reconcile AND next_attempt_at <= now()
                      AND (lease_owner IS NULL OR lease_expires_at < now()) AND ($2::uuid IS NULL OR id = $2::uuid)
                      ORDER BY next_attempt_at LIMIT 1 FOR UPDATE SKIP LOCKED)
        RETURNING id, workspace_id, schedule_id, post_id, connection_id, provider, is_mock, variant_id, provider_ids, preparation, unknown_since, fence::text AS fence`, [workerId, deliveryId]);
    return row;
  }, pool);
}

/** Reconcile the next due Unknown/handoff delivery (or only `opts.deliveryId`, used by tests and targeted checks). */
export async function reconcileOne(deps: EngineDeps, workerId: string, pool: Pool = getPool(), opts: { deliveryId?: string } = {}): Promise<string | null> {
  const d = await claimUnknown(pool, workerId, opts.deliveryId ?? null);
  if (!d) return null;
  const release = `lease_owner=NULL, lease_expires_at=NULL`;
  const n = await one<{ n: number }>(pool, `SELECT count(*)::int n FROM delivery_attempts WHERE delivery_id=$1 AND kind='reconcile'`, [d.id]);
  const attemptNo = (await one<{ m: number }>(pool, `SELECT coalesce(max(attempt_number),0)::int m FROM delivery_attempts WHERE delivery_id=$1`, [d.id])).m + 1;
  await pool.query(`INSERT INTO delivery_attempts(workspace_id, delivery_id, attempt_number, fence, worker_id, kind, phase) VALUES ($1,$2,$3,$4,$5,'reconcile','reconcile')`,
    [d.workspace_id, d.id, attemptNo, d.fence, workerId]);
  const end = (outcome: string, code: string | null, msg: string | null, ids?: string[]) => pool.query(
    `UPDATE delivery_attempts SET ended_at=now(), outcome=$3, safe_code=$4, safe_message=$5, provider_ids=coalesce($6, provider_ids) WHERE delivery_id=$1 AND attempt_number=$2`,
    [d.id, attemptNo, outcome, code, msg, ids ?? null]);

  let result;
  try {
    if (d.provider === 'x' && !d.is_mock) {
      const b = await withTx((tx) => checkAndConsumeBudget(tx, d.workspace_id, 'x.read', 1), pool);
      if (!b.ok) {
        await pool.query(`UPDATE deliveries SET ${release}, next_attempt_at=now() + interval '6 hours', last_error_message=$2 WHERE id=$1 AND fence=$3::bigint`, [d.id, `Automatic check paused: ${b.message} Resolve manually.`, d.fence]);
        await end('skipped', 'budget_exhausted', b.message);
        return 'budget';
      }
    }
    const creds = await deps.getCredentials(d.connection_id);
    const v = await one<{ rendered_text: string }>(pool, `SELECT rendered_text FROM variants WHERE id=$1`, [d.variant_id]);
    const sentAt = await maybeOne<{ started_at: Date }>(pool, `SELECT started_at FROM delivery_attempts WHERE delivery_id=$1 AND phase='sending' ORDER BY attempt_number DESC LIMIT 1`, [d.id]);
    const actx = await deps.adapterContext(d.provider, creds.connection);
    result = await deps.adapterFor(d.provider).reconcile(actx, {
      deliveryId: d.id, connection: creds.connection, credentials: creds.credentials, variantText: v.rendered_text,
      providerIds: d.provider_ids, checkpoint: d.preparation, sentAt: (sentAt?.started_at ?? d.unknown_since)?.toISOString() ?? null,
    });
  } catch (err) {
    result = { kind: 'still_unknown' as const, reason: 'the provider could not be reached' };
    log.warn('reconcile_error', { deliveryId: d.id, err: err as Error });
  }

  return withTx(async (tx) => {
    const fenced = `WHERE id=$1 AND fence=$2::bigint AND state IN ('unknown','handoff')`;
    let state = 'unknown';
    if (result.kind === 'published') {
      await tx.query(`UPDATE deliveries SET state='published', ${release}, needs_reconcile=false, provider_ids=(SELECT array_agg(DISTINCT x) FROM unnest(provider_ids || $3::text[]) x),
          provider_url=coalesce($4, provider_url), published_at=coalesce($5, now()), last_error_code=NULL, last_error_message='Confirmed by the provider after an uncertain response.', updated_at=now() ${fenced}`,
        [d.id, d.fence, result.providerIds, result.url ?? null, result.publishedAt ? new Date(result.publishedAt) : null]);
      await end('confirmed', null, 'Found on provider', result.providerIds);
      state = 'published';
    } else if (result.kind === 'not_published') {
      await tx.query(`UPDATE deliveries SET state='failed', ${release}, needs_reconcile=false, last_error_code='not_published_confirmed',
          last_error_message=$3, updated_at=now() ${fenced}`, [d.id, d.fence, `The provider confirmed this was not published (${result.reason}). Retrying is safe.`]);
      await end('not_published', 'not_published_confirmed', result.reason);
      state = 'failed';
    } else if (result.kind === 'handoff') {
      // Manual handoff: keep checking hourly (does not count toward the Unknown auto-check cap).
      await tx.query(`UPDATE deliveries SET state='handoff', ${release}, needs_reconcile=true, next_attempt_at=now() + interval '1 hour',
          last_error_code='manual_handoff', last_error_message=$3, updated_at=now() ${fenced}`, [d.id, d.fence, result.reason]);
      await end('handoff', 'manual_handoff', result.reason, result.providerIds);
      state = 'handoff';
    } else if (result.kind === 'unsupported') {
      await tx.query(`UPDATE deliveries SET ${release}, needs_reconcile=false, last_error_code='manual_review_required',
          last_error_message=$3, updated_at=now() ${fenced}`, [d.id, d.fence, `${result.reason} Check the channel and mark this result as published or not published.`]);
      await end('unsupported', 'manual_review_required', result.reason);
    } else {
      const stop = n.n + 1 >= MAX_AUTO_RECONCILES;
      const delayMin = Math.min(60, 2 ** Math.min(n.n, 6));
      await tx.query(`UPDATE deliveries SET ${release}, needs_reconcile=$3, next_attempt_at=now() + ($4 || ' minutes')::interval,
          last_error_message=$5, updated_at=now() ${fenced}`,
        [d.id, d.fence, !stop, String(delayMin), stop ? 'Automatic checks could not confirm the result. Check the channel and resolve manually.' : `Still checking with the provider (${result.kind === 'processing' ? 'processing' : result.reason}).`]);
      await end('still_unknown', null, result.kind === 'processing' ? 'processing' : result.reason);
    }
    if (state !== 'unknown') {
      await writeOutbox(tx, { workspaceId: d.workspace_id, aggregateType: 'delivery', aggregateId: d.id, eventType: 'delivery.state_changed', payload: { state, postId: d.post_id, scheduleId: d.schedule_id } });
      await completeScheduleIfDone(tx, d.schedule_id);
    }
    return state;
  }, pool);
}
