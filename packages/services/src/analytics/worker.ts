// Worker wiring for analytics (registered from apps/worker/src/main.ts):
//  - queue 'analytics-sync' (workload class: provider metric reads) — groupConcurrency per workspace + DB leases;
//  - queue 'analytics-report-export' (rendering; CH owns 'report-export') — one export at a time per workspace;
//  - analyticsTick(): cursor evaluation, due sync jobs, queued exports, legacy backfill, retention.
// Publishing keeps priority: 'delivery-due' has its own queue and claim loops; sync runs yield while deliveries are due.
import type { PgBoss } from 'pg-boss';
import { v5 as uuidv5 } from 'uuid';
import { getPool } from '@social-lite/db';
import { log } from '../log.js';
import { ensureMetricRegistry } from './registry.js';
import { liveAnalyticsDeps } from './index.js';
import { QUEUE_ANALYTICS_SYNC, dueSyncJobs, ensureSyncCursors, runConnectionSync, workspaceSyncConcurrency } from './sync.js';
import { QUEUE_REPORT_EXPORT, queuedExports, runReportExport, sweepExpiredExports } from './reports.js';
import { backfillLegacySnapshots } from './backfill.js';
import { purgeAnalyticsRetention } from './retention.js';

const NS = '0c6f4f8e-3b3d-4a35-9c1e-5a2b7f0d9e21';

let enabled = false;

/** Migration 015 present? (The worker must still start against a database that has not been migrated yet.) */
async function schemaReady(): Promise<boolean> {
  const r = await getPool().query<{ ok: boolean }>(`SELECT to_regclass('public.metric_definitions') IS NOT NULL AND to_regclass('public.report_exports') IS NOT NULL AS ok`);
  return !!r.rows[0]?.ok;
}

type RunInClass = <T>(cls: 'analytics_refresh' | 'report_export', meta: { queue?: string | null; workspaceId?: string | null; eligibleAt?: Date | null }, fn: () => Promise<T>) => Promise<T>;

export async function registerAnalyticsWorkers(boss: PgBoss, o: { workerId: string; track: <T>(p: Promise<T>) => Promise<T>; stopping: () => boolean; run?: RunInClass }): Promise<void> {
  // V3.1 PERF: `run` puts each job in its workload class (gates, backpressure, bulk pool, metrics); default: run directly.
  const run: RunInClass = o.run ?? ((_cls, _meta, fn) => fn());
  if (!(await schemaReady())) { log.warn('analytics_disabled', { reason: 'migration 015_v3_analytics not applied' }); return; }
  enabled = true;
  await ensureMetricRegistry();
  for (const q of [QUEUE_ANALYTICS_SYNC, QUEUE_REPORT_EXPORT]) {
    await boss.createQueue(q, { retryLimit: 3, retryDelay: 30, retryBackoff: true }).catch((err: Error) => { if (!/already exists/i.test(err.message)) throw err; });
  }
  await boss.work<{ connectionId: string; jobKey: string }>(QUEUE_ANALYTICS_SYNC,
    { batchSize: 1, pollingIntervalSeconds: 5, localConcurrency: 2, groupConcurrency: workspaceSyncConcurrency() }, async (jobs) => {
      if (o.stopping()) return;
      const deps = await liveAnalyticsDeps();
      for (const job of jobs) {
        const s = await o.track(run('analytics_refresh', { queue: QUEUE_ANALYTICS_SYNC }, () => runConnectionSync(job.data.connectionId, deps, { workerId: `${o.workerId}#sync`, jobKey: job.data.jobKey })));
        if (s.status !== 'skipped') log.info('analytics_sync_run', { connectionId: job.data.connectionId, ...s });
      }
    });
  await boss.work<{ exportId: string }>(QUEUE_REPORT_EXPORT, { batchSize: 1, pollingIntervalSeconds: 5, groupConcurrency: 1 }, async (jobs) => {
    for (const job of jobs) await o.track(run('report_export', { queue: QUEUE_REPORT_EXPORT }, () => runReportExport(job.data.exportId, { workerId: `${o.workerId}#export` })));
  });
}

let ticks = 0;

/** Periodic analytics housekeeping + enqueueing (call every ~30–60 s). */
export async function analyticsTick(boss: Pick<PgBoss, 'send'>): Promise<{ syncJobs: number; exports: number }> {
  if (!enabled) return { syncJobs: 0, exports: 0 };
  ticks++;
  if (ticks % 5 === 1) await ensureSyncCursors({ limit: 500 });
  const jobs = await dueSyncJobs(100);
  for (const j of jobs) {
    await boss.send(QUEUE_ANALYTICS_SYNC, { connectionId: j.connectionId, jobKey: j.jobKey }, { id: uuidv5(j.jobKey, NS), group: { id: j.workspaceId } });
  }
  const ex = await queuedExports(20);
  for (const e of ex) await boss.send(QUEUE_REPORT_EXPORT, { exportId: e.id }, { id: e.id, group: { id: e.workspace_id } });
  if (ticks % 10 === 1) {
    const b = await backfillLegacySnapshots({ batch: 500 }).catch((err) => { log.warn('analytics_backfill_failed', { err: err as Error }); return null; });
    if (b && (b.snapshots || b.coverageRows)) log.info('analytics_backfill', { ...b });
  }
  if (ticks % 60 === 1) {
    await sweepExpiredExports().catch((err) => log.warn('export_sweep_failed', { err: err as Error }));
    await purgeAnalyticsRetention().catch((err) => log.warn('analytics_retention_failed', { err: err as Error }));
  }
  return { syncJobs: jobs.length, exports: ex.length };
}
