-- V2 stream D — product & fairness: usage budgets with atomic reservations (workspace + team),
-- fair dispatch across workspaces, duplicate/collision window per brand.
-- Additive except usage_counters' primary key, which becomes two partial unique indexes so the same
-- counter table carries a team dimension (one mechanism for workspace and team budgets).

-- ---------------------------------------------------------------- usage counters: team scope + reservations
ALTER TABLE usage_counters ADD COLUMN team_id uuid;
ALTER TABLE usage_counters ADD COLUMN reserved bigint NOT NULL DEFAULT 0 CHECK (reserved >= 0);
ALTER TABLE usage_counters DROP CONSTRAINT usage_counters_pkey;
CREATE UNIQUE INDEX usage_counters_ws_uniq ON usage_counters(workspace_id, meter, period) WHERE team_id IS NULL;
CREATE UNIQUE INDEX usage_counters_team_uniq ON usage_counters(workspace_id, team_id, meter, period) WHERE team_id IS NOT NULL;
ALTER TABLE usage_counters ADD CONSTRAINT usage_counters_team_fk
  FOREIGN KEY (workspace_id, team_id) REFERENCES teams(workspace_id, id) ON DELETE CASCADE;

-- Team caps (workspace caps stay in workspaces.limits for compatibility: x_monthly_writes,
-- x_monthly_reads, ai_monthly_tokens, plus storage_bytes, monthly_exports, dispatch_concurrency).
CREATE TABLE usage_budgets (
  workspace_id uuid NOT NULL,
  team_id      uuid NOT NULL,
  meter        text NOT NULL CHECK (meter IN ('ai.tokens','x.write','x.read','storage.bytes','exports.count')),
  cap          bigint NOT NULL CHECK (cap >= 0),
  updated_by   uuid REFERENCES users(id),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (team_id, meter),
  FOREIGN KEY (workspace_id, team_id) REFERENCES teams(workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX usage_budgets_ws_idx ON usage_budgets(workspace_id);

-- Storage is a gauge (period 'total'): backfill what is already stored (originals of usable assets).
INSERT INTO usage_counters(workspace_id, meter, period, used)
SELECT workspace_id, 'storage.bytes', 'total', coalesce(sum(coalesce(bytes, declared_bytes, 0)), 0)
  FROM assets WHERE status IN ('ready','archived') GROUP BY workspace_id
ON CONFLICT DO NOTHING;

-- One row per reservation: reserved → settled | released | expired. Settle/release are idempotent
-- (status transition guarded by WHERE status='reserved').
CREATE TABLE usage_reservations (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id   uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  meter          text NOT NULL,
  period         text NOT NULL,
  team_ids       uuid[] NOT NULL DEFAULT '{}',
  amount         bigint NOT NULL CHECK (amount >= 0),
  settled_amount bigint,
  status         text NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved','settled','released','expired')),
  ref            text CHECK (ref IS NULL OR length(ref) <= 200),
  actor_user_id  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL,
  finished_at    timestamptz
);
CREATE INDEX usage_reservations_open_idx ON usage_reservations(workspace_id, meter, expires_at) WHERE status = 'reserved';
CREATE INDEX usage_reservations_ref_idx ON usage_reservations(workspace_id, ref) WHERE ref IS NOT NULL;

-- ---------------------------------------------------------------- fair dispatch
-- Per-workspace claim bookkeeping: claims for a workspace serialize on this row so the per-workspace
-- concurrency cap is exact under concurrent workers; last_claimed_at drives round-robin ordering.
CREATE TABLE workspace_dispatch_state (
  workspace_id    uuid PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  last_claimed_at timestamptz,
  claims          bigint NOT NULL DEFAULT 0
);
CREATE INDEX deliveries_live_lease_ws_idx ON deliveries(workspace_id) WHERE lease_owner IS NOT NULL;
CREATE INDEX deliveries_connection_due_idx ON deliveries(connection_id, due_at);

-- ---------------------------------------------------------------- duplicate / collision warning
-- Window (hours) in which similar content to the same destination is flagged. 0 disables the warning.
ALTER TABLE brands ADD COLUMN duplicate_window_hours integer NOT NULL DEFAULT 24
  CHECK (duplicate_window_hours BETWEEN 0 AND 720);

-- ---------------------------------------------------------------- activity centre
-- Category filters match on the action's first segment (e.g. 'connection', 'schedule', 'member').
CREATE INDEX audit_events_ws_kind_idx ON audit_events(workspace_id, (split_part(action, '.', 1)), id DESC);
