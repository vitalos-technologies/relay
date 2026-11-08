// Worker wiring for stream C (one call from apps/worker/src/main.ts). Sync jobs and inbound events already run on the
// foundation's 'integration-sync' queue; this adds the recovery/scheduling loops, all in the bulk 'integration_sync'
// class except Slack delivery (small, user-facing alerts; 'notifications' class).
import type { WorkloadClass } from '@social-lite/core/contracts/v31-perf';
import { log } from '../log.js';
import { registerIntegrationsV35 } from './index.js';
import { pollLinkedTasks } from './work/tasks.js';
import { dispatchDueGbpPosts } from './gbp/service.js';
import { collectSlackAlerts, queueSlackSummaries, sendSlackDeliveries } from './slack/service.js';

export interface IntegrationWorkerDeps {
  stopping: () => boolean;
  run: <T>(cls: WorkloadClass, meta: { queue?: string | null; workspaceId?: string | null }, fn: () => Promise<T>) => Promise<T>;
}

export function registerIntegrationWorkers(d: IntegrationWorkerDeps): NodeJS.Timeout[] {
  registerIntegrationsV35();
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
    // Google posts follow their Relay schedule + approval; the job is created only when due and approved.
    every('gbp-posts', 30_000, () => d.run('integration_sync', { queue: 'gbp-posts' }, () => dispatchDueGbpPosts())),
    // Slack: notifications → alerts, daily summaries, then delivery (quiet hours, rate limits, retries).
    every('slack-alerts', 10_000, () => d.run('notifications', { queue: 'slack-alerts' }, async () => {
      await collectSlackAlerts();
      await queueSlackSummaries();
      await sendSlackDeliveries();
    })),
    // Polling fallback for linked Asana/monday tasks (webhooks are at-most-once / optional).
    every('task-poll', 5 * 60_000, () => d.run('integration_sync', { queue: 'task-poll' }, () => pollLinkedTasks(20))),
  ];
}
