// V3.5 worker wiring (kept out of apps/worker/src/main.ts so the shared file only gains one call).
// Queues (contracts/v35-events.ts): 'inbox-reply' (customer_reply: main pool, never deferred), 'inbox-events'
// (inbox_ingest: hooks), 'integration-sync' (integration_sync: bulk pool, defers under publishing pressure).
// Recovery loops never rely on the queue alone: due replies/jobs are re-found by sweeps, expired leases become Unknown.
import type { PgBoss } from 'pg-boss';
import type { WorkloadClass } from '@social-lite/core/contracts/v31-perf';
import { V35_QUEUES } from '@social-lite/core/contracts/v35-events';
import { getPool } from '@social-lite/db';
import { log } from '../log.js';
import { processIntegrationEvent, reconcileSyncJobs, runSyncJob, sweepSyncJobs } from '../connectors/jobs.js';
import { refreshChannelHealth } from './channels.js';
import { sweepSla } from './cases.js';
import { sweepSnoozes } from './conversations.js';
import { handleInboxEvent } from './hooks.js';
import { dispatchReply, reconcileUnknownReplies, sweepReplies } from './replies.js';

interface Job { data: { eventType: string; aggregateId: string; workspaceId: string | null; payload?: Record<string, unknown> }; startAfter?: Date; createdOn?: Date }

export interface V35WorkerDeps {
  workerId: string;
  track: <T>(p: Promise<T>) => Promise<T>;
  stopping: () => boolean;
  /** workload.job(queue, job, fn) */
  job: <T>(queue: string, job: Job, fn: () => Promise<T>) => Promise<T>;
  /** workload.run(cls, meta, fn) */
  run: <T>(cls: WorkloadClass, meta: { queue?: string | null; workspaceId?: string | null }, fn: () => Promise<T>) => Promise<T>;
}

export async function registerV35Workers(boss: PgBoss, d: V35WorkerDeps): Promise<NodeJS.Timeout[]> {
  await boss.work<Job['data']>(V35_QUEUES.inboxReply, { batchSize: 5, pollingIntervalSeconds: 1, includeMetadata: true }, async (jobs) => {
    for (const job of jobs) await d.track(d.job(V35_QUEUES.inboxReply, job, () => dispatchReply(job.data.aggregateId, `${d.workerId}#reply`)));
  });
  await boss.work<Job['data']>(V35_QUEUES.inboxEvents, { batchSize: 10, pollingIntervalSeconds: 2, includeMetadata: true }, async (jobs) => {
    for (const job of jobs) await d.track(d.job(V35_QUEUES.inboxEvents, job, () => handleInboxEvent({ event_type: job.data.eventType, workspace_id: job.data.workspaceId, aggregate_id: job.data.aggregateId, payload: job.data.payload ?? {} })));
  });
  await boss.work<Job['data']>(V35_QUEUES.integrationSync, { batchSize: 2, pollingIntervalSeconds: 2, includeMetadata: true }, async (jobs) => {
    for (const job of jobs) {
      await d.track(d.job(V35_QUEUES.integrationSync, job, () => (job.data.eventType === 'integration.event_received'
        ? processIntegrationEvent(job.data.aggregateId) : runSyncJob(job.data.aggregateId, `${d.workerId}#sync`))));
    }
  });

  const every = (name: string, ms: number, fn: () => Promise<unknown>) => {
    let running = false;
    const tick = async () => {
      if (d.stopping() || running) return;
      running = true;
      try { await fn(); } catch (err) { log.error('loop_failed', { loop: name, err: err as Error }); } finally { running = false; }
    };
    void tick();
    return setInterval(tick, ms);
  };

  return [
    // Replies: recover lost wake-ups, expire dead leases to Unknown, reconcile Unknown sends (never resend).
    every('inbox-replies', 5_000, () => d.run('customer_reply', { queue: 'inbox-reply-sweep' }, async () => {
      const s = await sweepReplies();
      if (s.expired) log.warn('inbox_reply_leases_expired', { n: s.expired });
      for (const id of s.due) await dispatchReply(id, `${d.workerId}#reply-sweep`);
      await reconcileUnknownReplies(10);
    })),
    // Cases / snoozes / channel health.
    every('inbox-sweeps', 60_000, () => d.run('inbox_ingest', { queue: 'inbox-sweeps' }, async () => {
      await sweepSla();
      await sweepSnoozes();
      await refreshChannelHealth();
    })),
    // Integrations: expired leases → Unknown, due retries, reconciliation, failed inbound events due again.
    every('integration-jobs', 30_000, () => d.run('integration_sync', { queue: 'integration-sync-sweep' }, async () => {
      const s = await sweepSyncJobs();
      for (const id of s.due) await runSyncJob(id, `${d.workerId}#sync-sweep`);
      await reconcileSyncJobs(10);
      const ev = await getPool().query<{ id: string }>(`SELECT id FROM integration_events WHERE state IN ('pending','failed') AND next_attempt_at <= now() AND received_at < now() - interval '1 minute' ORDER BY next_attempt_at LIMIT 20`);
      for (const r of ev.rows) await processIntegrationEvent(r.id);
    })),
    // Retention (docs/v3-5/DATA_MODEL_AND_EVENTS.md): raw event bodies 7 days, activity 30 days, inbox events 90 days.
    every('v35-retention', 60 * 60_000, async () => {
      const db = getPool();
      await db.query(`UPDATE integration_events SET body=NULL WHERE body IS NOT NULL AND received_at < now() - interval '7 days'`);
      await db.query(`DELETE FROM integration_activity WHERE at < now() - interval '30 days'`);
      await db.query(`DELETE FROM inbox_events WHERE at < now() - interval '90 days'`);
    }),
  ];
}
