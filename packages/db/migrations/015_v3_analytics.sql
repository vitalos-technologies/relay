-- V3 AN — analytics semantics and pipeline (V3 spec §8, §9; docs/V3_ANALYTICS_DICTIONARY.md).
--
-- authorized connection → sync job (sync_runs / sync_cursors) → raw validated observations (metric_observations,
-- deduplicated on the fact key) → normalized facts: lifetime/cumulative snapshots (metric_cumulative_facts) kept
-- SEPARATE from time-bucket facts (metric_daily_facts) → cached aggregates (metric_resource_latest + metric_rollups,
-- incrementally maintained per touched bucket) → authorized report API. Fetch outcomes per series live in
-- data_coverage so "zero", "unsupported", "permission missing", "not fetched", "fetch failed" … stay distinct.
--
-- Additive. Legacy metric_snapshots / metric_fetch_state are kept (V1.1 page) and backfilled into the new tables
-- by the idempotent worker job services/analytics/backfill.ts (unsupported stays unsupported, never 0).

-- ---------------------------------------------------------------- synthetic fixtures flag
-- Analytics demo fixtures (services/analytics/demo.ts) live on synthetic, paused mock connections in demo workspaces
-- only. They are excluded from sync and from every live/simulated query.
ALTER TABLE connections ADD COLUMN is_synthetic boolean NOT NULL DEFAULT false;
ALTER TABLE connections ADD CONSTRAINT connections_synthetic_is_mock CHECK (NOT is_synthetic OR is_mock);

-- ---------------------------------------------------------------- metric registry
-- Canonical source: packages/services/src/analytics/registry.ts (synced by syncMetricRegistry()). A definition is
-- immutable per (metric_id, version): content_hash guards against silent redefinition; changing semantics = new version.
CREATE TABLE metric_definitions (
  metric_id            text NOT NULL CHECK (metric_id ~ '^[a-z]+\.(account|post|video)\.[A-Za-z0-9_]+$'),
  version              integer NOT NULL CHECK (version >= 1),
  provider             provider_kind NOT NULL,
  native_metric        text NOT NULL,
  dimension_key        text,
  name                 text NOT NULL,
  description          text NOT NULL,
  unit                 text NOT NULL CHECK (unit IN ('count','minutes','seconds','percent')),
  scope                text NOT NULL CHECK (scope IN ('account','post','video')),
  family               text NOT NULL,
  aggregation          text NOT NULL CHECK (aggregation IN ('sum','latest','ratio_of_sums','none')),
  time_basis           text NOT NULL CHECK (time_basis IN ('lifetime','window','daily','snapshot')),
  paid                 text NOT NULL CHECK (paid IN ('organic','mixed','paid')),
  availability         text NOT NULL CHECK (availability IN ('available','permission_required','in_development','not_fetched','excluded','deprecated')),
  fetched              boolean NOT NULL,
  required_scopes      text[] NOT NULL DEFAULT '{}',
  retention_days       integer CHECK (retention_days IS NULL OR retention_days > 0),
  provider_delay_hours integer NOT NULL DEFAULT 0 CHECK (provider_delay_hours >= 0),
  freshness_hours      integer NOT NULL DEFAULT 48 CHECK (freshness_hours > 0),
  spec                 jsonb NOT NULL DEFAULT '{}'::jsonb,   -- aliases, ratio components, thresholds, notes
  content_hash         text NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  retired_at           timestamptz,
  PRIMARY KEY (metric_id, version)
);
CREATE INDEX metric_definitions_native_idx ON metric_definitions(provider, native_metric);

-- ---------------------------------------------------------------- sync bookkeeping
-- One cursor per connection and stream: keyset position of the current pass (checkpointed after every item),
-- bounded backfill horizon, quota-aware cadence, failures, and a lease (one runner per connection).
CREATE TABLE sync_cursors (
  workspace_id         uuid NOT NULL,
  brand_id             uuid NOT NULL,
  connection_id        uuid NOT NULL,
  stream               text NOT NULL CHECK (stream IN ('post_metrics','account_metrics')),
  status               text NOT NULL DEFAULT 'active' CHECK (status IN ('active','stopped')),
  stop_reason          text CHECK (stop_reason IS NULL OR stop_reason IN ('unsupported','access_revoked','reconnect_required','connection_paused','brand_archived','workspace_suspended','budget_exhausted','synthetic')),
  cursor               jsonb,                    -- {"published_at": iso, "id": uuid} within the running pass; NULL = pass complete
  pass_started_at      timestamptz,
  backfill_from        timestamptz NOT NULL,     -- bounded backfill horizon (provider retention / ANALYTICS_BACKFILL_DAYS)
  next_run_at          timestamptz NOT NULL DEFAULT now(),
  interval_minutes     integer NOT NULL DEFAULT 60 CHECK (interval_minutes BETWEEN 5 AND 10080),
  consecutive_failures integer NOT NULL DEFAULT 0,
  lease_owner          text,
  lease_expires_at     timestamptz,
  last_run_id          uuid,
  last_success_at      timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (connection_id, stream),
  FOREIGN KEY (workspace_id, connection_id) REFERENCES connections(workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX sync_cursors_due_idx ON sync_cursors(next_run_at) WHERE status = 'active';
CREATE INDEX sync_cursors_ws_lease_idx ON sync_cursors(workspace_id) WHERE lease_owner IS NOT NULL;

CREATE TABLE sync_runs (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id           uuid NOT NULL,
  brand_id               uuid NOT NULL,
  connection_id          uuid NOT NULL,
  stream                 text NOT NULL,
  trigger                text NOT NULL CHECK (trigger IN ('schedule','backfill','manual','retry','legacy_backfill','demo')),
  job_key                text NOT NULL UNIQUE,     -- deterministic: a redelivered job never starts a second run
  status                 text NOT NULL DEFAULT 'running' CHECK (status IN ('running','succeeded','partial','failed','cancelled','skipped')),
  stop_reason            text,
  items_planned          integer NOT NULL DEFAULT 0,
  items_processed        integer NOT NULL DEFAULT 0,
  items_failed           integer NOT NULL DEFAULT 0,
  observations_written   integer NOT NULL DEFAULT 0,
  observations_unchanged integer NOT NULL DEFAULT 0,
  corrections            integer NOT NULL DEFAULT 0,
  rejected               integer NOT NULL DEFAULT 0,  -- invalid / unmapped points (never stored)
  worker_id              text,
  error_code             text,
  error_message          text,
  started_at             timestamptz NOT NULL DEFAULT now(),
  finished_at            timestamptz,
  FOREIGN KEY (workspace_id, connection_id) REFERENCES connections(workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX sync_runs_conn_idx ON sync_runs(connection_id, started_at DESC);
CREATE INDEX sync_runs_ws_idx ON sync_runs(workspace_id, started_at DESC);

-- ---------------------------------------------------------------- raw validated observations
-- Fact key = tenant, connection, resource, metric, period, dimension, definition version. A retry or re-fetch of the
-- same fact UPDATES the row (same value ⇒ observed_at only; different value ⇒ revision+1 = late correction). Never
-- appended twice. resource_id = delivery id (post) or connection id (account).
CREATE TABLE metric_observations (
  id                 bigserial PRIMARY KEY,
  workspace_id       uuid NOT NULL,
  brand_id           uuid NOT NULL,
  connection_id      uuid NOT NULL,
  resource_type      text NOT NULL CHECK (resource_type IN ('account','post')),
  resource_id        uuid NOT NULL,
  provider           provider_kind NOT NULL,
  provider_object_id text,
  metric_id          text NOT NULL,
  definition_version integer NOT NULL,
  native_metric      text NOT NULL,
  dimension          text NOT NULL DEFAULT '',
  period_key         text NOT NULL CHECK (period_key ~ '^(asof|day):\d{4}-\d{2}-\d{2}$'),
  native_period      text,
  window_start       date,
  value              numeric NOT NULL CHECK (value >= 0),
  source             text NOT NULL CHECK (source IN ('provider','simulated','synthetic')),
  observed_at        timestamptz NOT NULL,
  first_observed_at  timestamptz NOT NULL,
  revision           integer NOT NULL DEFAULT 1,
  previous_value     numeric,
  corrected_at       timestamptz,
  sync_run_id        uuid,
  legacy_snapshot_id bigint,
  FOREIGN KEY (metric_id, definition_version) REFERENCES metric_definitions(metric_id, version),
  FOREIGN KEY (workspace_id, connection_id) REFERENCES connections(workspace_id, id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX metric_observations_fact_key
  ON metric_observations(workspace_id, connection_id, resource_type, resource_id, metric_id, period_key, dimension, definition_version);
CREATE INDEX metric_observations_resource_idx ON metric_observations(workspace_id, resource_id, metric_id, observed_at DESC);
CREATE INDEX metric_observations_observed_idx ON metric_observations(observed_at);

-- ---------------------------------------------------------------- normalized facts (two separate stores)
-- 1) Lifetime/cumulative and point-in-time snapshots: the value AS OF a UTC date (last observation that day).
--    basis 'window' = provider rolling window total (e.g. Pinterest ≤ 90 days) that no longer covers the lifetime.
CREATE TABLE metric_cumulative_facts (
  workspace_id       uuid NOT NULL,
  brand_id           uuid NOT NULL,
  connection_id      uuid NOT NULL,
  resource_type      text NOT NULL CHECK (resource_type IN ('account','post')),
  resource_id        uuid NOT NULL,
  provider           provider_kind NOT NULL,
  metric_id          text NOT NULL,
  definition_version integer NOT NULL,
  dimension          text NOT NULL DEFAULT '',
  as_of_date         date NOT NULL,
  basis              text NOT NULL CHECK (basis IN ('lifetime','window','snapshot')),
  window_start       date,
  value              numeric NOT NULL CHECK (value >= 0),
  observed_at        timestamptz NOT NULL,
  through_at         timestamptz NOT NULL,       -- data complete through (observed_at − provider delay, or window end)
  source             text NOT NULL CHECK (source IN ('provider','simulated','synthetic')),
  revision           integer NOT NULL DEFAULT 1,
  PRIMARY KEY (workspace_id, connection_id, resource_type, resource_id, metric_id, dimension, definition_version, as_of_date),
  FOREIGN KEY (metric_id, definition_version) REFERENCES metric_definitions(metric_id, version),
  FOREIGN KEY (workspace_id, connection_id) REFERENCES connections(workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX metric_cumulative_facts_series_idx ON metric_cumulative_facts(workspace_id, resource_id, metric_id, as_of_date);
CREATE INDEX metric_cumulative_facts_account_idx ON metric_cumulative_facts(workspace_id, connection_id, metric_id, as_of_date)
  WHERE resource_type = 'account';

-- 2) Time-bucket facts: 'reported' = a provider-defined daily bucket (bucket_tz = the provider's day definition);
--    'observed_change' = difference between two consecutive cumulative snapshots (may be negative: corrections; not an
--    event-time count; period_start/period_end are the two observation instants).
CREATE TABLE metric_daily_facts (
  workspace_id       uuid NOT NULL,
  brand_id           uuid NOT NULL,
  connection_id      uuid NOT NULL,
  resource_type      text NOT NULL CHECK (resource_type IN ('account','post')),
  resource_id        uuid NOT NULL,
  provider           provider_kind NOT NULL,
  metric_id          text NOT NULL,
  definition_version integer NOT NULL,
  dimension          text NOT NULL DEFAULT '',
  fact_kind          text NOT NULL CHECK (fact_kind IN ('reported','observed_change')),
  bucket_date        date NOT NULL,
  bucket_tz          text NOT NULL,
  value              numeric NOT NULL,
  period_start       timestamptz NOT NULL,
  period_end         timestamptz NOT NULL,
  observed_at        timestamptz NOT NULL,
  source             text NOT NULL CHECK (source IN ('provider','simulated','synthetic')),
  revision           integer NOT NULL DEFAULT 1,
  PRIMARY KEY (workspace_id, connection_id, resource_type, resource_id, metric_id, dimension, definition_version, fact_kind, bucket_date),
  FOREIGN KEY (metric_id, definition_version) REFERENCES metric_definitions(metric_id, version),
  FOREIGN KEY (workspace_id, connection_id) REFERENCES connections(workspace_id, id) ON DELETE CASCADE,
  CHECK (period_end >= period_start),
  CHECK (fact_kind = 'observed_change' OR value >= 0)
);
CREATE INDEX metric_daily_facts_period_idx ON metric_daily_facts(workspace_id, fact_kind, period_end);

-- ---------------------------------------------------------------- cached aggregates (incrementally maintained)
-- Latest cumulative value per resource series (one row; replaced when a newer as-of date arrives).
CREATE TABLE metric_resource_latest (
  workspace_id       uuid NOT NULL,
  brand_id           uuid NOT NULL,
  connection_id      uuid NOT NULL,
  resource_type      text NOT NULL CHECK (resource_type IN ('account','post')),
  resource_id        uuid NOT NULL,
  provider           provider_kind NOT NULL,
  metric_id          text NOT NULL,
  definition_version integer NOT NULL,
  dimension          text NOT NULL DEFAULT '',
  basis              text NOT NULL,
  value              numeric NOT NULL,
  as_of_date         date NOT NULL,
  observed_at        timestamptz NOT NULL,
  through_at         timestamptz NOT NULL,
  published_at       timestamptz,                -- post resources (publish-date bucketing)
  rollup_bucket      timestamptz,                -- 15-minute floor of published_at
  source             text NOT NULL CHECK (source IN ('provider','simulated','synthetic')),
  PRIMARY KEY (workspace_id, connection_id, resource_type, resource_id, metric_id, dimension, definition_version),
  FOREIGN KEY (metric_id, definition_version) REFERENCES metric_definitions(metric_id, version),
  FOREIGN KEY (workspace_id, connection_id) REFERENCES connections(workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX metric_resource_latest_bucket_idx ON metric_resource_latest(workspace_id, connection_id, source, rollup_bucket) WHERE resource_type = 'post';
CREATE INDEX metric_resource_latest_published_idx ON metric_resource_latest(workspace_id, source, published_at) WHERE resource_type = 'post';
CREATE INDEX metric_resource_latest_resource_idx ON metric_resource_latest(workspace_id, resource_id);

-- Per (connection, source, 15-minute publish bucket, metric key, dimension): sums over the posts published in that
-- bucket, recomputed from metric_resource_latest whenever one of its posts changes. 15-minute buckets never straddle a
-- local midnight for any real UTC offset, so local-day totals are exact in every timezone (incl. DST days).
-- metric_key = a registry metric id, or a derived per-post pairing:
--   _derived.engagements                     Σ engagement components per post (posts with ≥1 component)
--   _derived.er_views.num / .den              engagements / views over posts with BOTH (ratio of sums)
--   _derived.er_impressions.num / .den        engagements / impressions over posts with BOTH
--   _derived.avd.num / .den                   watch seconds / views over videos with BOTH
--   _family.<family>                          Σ over the family's metrics per post (resources = distinct posts)
CREATE TABLE metric_rollups (
  workspace_id       uuid NOT NULL,
  brand_id           uuid NOT NULL,
  connection_id      uuid NOT NULL,
  provider           provider_kind NOT NULL,
  source             text NOT NULL CHECK (source IN ('provider','simulated','synthetic')),
  bucket_start       timestamptz NOT NULL CHECK (extract(epoch FROM bucket_start)::bigint % 900 = 0),
  metric_key         text NOT NULL,
  definition_version integer NOT NULL,
  dimension          text NOT NULL DEFAULT '',
  value_sum          numeric NOT NULL,
  resources          integer NOT NULL CHECK (resources >= 0),
  min_through_at     timestamptz,
  min_observed_at    timestamptz,
  max_observed_at    timestamptz,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, connection_id, source, bucket_start, metric_key, definition_version, dimension),
  FOREIGN KEY (workspace_id, connection_id) REFERENCES connections(workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX metric_rollups_scope_idx ON metric_rollups(workspace_id, source, bucket_start, brand_id);

-- ---------------------------------------------------------------- coverage / fetch outcome per series
-- metric_id '*' = the resource-level fetch state (drives cadence: next_attempt_at). Query-time states (zero, not
-- fetched, stale, provider delayed, partial coverage) are derived from these rows + facts + the query scope.
CREATE TABLE data_coverage (
  workspace_id         uuid NOT NULL,
  brand_id             uuid NOT NULL,
  connection_id        uuid NOT NULL,
  resource_type        text NOT NULL CHECK (resource_type IN ('account','post')),
  resource_id          uuid NOT NULL,
  provider             provider_kind NOT NULL,
  metric_id            text NOT NULL,
  status               text NOT NULL CHECK (status IN ('ok','unsupported','permission_missing','provider_delayed','fetch_failed',
                         'not_found','reconnect_required','budget_exhausted','rate_limited','access_revoked')),
  reason               text,
  last_attempt_at      timestamptz,
  last_success_at      timestamptz,
  next_attempt_at      timestamptz,
  consecutive_failures integer NOT NULL DEFAULT 0,
  last_sync_run_id     uuid,
  source               text NOT NULL DEFAULT 'provider' CHECK (source IN ('provider','simulated','synthetic')),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, connection_id, resource_type, resource_id, metric_id),
  FOREIGN KEY (workspace_id, connection_id) REFERENCES connections(workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX data_coverage_due_idx ON data_coverage(connection_id, next_attempt_at) WHERE metric_id = '*';
CREATE INDEX data_coverage_resource_idx ON data_coverage(workspace_id, resource_id);

-- Publish-date scans for coverage denominators and the content table.
CREATE INDEX deliveries_published_scope_idx ON deliveries(workspace_id, published_at, connection_id) WHERE state = 'published';

-- ---------------------------------------------------------------- reports
-- Saved views: filter state is URL-serialisable ids/dates/timezone only (no names, text or tokens). Access is
-- rechecked against the CURRENT policy every time a report is opened or exported.
CREATE TABLE report_definitions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  owner_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  name          text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 120),
  view          text NOT NULL CHECK (view IN ('overview','content','channels','video','audience','workflow')),
  filters       jsonb NOT NULL,
  query_string  text NOT NULL CHECK (length(query_string) <= 4000),
  visibility    text NOT NULL DEFAULT 'private' CHECK (visibility IN ('private','workspace')),
  brand_ids     uuid[] NOT NULL DEFAULT '{}',
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  archived_at   timestamptz,
  UNIQUE (workspace_id, id)
);
CREATE INDEX report_definitions_ws_idx ON report_definitions(workspace_id, updated_at DESC) WHERE archived_at IS NULL;

-- Async exports (queue 'report-export'). manifest reproduces scope, filters, timezone, metrics, observation timestamps
-- and coverage. Files live under exports/<workspace>/<export id>/ and expire.
CREATE TABLE report_exports (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id         uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  requested_by         uuid REFERENCES users(id) ON DELETE SET NULL,
  report_definition_id uuid,
  view                 text NOT NULL CHECK (view IN ('overview','content','channels','video','audience','workflow')),
  format               text NOT NULL CHECK (format IN ('csv','pdf','html')),
  -- 'download' or a Content Hub destination kind (packages/core/src/contracts/exports.ts ExportDestinationKind)
  destination          text NOT NULL DEFAULT 'download' CHECK (destination IN ('download','google_doc','drive_file','notion_page')),
  destination_ref      jsonb,                    -- {"connection_id": uuid, "parent_id": text|null} (ids only)
  filters              jsonb NOT NULL,
  query_string         text NOT NULL,
  brand_ids            uuid[] NOT NULL DEFAULT '{}',
  status               text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','succeeded','failed','cancelled','expired')),
  attempts             integer NOT NULL DEFAULT 0,
  object_key           text,
  content_type         text,
  filename             text,
  bytes                bigint,
  checksum_sha256      text,
  row_count            integer,
  manifest             jsonb,
  destination_result   jsonb,
  error_code           text,
  error_message        text,
  reservation_id       uuid,
  created_at           timestamptz NOT NULL DEFAULT now(),
  started_at           timestamptz,
  finished_at          timestamptz,
  expires_at           timestamptz,
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, report_definition_id) REFERENCES report_definitions(workspace_id, id) ON DELETE SET NULL (report_definition_id)
);
CREATE INDEX report_exports_user_idx ON report_exports(workspace_id, requested_by, created_at DESC);
CREATE INDEX report_exports_status_idx ON report_exports(status, created_at) WHERE status IN ('queued','running');
CREATE INDEX report_exports_expiry_idx ON report_exports(expires_at) WHERE status = 'succeeded';
