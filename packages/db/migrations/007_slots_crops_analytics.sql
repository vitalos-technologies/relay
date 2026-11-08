-- V1.1: reusable posting slots + queue reservations, native analytics snapshots.
-- Image crops need no new table: crop derivatives are cached in asset_derivatives with
-- variant = 'crop:<sha256(rect)>' (unique per asset, crop rect and transform_version).

-- ---------------------------------------------------------------- posting slots (SC-03)
-- A slot is an explicit wall-clock recurrence (ISO weekdays + HH:MM in an IANA zone) with a
-- destination set. It is NOT a recurring post: each queued post occupies exactly one occurrence.
CREATE TABLE posting_slots (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id   uuid NOT NULL,
  brand_id       uuid NOT NULL,
  label          text CHECK (label IS NULL OR length(label) <= 80),
  weekdays       smallint[] NOT NULL CHECK (cardinality(weekdays) BETWEEN 1 AND 7 AND weekdays <@ ARRAY[1,2,3,4,5,6,7]::smallint[]),
  local_time     text NOT NULL CHECK (local_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  timezone       text NOT NULL,
  connection_ids uuid[] NOT NULL CHECK (cardinality(connection_ids) BETWEEN 1 AND 50),
  active         boolean NOT NULL DEFAULT true,
  created_by     uuid REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  archived_at    timestamptz,
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, brand_id) REFERENCES brands(workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX posting_slots_brand_idx ON posting_slots(workspace_id, brand_id) WHERE archived_at IS NULL;

-- One live reservation per slot occurrence (the concurrency guard for "Add to queue").
-- A reservation is live while released_at IS NULL; it is lazily released when its schedule is no
-- longer live (cancelled/superseded/rejected) or when it was never attached to a schedule.
CREATE TABLE slot_reservations (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id   uuid NOT NULL,
  brand_id       uuid NOT NULL,
  slot_id        uuid NOT NULL,
  occurrence_at  timestamptz NOT NULL,
  local_time     text NOT NULL,               -- YYYY-MM-DDTHH:mm in the slot zone, as resolved
  utc_offset     text NOT NULL,               -- chosen offset (folds use the earlier instant)
  post_id        uuid NOT NULL,
  schedule_id    uuid,
  created_by     uuid REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  released_at    timestamptz,
  FOREIGN KEY (workspace_id, slot_id) REFERENCES posting_slots(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, post_id) REFERENCES posts(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, schedule_id) REFERENCES schedules(workspace_id, id) ON DELETE SET NULL (schedule_id)
);
CREATE UNIQUE INDEX slot_reservations_occurrence_uniq ON slot_reservations(slot_id, occurrence_at) WHERE released_at IS NULL;
CREATE INDEX slot_reservations_post_idx ON slot_reservations(post_id) WHERE released_at IS NULL;

-- ---------------------------------------------------------------- native analytics (spec §10, §17)
-- Raw provider metrics in provider-native terms. Never summed across networks. source='simulated'
-- only for mock_ destinations. Telegram has no snapshots (unsupported, shown as "Unavailable").
CREATE TABLE metric_snapshots (
  id                 bigserial PRIMARY KEY,
  workspace_id       uuid NOT NULL,
  brand_id           uuid NOT NULL,
  connection_id      uuid NOT NULL,
  delivery_id        uuid NOT NULL,
  provider           provider_kind NOT NULL,
  provider_object_id text NOT NULL,
  metric             text NOT NULL,           -- e.g. 'reach', 'post_media_view', 'impression_count'
  dimension          text,                    -- breakdown key, e.g. 'like' for post_reactions_by_type_total
  value              numeric NOT NULL,
  period             text NOT NULL,           -- provider period, e.g. 'lifetime'
  window_end         timestamptz,             -- provider end_time when reported
  observed_at        timestamptz NOT NULL DEFAULT now(),
  source             text NOT NULL CHECK (source IN ('provider','simulated')),
  FOREIGN KEY (workspace_id, delivery_id) REFERENCES deliveries(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, connection_id) REFERENCES connections(workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX metric_snapshots_delivery_idx ON metric_snapshots(delivery_id, metric, observed_at DESC);
CREATE INDEX metric_snapshots_ws_idx ON metric_snapshots(workspace_id, observed_at DESC);

-- Per-delivery refresh bookkeeping: throttling of on-demand refreshes and the last outcome.
CREATE TABLE metric_fetch_state (
  delivery_id        uuid PRIMARY KEY,
  workspace_id       uuid NOT NULL,
  last_requested_at  timestamptz,             -- on-demand throttle anchor
  last_attempt_at    timestamptz,
  last_success_at    timestamptz,
  status             text NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending','ok','unsupported','unavailable','permission_missing','budget_exhausted','reconnect','error')),
  message            text,
  FOREIGN KEY (workspace_id, delivery_id) REFERENCES deliveries(workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX metric_fetch_state_attempt_idx ON metric_fetch_state(last_attempt_at);
