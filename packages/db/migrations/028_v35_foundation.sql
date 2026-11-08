-- V3.5 foundation (stream FOUNDATION; brief docs/queue/03f_V3_5_PROMPT.md §3, §10–13, §19). Additive only.
-- 1. Shared connector + event infrastructure: integration installations (credentials stay in the existing `credentials`
--    vault), explicit resource selection, field mappings with the synchronization contract, external links, verified
--    inbound events, durable outbound sync jobs, activity history and cursors.
-- 2. Unified inbox: channels, provider identities (kept apart from internal customers), conversations, messages +
--    revisions, internal notes (separate table: never part of any outbound path), drafts, reply attempts (send-once),
--    content-free events, presence, saved replies and views.
-- 3. Customer care: SLA policies, cases, append-only case events.
-- Rollback: DROP the tables below (nothing earlier references them) and restore the two widened CHECK constraints.
-- Streams B–F use 029–033 (docs/V3_5_WORKSTREAMS.md).

-- ------------------------------------------------------------------ widened checks
ALTER TABLE scoped_role_grants DROP CONSTRAINT IF EXISTS scoped_role_grants_role_check;
ALTER TABLE scoped_role_grants ADD CONSTRAINT scoped_role_grants_role_check CHECK (role IN (
  'owner','admin','team_manager','brand_manager','editor','approver','publisher','analyst','viewer','exporter','guest','integration','care_agent'));

ALTER TABLE workload_samples DROP CONSTRAINT IF EXISTS workload_samples_workload_class_check;
ALTER TABLE workload_samples ADD CONSTRAINT workload_samples_workload_class_check CHECK (workload_class IN (
  'publishing','connection_health','interactive_import','analytics_refresh','historical_backfill','video','report_export','notifications',
  'customer_reply','inbox_ingest','integration_sync','listening_ingest','ai_assist'));

-- ------------------------------------------------------------------ integrations
CREATE TABLE integration_connections (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  brand_id            uuid REFERENCES brands(id) ON DELETE CASCADE,          -- NULL = workspace scope
  connector           text NOT NULL CHECK (connector IN ('asana','monday','hubspot','google_business_profile','google_translate','slack','mailchimp','whatsapp')),
  external_account_id text NOT NULL,
  display_name        text NOT NULL,
  status              text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','needs_attention','reconnect_required','paused','disconnected')),
  is_simulated        boolean NOT NULL DEFAULT false,
  credential_id       uuid REFERENCES credentials(id) ON DELETE SET NULL,
  granted_scopes      text[] NOT NULL DEFAULT '{}',
  missing_scopes      text[] NOT NULL DEFAULT '{}',
  settings            jsonb NOT NULL DEFAULT '{}'::jsonb,                     -- non-secret configuration only
  health_message      text,
  health_checked_at   timestamptz,
  last_success_at     timestamptz,
  last_error_at       timestamptz,
  last_error_code     text,
  rate_limit          jsonb,                                                 -- only what the provider reported
  paused              boolean NOT NULL DEFAULT false,
  paused_reason       text,
  created_by          uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  disconnected_at     timestamptz,
  CHECK (NOT is_simulated OR external_account_id LIKE 'mock\_%')
);
CREATE UNIQUE INDEX integration_connections_active_uniq ON integration_connections(
  workspace_id, connector, external_account_id, coalesce(brand_id, '00000000-0000-0000-0000-000000000000'::uuid)) WHERE disconnected_at IS NULL;
CREATE INDEX integration_connections_ws_idx ON integration_connections(workspace_id, connector) WHERE disconnected_at IS NULL;

CREATE TABLE integration_resources (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id   uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  integration_id uuid NOT NULL REFERENCES integration_connections(id) ON DELETE CASCADE,
  resource_type  text NOT NULL,       -- project | board | pipeline | location | channel | audience | glossary | phone_number
  external_id    text NOT NULL,
  name           text NOT NULL,
  url            text,
  selected       boolean NOT NULL DEFAULT true,
  access_state   text NOT NULL DEFAULT 'ok' CHECK (access_state IN ('ok','unavailable')),
  metadata       jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (integration_id, resource_type, external_id)
);

CREATE TABLE integration_field_mappings (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  integration_id  uuid NOT NULL REFERENCES integration_connections(id) ON DELETE CASCADE,
  resource_id     uuid REFERENCES integration_resources(id) ON DELETE CASCADE,
  relay_object    text NOT NULL,
  relay_field     text NOT NULL,
  external_field  text NOT NULL,
  source_of_truth text NOT NULL CHECK (source_of_truth IN ('relay','external')),
  direction       text NOT NULL DEFAULT 'relay_to_external' CHECK (direction IN ('relay_to_external','external_to_relay','two_way')),
  conflict        text NOT NULL DEFAULT 'manual_review' CHECK (conflict IN ('source_wins','manual_review','skip')),
  on_delete       text NOT NULL DEFAULT 'mark_unavailable' CHECK (on_delete IN ('unlink','mark_unavailable','archive_relay','ignore')),
  on_revoke       text NOT NULL DEFAULT 'mark_unavailable' CHECK (on_revoke IN ('mark_unavailable','pause')),
  protected       boolean NOT NULL DEFAULT false,
  enabled         boolean NOT NULL DEFAULT true,
  version         integer NOT NULL DEFAULT 1,
  created_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  -- Ownership, approval, consent and customer-sensitive fields never sync two-way (brief §3).
  CHECK (NOT (protected AND direction = 'two_way'))
);
CREATE UNIQUE INDEX integration_field_mappings_uniq ON integration_field_mappings(
  integration_id, coalesce(resource_id, '00000000-0000-0000-0000-000000000000'::uuid), relay_object, relay_field, external_field);

CREATE TABLE external_links (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id          uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  brand_id              uuid REFERENCES brands(id) ON DELETE CASCADE,
  integration_id        uuid NOT NULL REFERENCES integration_connections(id) ON DELETE CASCADE,
  relay_type            text NOT NULL CHECK (relay_type IN ('post','campaign','conversation','case','contact','customer','review','listening_alert','insight')),
  relay_id              uuid NOT NULL,
  external_type         text NOT NULL,
  external_id           text NOT NULL,
  external_url          text,
  status                text NOT NULL DEFAULT 'linked' CHECK (status IN ('linked','unavailable','unlinked')),
  status_detail         text,
  last_synced_at        timestamptz,
  last_external_version text,
  last_relay_version    text,
  created_by            uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  unlinked_at           timestamptz,
  unlinked_by           uuid REFERENCES users(id) ON DELETE SET NULL
);
-- One live link per external record, and one external record of a type per Relay object (no duplicate tickets/tasks).
CREATE UNIQUE INDEX external_links_external_uniq ON external_links(integration_id, external_type, external_id) WHERE status <> 'unlinked';
CREATE UNIQUE INDEX external_links_relay_uniq ON external_links(integration_id, relay_type, relay_id, external_type) WHERE status <> 'unlinked';
CREATE INDEX external_links_relay_idx ON external_links(workspace_id, relay_type, relay_id);

-- Verified inbound events (generic webhook ingress). Unverified requests are never stored.
CREATE TABLE integration_events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connector       text NOT NULL,
  dedupe_key      text NOT NULL,
  workspace_id    uuid REFERENCES workspaces(id) ON DELETE CASCADE,
  integration_id  uuid REFERENCES integration_connections(id) ON DELETE CASCADE,
  external_account_id text,
  event_type      text NOT NULL,
  origin          text NOT NULL DEFAULT 'external' CHECK (origin IN ('external','relay_echo')),
  state           text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','processing','processed','ignored','failed','dead')),
  attempts        integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  occurred_at     timestamptz,
  received_at     timestamptz NOT NULL DEFAULT now(),
  processed_at    timestamptz,
  last_error      text,
  summary         jsonb NOT NULL DEFAULT '{}'::jsonb,   -- content-free
  body            jsonb,                               -- raw verified body; erased after 7 days (worker retention)
  UNIQUE (connector, dedupe_key)
);
CREATE INDEX integration_events_pending_idx ON integration_events(next_attempt_at) WHERE state IN ('pending','failed');
CREATE INDEX integration_events_ws_idx ON integration_events(workspace_id, received_at DESC);

CREATE TABLE integration_sync_jobs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id     uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  integration_id   uuid NOT NULL REFERENCES integration_connections(id) ON DELETE CASCADE,
  kind             text NOT NULL,
  relay_type       text NOT NULL,
  relay_id         uuid NOT NULL,
  idempotency_key  text NOT NULL,
  payload          jsonb NOT NULL DEFAULT '{}'::jsonb,
  state            text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','running','waiting_retry','succeeded','failed','unknown','cancelled')),
  attempts         integer NOT NULL DEFAULT 0,
  next_attempt_at  timestamptz NOT NULL DEFAULT now(),
  lease_owner      text,
  lease_expires_at timestamptz,
  external_id      text,
  external_url     text,
  result           jsonb,
  last_error_code  text,
  last_error       text,
  created_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  finished_at      timestamptz,
  UNIQUE (workspace_id, idempotency_key)
);
CREATE INDEX integration_sync_jobs_due_idx ON integration_sync_jobs(next_attempt_at) WHERE state IN ('queued','waiting_retry','unknown','running');
CREATE INDEX integration_sync_jobs_int_idx ON integration_sync_jobs(integration_id, created_at DESC);

-- Error / retry / rate-limit history (safe messages only; 30-day retention).
CREATE TABLE integration_activity (
  id             bigserial PRIMARY KEY,
  workspace_id   uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  integration_id uuid REFERENCES integration_connections(id) ON DELETE CASCADE,
  channel_id     uuid,
  kind           text NOT NULL CHECK (kind IN ('sync','health','webhook','auth','rate_limit')),
  outcome        text NOT NULL CHECK (outcome IN ('ok','error','retry','throttled')),
  code           text,
  message        text,
  http_status    integer,
  job_id         uuid,
  at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX integration_activity_int_idx ON integration_activity(integration_id, at DESC);
CREATE INDEX integration_activity_ws_idx ON integration_activity(workspace_id, at DESC);

-- ------------------------------------------------------------------ inbox
CREATE TABLE inbox_channels (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  brand_id            uuid NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  kind                text NOT NULL CHECK (kind IN ('facebook_page','instagram','telegram_bot','whatsapp','google_business_profile','x','youtube','linkedin','threads','bluesky','tiktok')),
  connection_id       uuid REFERENCES connections(id) ON DELETE SET NULL,
  integration_id      uuid REFERENCES integration_connections(id) ON DELETE SET NULL,
  external_account_id text NOT NULL,
  display_name        text NOT NULL,
  is_simulated        boolean NOT NULL DEFAULT false,
  status              text NOT NULL DEFAULT 'active' CHECK (status IN ('active','needs_permission','paused','disconnected','error')),
  status_detail       text,
  missing_permissions text[] NOT NULL DEFAULT '{}',
  enabled_types       text[] NOT NULL DEFAULT '{dm,comment}',
  last_inbound_at     timestamptz,
  last_sync_at        timestamptz,
  created_by          uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  disconnected_at     timestamptz,
  CHECK (connection_id IS NOT NULL OR integration_id IS NOT NULL OR disconnected_at IS NOT NULL)
);
CREATE UNIQUE INDEX inbox_channels_active_uniq ON inbox_channels(workspace_id, kind, external_account_id) WHERE disconnected_at IS NULL;
CREATE INDEX inbox_channels_account_idx ON inbox_channels(kind, external_account_id) WHERE disconnected_at IS NULL;

-- Internal customers (Relay's own records). Provider identities (inbox_contacts) link to them only through an explicit,
-- reversible, audited link (never by matching names or handles).
CREATE TABLE inbox_customers (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  brand_id     uuid REFERENCES brands(id) ON DELETE CASCADE,
  display_name text NOT NULL,
  created_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  merged_into  uuid REFERENCES inbox_customers(id) ON DELETE SET NULL
);

CREATE TABLE inbox_contacts (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  channel_id   uuid NOT NULL REFERENCES inbox_channels(id) ON DELETE CASCADE,
  external_id  text NOT NULL,
  display_name text,
  handle       text,
  customer_id  uuid REFERENCES inbox_customers(id) ON DELETE SET NULL,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (channel_id, external_id)
);

CREATE TABLE inbox_identity_links (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  customer_id  uuid NOT NULL REFERENCES inbox_customers(id) ON DELETE CASCADE,
  contact_id   uuid NOT NULL REFERENCES inbox_contacts(id) ON DELETE CASCADE,
  method       text NOT NULL CHECK (method IN ('explicit_link','verified_identifier','merge')),
  reason       text,
  linked_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  linked_at    timestamptz NOT NULL DEFAULT now(),
  unlinked_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  unlinked_at  timestamptz
);
CREATE UNIQUE INDEX inbox_identity_links_live_uniq ON inbox_identity_links(contact_id) WHERE unlinked_at IS NULL;

-- ------------------------------------------------------------------ care (cases referenced by conversations)
CREATE TABLE care_sla_policies (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id           uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  brand_id               uuid REFERENCES brands(id) ON DELETE CASCADE,
  name                   text NOT NULL,
  timezone               text NOT NULL DEFAULT 'UTC',
  business_hours         jsonb,                     -- NULL = 24/7; else [{day,start,end}]
  holidays               date[] NOT NULL DEFAULT '{}',
  first_response_minutes integer CHECK (first_response_minutes IS NULL OR first_response_minutes > 0),
  resolution_minutes     integer CHECK (resolution_minutes IS NULL OR resolution_minutes > 0),
  count_automated        boolean NOT NULL DEFAULT false,
  is_default             boolean NOT NULL DEFAULT false,
  created_by             uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  archived_at            timestamptz
);
CREATE UNIQUE INDEX care_sla_policies_default_uniq ON care_sla_policies(workspace_id, coalesce(brand_id, '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE is_default AND archived_at IS NULL;

CREATE SEQUENCE care_case_number_seq;
CREATE TABLE care_cases (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number                   bigint NOT NULL DEFAULT nextval('care_case_number_seq'),
  workspace_id             uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  brand_id                 uuid NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  title                    text NOT NULL,
  category                 text,
  priority                 text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high','urgent')),
  state                    text NOT NULL DEFAULT 'open' CHECK (state IN ('open','waiting','resolved','reopened')),
  owner_id                 uuid REFERENCES users(id) ON DELETE SET NULL,
  team_id                  uuid REFERENCES teams(id) ON DELETE SET NULL,
  sla_policy_id            uuid REFERENCES care_sla_policies(id) ON DELETE SET NULL,
  opened_at                timestamptz NOT NULL DEFAULT now(),
  clock_started_at         timestamptz NOT NULL DEFAULT now(),
  paused_since             timestamptz,
  paused_business_ms       bigint NOT NULL DEFAULT 0,
  first_response_due_at    timestamptz,
  first_responded_at       timestamptz,
  resolution_due_at        timestamptz,
  resolved_at              timestamptz,
  resolution_reason        text,
  reopened_count           integer NOT NULL DEFAULT 0,
  first_response_breached_at timestamptz,
  resolution_breached_at   timestamptz,
  escalated_at             timestamptz,
  version                  integer NOT NULL DEFAULT 1,
  created_by               uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, number)
);
CREATE INDEX care_cases_ws_state_idx ON care_cases(workspace_id, state, opened_at DESC);
CREATE INDEX care_cases_due_idx ON care_cases(first_response_due_at) WHERE first_responded_at IS NULL AND first_response_breached_at IS NULL AND state <> 'resolved';
CREATE INDEX care_cases_res_due_idx ON care_cases(resolution_due_at) WHERE resolved_at IS NULL AND resolution_breached_at IS NULL;

CREATE TABLE care_case_events (
  id           bigserial PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  case_id      uuid NOT NULL REFERENCES care_cases(id) ON DELETE CASCADE,
  kind         text NOT NULL CHECK (kind IN ('created','state_changed','owner_changed','priority_changed','conversation_linked','conversation_unlinked',
                                             'clock_started','paused','resumed','first_response','resolved','reopened',
                                             'first_response_breached','resolution_breached','escalated','external_linked')),
  actor_id     uuid REFERENCES users(id) ON DELETE SET NULL,
  data         jsonb NOT NULL DEFAULT '{}'::jsonb,   -- content-free
  at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX care_case_events_case_idx ON care_case_events(case_id, id);

-- ------------------------------------------------------------------ conversations + messages
CREATE TABLE inbox_conversations (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id            uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  brand_id                uuid NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  channel_id              uuid NOT NULL REFERENCES inbox_channels(id) ON DELETE CASCADE,
  kind                    text NOT NULL CHECK (kind IN ('dm','comment','mention','review')),
  visibility              text NOT NULL CHECK (visibility IN ('private','public')),
  external_thread_id      text NOT NULL,
  contact_id              uuid REFERENCES inbox_contacts(id) ON DELETE SET NULL,
  subject                 text,
  preview                 text NOT NULL DEFAULT '',
  status                  text NOT NULL DEFAULT 'open' CHECK (status IN ('open','waiting','snoozed','resolved','spam')),
  priority                text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high','urgent')),
  language                text,
  labels                  text[] NOT NULL DEFAULT '{}',
  assignee_id             uuid REFERENCES users(id) ON DELETE SET NULL,
  team_id                 uuid REFERENCES teams(id) ON DELETE SET NULL,
  snoozed_until           timestamptz,
  version                 integer NOT NULL DEFAULT 1,
  first_inbound_at        timestamptz,
  last_message_at         timestamptz NOT NULL DEFAULT now(),
  last_inbound_at         timestamptz,
  last_outbound_at        timestamptz,
  unanswered_since        timestamptz,
  private_reply_used      boolean NOT NULL DEFAULT false,
  related_external_post_id text,
  related_post_id         uuid REFERENCES posts(id) ON DELETE SET NULL,
  case_id                 uuid REFERENCES care_cases(id) ON DELETE SET NULL,
  is_simulated            boolean NOT NULL DEFAULT false,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  resolved_at             timestamptz,
  UNIQUE (channel_id, kind, external_thread_id)
);
CREATE INDEX inbox_conv_ws_status_idx ON inbox_conversations(workspace_id, status, last_message_at DESC, id DESC);
CREATE INDEX inbox_conv_assignee_idx ON inbox_conversations(workspace_id, assignee_id, status, last_message_at DESC);
CREATE INDEX inbox_conv_brand_idx ON inbox_conversations(workspace_id, brand_id, status, last_message_at DESC);
CREATE INDEX inbox_conv_case_idx ON inbox_conversations(case_id) WHERE case_id IS NOT NULL;
CREATE INDEX inbox_conv_snooze_idx ON inbox_conversations(snoozed_until) WHERE status = 'snoozed';

CREATE TABLE inbox_reply_attempts (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  brand_id            uuid NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  conversation_id     uuid NOT NULL REFERENCES inbox_conversations(id) ON DELETE CASCADE,
  channel_id          uuid NOT NULL REFERENCES inbox_channels(id) ON DELETE CASCADE,
  mode                text NOT NULL CHECK (mode IN ('public_reply','private_message')),
  body                text NOT NULL,                     -- the exact text sent (revision recorded below)
  body_sha256         text NOT NULL,
  revision            integer NOT NULL DEFAULT 1,
  base_version        integer NOT NULL,
  idempotency_key     text NOT NULL,
  reply_to_external_id text,
  state               text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','sending','sent','failed','unknown','cancelled')),
  attempts            integer NOT NULL DEFAULT 0,
  next_attempt_at     timestamptz NOT NULL DEFAULT now(),
  lease_owner         text,
  lease_expires_at    timestamptz,
  provider_message_id text,
  provider_result     jsonb,                              -- safe fields only (id, http status, code, our message)
  error_code          text,
  error_message       text,
  reconcile_after     timestamptz,
  reconciled_at       timestamptz,
  resolved_by         uuid REFERENCES users(id) ON DELETE SET NULL,   -- person who settled an Unknown outcome
  automated           boolean NOT NULL DEFAULT false,
  is_simulated        boolean NOT NULL DEFAULT false,
  created_by          uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  sent_at             timestamptz,
  finished_at         timestamptz,
  UNIQUE (workspace_id, idempotency_key)
);
CREATE INDEX inbox_reply_due_idx ON inbox_reply_attempts(next_attempt_at) WHERE state = 'queued';
CREATE INDEX inbox_reply_lease_idx ON inbox_reply_attempts(lease_expires_at) WHERE state = 'sending';
CREATE INDEX inbox_reply_unknown_idx ON inbox_reply_attempts(reconcile_after) WHERE state = 'unknown' AND reconciled_at IS NULL;
CREATE INDEX inbox_reply_conv_idx ON inbox_reply_attempts(conversation_id, created_at);
-- At most one in-flight send per conversation (a second agent's send is refused, not queued behind it).
CREATE UNIQUE INDEX inbox_reply_inflight_uniq ON inbox_reply_attempts(conversation_id) WHERE state IN ('queued','sending');

CREATE TABLE inbox_messages (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id       uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  conversation_id    uuid NOT NULL REFERENCES inbox_conversations(id) ON DELETE CASCADE,
  channel_id         uuid NOT NULL REFERENCES inbox_channels(id) ON DELETE CASCADE,
  direction          text NOT NULL CHECK (direction IN ('inbound','outbound')),
  external_id        text,
  parent_external_id text,
  author_contact_id  uuid REFERENCES inbox_contacts(id) ON DELETE SET NULL,
  author_user_id     uuid REFERENCES users(id) ON DELETE SET NULL,
  body               text,                               -- NULL after provider deletion or retention erasure
  revision           integer NOT NULL DEFAULT 1,
  attachments        jsonb NOT NULL DEFAULT '[]'::jsonb, -- metadata only; nothing is fetched automatically
  provider_created_at timestamptz NOT NULL,
  received_at        timestamptz NOT NULL DEFAULT now(),
  edited_at          timestamptz,
  deleted_at         timestamptz,
  automated          boolean NOT NULL DEFAULT false,
  reply_attempt_id   uuid REFERENCES inbox_reply_attempts(id) ON DELETE SET NULL,
  delivery_state     text CHECK (delivery_state IN ('sent','delivered','read')),
  conv_version       integer,                            -- conversation version this message produced (collision details)
  is_simulated       boolean NOT NULL DEFAULT false
);
CREATE UNIQUE INDEX inbox_messages_ext_uniq ON inbox_messages(channel_id, external_id) WHERE external_id IS NOT NULL;
CREATE INDEX inbox_messages_conv_idx ON inbox_messages(conversation_id, provider_created_at, id);

CREATE TABLE inbox_message_revisions (
  id           bigserial PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  message_id   uuid NOT NULL REFERENCES inbox_messages(id) ON DELETE CASCADE,
  revision     integer NOT NULL,
  body         text,
  recorded_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (message_id, revision)
);

-- Internal notes: a separate table on purpose. No outbound code path reads it (brief §11, acceptance test 3).
CREATE TABLE inbox_notes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES inbox_conversations(id) ON DELETE CASCADE,
  author_id       uuid REFERENCES users(id) ON DELETE SET NULL,
  body            text NOT NULL,
  mentions        uuid[] NOT NULL DEFAULT '{}',
  created_at      timestamptz NOT NULL DEFAULT now(),
  edited_at       timestamptz,
  deleted_at      timestamptz
);
CREATE INDEX inbox_notes_conv_idx ON inbox_notes(conversation_id, created_at);

CREATE TABLE inbox_drafts (
  workspace_id    uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES inbox_conversations(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mode            text NOT NULL CHECK (mode IN ('public_reply','private_message')),
  body            text NOT NULL DEFAULT '',
  base_version    integer NOT NULL,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (conversation_id, user_id)
);

-- Content-free activity + realtime feed (ids and kinds only).
CREATE TABLE inbox_events (
  id              bigserial PRIMARY KEY,
  workspace_id    uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  conversation_id uuid REFERENCES inbox_conversations(id) ON DELETE CASCADE,
  brand_id        uuid,
  kind            text NOT NULL,
  actor_id        uuid REFERENCES users(id) ON DELETE SET NULL,
  data            jsonb NOT NULL DEFAULT '{}'::jsonb,
  at              timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX inbox_events_ws_idx ON inbox_events(workspace_id, id);
CREATE INDEX inbox_events_conv_idx ON inbox_events(conversation_id, id);

CREATE TABLE inbox_presence (
  conversation_id uuid NOT NULL REFERENCES inbox_conversations(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id    uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  state           text NOT NULL CHECK (state IN ('viewing','composing')),
  seen_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (conversation_id, user_id)
);

CREATE TABLE inbox_saved_replies (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  brand_id     uuid REFERENCES brands(id) ON DELETE CASCADE,
  title        text NOT NULL,
  body         text NOT NULL,
  created_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  archived_at  timestamptz
);
CREATE INDEX inbox_saved_replies_ws_idx ON inbox_saved_replies(workspace_id) WHERE archived_at IS NULL;

CREATE TABLE inbox_saved_views (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         text NOT NULL,
  filters      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- Cursors for polling / reconciliation (one of integration or channel).
CREATE TABLE integration_cursors (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  integration_id  uuid REFERENCES integration_connections(id) ON DELETE CASCADE,
  channel_id      uuid REFERENCES inbox_channels(id) ON DELETE CASCADE,
  scope           text NOT NULL,
  cursor          text,
  checkpoint_at   timestamptz,
  last_run_at     timestamptz,
  last_success_at timestamptz,
  last_error      text,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CHECK ((integration_id IS NULL) <> (channel_id IS NULL))
);
CREATE UNIQUE INDEX integration_cursors_uniq ON integration_cursors(coalesce(integration_id, channel_id), scope);
