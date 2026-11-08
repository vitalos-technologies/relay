// V3.5 durable event processing for integrations (brief §3 synchronization contract, §13 reliability):
//  - ingress: verify the RAW request (registry verifiers) → persist + dedupe (integration_events UNIQUE(connector,
//    dedupe_key)) → outbox → 200. Unverified requests are never stored; missing secrets answer 412 (never "accepted").
//  - inbound processing: registered handler per connector; retries with backoff; 'dead' after 8 attempts; Relay's own
//    echoes (origin marker) are recorded as relay_echo and ignored (loop prevention).
//  - outbound sync jobs: one row per idempotency key (repeat requests return the same job → one external record),
//    leased execution, retry/backoff honouring Retry-After, 'unknown' outcomes reconciled through the executor
//    (never blindly retried), activity + rate-limit history, paused/disconnected integrations never run.
import { AppError, notFound } from '@social-lite/core';
import {
  ORIGIN_MARKER_PREFIX, SYNC_RETRY, originMarker, syncBackoffMs, type ConnectorKey, type InboundRequest, type RelayObjectType, type SyncJobJson,
  type SyncJobRequest, type SyncJobState,
} from '@social-lite/core/contracts/v35-connectors';
import { getPool, many, maybeOne, one, withTx, type Queryable } from '@social-lite/db';
import type { Ctx } from '../context.js';
import { audit } from '../audit.js';
import { decryptSecret, settingAad } from '../crypto.js';
import { log } from '../log.js';
import { writeOutbox } from '../outbox.js';
import { assertUuid } from '../tenancy.js';
import { inboundHandler, isConnectorKey, syncExecutor, verifierFor } from './registry.js';
import { loadIntegration, recordActivity, upsertExternalLink } from './store.js';

const MAX_BODY = 512 * 1024;
const LEASE_MS = 2 * 60_000;
const MAX_EVENT_ATTEMPTS = 8;

export interface IngressResult { status: number; body: string; headers?: Record<string, string> }

/**
 * Generic webhook ingress for business connectors. `installationId` (query ?i=) selects a per-installation secret
 * (Asana hook secret, Mailchimp URL key) stored encrypted in integration_connections.settings.webhook_secret_enc.
 */
export async function ingestIntegrationWebhook(connector: string, req: Omit<InboundRequest, 'now'>, query: URLSearchParams): Promise<IngressResult> {
  if (!isConnectorKey(connector)) return { status: 404, body: '{"error":"unknown_connector"}' };
  if (req.rawBody.length > MAX_BODY) return { status: 413, body: '{"error":"payload_too_large"}' };
  const installationId = query.get('i');
  let inst: { id: string; workspace_id: string; settings: Record<string, unknown> } | null = null;
  if (installationId) {
    if (!/^[0-9a-f-]{36}$/i.test(installationId)) return { status: 404, body: '{"error":"unknown_installation"}' };
    inst = await maybeOne(getPool(), `SELECT id, workspace_id, settings FROM integration_connections WHERE id=$1 AND connector=$2 AND disconnected_at IS NULL`, [installationId, connector]);
    if (!inst) return { status: 404, body: '{"error":"unknown_installation"}' };
  }
  let installationSecret: string | null = null;
  const enc = inst?.settings?.webhook_secret_enc;
  if (enc && inst) {
    try { installationSecret = decryptSecret<string>(enc as never, settingAad(`integration:${inst.id}:webhook`)); } catch { installationSecret = null; }
  }
  const full: InboundRequest = { ...req, now: new Date() };
  const v = await verifierFor(connector)(full, { installationSecret, query });
  if (!v.ok) {
    log.warn('integration_webhook_rejected', { connector, reason: v.reason });
    if (v.reason === 'not_configured') return { status: 412, body: '{"error":"not_configured"}' };
    return { status: v.reason === 'malformed' ? 400 : 401, body: `{"error":"${v.reason}"}` };
  }
  if (v.kind === 'handshake') {
    // Asana: the hook secret arrives once in the handshake; store it (encrypted) on the installation before echoing it.
    if (connector === 'asana' && inst && full.headers['x-hook-secret']) {
      const { encryptSecret } = await import('../crypto.js');
      const blob = encryptSecret(full.headers['x-hook-secret'], settingAad(`integration:${inst.id}:webhook`));
      await getPool().query(`UPDATE integration_connections SET settings = settings || jsonb_build_object('webhook_secret_enc', $2::jsonb), updated_at=now() WHERE id=$1`, [inst.id, JSON.stringify(blob)]);
    } else if (connector === 'asana') {
      return { status: 404, body: '{"error":"unknown_installation"}' };
    }
    return { status: v.response.status, body: v.response.body, headers: v.response.headers };
  }
  const body = (() => { try { return JSON.parse(req.rawBody); } catch { return { raw_form: true }; } })();
  const echo = req.rawBody.includes(ORIGIN_MARKER_PREFIX) && /relay:[0-9a-f-]{36}/i.test(req.rawBody);
  const ins = await maybeOne<{ id: string }>(getPool(),
    `INSERT INTO integration_events(connector, dedupe_key, workspace_id, integration_id, external_account_id, event_type, origin, occurred_at, summary, body, state)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (connector, dedupe_key) DO NOTHING RETURNING id`,
    [connector, v.dedupeKey.slice(0, 500), inst?.workspace_id ?? null, inst?.id ?? null, v.externalAccountId, v.eventType, echo ? 'relay_echo' : 'external',
      v.occurredAt, JSON.stringify(v.summary), JSON.stringify(body), echo ? 'ignored' : 'pending']);
  if (ins && !echo) {
    await writeOutbox(getPool(), { workspaceId: inst?.workspace_id ?? null, aggregateType: 'integration_event', aggregateId: ins.id, eventType: 'integration.event_received', payload: { connector } });
  }
  // Duplicates are acknowledged so providers stop redelivering; they are never processed twice.
  return { status: 200, body: JSON.stringify({ ok: true, duplicate: !ins }) };
}

/** Worker: process one verified event through the connector's handler. */
export async function processIntegrationEvent(eventId: string): Promise<'processed' | 'ignored' | 'retry' | 'dead' | 'skipped'> {
  const db = getPool();
  const ev = await maybeOne<{ id: string; connector: ConnectorKey; workspace_id: string | null; integration_id: string | null; event_type: string; body: unknown; origin: 'external' | 'relay_echo'; attempts: number }>(db,
    `UPDATE integration_events SET state='processing', attempts=attempts+1 WHERE id=$1 AND state IN ('pending','failed') AND next_attempt_at <= now()
      RETURNING id, connector, workspace_id, integration_id, event_type, body, origin, attempts`, [eventId]);
  if (!ev) return 'skipped';
  const h = inboundHandler(ev.connector);
  if (!h) {
    await db.query(`UPDATE integration_events SET state='ignored', processed_at=now(), last_error='no handler registered' WHERE id=$1`, [ev.id]);
    return 'ignored';
  }
  try {
    const r = await h.handle({ id: ev.id, workspaceId: ev.workspace_id, integrationId: ev.integration_id, eventType: ev.event_type, body: ev.body, origin: ev.origin });
    await db.query(`UPDATE integration_events SET state=$2, processed_at=now(), last_error=NULL WHERE id=$1`, [ev.id, r.outcome]);
    if (ev.workspace_id) await recordActivity(db, { workspaceId: ev.workspace_id, integrationId: ev.integration_id, kind: 'webhook', outcome: 'ok', code: ev.event_type });
    return r.outcome;
  } catch (err) {
    const dead = ev.attempts >= MAX_EVENT_ATTEMPTS;
    await db.query(`UPDATE integration_events SET state=$2, last_error=$3, next_attempt_at=now() + make_interval(secs => $4) WHERE id=$1`,
      [ev.id, dead ? 'dead' : 'failed', (err as Error).message.slice(0, 300), Math.min(3600, 15 * 2 ** ev.attempts)]);
    if (ev.workspace_id) await recordActivity(db, { workspaceId: ev.workspace_id, integrationId: ev.integration_id, kind: 'webhook', outcome: 'error', code: 'handler_failed', message: (err as Error).name });
    return dead ? 'dead' : 'retry';
  }
}

// ------------------------------------------------------------------ outbound sync jobs
type JobRow = { id: string; workspace_id: string; integration_id: string; kind: string; relay_type: RelayObjectType; relay_id: string; idempotency_key: string; payload: Record<string, unknown>; state: SyncJobState; attempts: number; next_attempt_at: Date | null; external_id: string | null; external_url: string | null; last_error_code: string | null; last_error: string | null; created_at: Date; finished_at: Date | null };

export function toJobJson(r: JobRow): SyncJobJson {
  return {
    id: r.id, integration_id: r.integration_id, kind: r.kind, relay_type: r.relay_type, relay_id: r.relay_id, state: r.state, attempts: r.attempts,
    next_attempt_at: ['queued', 'waiting_retry', 'unknown'].includes(r.state) && r.next_attempt_at ? r.next_attempt_at.toISOString() : null,
    external_id: r.external_id, last_error: r.last_error_code || r.last_error ? { code: r.last_error_code, message: r.last_error } : null,
    created_at: r.created_at.toISOString(), finished_at: r.finished_at ? r.finished_at.toISOString() : null,
  };
}

/**
 * Enqueue (or return) the job for this logical request. Callers check their own domain permission first
 * (e.g. cases.manage for "case → HubSpot ticket"); this checks integrations.read + scope and that the integration is usable.
 */
export async function enqueueSyncJob(ctx: Ctx, req: SyncJobRequest, db?: Queryable): Promise<{ job: SyncJobJson; created: boolean }> {
  const run = async (tx: Queryable) => {
    const integ = await loadIntegration(ctx, req.integrationId, 'integrations.read', tx);
    if (integ.disconnected_at || integ.status === 'reconnect_required') throw new AppError('invalid_state', 'Reconnect this integration first.');
    const key = (req.idempotencyKey ?? `${req.kind}:${req.relayType}:${req.relayId}`).slice(0, 300);
    const existing = await maybeOne<JobRow>(tx, `SELECT * FROM integration_sync_jobs WHERE workspace_id=$1 AND idempotency_key=$2`, [ctx.access.workspaceId, key]);
    if (existing) return { job: toJobJson(existing), created: false };
    const row = await one<JobRow>(tx,
      `INSERT INTO integration_sync_jobs(workspace_id, integration_id, kind, relay_type, relay_id, idempotency_key, payload, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (workspace_id, idempotency_key) DO NOTHING RETURNING *`,
      [ctx.access.workspaceId, req.integrationId, req.kind, req.relayType, req.relayId, key, JSON.stringify(req.payload), ctx.actor.userId]);
    if (!row) {
      const again = await one<JobRow>(tx, `SELECT * FROM integration_sync_jobs WHERE workspace_id=$1 AND idempotency_key=$2`, [ctx.access.workspaceId, key]);
      return { job: toJobJson(again), created: false };
    }
    await writeOutbox(tx, { workspaceId: ctx.access.workspaceId, aggregateType: 'integration_sync_job', aggregateId: row.id, eventType: 'integration.sync_requested', payload: { kind: req.kind } });
    await audit(tx, { workspaceId: ctx.access.workspaceId, brandId: integ.brand_id, actorUserId: ctx.actor.userId, action: 'integration.sync_requested', resourceType: req.relayType, resourceId: req.relayId, diff: { kind: req.kind, job_id: row.id }, correlationId: ctx.correlationId });
    return { job: toJobJson(row), created: true };
  };
  return db ? run(db) : withTx(run);
}

export async function getSyncJob(ctx: Ctx, id: string): Promise<SyncJobJson> {
  assertUuid(id, 'Job');
  const r = await maybeOne<JobRow>(getPool(), `SELECT * FROM integration_sync_jobs WHERE id=$1 AND workspace_id=$2`, [id, ctx.access.workspaceId]);
  if (!r) throw notFound('Job');
  await loadIntegration(ctx, r.integration_id, 'integrations.read');
  return toJobJson(r);
}

/** Worker: run one job under a lease. Returns the resulting state (or 'skipped' when not claimable). */
export async function runSyncJob(jobId: string, workerId: string): Promise<SyncJobState | 'skipped'> {
  const db = getPool();
  const job = await maybeOne<JobRow & { integ_paused: boolean; integ_status: string; integ_disconnected: Date | null; brand_id: string | null }>(db,
    `UPDATE integration_sync_jobs j SET state='running', attempts=j.attempts+1, lease_owner=$2, lease_expires_at=now() + make_interval(secs => $3), updated_at=now()
       FROM integration_connections i
      WHERE j.id=$1 AND i.id=j.integration_id AND j.state IN ('queued','waiting_retry') AND j.next_attempt_at <= now()
        AND NOT i.paused AND i.disconnected_at IS NULL AND i.status NOT IN ('reconnect_required','disconnected')
      RETURNING j.*, i.paused AS integ_paused, i.status AS integ_status, i.disconnected_at AS integ_disconnected, i.brand_id`, [jobId, workerId, LEASE_MS / 1000]);
  if (!job) return 'skipped';
  const exec = syncExecutor(job.kind);
  if (!exec) {
    await finish(db, job, 'failed', { code: 'no_executor', message: 'This sync action is not available.' });
    return 'failed';
  }
  let outcome;
  try {
    outcome = await exec.run({ id: job.id, workspaceId: job.workspace_id, integrationId: job.integration_id, relayType: job.relay_type, relayId: job.relay_id, payload: job.payload, attempt: job.attempts, originMarker: originMarker(job.id) });
  } catch (err) {
    outcome = { kind: 'unknown' as const, code: 'executor_error', message: `The action stopped unexpectedly (${(err as Error).name}). Checking before retrying.` };
  }
  if (outcome.kind === 'succeeded') {
    await withTx(async (tx) => {
      if (outcome.externalId) await upsertExternalLink(tx, { workspaceId: job.workspace_id, brandId: job.brand_id, integrationId: job.integration_id, relayType: job.relay_type, relayId: job.relay_id, externalType: job.kind.split('.')[1] ?? 'record', externalId: outcome.externalId, externalUrl: outcome.externalUrl ?? null });
      await finish(tx, job, 'succeeded', null, outcome.externalId ?? null, outcome.externalUrl ?? null, outcome.result);
      await tx.query(`UPDATE integration_connections SET last_success_at=now(), updated_at=now() WHERE id=$1`, [job.integration_id]);
    });
    return 'succeeded';
  }
  if (outcome.kind === 'retry' && job.attempts < SYNC_RETRY.maxAttempts) {
    const wait = syncBackoffMs(job.attempts, outcome.retryAfterMs);
    await db.query(`UPDATE integration_sync_jobs SET state='waiting_retry', next_attempt_at=now() + make_interval(secs => $2), lease_owner=NULL, lease_expires_at=NULL,
                     last_error_code=$3, last_error=$4, updated_at=now() WHERE id=$1`, [job.id, Math.ceil(wait / 1000), outcome.code, outcome.message.slice(0, 300)]);
    if (outcome.rateLimit) await db.query(`UPDATE integration_connections SET rate_limit=$2 WHERE id=$1`, [job.integration_id, JSON.stringify({ ...outcome.rateLimit, observed_at: new Date().toISOString() })]);
    await recordActivity(db, { workspaceId: job.workspace_id, integrationId: job.integration_id, kind: outcome.rateLimit ? 'rate_limit' : 'sync', outcome: outcome.rateLimit ? 'throttled' : 'retry', code: outcome.code, message: outcome.message, jobId: job.id });
    return 'waiting_retry';
  }
  if (outcome.kind === 'unknown') {
    await db.query(`UPDATE integration_sync_jobs SET state='unknown', next_attempt_at=now() + interval '1 minute', lease_owner=NULL, lease_expires_at=NULL, last_error_code=$2, last_error=$3, updated_at=now() WHERE id=$1`,
      [job.id, outcome.code, outcome.message.slice(0, 300)]);
    await recordActivity(db, { workspaceId: job.workspace_id, integrationId: job.integration_id, kind: 'sync', outcome: 'error', code: outcome.code, message: outcome.message, jobId: job.id });
    return 'unknown';
  }
  await finish(db, job, 'failed', { code: outcome.code, message: outcome.message });
  return 'failed';
}

async function finish(db: Queryable, job: JobRow, state: SyncJobState, err: { code: string; message: string } | null, externalId: string | null = null, externalUrl: string | null = null, result?: Record<string, unknown>): Promise<void> {
  await db.query(
    `UPDATE integration_sync_jobs SET state=$2, lease_owner=NULL, lease_expires_at=NULL, finished_at=now(), updated_at=now(), last_error_code=$3, last_error=$4,
            external_id=coalesce($5, external_id), external_url=coalesce($6, external_url), result=coalesce($7, result) WHERE id=$1`,
    [job.id, state, err?.code ?? null, err?.message.slice(0, 300) ?? null, externalId, externalUrl, result ? JSON.stringify(result) : null]);
  await recordActivity(db, { workspaceId: job.workspace_id, integrationId: job.integration_id, kind: 'sync', outcome: state === 'succeeded' ? 'ok' : 'error', code: err?.code ?? job.kind, message: err?.message ?? null, jobId: job.id });
  if (state === 'failed') await db.query(`UPDATE integration_connections SET last_error_at=now(), last_error_code=$2 WHERE id=$1`, [job.integration_id, err?.code ?? null]);
}

/** Worker: reconcile 'unknown' jobs through the executor (found ⇒ succeeded + link; else stays unknown for a person). */
export async function reconcileSyncJobs(limit = 20): Promise<number> {
  const db = getPool();
  const rows = await many<JobRow & { brand_id: string | null }>(db,
    `SELECT j.*, i.brand_id FROM integration_sync_jobs j JOIN integration_connections i ON i.id=j.integration_id
      WHERE j.state='unknown' AND j.next_attempt_at <= now() AND i.disconnected_at IS NULL ORDER BY j.next_attempt_at LIMIT $1`, [limit]);
  let n = 0;
  for (const job of rows) {
    const exec = syncExecutor(job.kind);
    const r = exec?.reconcile ? await exec.reconcile({ id: job.id, integrationId: job.integration_id, originMarker: originMarker(job.id), payload: job.payload }).catch(() => ({ found: false as const })) : { found: false as const };
    if (r.found) {
      await withTx(async (tx) => {
        await upsertExternalLink(tx, { workspaceId: job.workspace_id, brandId: job.brand_id, integrationId: job.integration_id, relayType: job.relay_type, relayId: job.relay_id, externalType: job.kind.split('.')[1] ?? 'record', externalId: r.externalId, externalUrl: r.externalUrl ?? null });
        await finish(tx, job, 'succeeded', null, r.externalId, r.externalUrl ?? null, { reconciled: true });
      });
      n++;
    } else {
      // Not found yet: check again later with a growing interval; a person can retry explicitly (new attempt, audited).
      await db.query(`UPDATE integration_sync_jobs SET next_attempt_at=now() + make_interval(mins => least(60, 2 * attempts)), updated_at=now() WHERE id=$1`, [job.id]);
    }
  }
  return n;
}

/** Worker sweep: expired leases become 'unknown' (the call may have reached the provider); due retries are re-signalled. */
export async function sweepSyncJobs(): Promise<{ expired: number; due: string[] }> {
  const db = getPool();
  const expired = await db.query(`UPDATE integration_sync_jobs SET state='unknown', lease_owner=NULL, lease_expires_at=NULL, next_attempt_at=now(), last_error_code='lease_expired',
                                   last_error='The worker stopped during the call. Checking before retrying.', updated_at=now() WHERE state='running' AND lease_expires_at < now()`);
  const due = await many<{ id: string }>(db, `SELECT id FROM integration_sync_jobs WHERE state IN ('queued','waiting_retry') AND next_attempt_at <= now() ORDER BY next_attempt_at LIMIT 50`);
  return { expired: expired.rowCount ?? 0, due: due.map((d) => d.id) };
}

/** Explicit retry of a failed/unknown job by a person (new attempt; audited). Never automatic for 'unknown'. */
export async function retrySyncJob(ctx: Ctx, id: string): Promise<SyncJobJson> {
  return withTx(async (tx) => {
    const r = await maybeOne<JobRow>(tx, `SELECT * FROM integration_sync_jobs WHERE id=$1 AND workspace_id=$2 FOR UPDATE`, [id, ctx.access.workspaceId]);
    if (!r) throw notFound('Job');
    const integ = await loadIntegration(ctx, r.integration_id, 'integrations.manage', tx);
    if (!['failed', 'unknown'].includes(r.state)) throw new AppError('invalid_state', 'Only failed or unconfirmed jobs can be retried.');
    const row = await one<JobRow>(tx, `UPDATE integration_sync_jobs SET state='queued', next_attempt_at=now(), finished_at=NULL, updated_at=now() WHERE id=$1 RETURNING *`, [id]);
    await writeOutbox(tx, { workspaceId: ctx.access.workspaceId, aggregateType: 'integration_sync_job', aggregateId: id, eventType: 'integration.sync_requested', payload: { kind: r.kind, retry: true } });
    await audit(tx, { workspaceId: ctx.access.workspaceId, brandId: integ.brand_id, actorUserId: ctx.actor.userId, action: 'integration.sync_retried', resourceType: r.relay_type, resourceId: r.relay_id, diff: { job_id: id, from: r.state }, correlationId: ctx.correlationId });
    return toJobJson(row);
  });
}
