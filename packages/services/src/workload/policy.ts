// Workload classes (V3.1 brief §6). Publishing must stay dependable while imports, reports and video run:
//  - publishing (due publishing + reconciliation) runs on the worker's claim slots and the MAIN pool, which bulk work
//    can never use (bulk classes run on a separate pool — see runner.ts), and is never deferred. Light essential work
//    (notifications, connection health) also stays on the main pool and is never deferred;
//  - every other class has a per-process concurrency cap and a per-workspace cap (no tenant monopolises a class);
//  - bulk classes defer (bounded) while publishing is under pressure, so they cannot add DB load while due posts wait.
// Defaults are conservative; operators override per class with WORKLOAD_<CLASS>_CONCURRENCY / _PER_WORKSPACE.
import type { WorkloadClass, WorkloadClassPolicy } from '@social-lite/core/contracts/v31-perf';

const DEFAULTS: Record<WorkloadClass, Omit<WorkloadClassPolicy, 'class'>> = {
  publishing: { max_concurrent: 4, per_workspace: 4, defers_under_publishing_pressure: false, pool: 'main' },
  connection_health: { max_concurrent: 1, per_workspace: 1, defers_under_publishing_pressure: false, pool: 'main' },
  interactive_import: { max_concurrent: 2, per_workspace: 1, defers_under_publishing_pressure: false, pool: 'bulk' },
  analytics_refresh: { max_concurrent: 2, per_workspace: 1, defers_under_publishing_pressure: true, pool: 'bulk' },
  historical_backfill: { max_concurrent: 1, per_workspace: 1, defers_under_publishing_pressure: true, pool: 'bulk' },
  video: { max_concurrent: 1, per_workspace: 1, defers_under_publishing_pressure: true, pool: 'bulk' },
  report_export: { max_concurrent: 2, per_workspace: 1, defers_under_publishing_pressure: true, pool: 'bulk' },
  notifications: { max_concurrent: 2, per_workspace: 2, defers_under_publishing_pressure: false, pool: 'main' },
};

/** pg-boss queue / worker loop → workload class. Publishing's queue of record is the deliveries table. */
export const QUEUE_CLASS: Record<string, WorkloadClass> = {
  'delivery-due': 'publishing',
  deliveries: 'publishing',
  events: 'notifications',
  'source-import': 'interactive_import',
  writeback: 'interactive_import',
  'report-export': 'report_export',
  'analytics-report-export': 'report_export',
  'analytics-sync': 'analytics_refresh',
  'media-transcode': 'video',
  'collab-notify': 'notifications',
};

function envInt(name: string, env: NodeJS.ProcessEnv): number | null {
  const v = env[name];
  if (v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= 256 ? n : null;
}

export function workloadPolicies(env: NodeJS.ProcessEnv = process.env, publishingSlots?: number): Record<WorkloadClass, WorkloadClassPolicy> {
  const out = {} as Record<WorkloadClass, WorkloadClassPolicy>;
  for (const [cls, d] of Object.entries(DEFAULTS) as Array<[WorkloadClass, (typeof DEFAULTS)[WorkloadClass]]>) {
    const key = cls.toUpperCase();
    const max = cls === 'publishing' ? (publishingSlots ?? envInt('WORKER_CONCURRENCY', env) ?? d.max_concurrent) : (envInt(`WORKLOAD_${key}_CONCURRENCY`, env) ?? d.max_concurrent);
    const perWs = Math.min(max, envInt(`WORKLOAD_${key}_PER_WORKSPACE`, env) ?? d.per_workspace);
    out[cls] = { class: cls, ...d, max_concurrent: max, per_workspace: cls === 'publishing' ? max : perWs };
  }
  return out;
}

export const PRESSURE_DEFAULTS = {
  /** Publishing is under pressure when claimable due work has waited longer than this. */
  dueAgeSeconds: 10,
  /** Longest a bulk item defers for publishing pressure before it runs anyway (bulk is slowed, never starved). */
  maxDeferMs: 60_000,
  /** Longest an item waits for a class/workspace slot before it runs anyway (stays below pg-boss job expiry). */
  maxSlotWaitMs: 10 * 60_000,
};
