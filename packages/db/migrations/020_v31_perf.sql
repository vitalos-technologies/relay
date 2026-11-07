-- V3.1 PERF (stream PERF): measured indexes + workload-isolation metrics. Additive only (new indexes + one new table);
-- no data rewrite. Every index below is justified by a before/after measurement in docs/PERFORMANCE_RESULTS.md.
-- Rollback: DROP the indexes and the table (nothing else depends on them).

-- Per-item timings of background work (queue age is a live gauge; these rows give dispatch delay and processing
-- time per workload class, provider time kept apart). Ids and timings only — no content. 7-day retention (worker).
CREATE TABLE workload_samples (
  id                bigserial PRIMARY KEY,
  workload_class    text NOT NULL CHECK (workload_class IN ('publishing','connection_health','interactive_import','analytics_refresh',
                                                            'historical_backfill','video','report_export','notifications')),
  queue             text,
  workspace_id      uuid REFERENCES workspaces(id) ON DELETE CASCADE,
  provider          text,
  eligible_at       timestamptz NOT NULL,
  started_at        timestamptz NOT NULL,
  finished_at       timestamptz NOT NULL,
  dispatch_delay_ms integer NOT NULL CHECK (dispatch_delay_ms >= 0),
  local_wait_ms     integer NOT NULL DEFAULT 0 CHECK (local_wait_ms >= 0),
  deferred_ms       integer NOT NULL DEFAULT 0 CHECK (deferred_ms >= 0),
  processing_ms     integer NOT NULL CHECK (processing_ms >= 0),
  provider_ms       integer CHECK (provider_ms IS NULL OR provider_ms >= 0),
  outcome           text NOT NULL CHECK (outcome IN ('ok','error')),
  overflow          boolean NOT NULL DEFAULT false,
  worker_id         text
);
CREATE INDEX workload_samples_ws_idx ON workload_samples(workspace_id, finished_at DESC) WHERE workspace_id IS NOT NULL;
CREATE INDEX workload_samples_finished_idx ON workload_samples(finished_at);

-- ------------------------------------------------------------------ measured indexes (Large profile, EXPLAIN ANALYZE)
-- History / dashboard "recent" / ops (all brands): ORDER BY due_at DESC, id DESC within a workspace. The V1 index
-- (workspace_id, brand_id, due_at DESC, id) cannot give that order across brands → full sort of the workspace's
-- deliveries (Large: 391 ms → 1.3 ms for the first page).
CREATE INDEX deliveries_ws_due_idx ON deliveries(workspace_id, due_at DESC, id DESC);
-- Dashboard attention lists (blocked/unknown/failed/expired/handoff, newest first). Partial: only states that need
-- attention (Large: 188 ms → 0.7 ms per state).
CREATE INDEX deliveries_ws_attention_idx ON deliveries(workspace_id, state, updated_at DESC)
  WHERE state IN ('blocked','unknown','failed','expired','handoff');
-- Planner across all brands: due-time range within a workspace (Large week: 95 ms → 22 ms; was a seq scan).
CREATE INDEX schedules_ws_due_idx ON schedules(workspace_id, due_at);
-- Post detail + calendar decoration: latest approval of a schedule (was a seq scan of approvals).
CREATE INDEX approvals_schedule_idx ON approvals(schedule_id, requested_at DESC);
-- Approval inbox "decided" tab, newest first.
CREATE INDEX approvals_decided_idx ON approvals(workspace_id, decided_at DESC NULLS LAST) WHERE decision <> 'pending';
-- Operations: dispatch lateness over the last 7 days of attempts in a workspace (was a seq scan of attempts).
CREATE INDEX delivery_attempts_ws_started_idx ON delivery_attempts(workspace_id, started_at);
