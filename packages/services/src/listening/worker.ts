// Listening worker wiring (one call from apps/worker/src/main.ts). Bulk pool, listening_ingest class (defers under
// publishing pressure, 1 per workspace): it can never delay customer replies or publishing.
//   queue 'listening-ingest': 'listening.ingest_requested' → observeMessage; 'listening.rematch_requested' → rematchSearch
//   loops: catch-up sweep (cursor) + edits reprocess + rematch recovery + backfills (30 s), alert rules (60 s), retention.
import type { PgBoss } from 'pg-boss';
import { V35_QUEUES } from '@social-lite/core/contracts/v35-events';
import { getPool } from '@social-lite/db';
import { log } from '../log.js';
import type { V35WorkerDeps } from '../inbox/worker.js';
import { observeMessage, pendingRematches, registerListeningHooks, rematchSearch, reprocessEdited, runBackfills, sweepIngest } from './ingest.js';
import { sweepAlertRules } from './alerts.js';

interface Job { data: { eventType: string; aggregateId: string; workspaceId: string | null; payload?: Record<string, unknown> } }

export async function registerListeningWorkers(boss: PgBoss, d: V35WorkerDeps): Promise<NodeJS.Timeout[]> {
  registerListeningHooks();
  await boss.work<Job['data']>(V35_QUEUES.listeningIngest, { batchSize: 5, pollingIntervalSeconds: 2, includeMetadata: true }, async (jobs) => {
    for (const job of jobs) {
      await d.track(d.job(V35_QUEUES.listeningIngest, job, async (): Promise<unknown> => (job.data.eventType === 'listening.rematch_requested'
        ? rematchSearch(job.data.aggregateId) : observeMessage(job.data.aggregateId))));
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
    every('listening-ingest', 30_000, () => d.run('listening_ingest', { queue: 'listening-ingest-sweep' }, async () => {
      for (let i = 0; i < 5; i++) if ((await sweepIngest(200)).scanned < 200) break;
      await reprocessEdited(100);
      for (const id of await pendingRematches(3)) await rematchSearch(id);
      await runBackfills(300);
    })),
    every('listening-alerts', 20_000, () => d.run('listening_ingest', { queue: 'listening-alerts' }, () => sweepAlertRules(100))),
    // Retention: ingest failure log 30 days (observations follow the inbox: removed at source ⇒ erased by the 031 trigger).
    every('listening-retention', 60 * 60_000, async () => {
      await getPool().query(`DELETE FROM listening_ingest_failures WHERE at < now() - interval '30 days'`);
    }),
  ];
}
