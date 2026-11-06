-- Social Lite core schema.
-- Invariants:
--  * Every tenant-owned row carries workspace_id; brand-owned rows also carry brand_id.
--  * Cross-tenant relationships are prevented by composite foreign keys (workspace_id, id).
--  * Revisions and variants are immutable once written (trigger-enforced).
--  * One delivery per (schedule, variant); one schedule per (post, generation).
--  * Provider IDs are text; all timestamps are timestamptz (UTC instants).

CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------- identity
CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  oidc_issuer   text NOT NULL,
  oidc_subject  text NOT NULL,
  email         citext NOT NULL UNIQUE,
  email_verified boolean NOT NULL DEFAULT false,
  name          text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz,
  disabled_at   timestamptz,
  UNIQUE (oidc_issuer, oidc_subject)
);

CREATE TABLE sessions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash    bytea NOT NULL UNIQUE,          -- sha256 of the opaque cookie token
  csrf_token    text NOT NULL,                  -- double-submit token, bound to session
  active_workspace_id uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  revoked_at    timestamptz,
  user_agent    text,
  ip            inet
);
CREATE INDEX sessions_user_idx ON sessions(user_id);

-- Single-use, expiring OAuth/OIDC state (AC-01). Bound to initiating user/workspace/brand.
CREATE TABLE oauth_states (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  state_hash    bytea NOT NULL UNIQUE,
  purpose       text NOT NULL CHECK (purpose IN ('login','connect')),
  provider      text NOT NULL,
  user_id       uuid REFERENCES users(id) ON DELETE CASCADE,
  workspace_id  uuid,
  brand_id      uuid,
  code_verifier_enc jsonb,                      -- encrypted PKCE verifier
  nonce         text,
  redirect_after text,
  invitation_token_hash bytea,
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  consumed_at   timestamptz
);

-- ---------------------------------------------------------------- tenancy
CREATE TABLE workspaces (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name               text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  timezone           text NOT NULL DEFAULT 'Europe/London',
  state              text NOT NULL DEFAULT 'active' CHECK (state IN ('active','suspended')),
  is_demo            boolean NOT NULL DEFAULT false,
  publishing_paused  boolean NOT NULL DEFAULT false,
  paused_reason      text,
  paused_by          uuid REFERENCES users(id),
  paused_at          timestamptz,
  limits             jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TYPE member_role AS ENUM ('owner','admin','editor','approver','viewer');

CREATE TABLE memberships (
  workspace_id   uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role           member_role NOT NULL,
  brand_restricted boolean NOT NULL DEFAULT false,
  created_at     timestamptz NOT NULL DEFAULT now(),
  removed_at     timestamptz,
  removed_by     uuid REFERENCES users(id),
  PRIMARY KEY (workspace_id, user_id)
);
CREATE INDEX memberships_user_idx ON memberships(user_id) WHERE removed_at IS NULL;

CREATE TABLE brands (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name                text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  timezone            text NOT NULL DEFAULT 'Europe/London',
  approval_required   boolean NOT NULL DEFAULT false,
  editors_can_publish boolean NOT NULL DEFAULT false,
  default_deadline_minutes integer NOT NULL DEFAULT 15 CHECK (default_deadline_minutes BETWEEN 1 AND 10080),
  publishing_paused   boolean NOT NULL DEFAULT false,
  paused_reason       text,
  paused_by           uuid REFERENCES users(id),
  paused_at           timestamptz,
  voice               jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_demo             boolean NOT NULL DEFAULT false,
  created_at          timestamptz NOT NULL DEFAULT now(),
  archived_at         timestamptz,
  UNIQUE (workspace_id, id)
);

CREATE TABLE membership_brand_grants (
  workspace_id uuid NOT NULL,
  user_id      uuid NOT NULL,
  brand_id     uuid NOT NULL,
  PRIMARY KEY (workspace_id, user_id, brand_id),
  FOREIGN KEY (workspace_id, user_id) REFERENCES memberships(workspace_id, user_id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, brand_id) REFERENCES brands(workspace_id, id) ON DELETE CASCADE
);

CREATE TABLE invitations (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  email        citext NOT NULL,
  role         member_role NOT NULL CHECK (role <> 'owner'),
  brand_ids    uuid[] NOT NULL DEFAULT '{}',
  token_hash   bytea NOT NULL UNIQUE,
  invited_by   uuid NOT NULL REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  accepted_at  timestamptz,
  accepted_by  uuid REFERENCES users(id),
  revoked_at   timestamptz
);
CREATE UNIQUE INDEX invitations_open_uniq ON invitations(workspace_id, email)
  WHERE accepted_at IS NULL AND revoked_at IS NULL;

-- ---------------------------------------------------------------- credentials & connections
-- Envelope-encrypted secrets. The data key is wrapped by a key-encryption key held
-- outside the database (KEY_ENCRYPTION_KEYS env / KMS). Never selected by UI queries.
CREATE TABLE credentials (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id     uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  encrypted_blob   jsonb NOT NULL,         -- {v, kid, wrappedKey, iv, tag, ct}
  key_version      text NOT NULL,
  expires_at       timestamptz,
  refresh_expires_at timestamptz,
  granted_scopes   text[] NOT NULL DEFAULT '{}',
  refresh_version  integer NOT NULL DEFAULT 0,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id)
);

CREATE TYPE provider_kind AS ENUM ('instagram','facebook','telegram','x');
CREATE TYPE connection_status AS ENUM (
  'pending_verification','ready','missing_permission','expiring','reconnect_required','paused','disconnected');

CREATE TABLE connections (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id         uuid NOT NULL,
  brand_id             uuid NOT NULL,
  provider             provider_kind NOT NULL,
  provider_account_id  text NOT NULL,          -- numeric IDs kept as strings
  display_name         text NOT NULL,
  username             text,
  status               connection_status NOT NULL DEFAULT 'pending_verification',
  is_mock              boolean NOT NULL DEFAULT false,  -- simulated destination; never real transport
  credential_id        uuid,
  capabilities         jsonb NOT NULL DEFAULT '{}'::jsonb,
  health_detail        jsonb NOT NULL DEFAULT '{}'::jsonb,  -- safe, user-facing only
  health_checked_at    timestamptz,
  metadata             jsonb NOT NULL DEFAULT '{}'::jsonb,  -- non-secret provider metadata
  throttled_until      timestamptz,
  paused               boolean NOT NULL DEFAULT false,
  created_by           uuid REFERENCES users(id),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  disconnected_at      timestamptz,
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, brand_id) REFERENCES brands(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, credential_id) REFERENCES credentials(workspace_id, id),
  CHECK (NOT is_mock OR provider_account_id LIKE 'mock\_%')
);
-- One active connection per provider identity per brand. Reuse in another brand is explicit.
CREATE UNIQUE INDEX connections_identity_uniq ON connections(brand_id, provider, provider_account_id)
  WHERE disconnected_at IS NULL;
CREATE INDEX connections_brand_idx ON connections(workspace_id, brand_id);

-- ---------------------------------------------------------------- media
CREATE TYPE asset_status AS ENUM ('pending_upload','quarantined','ready','rejected','archived');

CREATE TABLE assets (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id      uuid NOT NULL,
  brand_id          uuid NOT NULL,
  uploaded_by       uuid REFERENCES users(id),
  object_key        text NOT NULL UNIQUE,
  original_filename text,
  declared_mime     text,
  declared_bytes    bigint,
  mime              text,
  checksum_sha256   text,
  bytes             bigint,
  width             integer,
  height            integer,
  status            asset_status NOT NULL DEFAULT 'pending_upload',
  rejection_reason  text,
  alt_text          text,
  tags              text[] NOT NULL DEFAULT '{}',
  created_at        timestamptz NOT NULL DEFAULT now(),
  validated_at      timestamptz,
  archived_at       timestamptz,
  retention_at      timestamptz,
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, brand_id) REFERENCES brands(workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX assets_brand_idx ON assets(workspace_id, brand_id, created_at DESC);

CREATE TABLE asset_derivatives (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id      uuid NOT NULL,
  asset_id          uuid NOT NULL,
  variant           text NOT NULL,       -- 'preview' | 'thumb' | 'jpeg_publish'
  object_key        text NOT NULL UNIQUE,
  mime              text NOT NULL,
  bytes             bigint NOT NULL,
  width             integer NOT NULL,
  height            integer NOT NULL,
  checksum_sha256   text NOT NULL,
  transform_version integer NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (asset_id, variant, transform_version),
  FOREIGN KEY (workspace_id, asset_id) REFERENCES assets(workspace_id, id) ON DELETE CASCADE
);

-- ---------------------------------------------------------------- content
CREATE TABLE templates (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  brand_id     uuid NOT NULL,
  name         text NOT NULL,
  body         text NOT NULL,
  tags         text[] NOT NULL DEFAULT '{}',
  created_by   uuid REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  archived_at  timestamptz,
  FOREIGN KEY (workspace_id, brand_id) REFERENCES brands(workspace_id, id) ON DELETE CASCADE
);

-- A post holds a mutable, versioned working draft (autosaved with optimistic concurrency).
-- Submitting, approving, scheduling or publishing snapshots the draft into an immutable revision.
CREATE TABLE posts (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id         uuid NOT NULL,
  brand_id             uuid NOT NULL,
  created_by           uuid REFERENCES users(id),
  title                text,
  tags                 text[] NOT NULL DEFAULT '{}',
  draft                jsonb NOT NULL DEFAULT '{}'::jsonb,   -- DraftContent (packages/core)
  version              integer NOT NULL DEFAULT 1,           -- optimistic concurrency
  current_revision_id  uuid,
  schedule_generation  integer NOT NULL DEFAULT 0,
  source               jsonb,                                -- e.g. {kind:'tipsignal', eventId}
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  updated_by           uuid REFERENCES users(id),
  archived_at          timestamptz,
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, brand_id) REFERENCES brands(workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX posts_brand_idx ON posts(workspace_id, brand_id, updated_at DESC);

CREATE TABLE post_revisions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id     uuid NOT NULL,
  post_id          uuid NOT NULL,
  revision_number  integer NOT NULL,
  base_text        text NOT NULL DEFAULT '',
  base_link        text,
  base_asset_ids   uuid[] NOT NULL DEFAULT '{}',
  content_hash     text NOT NULL,
  created_by       uuid REFERENCES users(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (post_id, revision_number),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, post_id) REFERENCES posts(workspace_id, id) ON DELETE CASCADE
);

CREATE TABLE variants (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id   uuid NOT NULL,
  revision_id    uuid NOT NULL,
  connection_id  uuid NOT NULL,
  inherit_text   boolean NOT NULL DEFAULT true,
  rendered_text  text NOT NULL DEFAULT '',
  link           text,
  format         text NOT NULL CHECK (format IN ('text','image','album','video','reel')),
  asset_ids      uuid[] NOT NULL DEFAULT '{}',
  crop           jsonb,
  buttons        jsonb NOT NULL DEFAULT '[]'::jsonb,
  options        jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (revision_id, connection_id),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, revision_id) REFERENCES post_revisions(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, connection_id) REFERENCES connections(workspace_id, id)
);

CREATE OR REPLACE FUNCTION forbid_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'rows in % are immutable', TG_TABLE_NAME USING ERRCODE = 'check_violation';
END $$;
CREATE TRIGGER post_revisions_immutable BEFORE UPDATE ON post_revisions FOR EACH ROW EXECUTE FUNCTION forbid_update();
CREATE TRIGGER variants_immutable BEFORE UPDATE ON variants FOR EACH ROW EXECUTE FUNCTION forbid_update();

ALTER TABLE posts ADD CONSTRAINT posts_current_revision_fk
  FOREIGN KEY (workspace_id, current_revision_id) REFERENCES post_revisions(workspace_id, id) DEFERRABLE INITIALLY DEFERRED;

-- ---------------------------------------------------------------- approval & scheduling
CREATE TABLE schedules (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id      uuid NOT NULL,
  brand_id          uuid NOT NULL,
  post_id           uuid NOT NULL,
  revision_id       uuid NOT NULL,
  generation        integer NOT NULL,
  due_at            timestamptz NOT NULL,
  input_timezone    text NOT NULL,
  input_local_time  text NOT NULL,          -- original wall-clock input, e.g. 2026-11-10T09:00:00
  input_offset      text,                   -- chosen offset when the wall time was ambiguous
  publish_before    timestamptz NOT NULL,
  is_immediate      boolean NOT NULL DEFAULT false,
  status            text NOT NULL DEFAULT 'active' CHECK (status IN ('pending_approval','active','superseded','cancelled','completed','rejected')),
  fingerprint       text NOT NULL,          -- hash of revision+destinations+time+deadline
  created_by        uuid REFERENCES users(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  cancelled_at      timestamptz,
  cancelled_by      uuid REFERENCES users(id),
  UNIQUE (post_id, generation),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, brand_id) REFERENCES brands(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, post_id) REFERENCES posts(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, revision_id) REFERENCES post_revisions(workspace_id, id),
  CHECK (publish_before > due_at)
);
CREATE INDEX schedules_calendar_idx ON schedules(workspace_id, brand_id, due_at);
-- At most one live (active or awaiting approval) schedule per post.
CREATE UNIQUE INDEX schedules_one_live_per_post ON schedules(post_id) WHERE status IN ('active','pending_approval');

CREATE TABLE approvals (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id     uuid NOT NULL,
  brand_id         uuid NOT NULL,
  post_id          uuid NOT NULL,
  revision_id      uuid NOT NULL,
  schedule_id      uuid NOT NULL,
  schedule_generation integer NOT NULL,
  fingerprint      text NOT NULL,
  requested_by     uuid REFERENCES users(id),
  requested_at     timestamptz NOT NULL DEFAULT now(),
  reviewer_id      uuid REFERENCES users(id),
  decision         text NOT NULL DEFAULT 'pending' CHECK (decision IN ('pending','approved','rejected','invalidated')),
  decided_at       timestamptz,
  reason           text,
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, schedule_id) REFERENCES schedules(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, revision_id) REFERENCES post_revisions(workspace_id, id),
  CHECK (decision <> 'rejected' OR (reason IS NOT NULL AND length(trim(reason)) > 0))
);
CREATE INDEX approvals_pending_idx ON approvals(workspace_id, brand_id) WHERE decision = 'pending';

-- ---------------------------------------------------------------- delivery engine
CREATE TYPE delivery_state AS ENUM (
  'scheduled','preparing','publishing','processing','retry_wait','published',
  'failed','blocked','paused','cancelled','expired','unknown');

CREATE TABLE deliveries (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id      uuid NOT NULL,
  brand_id          uuid NOT NULL,
  post_id           uuid NOT NULL,
  schedule_id       uuid NOT NULL,
  generation        integer NOT NULL,
  revision_id       uuid NOT NULL,
  variant_id        uuid NOT NULL,
  connection_id     uuid NOT NULL,
  provider          provider_kind NOT NULL,
  is_mock           boolean NOT NULL DEFAULT false,
  state             delivery_state NOT NULL DEFAULT 'scheduled',
  phase             text NOT NULL DEFAULT 'idle' CHECK (phase IN ('idle','preparing','sending','awaiting_provider')),
  due_at            timestamptz NOT NULL,
  publish_before    timestamptz NOT NULL,
  next_attempt_at   timestamptz NOT NULL,
  attempt_count     integer NOT NULL DEFAULT 0,
  max_attempts      integer NOT NULL DEFAULT 5,
  lease_owner       text,
  lease_expires_at  timestamptz,
  fence             bigint NOT NULL DEFAULT 0,      -- fencing token, incremented on every claim
  preparation       jsonb,                          -- checkpoint: container/media ids + expiry
  provider_ids      text[] NOT NULL DEFAULT '{}',
  provider_url      text,
  published_at      timestamptz,
  last_error_code   text,
  last_error_message text,                          -- safe, user-facing
  blocked_reason    text,
  needs_reconcile   boolean NOT NULL DEFAULT false,
  unknown_since     timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (schedule_id, variant_id),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, schedule_id) REFERENCES schedules(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, variant_id) REFERENCES variants(workspace_id, id),
  FOREIGN KEY (workspace_id, connection_id) REFERENCES connections(workspace_id, id)
);
CREATE INDEX deliveries_due_idx ON deliveries(next_attempt_at)
  WHERE state IN ('scheduled','retry_wait','processing');
CREATE INDEX deliveries_lease_idx ON deliveries(lease_expires_at)
  WHERE lease_owner IS NOT NULL;
CREATE INDEX deliveries_post_idx ON deliveries(workspace_id, post_id);
CREATE INDEX deliveries_connection_idx ON deliveries(connection_id, state);
CREATE INDEX deliveries_history_idx ON deliveries(workspace_id, brand_id, due_at DESC, id);

CREATE TABLE delivery_attempts (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id     uuid NOT NULL,
  delivery_id      uuid NOT NULL,
  attempt_number   integer NOT NULL,
  fence            bigint NOT NULL,
  worker_id        text,
  actor_user_id    uuid REFERENCES users(id),     -- manual retry/resolve actor
  kind             text NOT NULL DEFAULT 'automatic' CHECK (kind IN ('automatic','manual_retry','reconcile','manual_resolution')),
  phase            text NOT NULL,
  started_at       timestamptz NOT NULL DEFAULT now(),
  ended_at         timestamptz,
  outcome          text,                          -- confirmed|processing|retryable|permanent|unknown|blocked|stale
  safe_code        text,
  safe_message     text,
  provider_ids     text[] NOT NULL DEFAULT '{}',
  correlation_id   text,
  duplicate_risk_acknowledged boolean NOT NULL DEFAULT false,
  UNIQUE (delivery_id, attempt_number),
  FOREIGN KEY (workspace_id, delivery_id) REFERENCES deliveries(workspace_id, id) ON DELETE CASCADE
);

-- Transactional outbox. Written in the same transaction as the state change.
CREATE TABLE outbox (
  id               bigserial PRIMARY KEY,
  workspace_id     uuid,
  aggregate_type   text NOT NULL,
  aggregate_id     text NOT NULL,
  event_type       text NOT NULL,
  payload          jsonb NOT NULL DEFAULT '{}'::jsonb,
  payload_version  integer NOT NULL DEFAULT 1,
  dispatch_state   text NOT NULL DEFAULT 'pending' CHECK (dispatch_state IN ('pending','dispatched','dead')),
  available_at     timestamptz NOT NULL DEFAULT now(),
  attempts         integer NOT NULL DEFAULT 0,
  last_error       text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  dispatched_at    timestamptz
);
CREATE INDEX outbox_pending_idx ON outbox(available_at, id) WHERE dispatch_state = 'pending';

CREATE TABLE webhook_receipts (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider          text NOT NULL,
  connection_id     uuid,
  external_event_id text,
  digest            text NOT NULL,
  received_at       timestamptz NOT NULL DEFAULT now(),
  event_time        timestamptz,
  processing_state  text NOT NULL DEFAULT 'pending' CHECK (processing_state IN ('pending','processed','ignored','failed')),
  processed_at      timestamptz,
  body              jsonb,                     -- retained at most 7 days (retention job)
  error             text
);
CREATE UNIQUE INDEX webhook_receipts_event_uniq ON webhook_receipts(provider, external_event_id) WHERE external_event_id IS NOT NULL;
CREATE UNIQUE INDEX webhook_receipts_digest_uniq ON webhook_receipts(provider, coalesce(connection_id::text,''), digest) WHERE external_event_id IS NULL;

CREATE TABLE audit_events (
  id              bigserial PRIMARY KEY,
  workspace_id    uuid,
  brand_id        uuid,
  actor_user_id   uuid REFERENCES users(id),
  actor_service   text,
  action          text NOT NULL,
  resource_type   text NOT NULL,
  resource_id     text,
  diff            jsonb NOT NULL DEFAULT '{}'::jsonb,
  correlation_id  text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_events_ws_idx ON audit_events(workspace_id, created_at DESC, id DESC);

CREATE TABLE notifications (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id   uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  severity       text NOT NULL CHECK (severity IN ('info','warning','critical')),
  kind           text NOT NULL,
  title          text NOT NULL,
  body           text,
  reference_type text,
  reference_id   text,
  dedupe_key     text NOT NULL,
  occurrences    integer NOT NULL DEFAULT 1,
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_seen_at   timestamptz NOT NULL DEFAULT now(),
  read_at        timestamptz,
  emailed_at     timestamptz,
  UNIQUE (user_id, dedupe_key)
);

CREATE TABLE idempotency_keys (
  workspace_id    uuid NOT NULL,
  user_id         uuid NOT NULL,
  action          text NOT NULL,
  key             text NOT NULL CHECK (length(key) BETWEEN 8 AND 200),
  request_hash    text NOT NULL,
  response_status integer,
  response_body   jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL DEFAULT now() + interval '24 hours',
  PRIMARY KEY (workspace_id, action, key)
);

-- Per-workspace, per-provider monthly usage (X API budget, AI caps).
CREATE TABLE usage_counters (
  workspace_id  uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  meter         text NOT NULL,             -- e.g. 'x.write', 'x.read', 'x.media', 'ai.tokens'
  period        text NOT NULL,             -- 'YYYY-MM' UTC
  used          bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (workspace_id, meter, period)
);

CREATE TABLE provider_circuits (
  provider      provider_kind PRIMARY KEY,
  state         text NOT NULL DEFAULT 'closed' CHECK (state IN ('closed','open','half_open')),
  failure_count integer NOT NULL DEFAULT 0,
  opened_until  timestamptz,
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE worker_heartbeats (
  worker_id    text PRIMARY KEY,
  started_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  version      text,
  info         jsonb NOT NULL DEFAULT '{}'::jsonb
);

-- System-wide switches. 'dispatch_enabled'=false is used after a database restore
-- until ambiguous deliveries are reconciled (docs/OPERATIONS.md).
CREATE TABLE system_flags (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  text
);
INSERT INTO system_flags(key, value, updated_by) VALUES ('dispatch_enabled', 'true'::jsonb, 'migration');

-- App-level settings entered through the protected setup page (non-secret values plain,
-- secret values envelope-encrypted). Never returned to clients in decrypted form.
CREATE TABLE app_settings (
  key          text PRIMARY KEY,
  value_plain  text,
  value_secret jsonb,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  updated_by   uuid REFERENCES users(id)
);
