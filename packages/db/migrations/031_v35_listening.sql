-- V3.5 social listening (stream D; brief docs/queue/03f_V3_5_PROMPT.md §14–15). Additive only.
-- Connected-source monitoring observes PUBLIC inbox items (comments, mentions, reviews) — private messages are never
-- copied here (CHECK on conversation_kind). Broad listening providers (licensed/approved) write the same observation rows
-- once activated; none is active in this build (coverage registry marks them "awaiting activation").
-- Deletion propagation: a trigger on inbox_messages mirrors provider deletions, retention erasure and edits into
-- listening_observations in the SAME transaction (search index + derived counts follow immediately); hard deletes cascade.
-- Rollback: DROP TRIGGER inbox_messages_listening_sync ON inbox_messages; DROP FUNCTION listening_sync_from_inbox();
-- then DROP the listening_* tables below (nothing earlier references them).

CREATE TABLE listening_observations (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id          uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  brand_id              uuid NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  layer                 text NOT NULL DEFAULT 'connected' CHECK (layer IN ('connected','broad')),
  source_key            text NOT NULL,                                   -- 'connected:facebook_page', 'broad:…'
  channel_id            uuid REFERENCES inbox_channels(id) ON DELETE CASCADE,
  inbox_message_id      uuid REFERENCES inbox_messages(id) ON DELETE CASCADE,
  conversation_id       uuid REFERENCES inbox_conversations(id) ON DELETE SET NULL,
  conversation_kind     text NOT NULL CHECK (conversation_kind IN ('comment','mention','review')),  -- never 'dm'
  external_id           text,
  body                  text,                                            -- NULL = removed at source / erased
  body_tsv              tsvector GENERATED ALWAYS AS (to_tsvector('simple', coalesce(body, ''))) STORED,
  language              text,
  fingerprint           text,                                            -- sha256 of normalised text (repeat detection)
  duplicate_of          uuid REFERENCES listening_observations(id) ON DELETE SET NULL,
  terms                 text[] NOT NULL DEFAULT '{}',                    -- salient keywords (topic grouping)
  sentiment_label       text NOT NULL DEFAULT 'unscored' CHECK (sentiment_label IN ('positive','negative','neutral','mixed','unscored')),
  sentiment_score       real,
  sentiment_confidence  real NOT NULL DEFAULT 0,
  sentiment_method      text NOT NULL DEFAULT 'lexicon_v1',
  sentiment_evidence    text[] NOT NULL DEFAULT '{}',
  corrected_label       text CHECK (corrected_label IN ('positive','negative','neutral','mixed')),
  corrected_by          uuid REFERENCES users(id) ON DELETE SET NULL,
  corrected_at          timestamptz,
  excluded_at           timestamptz,                                     -- manager marked irrelevant (kept out of every metric)
  excluded_by           uuid REFERENCES users(id) ON DELETE SET NULL,
  excluded_reason       text,
  source_revision       integer NOT NULL DEFAULT 1,
  needs_reprocess       boolean NOT NULL DEFAULT false,                  -- edited at source: reclassify + rematch
  occurred_at           timestamptz NOT NULL,                            -- provider timestamp
  observed_at           timestamptz NOT NULL DEFAULT now(),              -- retrieval time
  removed_at            timestamptz,                                     -- provider deletion / retention erasure
  is_simulated          boolean NOT NULL DEFAULT false,
  CHECK (layer = 'broad' OR inbox_message_id IS NOT NULL)
);
CREATE UNIQUE INDEX listening_obs_message_uniq ON listening_observations(inbox_message_id) WHERE inbox_message_id IS NOT NULL;
CREATE UNIQUE INDEX listening_obs_external_uniq ON listening_observations(workspace_id, source_key, external_id) WHERE layer = 'broad';
CREATE INDEX listening_obs_brand_time_idx ON listening_observations(workspace_id, brand_id, is_simulated, occurred_at DESC);
CREATE INDEX listening_obs_fp_idx ON listening_observations(workspace_id, brand_id, fingerprint, occurred_at);
CREATE INDEX listening_obs_tsv_idx ON listening_observations USING gin(body_tsv);
CREATE INDEX listening_obs_reprocess_idx ON listening_observations(id) WHERE needs_reprocess;
CREATE INDEX listening_obs_channel_idx ON listening_observations(channel_id, occurred_at);
CREATE INDEX listening_obs_dup_idx ON listening_observations(duplicate_of) WHERE duplicate_of IS NOT NULL;

-- Saved searches (versioned definitions). role: own brand / competitor / topic (share of voice compares own vs competitors).
CREATE TABLE listening_searches (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id     uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  brand_id         uuid NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  name             text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  role             text NOT NULL DEFAULT 'own' CHECK (role IN ('own','competitor','topic')),
  terms            text[] NOT NULL DEFAULT '{}',
  keywords         text[] NOT NULL DEFAULT '{}',
  exclusions       text[] NOT NULL DEFAULT '{}',
  boolean_query    text CHECK (boolean_query IS NULL OR length(boolean_query) <= 500),
  languages        text[] NOT NULL DEFAULT '{}',
  sources          text[] NOT NULL DEFAULT '{}',
  kinds            text[] NOT NULL DEFAULT '{}',
  version          integer NOT NULL DEFAULT 1,
  matched_version  integer NOT NULL DEFAULT 0,                           -- version whose re-match finished
  rematch_state    text NOT NULL DEFAULT 'pending' CHECK (rematch_state IN ('idle','pending','running')),
  created_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  archived_at      timestamptz
);
CREATE INDEX listening_searches_ws_idx ON listening_searches(workspace_id, brand_id) WHERE archived_at IS NULL;

CREATE TABLE listening_search_versions (
  search_id   uuid NOT NULL REFERENCES listening_searches(id) ON DELETE CASCADE,
  version     integer NOT NULL,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  definition  jsonb NOT NULL,
  created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (search_id, version)
);

-- Search index: which observations match which search (at which query version). Rebuilt on definition change.
CREATE TABLE listening_matches (
  search_id      uuid NOT NULL REFERENCES listening_searches(id) ON DELETE CASCADE,
  observation_id uuid NOT NULL REFERENCES listening_observations(id) ON DELETE CASCADE,
  workspace_id   uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  query_version  integer NOT NULL,
  occurred_at    timestamptz NOT NULL,
  matched_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (search_id, observation_id)
);
CREATE INDEX listening_matches_time_idx ON listening_matches(search_id, occurred_at DESC);
CREATE INDEX listening_matches_obs_idx ON listening_matches(observation_id);

-- Spike alert rules (minimum sample, baseline, cooldown) and fired alerts (deduplicated per rule + window).
CREATE TABLE listening_alert_rules (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id         uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  brand_id             uuid NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  search_id            uuid NOT NULL REFERENCES listening_searches(id) ON DELETE CASCADE,
  name                 text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  metric               text NOT NULL DEFAULT 'volume' CHECK (metric IN ('volume','negative')),
  window_minutes       integer NOT NULL DEFAULT 60 CHECK (window_minutes BETWEEN 15 AND 1440),
  baseline_days        integer NOT NULL DEFAULT 7 CHECK (baseline_days BETWEEN 1 AND 28),
  min_sample           integer NOT NULL DEFAULT 10 CHECK (min_sample BETWEEN 3 AND 10000),
  multiplier           real NOT NULL DEFAULT 2 CHECK (multiplier >= 1.2 AND multiplier <= 20),
  min_baseline_windows integer NOT NULL DEFAULT 24 CHECK (min_baseline_windows BETWEEN 3 AND 2000),
  cooldown_minutes     integer NOT NULL DEFAULT 360 CHECK (cooldown_minutes BETWEEN 15 AND 10080),
  recipients           uuid[] NOT NULL DEFAULT '{}',
  enabled              boolean NOT NULL DEFAULT true,
  last_evaluated_at    timestamptz,
  last_state           text,
  last_detail          text,
  version              integer NOT NULL DEFAULT 1,
  created_by           uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  archived_at          timestamptz
);
CREATE INDEX listening_alert_rules_search_idx ON listening_alert_rules(search_id) WHERE archived_at IS NULL AND enabled;

CREATE TABLE listening_alerts (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id      uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  brand_id          uuid NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  rule_id           uuid NOT NULL REFERENCES listening_alert_rules(id) ON DELETE CASCADE,
  search_id         uuid NOT NULL REFERENCES listening_searches(id) ON DELETE CASCADE,
  query_version     integer NOT NULL,
  metric            text NOT NULL,
  window_start      timestamptz NOT NULL,
  window_end        timestamptz NOT NULL,
  observed          integer NOT NULL,
  baseline_mean     real NOT NULL,
  baseline_stddev   real NOT NULL,
  baseline_windows  integer NOT NULL,
  threshold         integer NOT NULL,
  min_sample        integer NOT NULL,
  coverage          jsonb NOT NULL,                                     -- ListeningCoverage snapshot at fire time
  is_simulated      boolean NOT NULL DEFAULT false,
  state             text NOT NULL DEFAULT 'open' CHECK (state IN ('open','acknowledged','dismissed')),
  acknowledged_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  acknowledged_at   timestamptz,
  dedupe_key        text NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, dedupe_key)
);
CREATE INDEX listening_alerts_ws_idx ON listening_alerts(workspace_id, brand_id, created_at DESC);
CREATE INDEX listening_alerts_rule_idx ON listening_alerts(rule_id, created_at DESC);

-- Evidence: the exact observations behind an alert (acceptance test 10). Removing an observation removes its evidence row;
-- the alert keeps its fire-time count and shows how many items were removed at source since.
CREATE TABLE listening_alert_evidence (
  alert_id       uuid NOT NULL REFERENCES listening_alerts(id) ON DELETE CASCADE,
  observation_id uuid NOT NULL REFERENCES listening_observations(id) ON DELETE CASCADE,
  workspace_id   uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  PRIMARY KEY (alert_id, observation_id)
);
CREATE INDEX listening_alert_evidence_obs_idx ON listening_alert_evidence(observation_id);

CREATE TABLE listening_dashboards (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  brand_id     uuid NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  name         text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  widgets      jsonb NOT NULL DEFAULT '[]'::jsonb,
  shared       boolean NOT NULL DEFAULT true,
  created_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  archived_at  timestamptz
);
CREATE INDEX listening_dashboards_ws_idx ON listening_dashboards(workspace_id, brand_id) WHERE archived_at IS NULL;

-- Insight → action links (task / case / content draft), audited and shown on the observation/alert.
CREATE TABLE listening_insight_actions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id   uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  brand_id       uuid NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  observation_id uuid REFERENCES listening_observations(id) ON DELETE SET NULL,
  alert_id       uuid REFERENCES listening_alerts(id) ON DELETE SET NULL,
  search_id      uuid REFERENCES listening_searches(id) ON DELETE SET NULL,
  action         text NOT NULL CHECK (action IN ('task','case','draft')),
  target_id      uuid NOT NULL,
  idempotency_key text NOT NULL,
  created_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, idempotency_key)
);
CREATE INDEX listening_insight_actions_obs_idx ON listening_insight_actions(observation_id);
CREATE INDEX listening_insight_actions_alert_idx ON listening_insight_actions(alert_id);

-- Per-channel opt-out of connected-source monitoring (managers). Default: every public channel type is monitored.
CREATE TABLE listening_channel_settings (
  channel_id   uuid PRIMARY KEY REFERENCES inbox_channels(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  excluded     boolean NOT NULL DEFAULT false,
  backfill_requested_at timestamptz,                                  -- re-included: re-observe stored public items
  changed_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  changed_at   timestamptz NOT NULL DEFAULT now()
);

-- Ingestion cursor over inbox_messages (catch-up sweep; the event path is the fast path) + failure log.
CREATE TABLE listening_cursors (
  key          text PRIMARY KEY,
  received_at  timestamptz NOT NULL DEFAULT '-infinity',
  message_id   uuid,
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE listening_ingest_failures (
  id             bigserial PRIMARY KEY,
  workspace_id   uuid REFERENCES workspaces(id) ON DELETE CASCADE,
  source_key     text NOT NULL,
  ref_id         text,
  code           text NOT NULL,
  message        text NOT NULL,
  at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX listening_ingest_failures_ws_idx ON listening_ingest_failures(workspace_id, at DESC);

-- ------------------------------------------------------------------ deletion / correction propagation
CREATE OR REPLACE FUNCTION listening_sync_from_inbox() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_obs uuid;
  v_first uuid;
BEGIN
  SELECT id INTO v_obs FROM listening_observations WHERE inbox_message_id = NEW.id AND removed_at IS NULL;
  IF v_obs IS NULL THEN RETURN NEW; END IF;
  IF NEW.deleted_at IS NOT NULL OR NEW.body IS NULL THEN
    UPDATE listening_observations SET body = NULL, sentiment_evidence = '{}', terms = '{}', fingerprint = NULL,
           removed_at = coalesce(NEW.deleted_at, now()), needs_reprocess = false
     WHERE id = v_obs;
    DELETE FROM listening_matches WHERE observation_id = v_obs;   -- out of the search index immediately
    -- Repeats of a removed original: the earliest remaining repeat becomes the original (counts stay "unique once").
    SELECT id INTO v_first FROM listening_observations WHERE duplicate_of = v_obs AND removed_at IS NULL ORDER BY occurred_at, id LIMIT 1;
    IF v_first IS NOT NULL THEN
      UPDATE listening_observations SET duplicate_of = NULL WHERE id = v_first;
      UPDATE listening_observations SET duplicate_of = v_first WHERE duplicate_of = v_obs;
    END IF;
  ELSIF NEW.body IS DISTINCT FROM OLD.body THEN
    UPDATE listening_observations SET body = NEW.body, source_revision = NEW.revision, needs_reprocess = true WHERE id = v_obs;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER inbox_messages_listening_sync AFTER UPDATE OF body, deleted_at ON inbox_messages
  FOR EACH ROW WHEN (OLD.body IS DISTINCT FROM NEW.body OR OLD.deleted_at IS DISTINCT FROM NEW.deleted_at)
  EXECUTE FUNCTION listening_sync_from_inbox();
