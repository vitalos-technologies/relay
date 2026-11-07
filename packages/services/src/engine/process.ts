// Delivery processing (spec §11 steps 5-10). External calls run OUTSIDE transactions; every state
// write is fenced. Ambiguous outcomes become Unknown and are reconciled, never blindly resent.
import {
  decideRetry, deriveFormat, mediaKindOf, type AdapterContext, type Checkpoint, type PrepareOutcome, type ProviderCredentials, type PublishConnection,
  type PublishInput, type PublishMedia, type PublishOutcome, type PublishingAdapter, type ReconcileOutcome, type BlockingReason, type Provider,
} from '@social-lite/core';
import { getPool, maybeOne, one, withTx, type Pool, type Queryable } from '@social-lite/db';
import { writeOutbox } from '../outbox.js';
import { log } from '../log.js';
import { blockDeliveriesForConnection } from './hooks.js';
import { fencedUpdate, heartbeat, type ClaimedDelivery } from './claim.js';
import { checkAndConsumeBudget, budgetMeterFor } from './budget.js';
import { recordCircuit } from './circuit.js';
import { cropsFromOptions, type CropSpec } from '../crops/index.js';

/** Thrown by EngineDeps.getCredentials when the connection cannot be used (revoked, refresh failed). */
export class CredentialsUnavailable extends Error {
  constructor(message: string, readonly blocking: 'reconnect' | 'permission' = 'reconnect') { super(message); }
}

/** Injected integration points (wired to the connections/media services by the worker; faked in tests). */
export interface EngineDeps {
  adapterFor(provider: Provider): PublishingAdapter;
  getCredentials(connectionId: string, opts?: { forceRefresh?: boolean }): Promise<{ credentials: ProviderCredentials; connection: PublishConnection }>;
  adapterContext(provider: Provider, connection: PublishConnection): Promise<AdapterContext>;
  /** opts.crops (V1.1): per-asset crop specs from the variant; the cropped derivative must be returned. */
  loadMedia(workspaceId: string, assetIds: string[], opts?: { crops?: Record<string, CropSpec> }): Promise<PublishMedia[]>;
  now?(): Date;
}

interface GateRow {
  ws_paused: boolean; brand_paused: boolean; conn_paused: boolean; conn_status: string; conn_disconnected: boolean;
  conn_account: string; conn_is_mock: boolean; schedule_status: string; schedule_generation: number; post_generation: number;
  approval_required: boolean; approved: boolean; publish_before: Date; state: string;
}

type GateResult = { ok: true } | { ok: false; state: 'paused' | 'blocked' | 'cancelled' | 'expired'; code: string; message: string };

async function gate(db: Queryable, d: ClaimedDelivery): Promise<GateResult> {
  const g = await one<GateRow>(db,
    `SELECT w.publishing_paused ws_paused, b.publishing_paused brand_paused, c.paused conn_paused, c.status conn_status,
            (c.disconnected_at IS NOT NULL) conn_disconnected, c.provider_account_id conn_account, c.is_mock conn_is_mock,
            s.status schedule_status, s.generation schedule_generation, p.schedule_generation post_generation,
            b.approval_required,
            EXISTS (SELECT 1 FROM approvals a WHERE a.schedule_id=s.id AND a.decision='approved' AND a.revision_id=s.revision_id AND a.fingerprint=s.fingerprint) approved,
            d.publish_before, d.state
       FROM deliveries d JOIN workspaces w ON w.id=d.workspace_id JOIN brands b ON b.id=d.brand_id
       JOIN connections c ON c.id=d.connection_id JOIN schedules s ON s.id=d.schedule_id JOIN posts p ON p.id=d.post_id
      WHERE d.id=$1`, [d.id]);
  if (g.schedule_status !== 'active' || g.schedule_generation !== g.post_generation || d.generation !== g.schedule_generation) {
    return { ok: false, state: 'cancelled', code: 'superseded', message: 'This schedule was cancelled or replaced before publication. Nothing was sent.' };
  }
  if (g.publish_before.getTime() <= Date.now()) {
    return { ok: false, state: 'expired', code: 'deadline_passed', message: 'Missed: the publish-before deadline passed. Review and reschedule if still relevant.' };
  }
  if (g.ws_paused || g.brand_paused || g.conn_paused) {
    return { ok: false, state: 'paused', code: 'paused', message: `Publishing is paused for this ${g.ws_paused ? 'workspace' : g.brand_paused ? 'brand' : 'account'}.` };
  }
  if (g.conn_disconnected) return { ok: false, state: 'blocked', code: 'disconnected', message: 'The account was disconnected. Reconnect it to publish.' };
  if (!['ready', 'expiring'].includes(g.conn_status)) {
    return { ok: false, state: 'blocked', code: g.conn_status, message: `The account needs attention (${g.conn_status.replace(/_/g, ' ')}). Fix it on Accounts; this post will resume if still timely.` };
  }
  if (g.conn_is_mock !== d.is_mock || (d.is_mock && !g.conn_account.startsWith('mock_'))) {
    return { ok: false, state: 'blocked', code: 'identity_mismatch', message: 'The destination identity changed. Review and reschedule.' };
  }
  if (g.approval_required && !g.approved) {
    return { ok: false, state: 'blocked', code: 'approval_missing', message: 'Approval is required and was not granted for this exact version and time.' };
  }
  return { ok: true };
}

async function endAttempt(db: Queryable, d: ClaimedDelivery, a: { outcome: string; phase?: string; code?: string | null; message?: string | null; providerIds?: string[] }) {
  await db.query(
    `UPDATE delivery_attempts SET ended_at=now(), outcome=$3, phase=coalesce($4, phase), safe_code=$5, safe_message=$6, provider_ids=coalesce($7, provider_ids)
      WHERE delivery_id=$1 AND attempt_number=$2`,
    [d.id, Math.max(d.attempt_count, 1), a.outcome, a.phase ?? null, a.code ?? null, a.message?.slice(0, 500) ?? null, a.providerIds ?? null]);
}

async function stateChanged(db: Queryable, d: ClaimedDelivery, state: string) {
  await writeOutbox(db, { workspaceId: d.workspace_id, aggregateType: 'delivery', aggregateId: d.id, eventType: 'delivery.state_changed', payload: { state, postId: d.post_id, scheduleId: d.schedule_id } });
  await completeScheduleIfDone(db, d.schedule_id);
}

export async function completeScheduleIfDone(db: Queryable, scheduleId: string) {
  await db.query(
    `UPDATE schedules SET status='completed' WHERE id=$1 AND status='active'
        AND NOT EXISTS (SELECT 1 FROM deliveries WHERE schedule_id=$1 AND state NOT IN ('published','failed','cancelled','expired'))`, [scheduleId]);
}

const RELEASE = `lease_owner=NULL, lease_expires_at=NULL`;

/** Simulated destinations never influence the live provider circuit breaker. */
const circuit = (pool: Pool, d: ClaimedDelivery, ok: boolean) => (d.is_mock ? Promise.resolve() : recordCircuit(pool, d.provider, ok));

/** Finish with a terminal or waiting state; fenced. Returns false if the claim was lost. */
async function settle(pool: Pool, d: ClaimedDelivery, p: {
  state: string; phase?: string; code?: string | null; message?: string | null; nextAttemptAt?: Date; providerIds?: string[]; url?: string | null;
  publishedAt?: Date | null; checkpoint?: Checkpoint | null; blockedReason?: string | null; attemptOutcome: string; extraWhere?: string;
}): Promise<boolean> {
  return withTx(async (tx) => {
    const ok = await fencedUpdate(tx, d,
      `state=$4::delivery_state, phase=$5, ${RELEASE}, last_error_code=$6, last_error_message=$7, next_attempt_at=coalesce($8, next_attempt_at),
       provider_ids = CASE WHEN $9::text[] IS NULL THEN provider_ids ELSE (SELECT array_agg(DISTINCT x) FROM unnest(provider_ids || $9::text[]) x) END,
       provider_url=coalesce($10, provider_url), published_at=coalesce($11, published_at),
       preparation = CASE WHEN $12::jsonb IS NULL THEN preparation ELSE $12::jsonb END, blocked_reason=$13,
       unknown_since = CASE WHEN $4='unknown' THEN coalesce(unknown_since, now()) ELSE unknown_since END,
       needs_reconcile = ($4='unknown')`,
      [p.state, p.phase ?? 'idle', p.code ?? null, p.message ?? null, p.nextAttemptAt ?? null, p.providerIds ?? null, p.url ?? null,
        p.publishedAt ?? null, p.checkpoint ? JSON.stringify(p.checkpoint) : null, p.blockedReason ?? null], p.extraWhere ?? '');
    if (!ok) return false;
    await endAttempt(tx, d, { outcome: p.attemptOutcome, code: p.code, message: p.message, providerIds: p.providerIds });
    await stateChanged(tx, d, p.state);
    return true;
  }, pool);
}

/** A late result from a worker that lost its claim: keep provider IDs for reconciliation, never change state. */
async function recordLateResult(pool: Pool, d: ClaimedDelivery, providerIds: string[], note: string) {
  await pool.query(
    `UPDATE deliveries SET provider_ids=(SELECT array_agg(DISTINCT x) FROM unnest(provider_ids || $2::text[]) x),
            needs_reconcile = needs_reconcile OR state IN ('unknown','processing'), updated_at=now() WHERE id=$1`, [d.id, providerIds]);
  await endAttempt(pool, d, { outcome: 'stale', code: 'stale_claim', message: note, providerIds });
  log.warn('delivery_late_result', { deliveryId: d.id, providerIds: providerIds.length });
}

async function retryOrFail(pool: Pool, d: ClaimedDelivery, code: string, message: string, retryAfterMs?: number, checkpoint?: Checkpoint | null) {
  const now = new Date();
  const decision = decideRetry({ attemptNumber: d.attempt_count, maxAttempts: d.max_attempts, now, publishBefore: d.publish_before, providerRetryAfterMs: retryAfterMs });
  if (decision.retry) {
    return settle(pool, d, { state: 'retry_wait', code, message: `${message} Retrying automatically.`, nextAttemptAt: decision.at, checkpoint, attemptOutcome: 'retryable' });
  }
  if (decision.reason === 'deadline') {
    return settle(pool, d, { state: 'expired', code, message: `${message} The publish-before deadline would pass before another attempt, so it was not retried.`, attemptOutcome: 'retryable' });
  }
  return settle(pool, d, { state: 'failed', code, message: `${message} Gave up after ${d.attempt_count} attempts.`, attemptOutcome: 'retryable' });
}

async function blockFor(pool: Pool, d: ClaimedDelivery, blocking: BlockingReason, code: string, message: string, retryAfterMs?: number) {
  if (blocking === 'rate_limit') {
    const until = new Date(Date.now() + (retryAfterMs ?? 15 * 60_000));
    await pool.query(`UPDATE connections SET throttled_until=greatest(coalesce(throttled_until, now()), $2) WHERE id=$1`, [d.connection_id, until]);
    return retryOrFail(pool, d, code, message, retryAfterMs ?? 15 * 60_000);
  }
  return withTx(async (tx) => {
    if (blocking === 'reconnect' || blocking === 'permission') {
      const status = blocking === 'reconnect' ? 'reconnect_required' : 'missing_permission';
      await tx.query(`UPDATE connections SET status=$2, health_detail=jsonb_build_object('message', $3::text), health_checked_at=now(), updated_at=now() WHERE id=$1 AND disconnected_at IS NULL`,
        [d.connection_id, status, message]);
      await writeOutbox(tx, { workspaceId: d.workspace_id, aggregateType: 'connection', aggregateId: d.connection_id, eventType: 'connection.health_changed', payload: { status } });
    }
    const ok = await fencedUpdate(tx, d, `state='blocked', phase='idle', ${RELEASE}, blocked_reason=$4, last_error_code=$5, last_error_message=$4`, [message, code]);
    if (!ok) return false;
    if (blocking === 'reconnect' || blocking === 'permission') await blockDeliveriesForConnection(tx, d.connection_id, message);
    await endAttempt(tx, d, { outcome: 'blocked', code, message });
    await stateChanged(tx, d, 'blocked');
    return true;
  }, pool);
}

async function handlePermanent(pool: Pool, d: ClaimedDelivery, o: { code: string; message: string; blocking?: BlockingReason }, retryAfterMs?: number) {
  if (o.blocking) return blockFor(pool, d, o.blocking, o.code, o.message, retryAfterMs);
  return settle(pool, d, { state: 'failed', code: o.code, message: o.message, attemptOutcome: 'permanent' });
}

function withHeartbeat<T>(pool: Pool, d: ClaimedDelivery, fn: () => Promise<T>): Promise<T> {
  const t = setInterval(() => { heartbeat(pool, d).catch(() => undefined); }, 20_000);
  return fn().finally(() => clearInterval(t));
}

async function buildInput(pool: Pool, deps: EngineDeps, d: ClaimedDelivery, credentials: ProviderCredentials, connection: PublishConnection): Promise<PublishInput> {
  const v = await one<{ rendered_text: string; link: string | null; format: PublishInput['variant']['format']; buttons: PublishInput['variant']['buttons']; options: Record<string, unknown>; asset_ids: string[] }>(pool,
    `SELECT rendered_text, link, format, buttons, options, asset_ids FROM variants WHERE id=$1 AND workspace_id=$2`, [d.variant_id, d.workspace_id]);
  const { crops } = cropsFromOptions(v.options); // V1.1: publish the cropped derivative when a crop is set
  const media = Object.keys(crops).length ? await deps.loadMedia(d.workspace_id, v.asset_ids, { crops }) : await deps.loadMedia(d.workspace_id, v.asset_ids);
  return {
    deliveryId: d.id, attemptNumber: d.attempt_count, idempotencyKey: `${d.id}:${d.generation}`, connection, credentials,
    // V1.1: the format follows the media actually attached (image/album/video/reel), not the snapshot's count-only guess.
    variant: { text: v.rendered_text, link: v.link, format: media.length ? deriveFormat(d.provider, media.map(mediaKindOf)) : v.format, buttons: v.buttons ?? [], options: v.options ?? {} }, media,
  };
}

/** Process one claimed delivery end-to-end. Never throws for provider problems; returns the final state. */
export async function processDelivery(deps: EngineDeps, d: ClaimedDelivery, pool: Pool = getPool()): Promise<string> {
  try {
    if (d.prior_state === 'processing') return await pollProcessing(deps, d, pool);
    const g = await gate(pool, d);
    if (!g.ok) {
      await settle(pool, d, { state: g.state, code: g.code, message: g.message, blockedReason: g.state === 'blocked' ? g.message : null, attemptOutcome: 'gated' });
      return g.state;
    }
    let creds: Awaited<ReturnType<EngineDeps['getCredentials']>>;
    try {
      creds = await deps.getCredentials(d.connection_id);
    } catch (err) {
      const e = err as CredentialsUnavailable;
      await blockFor(pool, d, e.blocking ?? 'reconnect', 'credentials_unavailable', e.message || 'The account must be reconnected.');
      return 'blocked';
    }
    const adapter = deps.adapterFor(d.provider);
    const actx = await deps.adapterContext(d.provider, creds.connection);
    const input = await buildInput(pool, deps, d, creds.credentials, creds.connection);
    const validation = adapter.validate(input);
    if (!validation.ok) {
      await settle(pool, d, { state: 'failed', code: 'validation_failed', message: validation.issues.map((i) => i.message).join(' '), attemptOutcome: 'permanent' });
      return 'failed';
    }

    // ---- preparation (safe to repeat: creates no visible post)
    let prep: PrepareOutcome;
    try {
      prep = await withHeartbeat(pool, d, () => adapter.prepare(actx, input, d.preparation as Checkpoint | null));
    } catch (err) {
      log.warn('prepare_threw', { deliveryId: d.id, err: err as Error });
      prep = { kind: 'retryable', code: 'prepare_error', message: 'Preparing the media failed.' };
    }
    if (prep.kind === 'pending') {
      await settle(pool, d, { state: 'scheduled', code: null, message: null, nextAttemptAt: new Date(Date.now() + prep.checkAfterMs), checkpoint: prep.checkpoint, attemptOutcome: 'pending' });
      // A pending poll is not a failed attempt.
      await pool.query(`UPDATE deliveries SET attempt_count=greatest(attempt_count-1,0) WHERE id=$1`, [d.id]);
      return 'scheduled';
    }
    if (prep.kind === 'retryable') { await circuit(pool, d, false); await retryOrFail(pool, d, prep.code, prep.message, prep.retryAfterMs, prep.checkpoint); return 'retry_wait'; }
    if (prep.kind === 'permanent') { await handlePermanent(pool, d, prep); return 'failed'; }
    const checkpoint = prep.checkpoint;

    // ---- final gate + budget + transition to SENDING atomically (cancellation guaranteed only before this point)
    const sendGate = await withTx(async (tx) => {
      const locked = await maybeOne<{ state: string }>(tx, `SELECT state FROM deliveries WHERE id=$1 AND fence=$2::bigint AND lease_owner=$3 FOR UPDATE`, [d.id, d.fence, d.lease_owner]);
      if (!locked || locked.state !== 'preparing') return { ok: false as const, lost: true as const };
      const g2 = await gate(tx, d);
      if (!g2.ok) return { ok: false as const, lost: false as const, g: g2 };
      const meter = budgetMeterFor(d.provider, d.is_mock);
      if (meter) {
        const b = await checkAndConsumeBudget(tx, d.workspace_id, meter, 1);
        if (!b.ok) return { ok: false as const, lost: false as const, budget: b.message };
      }
      await fencedUpdate(tx, d, `state='publishing', phase='sending', preparation=$4::jsonb`, [JSON.stringify(checkpoint)]);
      await tx.query(`UPDATE delivery_attempts SET phase='sending' WHERE delivery_id=$1 AND attempt_number=$2`, [d.id, Math.max(d.attempt_count, 1)]);
      return { ok: true as const };
    }, pool);
    if (!sendGate.ok) {
      if (sendGate.lost) { await endAttempt(pool, d, { outcome: 'stale', code: 'claim_lost', message: 'Stopped before sending (cancelled or claim lost).' }); return 'stale'; }
      if ('budget' in sendGate && sendGate.budget) { await blockFor(pool, d, 'budget', 'budget_exhausted', sendGate.budget); return 'blocked'; }
      const g2 = (sendGate as { g: Exclude<GateResult, { ok: true }> }).g;
      await settle(pool, d, { state: g2.state, code: g2.code, message: g2.message, blockedReason: g2.state === 'blocked' ? g2.message : null, attemptOutcome: 'gated' });
      return g2.state;
    }
    d.state = 'publishing';

    // ---- publish (outside any transaction)
    let out: PublishOutcome;
    try {
      out = await withHeartbeat(pool, d, () => adapter.publish(actx, input, checkpoint));
    } catch (err) {
      log.error('publish_threw', { deliveryId: d.id, err: err as Error });
      out = { kind: 'unknown', code: 'adapter_error', message: 'An unexpected error occurred while sending; the post may or may not exist.' };
    }
    return await applyPublishOutcome(pool, d, out);
  } catch (err) {
    log.error('process_delivery_failed', { deliveryId: d.id, err: err as Error });
    // Leave the lease to expire: the sweeper decides (requeue if not sending; Unknown if sending).
    return 'error';
  }
}

async function applyPublishOutcome(pool: Pool, d: ClaimedDelivery, out: PublishOutcome): Promise<string> {
  let ok = true;
  switch (out.kind) {
    case 'confirmed':
      await circuit(pool, d, true);
      ok = await settle(pool, d, { state: 'published', code: null, message: null, providerIds: out.providerIds, url: out.url ?? null,
        publishedAt: out.publishedAt ? new Date(out.publishedAt) : new Date(), attemptOutcome: 'confirmed' });
      if (!ok) await recordLateResult(pool, d, out.providerIds, 'Provider confirmed publication after this worker lost its claim.');
      return ok ? 'published' : 'stale';
    case 'processing':
      ok = await settle(pool, d, { state: 'processing', phase: 'awaiting_provider', code: null, message: 'Accepted by the provider; waiting for processing to finish.',
        providerIds: out.providerIds, checkpoint: out.checkpoint ?? null, nextAttemptAt: new Date(Date.now() + out.checkAfterMs), attemptOutcome: 'processing' });
      if (!ok) await recordLateResult(pool, d, out.providerIds, 'Provider accepted the post after this worker lost its claim.');
      return 'processing';
    case 'rejected_safe_to_retry':
      await circuit(pool, d, false);
      if (out.retryAfterMs) await pool.query(`UPDATE connections SET throttled_until=greatest(coalesce(throttled_until, now()), now() + ($2 || ' milliseconds')::interval) WHERE id=$1`, [d.connection_id, String(out.retryAfterMs)]);
      await retryOrFail(pool, d, out.code, out.message, out.retryAfterMs);
      return 'retry_wait';
    case 'permanent_failure':
      await handlePermanent(pool, d, out);
      return out.blocking ? 'blocked' : 'failed';
    case 'unknown':
      await circuit(pool, d, false);
      ok = await settle(pool, d, { state: 'unknown', code: out.code, message: `${out.message} We will check with the provider before doing anything else.`,
        providerIds: out.providerIds, nextAttemptAt: new Date(Date.now() + 30_000), attemptOutcome: 'unknown' });
      if (!ok && out.providerIds?.length) await recordLateResult(pool, d, out.providerIds, 'Ambiguous result after claim was lost.');
      return 'unknown';
  }
}

/** Processing state: ask the provider (read-only) whether asynchronous publication finished. */
async function pollProcessing(deps: EngineDeps, d: ClaimedDelivery, pool: Pool): Promise<string> {
  let r: ReconcileOutcome;
  try {
    const creds = await deps.getCredentials(d.connection_id);
    const v = await one<{ rendered_text: string }>(pool, `SELECT rendered_text FROM variants WHERE id=$1`, [d.variant_id]);
    const actx = await deps.adapterContext(d.provider, creds.connection);
    r = await deps.adapterFor(d.provider).reconcile(actx, {
      deliveryId: d.id, connection: creds.connection, credentials: creds.credentials, variantText: v.rendered_text,
      providerIds: d.provider_ids, checkpoint: d.preparation as Checkpoint | null, sentAt: null,
    });
  } catch (err) {
    r = { kind: 'still_unknown', reason: (err as Error).message?.slice(0, 200) ?? 'status check failed' };
  }
  const extra = `AND state='processing'`;
  if (r.kind === 'published') {
    await settle(pool, d, { state: 'published', code: null, message: null, providerIds: r.providerIds, url: r.url ?? null, publishedAt: r.publishedAt ? new Date(r.publishedAt) : new Date(), attemptOutcome: 'confirmed', extraWhere: extra });
    return 'published';
  }
  if (r.kind === 'processing') {
    const tooLong = Date.now() - d.due_at.getTime() > 2 * 60 * 60_000;
    if (!tooLong) {
      await settle(pool, d, { state: 'processing', phase: 'awaiting_provider', code: null, message: 'Still processing at the provider.', nextAttemptAt: new Date(Date.now() + r.checkAfterMs), attemptOutcome: 'processing', extraWhere: extra });
      return 'processing';
    }
    await settle(pool, d, { state: 'unknown', code: 'processing_timeout', message: 'The provider has not finished processing after 2 hours.', nextAttemptAt: new Date(Date.now() + 300_000), attemptOutcome: 'unknown', extraWhere: extra });
    return 'unknown';
  }
  if (r.kind === 'not_published') {
    await settle(pool, d, { state: 'failed', code: 'provider_processing_failed', message: `The provider did not publish this post: ${r.reason}`, attemptOutcome: 'permanent', extraWhere: extra });
    return 'failed';
  }
  await settle(pool, d, { state: 'unknown', code: 'status_unavailable', message: `Could not confirm the result with the provider (${r.reason}).`, nextAttemptAt: new Date(Date.now() + 120_000), attemptOutcome: 'unknown', extraWhere: extra });
  return 'unknown';
}
