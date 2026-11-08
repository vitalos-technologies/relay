// V3.1 PERF typed contracts (workload isolation + operations metrics). Served by GET /api/ops/workload
// (apps/web/app/api/ops/workload/route.ts) from packages/services/src/workload/stats.ts.
//
// Three numbers are kept apart on purpose (brief §6) — never add them up into one "latency":
//  - queue age:       how long the OLDEST eligible-but-not-started item has been waiting right now (gauge);
//  - dispatch delay:  eligible (due / retry time / job start_after) → a worker started it (per finished item);
//  - processing time: started → finished, split into app time and provider time (time inside provider adapters).
// Provider time is reported only where it is instrumented (publishing); elsewhere it is null, not 0.

export const WORKLOAD_CLASSES = [
  'publishing',          // due publishing + reconciliation (reserved capacity; never deferred)
  'connection_health',   // credential refresh + essential connection health checks
  'interactive_import',  // source imports / uploads a person is waiting for
  'analytics_refresh',   // provider metric syncs
  'historical_backfill', // analytics backfills / repairs
  'video',               // video validation / transcoding
  'report_export',       // report + Content Hub + MCP exports
  'notifications',       // outbox events, emails, digests
  // V3.5 (contracts/v35-events.ts): customer replies + inbox ingestion keep reserved main-pool capacity; integration
  // sync, listening and AI run on the bulk pool so a listening import can never starve replies or publishing.
  'customer_reply', 'inbox_ingest', 'integration_sync', 'listening_ingest', 'ai_assist',
] as const;
export type WorkloadClass = (typeof WORKLOAD_CLASSES)[number];

export interface WorkloadClassPolicy {
  class: WorkloadClass;
  /** Max items of this class running at once in ONE worker process (publishing: claim slots). */
  max_concurrent: number;
  /** Max items of this class for ONE workspace at once in one worker process. */
  per_workspace: number;
  /** Bulk classes wait (bounded) while publishing is under pressure. */
  defers_under_publishing_pressure: boolean;
  /** DB pool: 'main' (claim loops/publishing + light essential work) or 'bulk' (separate, smaller pool; can never take main connections). */
  pool: 'main' | 'bulk';
}

export interface Percentiles { n: number; p50_ms: number | null; p95_ms: number | null; max_ms: number | null }

export interface WorkloadClassStats {
  class: WorkloadClass;
  /** Finished items in the window (this workspace only). */
  finished: number;
  failed: number;
  dispatch_delay: Percentiles;
  processing: Percentiles;
  /** Time inside provider adapters (null when the class is not instrumented). */
  provider: Percentiles | null;
  /** processing − provider. */
  app: Percentiles | null;
  /** Portion of dispatch delay spent waiting for a worker slot or backpressure inside the worker. */
  local_wait: Percentiles;
}

export interface QueueGauge {
  /** pg-boss queue name or 'deliveries' (the publishing queue of record). */
  queue: string;
  class: WorkloadClass;
  /** Eligible, not started (system-wide count; no tenant data). */
  waiting: number;
  /** Age of the oldest eligible, not-started item (seconds); 0 when nothing waits. */
  oldest_age_seconds: number;
}

export interface WorkloadResponse {
  generated_at: string;
  window_minutes: number;
  /** Is publishing currently under pressure (bulk classes are deferring)? */
  publishing_pressure: { active: boolean; reason: string | null };
  policies: WorkloadClassPolicy[];
  classes: WorkloadClassStats[];
  queues: QueueGauge[];
  note: string;
}
