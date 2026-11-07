// Relay background worker. Runs continuously, independent of browsers and web requests.
//  - Outbox dispatcher -> pg-boss (deterministic job ids)
//  - delivery-due consumer (fast path) + due-work claim loop (recovery path; never relies on the queue alone)
//  - lease/deadline sweepers, Unknown reconciliation, connection health checks, retention
//  - heartbeat row + HTTP health endpoint, graceful drain on SIGTERM
import { createServer } from 'node:http';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { assertRuntimeDbRole, closePool, getPool, maybeOne } from '@social-lite/db';
import {
  claimDelivery, config, dispatchEnabled, log, processDelivery, reconcileOne, sweepDeadlines, sweepExpiredLeases,
} from '@social-lite/services';
import { liveEngineDeps } from '@social-lite/services/engine/live-deps';
import { handleEvent } from '@social-lite/services/engine/notify';
import { runNotificationSweeps } from '@social-lite/services/collab/notifications';
import { dispatchOutbox, QUEUE_COLLAB, QUEUE_DELIVERY_DUE, QUEUE_EVENTS, QUEUE_MEDIA_TRANSCODE, startBoss } from '@social-lite/services/engine/outbox-dispatcher';
import { runHealthChecks } from '@social-lite/services/connections/index';
import { ensureBucket } from '@social-lite/services/storage';
import { instrumentEngineDeps } from '@social-lite/services/workload/runner';
import { createWorkerWorkload } from '@social-lite/services/workload/worker';

process.env.SERVICE_NAME ??= 'worker';
const cfg = config();
const WORKER_ID = cfg.WORKER_ID ?? `${hostname()}-${process.pid}-${randomUUID().slice(0, 6)}`;
const CONCURRENCY = Number(process.env.WORKER_CONCURRENCY ?? 4);
const PORT = Number(process.env.WORKER_HEALTH_PORT ?? 3001);
const VERSION = process.env.APP_VERSION ?? 'dev';

const deps = instrumentEngineDeps(liveEngineDeps()); // V3.1: provider time measured apart from app time
// V3.1 workload isolation: bulk classes on their own pool + gates + backpressure; publishing keeps the main pool.
const workload = createWorkerWorkload({ workerId: WORKER_ID, publishingSlots: CONCURRENCY });
let stopping = false;
const inFlight = new Set<Promise<unknown>>();
const lastRun: Record<string, string> = {};

function track<T>(p: Promise<T>): Promise<T> {
  inFlight.add(p);
  p.finally(() => inFlight.delete(p)).catch(() => undefined);
  return p;
}

function every(name: string, ms: number, fn: () => Promise<unknown>): NodeJS.Timeout {
  let running = false;
  const tick = async () => {
    if (stopping || running) return;
    running = true;
    try { await fn(); lastRun[name] = new Date().toISOString(); } catch (err) { log.error('loop_failed', { loop: name, err: err as Error }); } finally { running = false; }
  };
  void tick();
  return setInterval(tick, ms);
}

/** Claim and process due deliveries until none remain or capacity is used. */
async function claimLoop(slot: number): Promise<void> {
  if (!(await dispatchEnabled(undefined, VERSION))) return;
  for (let i = 0; i < 25 && !stopping; i++) {
    const d = await claimDelivery(`${WORKER_ID}#${slot}`);
    if (!d) return;
    const state = await track(workload.publish(d, () => processDelivery(deps, d)));
    log.info('delivery_processed', { deliveryId: d.id, provider: d.provider, simulated: d.is_mock, state });
  }
}

async function main(): Promise<void> {
  const { initKmsKeyProvider } = await import('@social-lite/services/kms');
  const kids = await initKmsKeyProvider(); // fail closed if KMS is configured but unusable
  if (kids) log.info('kms_keys_loaded', { kids });
  const pool = getPool();
  const schema = await maybeOne<{ n: number }>(pool, `SELECT count(*)::int n FROM schema_migrations`).catch(() => null);
  if (!schema) throw new Error('Database is not migrated. Run the migration job first.');
  const dbRole = await assertRuntimeDbRole(pool, { production: cfg.APP_ENV === 'production', component: 'worker' }); // G14: fail closed in production
  if (dbRole.problems.length) log.warn('privileged_db_role', { role: dbRole.role, problems: dbRole.problems });
  if (cfg.APP_ENV !== 'production') await ensureBucket().catch((err) => log.warn('bucket_check_failed', { err }));

  await pool.query(
    `INSERT INTO worker_heartbeats(worker_id, version, info) VALUES ($1,$2,$3)
     ON CONFLICT (worker_id) DO UPDATE SET last_seen_at=now(), started_at=now(), version=$2, info=$3`,
    [WORKER_ID, VERSION, JSON.stringify({ concurrency: CONCURRENCY, mockProviders: cfg.ENABLE_MOCK_PROVIDERS && cfg.APP_ENV !== 'production' })]);

  const boss = await startBoss(cfg.DATABASE_URL);
  await boss.work<{ aggregateId: string }>(QUEUE_DELIVERY_DUE, { batchSize: 5, pollingIntervalSeconds: 1 }, async (jobs) => {
    if (stopping || !(await dispatchEnabled(undefined, VERSION))) return;
    for (const job of jobs) {
      const d = await claimDelivery(`${WORKER_ID}#q`, { deliveryId: job.data.aggregateId });
      if (d) await track(workload.publish(d, () => processDelivery(deps, d), QUEUE_DELIVERY_DUE));
    }
  });
  await boss.work<{ eventType: string; aggregateId: string; workspaceId: string | null; payload: Record<string, unknown> }>(QUEUE_EVENTS, { batchSize: 10, pollingIntervalSeconds: 2 }, async (jobs) => {
    for (const job of jobs) {
      // V1.1 media: uploaded videos are validated/transcoded here, never in the web request (throws ⇒ pg-boss retries).
      // (V3.1: new uploads go to 'media-transcode'; this branch drains events enqueued before the upgrade.)
      if (job.data.eventType === 'asset.uploaded') { await track(workload.run('video', { queue: QUEUE_EVENTS, workspaceId: job.data.workspaceId }, async () => (await import('@social-lite/services/media/video-worker')).handleAssetUploaded({ workspace_id: job.data.workspaceId, aggregate_id: job.data.aggregateId, payload: job.data.payload }))); continue; }
      await workload.job(QUEUE_EVENTS, job, () => handleEvent({ event_type: job.data.eventType, aggregate_id: job.data.aggregateId, workspace_id: job.data.workspaceId, payload: job.data.payload ?? {} }));
    }
  });
  // V3.1 'video' workload class: validation/transcoding on its own queue (one at a time per worker, defers under publishing pressure).
  await boss.work<{ aggregateId: string; workspaceId: string | null; payload: Record<string, unknown> }>(QUEUE_MEDIA_TRANSCODE, { batchSize: 1, pollingIntervalSeconds: 2, includeMetadata: true }, async (jobs) => {
    for (const job of jobs) await track(workload.job(QUEUE_MEDIA_TRANSCODE, job, async () => (await import('@social-lite/services/media/video-worker')).handleAssetUploaded({ workspace_id: job.data.workspaceId, aggregate_id: job.data.aggregateId, payload: job.data.payload })));
  });
  // Collaboration notifications: own queue + 'notifications' workload class (publishing never waits behind them).
  await boss.work<{ eventType: string; aggregateId: string; workspaceId: string | null; payload: Record<string, unknown> }>(QUEUE_COLLAB, { batchSize: 10, pollingIntervalSeconds: 1, includeMetadata: true }, async (jobs) => {
    for (const job of jobs) await track(workload.job(QUEUE_COLLAB, job, () => handleEvent({ event_type: job.data.eventType, aggregate_id: job.data.aggregateId, workspace_id: job.data.workspaceId, payload: job.data.payload ?? {} })));
  });
  // V3 Content Hub workload queues: ids only; handlers reload rows, re-check authority, one job per workspace per class.
  const contentHub = await import('@social-lite/services/content-hub/jobs');
  for (const q of [contentHub.QUEUE_SOURCE_IMPORT, contentHub.QUEUE_REPORT_EXPORT, contentHub.QUEUE_WRITEBACK]) {
    await boss.work<{ eventType: string; aggregateId: string; workspaceId: string | null }>(q, { batchSize: 1, pollingIntervalSeconds: 2, includeMetadata: true }, async (jobs) => {
      for (const job of jobs) await track(workload.job(q, job, () => contentHub.handleContentHubJob(job.data)));
    });
  }

  // V3 analytics: 'analytics-sync' (per-workspace group concurrency) + 'analytics-report-export'; ids only, authority re-checked per job.
  const analytics = await import('@social-lite/services/analytics/worker');
  // Analytics report exports to Google Docs/Drive/Notion go through the Content Hub exporter (same authority checks).
  const { registerReportExporter } = await import('@social-lite/services/analytics/exporters');
  registerReportExporter((await import('@social-lite/services/content-hub/exports')).contentHubExporter);
  await analytics.registerAnalyticsWorkers(boss, { workerId: WORKER_ID, track, stopping: () => stopping, run: (cls, meta, fn) => workload.run(cls, meta, fn) });
  // V3.1 bulk jobs ('bulk-ops'): ids only; the job reloads items and re-checks the creator's authority per item.
  const bulk = await import('@social-lite/services/data/bulk');
  await boss.work<{ aggregateId: string }>('bulk-ops', { batchSize: 1, pollingIntervalSeconds: 2 }, async (jobs) => {
    for (const job of jobs) await track(workload.run('interactive_import', { queue: 'bulk-ops' }, () => bulk.handleBulkJob(job.data)));
  });

  const timers = [
    every('heartbeat', 10_000, () => pool.query(`UPDATE worker_heartbeats SET last_seen_at=now(), info = info || $2::jsonb WHERE worker_id=$1`, [WORKER_ID, JSON.stringify({ inFlight: inFlight.size, lastRun, workload: workload.runner.snapshot() })])),
    every('outbox', 1_000, async () => { while ((await dispatchOutbox(boss)) > 0 && !stopping) { /* drain */ } }),
    ...Array.from({ length: CONCURRENCY }, (_, slot) => every(`claim#${slot}`, 1_000, () => claimLoop(slot))),
    every('sweep', 5_000, async () => {
      const leases = await sweepExpiredLeases();
      const expired = await sweepDeadlines();
      if (leases.unknown || leases.requeued || expired) log.warn('sweep', { ...leases, expired });
    }),
    every('reconcile', 15_000, async () => { if (await dispatchEnabled(undefined, VERSION)) { for (let i = 0; i < 10 && (await reconcileOne(deps, WORKER_ID)); i++) { /* continue */ } } }),
    every('health', 10 * 60_000, () => workload.run('connection_health', { queue: 'health' }, () => runHealthChecks(25))),
    // V2 budgets: release usage reservations whose request/worker died before settling.
    every('budget-sweep', 60_000, async () => {
      const { sweepExpiredReservations } = await import('@social-lite/services/product/budgets');
      await sweepExpiredReservations({ limit: 200 });
    }),
    // V3 MCP: report exports started by MCP clients (leased; authority re-checked when each job runs).
    every('mcp-jobs', 5_000, async () => {
      const { runMcpJobs } = await import('@social-lite/services/mcp/jobs');
      await workload.run('report_export', { queue: 'mcp-jobs' }, () => runMcpJobs({ limit: 5 }));
    }),
    // V3 analytics (replaces the V1.1 hourly refresh): cursors → due sync jobs, queued exports, legacy backfill, retention.
    every('analytics', 30_000, () => workload.run('historical_backfill', { queue: 'analytics-tick' }, () => analytics.analyticsTick(boss))),
    // V2 collaboration: quiet-hours-deferred emails + daily digests (recipient re-checked at send).
    every('notification-emails', 60_000, () => workload.run('notifications', { queue: 'notification-emails' }, () => runNotificationSweeps())),
    // Collaboration: bounded deadline reminders, overdue reviews, offboarding (tasks of people who lost access), presence purge.
    every('collab-sweeps', 60_000, async () => { const { runCollabSweeps } = await import('@social-lite/services/collab/sweeps'); await workload.run('notifications', { queue: 'collab-sweeps' }, () => runCollabSweeps()); }),
    // G7: revoke expired grants (already ignored at access time), audit, refresh summaries, revalidate authority.
    every('grant-expiry', 5 * 60_000, async () => { const { sweepExpiredGrants } = await import('@social-lite/services/grant-expiry'); await sweepExpiredGrants(); }),
    // V3 Content Hub: writeback sweep (app-owned facts only), Drive channel renewal, snapshot retention.
    every('content-hub', 2 * 60_000, () => workload.run('interactive_import', { queue: 'content-hub-sweeps' }, () => contentHub.runContentHubSweeps())),
    // V3.1: resume bulk jobs whose wake-up was lost or whose runner died; purge trash past retention (references re-checked).
    every('bulk-jobs', 30_000, () => workload.run('interactive_import', { queue: 'bulk-ops-sweep' }, () => bulk.sweepBulkJobs(5))),
    // V3.1: per-item workload timings (dispatch delay / processing / provider) → workload_samples (buffered).
    every('workload-samples', 5_000, () => workload.recorder.flush()),
    every('trash-purge', 60 * 60_000, async () => { const { purgeTrash } = await import('@social-lite/services/data/trash'); await purgeTrash({ limit: 200 }); }),
    every('retention', 60 * 60_000, async () => {
      await pool.query(`UPDATE webhook_receipts SET body=NULL WHERE body IS NOT NULL AND received_at < now() - interval '7 days'`);
      await pool.query(`DELETE FROM idempotency_keys WHERE expires_at < now()`);
      await pool.query(`DELETE FROM oauth_states WHERE expires_at < now() - interval '1 day'`);
      await pool.query(`DELETE FROM connection_flows WHERE expires_at < now() - interval '1 day'`);
      await pool.query(`DELETE FROM sessions WHERE expires_at < now() - interval '7 days'`);
      await pool.query(`DELETE FROM outbox WHERE dispatch_state='dispatched' AND dispatched_at < now() - interval '30 days'`);
      await pool.query(`DELETE FROM worker_heartbeats WHERE last_seen_at < now() - interval '7 days'`);
      const { runCollabRetention } = await import('@social-lite/services/collab/sweeps');
      await runCollabRetention();
    }),
  ];

  const server = createServer(async (req, res) => {
    if (req.url === '/health') { res.writeHead(stopping ? 503 : 200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ status: stopping ? 'draining' : 'ok', worker: WORKER_ID })); return; }
    if (req.url === '/ready') {
      try { await pool.query('SELECT 1'); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ status: 'ready', inFlight: inFlight.size, lastRun, workload: workload.runner.snapshot() })); }
      catch { res.writeHead(503); res.end('{"status":"db_unavailable"}'); }
      return;
    }
    res.writeHead(404); res.end();
  }).listen(PORT, '0.0.0.0');

  log.info('worker_started', { workerId: WORKER_ID, concurrency: CONCURRENCY, env: cfg.APP_ENV, healthPort: PORT });

  const shutdown = async (sig: string) => {
    if (stopping) return;
    stopping = true;
    log.info('worker_draining', { sig, inFlight: inFlight.size });
    timers.forEach(clearInterval);
    const deadline = Date.now() + 30_000;
    while (inFlight.size && Date.now() < deadline) await Promise.race([...inFlight, new Promise((r) => setTimeout(r, 500))]).catch(() => undefined);
    // Anything still in flight keeps its lease; the sweeper decides (requeue if not sending, Unknown if sending).
    await boss.stop({ graceful: true, timeout: 5_000 }).catch(() => undefined);
    server.close();
    await pool.query(`UPDATE worker_heartbeats SET info = info || '{"stopped":true}'::jsonb WHERE worker_id=$1`, [WORKER_ID]).catch(() => undefined);
    await workload.close();
    await closePool();
    log.info('worker_stopped', { remaining: inFlight.size });
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  log.error('worker_fatal', { err: err as Error });
  process.exit(1);
});
