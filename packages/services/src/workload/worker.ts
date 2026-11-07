// Worker wiring for workload isolation (V3.1 brief §6), kept out of apps/worker/src/main.ts so the shared file only
// gains a few calls. Creates the bulk pool (WORKER_BULK_POOL_MAX, default 6), the publishing-pressure source, the sample
// recorder and the runner. The main pool (DATABASE_POOL_MAX, default 10) stays with the claim loops / publishing.
import type { WorkloadClass } from '@social-lite/core/contracts/v31-perf';
import { createPool, type Pool } from '@social-lite/db';
import type { ClaimedDelivery } from '../engine/claim.js';
import { log } from '../log.js';
import { QUEUE_CLASS } from './policy.js';
import { publishingPressure, SampleRecorder, WorkloadRunner, type RunMeta } from './runner.js';

export interface WorkerWorkload {
  runner: WorkloadRunner;
  recorder: SampleRecorder;
  bulkPool: Pool;
  /** Run a background item of `cls` (gates, backpressure, bulk pool, metrics). */
  run<T>(cls: WorkloadClass, meta: RunMeta, fn: () => Promise<T>): Promise<T>;
  /** Run the item of a pg-boss job of `queue` (class from QUEUE_CLASS; eligible = job start_after when known). */
  job<T>(queue: string, job: { data?: { workspaceId?: string | null }; startAfter?: Date; createdOn?: Date }, fn: () => Promise<T>): Promise<T>;
  /** Process a claimed delivery as publishing (never gated; provider time measured). */
  publish<T>(d: Pick<ClaimedDelivery, 'workspace_id' | 'provider' | 'next_attempt_at'>, fn: () => Promise<T>, queue?: string): Promise<T>;
  close(): Promise<void>;
}

export function createWorkerWorkload(o: { workerId: string; publishingSlots: number }): WorkerWorkload {
  const n = Number(process.env.WORKER_BULK_POOL_MAX ?? 6);
  // Bulk items queue for a connection rather than fail fast: a full bulk pool must slow bulk work, not error it.
  const bulkPool = createPool(undefined, Number.isInteger(n) && n >= 1 ? n : 6, { connectionTimeoutMillis: 120_000, applicationName: 'worker-bulk' });
  const recorder = new SampleRecorder();
  // eslint-disable-next-line prefer-const
  let runner: WorkloadRunner;
  const pressure = publishingPressure({ slots: o.publishingSlots, busy: () => runner.publishingRunning, dueAgeSeconds: Number(process.env.PUBLISHING_PRESSURE_DUE_AGE_SECONDS ?? 10) || 10 });
  runner = new WorkloadRunner({ workerId: o.workerId, bulkPool, pressure, recorder, publishingSlots: o.publishingSlots });
  log.info('workload_classes', { policies: Object.values(runner.policies).map((p) => `${p.class}:${p.max_concurrent}/${p.per_workspace}${p.defers_under_publishing_pressure ? ':defers' : ''}`).join(' '), bulkPool: bulkPool.options.max });
  return {
    runner, recorder, bulkPool,
    run: (cls, meta, fn) => runner.run(cls, meta, fn),
    job: (queue, job, fn) => runner.run(QUEUE_CLASS[queue] ?? 'notifications', { queue, workspaceId: job.data?.workspaceId ?? null, eligibleAt: job.startAfter ?? job.createdOn ?? null }, fn),
    publish: (d, fn, queue = 'deliveries') => runner.publishing({ queue, workspaceId: d.workspace_id, provider: d.provider, eligibleAt: d.next_attempt_at }, fn),
    async close() {
      await recorder.flush().catch(() => undefined);
      await bulkPool.end().catch(() => undefined);
    },
  };
}
