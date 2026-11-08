// Stream E worker wiring (one call from apps/worker/src/main.ts, registered BEFORE the inbox consumers so the
// automation hooks exist before the first 'inbox-events' job is processed):
//  - 'ai-assist' queue → executeRun (workload class ai_assist: bulk pool, budget-gated, never blocks replies/publishing);
//  - recovery: queued runs whose wake-up was lost, expired leases (every 15 s);
//  - case.sla_nearing sweep (every 60 s, inbox_ingest class — DB only);
//  - retention: AI run output + the person's request text purged after 30 days (hourly).
import type { PgBoss } from 'pg-boss';
import { V35_QUEUES } from '@social-lite/core/contracts/v35-events';
import { log } from '../log.js';
import type { V35WorkerDeps } from '../inbox/worker.js';
import { executeRun, purgeRunOutputs, sweepRuns } from '../assistant/runs.js';
import { installAutomation } from './install.js';
import { sweepSlaNearing } from './engine.js';

interface Job { data: { eventType: string; aggregateId: string; workspaceId: string | null; payload?: Record<string, unknown> } }

export async function registerAiAutomationWorkers(boss: PgBoss, d: V35WorkerDeps): Promise<NodeJS.Timeout[]> {
  installAutomation();
  await boss.work<Job['data']>(V35_QUEUES.aiAssist, { batchSize: 2, pollingIntervalSeconds: 1, includeMetadata: true }, async (jobs) => {
    for (const job of jobs) await d.track(d.job(V35_QUEUES.aiAssist, job, () => executeRun(job.data.aggregateId, `${d.workerId}#ai`)));
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
    every('ai-runs', 15_000, () => d.run('ai_assist', { queue: 'ai-assist' }, async () => {
      for (const id of await sweepRuns()) await executeRun(id, `${d.workerId}#ai-sweep`);
    })),
    every('automation-sla', 60_000, () => d.run('inbox_ingest', { queue: 'inbox-sweeps' }, () => sweepSlaNearing())),
    every('ai-retention', 60 * 60_000, () => purgeRunOutputs()),
  ];
}
