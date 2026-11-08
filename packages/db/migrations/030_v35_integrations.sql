-- V3.5 stream C — seven business integrations (brief docs/queue/03f_V3_5_PROMPT.md §3–9). Additive only.
-- Builds on 028 (integration_connections, integration_resources, field mappings, external_links, events, sync jobs).
--  1. Simulated provider store for mock_ installations (business connectors only; never used by live installations).
--  2. External work items (Asana tasks / monday.com items) linked to posts, campaigns, conversations and cases, with
--     explicit two-way fields and loop prevention (pushed-state hash + origin marker).
--  3. External record snapshots (status shown in Relay: task status, HubSpot ticket stage, Mailchimp campaign report).
--  4. Google Business Profile local posts that ride on an approved Relay schedule (scheduling + approval services).
--  5. Slack: explicit Slack-user ↔ Relay-user links, alert routes (channel, categories, brands, quiet hours, rate),
--     delivery history (deduplicated) and server-side bindings for interactive approval buttons (exact revision).
--  6. Cloud Translation: workspace control (off until an admin enables it) and translation records (originals kept).
-- Rollback: DROP the tables below (nothing earlier references them).

-- ------------------------------------------------------------------ 1. simulated provider store
CREATE TABLE integration_sim_objects (
  connector   text NOT NULL,
  account_id  text NOT NULL CHECK (account_id LIKE 'mock\_%'),
  object_type text NOT NULL,
  object_id   text NOT NULL,
  data        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (connector, account_id, object_type, object_id)
);
CREATE TABLE integration_sim_counters (key text PRIMARY KEY, value integer NOT NULL DEFAULT 0);

-- ------------------------------------------------------------------ 2. external work items (Asana / monday.com)
CREATE TABLE integration_tasks (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id         uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  brand_id             uuid REFERENCES brands(id) ON DELETE CASCADE,
  integration_id       uuid NOT NULL REFERENCES integration_connections(id) ON DELETE CASCADE,
  connector            text NOT NULL CHECK (connector IN ('asana','monday')),
  relay_type           text NOT NULL CHECK (relay_type IN ('post','campaign','conversation','case','listening_alert','insight')),
  relay_id             uuid NOT NULL,
  resource_id          uuid REFERENCES integration_resources(id) ON DELETE SET NULL,   -- project / board (explicitly selected)
  external_id          text,
  external_url         text,
  title                text NOT NULL CHECK (length(title) BETWEEN 1 AND 255),
  description          text CHECK (description IS NULL OR length(description) <= 4000),  -- safe summary, never a whole conversation
  due_on               date,
  priority             text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high','urgent')),
  status               text NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','done')),
  external_status      text,                 -- provider's own label (e.g. monday status column text)
  external_assignee    text,                 -- display name only
  link_state           text NOT NULL DEFAULT 'pending' CHECK (link_state IN ('pending','linked','unavailable','unlinked','failed')),
  link_detail          text,
  relay_version        integer NOT NULL DEFAULT 1,      -- bumps on every Relay-side edit
  synced_relay_version integer NOT NULL DEFAULT 0,      -- last Relay version pushed successfully
  last_pushed_hash     text,                 -- hash of the mapped fields Relay last wrote (echo detection)
  last_pulled_hash     text,                 -- hash of the mapped fields last read from the provider
  external_modified_at timestamptz,
  last_pulled_at       timestamptz,
  conflict             jsonb,                -- manual-review conflicts (field → {relay, external})
  idempotency_key      text NOT NULL,
  created_by           uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, idempotency_key)
);
CREATE UNIQUE INDEX integration_tasks_external_uniq ON integration_tasks(integration_id, external_id) WHERE external_id IS NOT NULL AND link_state <> 'unlinked';
CREATE INDEX integration_tasks_relay_idx ON integration_tasks(workspace_id, relay_type, relay_id);

-- ------------------------------------------------------------------ 3. external record snapshots
CREATE TABLE external_link_snapshots (
  link_id      uuid PRIMARY KEY REFERENCES external_links(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  data         jsonb NOT NULL DEFAULT '{}'::jsonb,   -- permitted, minimal fields only (no customer PII beyond what is shown)
  fetched_at   timestamptz NOT NULL DEFAULT now(),
  fetch_error  text
);

-- ------------------------------------------------------------------ 4. Google Business Profile local posts
CREATE TABLE gbp_local_posts (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id         uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  brand_id             uuid NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  integration_id       uuid NOT NULL REFERENCES integration_connections(id) ON DELETE CASCADE,
  location_resource_id uuid NOT NULL REFERENCES integration_resources(id) ON DELETE CASCADE,
  post_id              uuid NOT NULL,
  schedule_id          uuid NOT NULL,
  revision_id          uuid NOT NULL,
  schedule_fingerprint text NOT NULL,        -- the exact scheduled/approved version this request is bound to
  summary              text NOT NULL CHECK (length(summary) BETWEEN 1 AND 1500),
  call_to_action       jsonb,
  topic_type           text NOT NULL DEFAULT 'STANDARD' CHECK (topic_type IN ('STANDARD')),
  state                text NOT NULL DEFAULT 'waiting_approval' CHECK (state IN ('waiting_approval','scheduled','publishing','live','processing','rejected','failed','needs_review','cancelled','unknown')),
  state_detail         text,
  due_at               timestamptz NOT NULL,
  sync_job_id          uuid REFERENCES integration_sync_jobs(id) ON DELETE SET NULL,
  external_name        text,                 -- accounts/{a}/locations/{l}/localPosts/{p}
  external_url         text,
  created_by           uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, post_id) REFERENCES posts(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, schedule_id) REFERENCES schedules(workspace_id, id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX gbp_local_posts_uniq ON gbp_local_posts(schedule_id, location_resource_id) WHERE state <> 'cancelled';
CREATE INDEX gbp_local_posts_due_idx ON gbp_local_posts(due_at) WHERE state IN ('waiting_approval','scheduled');

-- ------------------------------------------------------------------ 5. Slack
-- Explicit link made by the Relay user (signed in) for the Slack identity that clicked (verified request). Never by name/email.
CREATE TABLE slack_user_links (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id   uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  integration_id uuid NOT NULL REFERENCES integration_connections(id) ON DELETE CASCADE,
  slack_team_id  text NOT NULL,
  slack_user_id  text NOT NULL,
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  linked_at      timestamptz NOT NULL DEFAULT now(),
  unlinked_at    timestamptz,
  unlinked_by    uuid REFERENCES users(id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX slack_user_links_live_uniq ON slack_user_links(integration_id, slack_user_id) WHERE unlinked_at IS NULL;
CREATE UNIQUE INDEX slack_user_links_user_uniq ON slack_user_links(integration_id, user_id) WHERE unlinked_at IS NULL;

CREATE TABLE slack_link_tokens (
  token_hash     bytea PRIMARY KEY,
  workspace_id   uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  integration_id uuid NOT NULL REFERENCES integration_connections(id) ON DELETE CASCADE,
  slack_team_id  text NOT NULL,
  slack_user_id  text NOT NULL,
  expires_at     timestamptz NOT NULL,
  consumed_at    timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE slack_alert_routes (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id   uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  integration_id uuid NOT NULL REFERENCES integration_connections(id) ON DELETE CASCADE,
  resource_id    uuid NOT NULL REFERENCES integration_resources(id) ON DELETE CASCADE,   -- the selected channel
  categories     text[] NOT NULL DEFAULT '{}' CHECK (categories <@ ARRAY['approvals','assignments','connection_alerts','delivery_alerts','care_escalations','listening_alerts','summaries']::text[]),
  brand_ids      uuid[],                     -- NULL = all brands the route creator can see at delivery time
  quiet_start    time,
  quiet_end      time,
  timezone       text NOT NULL DEFAULT 'UTC',
  max_per_hour   integer NOT NULL DEFAULT 20 CHECK (max_per_hour BETWEEN 1 AND 200),
  summary_time   time,                       -- daily summary (local time) when 'summaries' is selected
  enabled        boolean NOT NULL DEFAULT true,
  created_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (integration_id, resource_id)
);

CREATE TABLE slack_deliveries (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id   uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  integration_id uuid NOT NULL REFERENCES integration_connections(id) ON DELETE CASCADE,
  route_id       uuid NOT NULL REFERENCES slack_alert_routes(id) ON DELETE CASCADE,
  event_key      text NOT NULL,              -- deduplication: one Slack message per route per event
  category       text NOT NULL,
  brand_id       uuid,
  reference_type text,
  reference_id   text,
  text           text NOT NULL CHECK (length(text) <= 500),   -- minimal, no customer message content
  link_path      text CHECK (link_path IS NULL OR link_path ~ '^/[A-Za-z0-9]'),
  state          text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','deferred','sending','sent','failed','suppressed','unknown')),
  state_detail   text,
  not_before     timestamptz NOT NULL DEFAULT now(),
  attempts       integer NOT NULL DEFAULT 0,
  message_ts     text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  sent_at        timestamptz,
  UNIQUE (route_id, event_key)
);
CREATE INDEX slack_deliveries_due_idx ON slack_deliveries(not_before) WHERE state IN ('queued','deferred');
CREATE INDEX slack_deliveries_int_idx ON slack_deliveries(integration_id, created_at DESC);

-- Interactive buttons carry only this id; the binding (approval + exact revision + fingerprint) stays server-side.
CREATE TABLE slack_actions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id   uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  integration_id uuid NOT NULL REFERENCES integration_connections(id) ON DELETE CASCADE,
  delivery_id    uuid REFERENCES slack_deliveries(id) ON DELETE CASCADE,
  kind           text NOT NULL CHECK (kind IN ('approval')),
  approval_id    uuid NOT NULL,
  revision_id    uuid NOT NULL,
  fingerprint    text NOT NULL,
  expires_at     timestamptz NOT NULL,
  used_at        timestamptz,
  used_by        uuid REFERENCES users(id) ON DELETE SET NULL,
  outcome        text,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------------ 6. Cloud Translation
CREATE TABLE translation_settings (
  workspace_id           uuid PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  enabled                boolean NOT NULL DEFAULT false,
  allow_customer_content boolean NOT NULL DEFAULT false,   -- inbox messages / reply drafts may be sent to the provider
  monthly_char_cap       integer NOT NULL DEFAULT 500000 CHECK (monthly_char_cap BETWEEN 1000 AND 100000000),
  glossary_id            text,
  billing_acknowledged_by uuid REFERENCES users(id) ON DELETE SET NULL,
  billing_acknowledged_at timestamptz,
  updated_by             uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at             timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE translations (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id         uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  brand_id             uuid REFERENCES brands(id) ON DELETE CASCADE,
  integration_id       uuid REFERENCES integration_connections(id) ON DELETE SET NULL,
  source_type          text NOT NULL CHECK (source_type IN ('inbox_message','reply_draft','post_variant','listening_result','text')),
  source_id            uuid,
  source_sha256        text NOT NULL,
  source_lang          text,                 -- given or detected by the provider
  detected             boolean NOT NULL DEFAULT false,
  target_lang          text NOT NULL,
  translated_text      text NOT NULL,        -- the original is never modified
  glossary_id          text,
  characters           integer NOT NULL CHECK (characters >= 0),
  cost_estimate_micros bigint NOT NULL DEFAULT 0, -- USD micros at the configured list price (estimate, not an invoice)
  is_simulated         boolean NOT NULL DEFAULT false,
  created_by           uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX translations_source_idx ON translations(workspace_id, source_type, source_id, target_lang, source_sha256);
CREATE INDEX translations_month_idx ON translations(workspace_id, created_at);
