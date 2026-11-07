// Social Lite background worker. Runs continuously, independent of browsers and web requests.
//  - Outbox dispatcher -> pg-boss (deterministic job ids)
//  - delivery-due consumer (fast path) + due-work claim loop (recovery path; never relies on the queue alone)
//  - lease/deadline sweepers, Unknown reconciliation, connection health checks, retention
//  - heartbeat row + HTTP health endpoint, graceful drain on SIGTERM
import { createServer } from 'node:http';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { closePool, getPool, maybeOne } from '@social-lite/db';
import {
  claimDelivery, config, dispatchEnabled, log, processDelivery, reconcileOne, sweepDeadlines, sweepExpiredLeases,
} from '@social-lite/services';
import { liveEngineDeps } from '@social-lite/services/engine/live-deps';
import { handleEvent } from '@social-lite/services/engine/notify';
import { runNotificationSweeps } from '@social-lite/services/collab/notifications';
import { dispatchOutbox, QUEUE_DELIVERY_DUE, QUEUE_EVENTS, startBoss } from '@social-lite/services/engine/outbox-dispatcher';
import { runHealthChecks } from '@social-lite/services/connections/index';
import { ensureBucket } from '@social-lite/services/storage';

process.env.SERVICE_NAME ??= 'worker';
const cfg = config();
const WORKER_ID = cfg.WORKER_ID ?? `${hostname()}-${process.pid}-${randomUUID().slice(0, 6)}`;
const CONCURRENCY = Number(process.env.WORKER_CONCURRENCY ?? 4);
const PORT = Number(process.env.WORKER_HEALTH_PORT ?? 3001);
const VERSION = process.env.APP_VERSION ?? 'dev';

const deps = liveEngineDeps();
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
  if (!(await dispatchEnabled())) return;
  for (let i = 0; i < 25 && !stopping; i++) {
    const d = await claimDelivery(`${WORKER_ID}#${slot}`);
    if (!d) return;
    const state = await track(processDelivery(deps, d));
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
  if (cfg.APP_ENV !== 'production') await ensureBucket().catch((err) => log.warn('bucket_check_failed', { err }));

  await pool.query(
    `INSERT INTO worker_heartbeats(worker_id, version, info) VALUES ($1,$2,$3)
     ON CONFLICT (worker_id) DO UPDATE SET last_seen_at=now(), started_at=now(), version=$2, info=$3`,
    [WORKER_ID, VERSION, JSON.stringify({ concurrency: CONCURRENCY, mockProviders: cfg.ENABLE_MOCK_PROVIDERS && cfg.APP_ENV !== 'production' })]);

  const boss = await startBoss(cfg.DATABASE_URL);
  await boss.work<{ aggregateId: string }>(QUEUE_DELIVERY_DUE, { batchSize: 5, pollingIntervalSeconds: 1 }, async (jobs) => {
    if (stopping || !(await dispatchEnabled())) return;
    for (const job of jobs) {
      const d = await claimDelivery(`${WORKER_ID}#q`, { deliveryId: job.data.aggregateId });
      if (d) await track(processDelivery(deps, d));
    }
  });
  await boss.work<{ eventType: string; aggregateId: string; workspaceId: string | null; payload: Record<string, unknown> }>(QUEUE_EVENTS, { batchSize: 10, pollingIntervalSeconds: 2 }, async (jobs) => {
    for (const job of jobs) {
      // V1.1 media: uploaded videos are validated/transcoded here, never in the web request (throws ⇒ pg-boss retries).
      if (job.data.eventType === 'asset.uploaded') { await track((await import('@social-lite/services/media/video-worker')).handleAssetUploaded({ workspace_id: job.data.workspaceId, aggregate_id: job.data.aggregateId, payload: job.data.payload })); continue; }
      await handleEvent({ event_type: job.data.eventType, aggregate_id: job.data.aggregateId, workspace_id: job.data.workspaceId, payload: job.data.payload ?? {} });
    }
  });

  const timers = [
    every('heartbeat', 10_000, () => pool.query(`UPDATE worker_heartbeats SET last_seen_at=now(), info = info || $2::jsonb WHERE worker_id=$1`, [WORKER_ID, JSON.stringify({ inFlight: inFlight.size, lastRun })])),
    every('outbox', 1_000, async () => { while ((await dispatchOutbox(boss)) > 0 && !stopping) { /* drain */ } }),
    ...Array.from({ length: CONCURRENCY }, (_, slot) => every(`claim#${slot}`, 1_000, () => claimLoop(slot))),
    every('sweep', 5_000, async () => {
      const leases = await sweepExpiredLeases();
      const expired = await sweepDeadlines();
      if (leases.unknown || leases.requeued || expired) log.warn('sweep', { ...leases, expired });
    }),
    every('reconcile', 15_000, async () => { if (await dispatchEnabled()) { for (let i = 0; i < 10 && (await reconcileOne(deps, WORKER_ID)); i++) { /* continue */ } } }),
    every('health', 10 * 60_000, () => runHealthChecks(25)),
    // V2 budgets: release usage reservations whose request/worker died before settling.
    every('budget-sweep', 60_000, async () => {
      const { sweepExpiredReservations } = await import('@social-lite/services/product/budgets');
      await sweepExpiredReservations({ limit: 200 });
    }),
    // V1.1 analytics: daily provider metrics refresh (claims per delivery; X reads are budget-metered).
    every('metrics', 60 * 60_000, async () => {
      const { liveAnalyticsDeps, runDailyMetricsRefresh } = await import('@social-lite/services/analytics/index');
      await runDailyMetricsRefresh(await liveAnalyticsDeps(), { limit: 200 });
    }),
    // V2 collaboration: quiet-hours-deferred emails + daily digests (recipient re-checked at send).
    every('notification-emails', 60_000, () => runNotificationSweeps()),
    every('retention', 60 * 60_000, async () => {
      await pool.query(`UPDATE webhook_receipts SET body=NULL WHERE body IS NOT NULL AND received_at < now() - interval '7 days'`);
      await pool.query(`DELETE FROM idempotency_keys WHERE expires_at < now()`);
      await pool.query(`DELETE FROM oauth_states WHERE expires_at < now() - interval '1 day'`);
      await pool.query(`DELETE FROM connection_flows WHERE expires_at < now() - interval '1 day'`);
      await pool.query(`DELETE FROM sessions WHERE expires_at < now() - interval '7 days'`);
      await pool.query(`DELETE FROM outbox WHERE dispatch_state='dispatched' AND dispatched_at < now() - interval '30 days'`);
      await pool.query(`DELETE FROM worker_heartbeats WHERE last_seen_at < now() - interval '7 days'`);
    }),
  ];

  const server = createServer(async (req, res) => {
    if (req.url === '/health') { res.writeHead(stopping ? 503 : 200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ status: stopping ? 'draining' : 'ok', worker: WORKER_ID })); return; }
    if (req.url === '/ready') {
      try { await pool.query('SELECT 1'); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ status: 'ready', inFlight: inFlight.size, lastRun })); }
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
