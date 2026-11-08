-- V3.1 DATA stream: draft resilience (autosave client revisions, recovery policy), trash / soft delete with
-- retention, durable bulk jobs with per-item results, recent items and full-text search indexes.
-- Additive only: new nullable columns, new tables, new indexes; one widened CHECK on post_versions.kind.
-- Rollback: the application ignores these columns/tables when the V3.1 data code is not deployed
-- (trashed rows would reappear as ordinary rows), see docs/V3_1_DATA_API.md "Migration and rollback".

-- ---------------------------------------------------------------- trash / soft delete (§10)
-- deleted_at set ⇒ in trash: invisible to every normal read path; restorable until purge_after; then the
-- retention purge job deletes it physically (after re-checking references). Archive (archived_at) is separate.
ALTER TABLE posts ADD COLUMN deleted_at timestamptz;
ALTER TABLE posts ADD COLUMN deleted_by uuid REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE posts ADD COLUMN purge_after timestamptz;
ALTER TABLE posts ADD CONSTRAINT posts_trash_consistent CHECK ((deleted_at IS NULL) = (purge_after IS NULL));
CREATE INDEX posts_trash_idx ON posts (workspace_id, deleted_at DESC) WHERE deleted_at IS NOT NULL;
CREATE INDEX posts_purge_due_idx ON posts (purge_after) WHERE deleted_at IS NOT NULL;

ALTER TABLE assets ADD COLUMN deleted_at timestamptz;
ALTER TABLE assets ADD COLUMN deleted_by uuid REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE assets ADD COLUMN purge_after timestamptz;
ALTER TABLE assets ADD COLUMN purge_blocked_reason text;
ALTER TABLE assets ADD CONSTRAINT assets_trash_consistent CHECK ((deleted_at IS NULL) = (purge_after IS NULL));
CREATE INDEX assets_trash_idx ON assets (workspace_id, deleted_at DESC) WHERE deleted_at IS NOT NULL;
CREATE INDEX assets_purge_due_idx ON assets (purge_after) WHERE deleted_at IS NOT NULL;

-- ---------------------------------------------------------------- draft resilience (§9)
-- A save applied from browser-recovered content is its own version kind (history shows where it came from).
ALTER TABLE post_versions DROP CONSTRAINT post_versions_kind_check;
ALTER TABLE post_versions ADD CONSTRAINT post_versions_kind_check CHECK (kind IN ('created','saved','conflict','restored','recovered'));

-- Last autosave per (post, editor tab). Lets the server ignore out-of-order autosaves from the same tab and
-- answer a retried save (lost response) with the original result instead of a false conflict.
CREATE TABLE draft_save_clients (
  workspace_id         uuid NOT NULL,
  post_id              uuid NOT NULL,
  user_id              uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id            text NOT NULL CHECK (client_id ~ '^[A-Za-z0-9_-]{8,64}$'),
  last_client_revision bigint NOT NULL CHECK (last_client_revision >= 0),
  last_content_hash    text NOT NULL,
  last_version         integer NOT NULL,
  updated_at           timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (post_id, user_id, client_id),
  FOREIGN KEY (workspace_id, post_id) REFERENCES posts(workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX draft_save_clients_age_idx ON draft_save_clients (updated_at);

-- Workspace data policy: persistent local (browser) recovery can be disabled ('session' = tab-lifetime only,
-- 'off' = never stored locally). Absent row ⇒ defaults (persistent, 72 h).
CREATE TABLE workspace_data_policies (
  workspace_id          uuid PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  local_recovery        text NOT NULL DEFAULT 'persistent' CHECK (local_recovery IN ('persistent','session','off')),
  local_recovery_hours  integer NOT NULL DEFAULT 72 CHECK (local_recovery_hours BETWEEN 1 AND 720),
  clear_on_logout       boolean NOT NULL DEFAULT true,
  updated_by            uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at            timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- bulk jobs (§11)
CREATE TABLE bulk_jobs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id     uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  created_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  target_kind      text NOT NULL CHECK (target_kind IN ('post','asset')),
  action           text NOT NULL,
  params           jsonb NOT NULL DEFAULT '{}'::jsonb,
  preview_hash     text NOT NULL,
  idempotency_key  text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 200),
  request_hash     text NOT NULL,
  undo_of          uuid REFERENCES bulk_jobs(id) ON DELETE SET NULL,
  -- assurance of the starting session (server-derived); background runs re-check grants, not MFA freshness
  started_mfa      boolean NOT NULL DEFAULT false,
  policy_version   bigint NOT NULL DEFAULT 0,
  status           text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','completed','completed_with_errors','failed','cancelled')),
  item_count       integer NOT NULL CHECK (item_count BETWEEN 1 AND 500),
  attempts         integer NOT NULL DEFAULT 0,
  lease_until      timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  started_at       timestamptz,
  finished_at      timestamptz,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, created_by, idempotency_key)
);
CREATE INDEX bulk_jobs_workspace_idx ON bulk_jobs (workspace_id, created_at DESC);
CREATE INDEX bulk_jobs_runnable_idx ON bulk_jobs (updated_at) WHERE status IN ('queued','running');

CREATE TABLE bulk_job_items (
  workspace_id   uuid NOT NULL,
  job_id         uuid NOT NULL,
  item_id        uuid NOT NULL,
  brand_id       uuid,
  position       integer NOT NULL,
  status         text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','succeeded','failed','skipped')),
  error_code     text,
  error_message  text,
  before         jsonb,
  after          jsonb,
  attempts       integer NOT NULL DEFAULT 0,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (job_id, item_id),
  FOREIGN KEY (workspace_id, job_id) REFERENCES bulk_jobs(workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX bulk_job_items_pending_idx ON bulk_job_items (job_id, position) WHERE status = 'pending';

-- ---------------------------------------------------------------- search (§8)
-- Recently opened items per person (re-authorized on every read; capped per user by the service).
CREATE TABLE recent_items (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind         text NOT NULL CHECK (kind IN ('post','campaign','asset','brand')),
  item_id      uuid NOT NULL,
  viewed_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id, kind, item_id)
);
CREATE INDEX recent_items_user_idx ON recent_items (workspace_id, user_id, viewed_at DESC);

-- Full-text indexes ('simple' config: language-neutral, no stemming; prefix queries via :*). Expression indexes,
-- so no table rewrite. The service queries use exactly these expressions.
CREATE INDEX posts_search_fts ON posts USING gin (to_tsvector('simple', coalesce(title, '') || ' ' || coalesce(draft->>'baseText', '')));
CREATE INDEX campaigns_search_fts ON campaigns USING gin (to_tsvector('simple', name || ' ' || coalesce(description, '')));
-- array_to_string is STABLE (polymorphic); for text[] it is immutable in practice, so wrap it for the index.
CREATE FUNCTION relay_tags_text(text[]) RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$ SELECT coalesce(array_to_string($1, ' '), '') $$;
CREATE INDEX assets_search_fts ON assets USING gin (to_tsvector('simple', coalesce(original_filename, '') || ' ' || coalesce(alt_text, '') || ' ' || relay_tags_text(tags)));
