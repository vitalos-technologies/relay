// User-initiated delivery actions: safe retry and manual resolution of Unknown results (DE-02, §11).
import { AppError, notFound } from '@social-lite/core';
import { getPool, many, maybeOne, one, withTx } from '@social-lite/db';
import type { Ctx } from '../context.js';
import { audit } from '../audit.js';
import { writeOutbox } from '../outbox.js';
import { assertBrand, assertUuid, authorizeCtx, brandAllowed } from '../tenancy.js';
import { DELIVERY_SELECT, deliveryJson, type DeliveryRow } from '../posts/serialize.js';
import { completeScheduleIfDone } from './process.js';

async function loadDelivery(ctx: Ctx, id: string, lock = false) {
  assertUuid(id, 'Delivery');
  const db = getPool();
  const d = await maybeOne<DeliveryRow>(db, `SELECT ${DELIVERY_SELECT} FROM deliveries d JOIN connections c ON c.id=d.connection_id WHERE d.id=$1 AND d.workspace_id=$2 ${lock ? 'FOR UPDATE OF d' : ''}`, [id, ctx.access.workspaceId]);
  if (!d || !brandAllowed(ctx, d.brand_id)) throw notFound('Delivery');
  return d;
}

/** V2: retry/resolve need publishing.retry on the brand (publisher, brand_manager, admin, owner). */
function mayPublish(ctx: Ctx, brandId: string): boolean {
  return authorizeCtx(ctx, 'publishing.retry', { brandId }).allowed;
}

export async function attemptsFor(deliveryId: string) {
  const rows = await many<{ attempt_number: number; kind: string; phase: string; outcome: string | null; safe_code: string | null; safe_message: string | null;
    started_at: Date; ended_at: Date | null; actor_email: string | null; duplicate_risk_acknowledged: boolean; provider_ids: string[] }>(getPool(),
    `SELECT a.attempt_number, a.kind, a.phase, a.outcome, a.safe_code, a.safe_message, a.started_at, a.ended_at, u.email AS actor_email,
            a.duplicate_risk_acknowledged, a.provider_ids
       FROM delivery_attempts a LEFT JOIN users u ON u.id=a.actor_user_id WHERE a.delivery_id=$1 ORDER BY a.attempt_number`, [deliveryId]);
  return rows.map((r) => ({ ...r, started_at: r.started_at.toISOString(), ended_at: r.ended_at?.toISOString() ?? null }));
}

/**
 * Retry ONE destination. Successful destinations are never resent. Unknown requires explicit
 * duplicate-risk acknowledgement and is recorded as an audited manual attempt.
 */
export async function retryDelivery(ctx: Ctx, deliveryId: string, opts: { acknowledge_duplicate_risk?: boolean; deadline_minutes?: number }) {
  return withTx(async (tx) => {
    const d0 = await loadDelivery(ctx, deliveryId);
    const brand = await assertBrand(ctx, d0.brand_id, tx);
    if (!mayPublish(ctx, brand.id)) throw new AppError('forbidden', 'You cannot retry publications for this brand');
    const d = await one<DeliveryRow & { lease_owner: string | null }>(tx, `SELECT d.*, NULL::text AS display_name FROM deliveries d WHERE d.id=$1 FOR UPDATE`, [deliveryId]);
    if (d.state === 'published') throw new AppError('invalid_state', 'This destination is already published; it will not be sent again.');
    if (d.state === 'blocked' && (d as { last_error_code?: string | null }).last_error_code === 'authority_hold') {
      throw new AppError('invalid_state', 'This publication is held because its scheduler lost publishing rights. Adopt it from the adoption queue instead.', undefined, { reason: 'authority_hold' });
    }
    if (d.state === 'unknown' && !opts.acknowledge_duplicate_risk) {
      throw new AppError('invalid_state', 'The previous attempt may already have been published. Confirm you accept the risk of a duplicate post, or check the channel and resolve it instead.', undefined, { reason: 'duplicate_risk_ack_required' });
    }
    if (!['failed', 'expired', 'unknown', 'blocked'].includes(d.state)) throw new AppError('invalid_state', `A ${d.state.replace('_', ' ')} destination cannot be retried now.`);
    if (d.lease_owner) throw new AppError('invalid_state', 'This destination is being processed. Try again shortly.');
    const s = await one<{ status: string; generation: number; post_generation: number }>(tx,
      `SELECT s.status, s.generation, p.schedule_generation post_generation FROM schedules s JOIN posts p ON p.id=s.post_id WHERE s.id=$1`, [d.schedule_id]);
    if (s.generation !== s.post_generation || !['active', 'completed'].includes(s.status)) {
      throw new AppError('invalid_state', 'This schedule was replaced or cancelled. Schedule the post again instead.');
    }
    if (brand.approval_required) {
      const ok = await maybeOne(tx, `SELECT 1 FROM approvals a JOIN schedules s ON s.id=a.schedule_id WHERE a.schedule_id=$1 AND a.decision='approved' AND a.fingerprint=s.fingerprint`, [d.schedule_id]);
      if (!ok) throw new AppError('invalid_state', 'Approval for this content is no longer valid. Submit it for review again.');
    }
    const conn = await one<{ status: string; paused: boolean; disconnected_at: Date | null }>(tx, `SELECT status, paused, disconnected_at FROM connections WHERE id=$1`, [d.connection_id]);
    if (conn.disconnected_at || !['ready', 'expiring'].includes(conn.status)) throw new AppError('invalid_state', 'Fix the account on Accounts before retrying.');
    const graceMin = opts.deadline_minutes ?? brand.default_deadline_minutes;
    const publishBefore = d.publish_before.getTime() > Date.now() + 60_000 ? d.publish_before : new Date(Date.now() + graceMin * 60_000);
    const wasUnknown = d.state === 'unknown';
    // Attempt numbers stay monotonic: the manual request row takes max+1, and the delivery's attempt
    // budget is extended by 5 (or by exactly 1 for an acknowledged Unknown, which never auto-retries).
    const n = await one<{ m: number }>(tx, `SELECT coalesce(max(attempt_number),0)::int m FROM delivery_attempts WHERE delivery_id=$1`, [d.id]);
    await tx.query(`INSERT INTO delivery_attempts(workspace_id, delivery_id, attempt_number, fence, actor_user_id, kind, phase, outcome, ended_at, duplicate_risk_acknowledged, safe_message)
                    VALUES ($1,$2,$3,0,$4,'manual_retry','requested','requeued',now(),$5,$6)`,
      [d.workspace_id, d.id, n.m + 1, ctx.actor.userId, !!opts.acknowledge_duplicate_risk, `Retry requested from ${d.state}`]);
    await tx.query(
      `UPDATE deliveries SET state='scheduled', phase='idle', next_attempt_at=now(), publish_before=$2, attempt_count=$3::int, max_attempts=$3::int + $4::int,
              needs_reconcile=false, blocked_reason=NULL, last_error_code=NULL, last_error_message=$5, preparation=CASE WHEN $6::boolean THEN NULL ELSE preparation END, updated_at=now()
        WHERE id=$1`, [d.id, publishBefore, n.m + 1, wasUnknown ? 1 : 5, wasUnknown ? 'Manual retry after duplicate-risk acknowledgement.' : 'Manual retry requested.', wasUnknown]);
    await tx.query(`UPDATE schedules SET status='active' WHERE id=$1 AND status='completed'`, [d.schedule_id]);
    await writeOutbox(tx, { workspaceId: d.workspace_id, aggregateType: 'delivery', aggregateId: d.id, eventType: 'delivery.due' });
    await audit(tx, { workspaceId: d.workspace_id, brandId: d.brand_id, actorUserId: ctx.actor.userId, action: wasUnknown ? 'delivery.retry_with_duplicate_risk' : 'delivery.retry',
      resourceType: 'delivery', resourceId: d.id, diff: { from_state: d.state, acknowledged_duplicate_risk: !!opts.acknowledge_duplicate_risk }, correlationId: ctx.correlationId });
    const fresh = await one<DeliveryRow>(tx, `SELECT ${DELIVERY_SELECT} FROM deliveries d JOIN connections c ON c.id=d.connection_id WHERE d.id=$1`, [d.id]);
    return deliveryJson(fresh);
  });
}

/** Manual reconciliation of an Unknown result after the user checked the channel. */
export async function resolveDelivery(ctx: Ctx, deliveryId: string, input: { outcome: 'published' | 'not_published'; provider_url?: string; note?: string }) {
  if (!['published', 'not_published'].includes(input.outcome)) throw new AppError('validation_failed', 'Choose published or not published');
  if (input.provider_url && !/^https:\/\//.test(input.provider_url)) throw new AppError('validation_failed', 'The link must start with https://', { provider_url: 'Invalid link' });
  return withTx(async (tx) => {
    const d0 = await loadDelivery(ctx, deliveryId);
    const brand = await assertBrand(ctx, d0.brand_id, tx);
    if (!mayPublish(ctx, brand.id)) throw new AppError('forbidden', 'You cannot resolve publications for this brand');
    const d = await one<{ state: string; lease_owner: string | null; workspace_id: string; schedule_id: string; post_id: string; brand_id: string }>(tx, `SELECT * FROM deliveries WHERE id=$1 FOR UPDATE`, [deliveryId]);
    if (d.state !== 'unknown') throw new AppError('invalid_state', 'Only results that are Unknown can be resolved manually.');
    if (d.lease_owner) throw new AppError('invalid_state', 'An automatic check is running. Try again in a minute.');
    const published = input.outcome === 'published';
    await tx.query(
      `UPDATE deliveries SET state=$2::delivery_state, needs_reconcile=false, provider_url=coalesce($3, provider_url),
              published_at=CASE WHEN $2='published' THEN coalesce(published_at, now()) ELSE published_at END,
              last_error_code=$4, last_error_message=$5, updated_at=now() WHERE id=$1`,
      [deliveryId, published ? 'published' : 'failed', input.provider_url ?? null, published ? 'manually_confirmed' : 'manually_not_published',
        published ? 'Marked as published after a manual check.' : 'Marked as not published after a manual check. Retrying is safe.']);
    const n = await one<{ m: number }>(tx, `SELECT coalesce(max(attempt_number),0)::int m FROM delivery_attempts WHERE delivery_id=$1`, [deliveryId]);
    await tx.query(`INSERT INTO delivery_attempts(workspace_id, delivery_id, attempt_number, fence, actor_user_id, kind, phase, outcome, ended_at, safe_message)
                    VALUES ($1,$2,$3,0,$4,'manual_resolution','resolve',$5,now(),$6)`,
      [d.workspace_id, deliveryId, n.m + 1, ctx.actor.userId, input.outcome, input.note?.slice(0, 300) ?? null]);
    await writeOutbox(tx, { workspaceId: d.workspace_id, aggregateType: 'delivery', aggregateId: deliveryId, eventType: 'delivery.state_changed', payload: { state: published ? 'published' : 'failed', postId: d.post_id, scheduleId: d.schedule_id } });
    await completeScheduleIfDone(tx, d.schedule_id);
    await audit(tx, { workspaceId: d.workspace_id, brandId: d.brand_id, actorUserId: ctx.actor.userId, action: 'delivery.resolved_manually', resourceType: 'delivery', resourceId: deliveryId, diff: { outcome: input.outcome }, correlationId: ctx.correlationId });
    const fresh = await one<DeliveryRow>(tx, `SELECT ${DELIVERY_SELECT} FROM deliveries d JOIN connections c ON c.id=d.connection_id WHERE d.id=$1`, [deliveryId]);
    return deliveryJson(fresh);
  });
}

export async function postDeliveries(ctx: Ctx, postId: string) {
  assertUuid(postId, 'Post');
  const db = getPool();
  const p = await maybeOne<{ brand_id: string }>(db, `SELECT brand_id FROM posts WHERE id=$1 AND workspace_id=$2`, [postId, ctx.access.workspaceId]);
  if (!p || !brandAllowed(ctx, p.brand_id)) throw notFound('Post');
  const rows = await many<DeliveryRow>(db,
    `SELECT ${DELIVERY_SELECT} FROM deliveries d JOIN connections c ON c.id=d.connection_id
      WHERE d.post_id=$1 AND d.schedule_id = (SELECT id FROM schedules WHERE post_id=$1 ORDER BY generation DESC LIMIT 1)
      ORDER BY d.provider, c.display_name`, [postId]);
  return { items: await Promise.all(rows.map(async (d) => deliveryJson(d, await attemptsFor(d.id)))) };
}
