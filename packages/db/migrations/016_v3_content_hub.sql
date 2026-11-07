-- V3 Content Hub (stream CH): Google Drive/Docs + Notion source connections, per-item grants, linked source items,
-- immutable snapshots, idempotent imports, Notion property mappings, sync checkpoints, export and writeback jobs.
-- Every row is workspace scoped; brand-scoped rows use composite (workspace_id, brand_id) foreign keys so a row can
-- never point at another tenant's brand/connection/item. See docs/V3_CONTENT_INTEGRATIONS.md.

-- Per-workspace Content Hub policy (snapshot retention after access loss/disconnect).
CREATE TABLE content_hub_settings (
  workspace_id            uuid PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  snapshot_retention_days integer NOT NULL DEFAULT 365 CHECK (snapshot_retention_days BETWEEN 1 AND 3650),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  updated_by              uuid REFERENCES users(id) ON DELETE SET NULL
);

-- A Google content (Drive/Docs) or Notion authorization. Separate from sign-in and from social (YouTube) connections.
-- brand_id NULL = workspace-wide connection (usable for brands the acting person may work on); otherwise brand-scoped.
CREATE TABLE content_connections (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id          uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  brand_id              uuid,
  source                text NOT NULL CHECK (source IN ('google', 'notion')),
  -- oauth: public OAuth; internal_token: explicitly configured Notion internal connection (test installs only);
  -- test: labelled test transport (never live).
  auth_mode             text NOT NULL DEFAULT 'oauth' CHECK (auth_mode IN ('oauth', 'internal_token', 'test')),
  external_account_id   text NOT NULL,              -- Google subject / Notion bot_id
  account_label         text NOT NULL,              -- Google email / Notion workspace name
  external_workspace_id text,                       -- Notion workspace_id
  granted_scopes        text[] NOT NULL DEFAULT '{}',
  credentials_enc       jsonb,                      -- envelope-encrypted token set; AAD content-connection:<ws>:<id>
  token_expires_at      timestamptz,
  refresh_version       integer NOT NULL DEFAULT 0,
  status                text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'reconnect_required', 'disconnected')),
  status_detail         text,
  writeback_enabled     boolean NOT NULL DEFAULT false,  -- workspace/brand-level opt-in; mappings opt in per field
  authorized_by         uuid REFERENCES users(id) ON DELETE SET NULL,
  last_used_at          timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  disconnected_at       timestamptz,
  disconnected_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, brand_id) REFERENCES brands(workspace_id, id) ON DELETE CASCADE,
  CHECK (status <> 'disconnected' OR (disconnected_at IS NOT NULL AND credentials_enc IS NULL))
);
CREATE UNIQUE INDEX content_connections_identity_uq ON content_connections
  (workspace_id, coalesce(brand_id, '00000000-0000-0000-0000-000000000000'::uuid), source, external_account_id) WHERE disconnected_at IS NULL;
CREATE INDEX content_connections_ws_idx ON content_connections (workspace_id, source) WHERE disconnected_at IS NULL;
CREATE INDEX content_connections_notion_ws_idx ON content_connections (external_workspace_id) WHERE source = 'notion' AND disconnected_at IS NULL;

-- Explicit per-item authorization evidence: a Picker selection, a Notion page/data source shared with the connection
-- and chosen in Relay, or an export destination. Imports/exports only accept granted, server-verified items.
CREATE TABLE source_grants (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL,
  connection_id uuid NOT NULL,
  external_id   text NOT NULL CHECK (length(external_id) BETWEEN 1 AND 200),
  item_kind     text NOT NULL CHECK (item_kind IN ('drive_file', 'google_doc', 'drive_folder', 'notion_page', 'notion_data_source')),
  purpose       text NOT NULL DEFAULT 'import' CHECK (purpose IN ('import', 'export_destination')),
  granted_via   text NOT NULL CHECK (granted_via IN ('picker', 'notion_selection', 'created_by_app')),
  title         text,
  writable      boolean NOT NULL DEFAULT false,
  granted_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  verified_at   timestamptz NOT NULL DEFAULT now(),
  revoked_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id),
  UNIQUE (connection_id, item_kind, external_id, purpose),
  FOREIGN KEY (workspace_id, connection_id) REFERENCES content_connections(workspace_id, id) ON DELETE CASCADE
);

-- A linked source item for ONE brand (the same external file linked to two brands is two rows).
CREATE TABLE source_items (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        uuid NOT NULL,
  brand_id            uuid NOT NULL,
  connection_id       uuid NOT NULL,
  parent_item_id      uuid,                           -- Notion row → its data source item
  item_kind           text NOT NULL CHECK (item_kind IN ('drive_file', 'google_doc', 'notion_page', 'notion_data_source', 'notion_row')),
  external_id         text NOT NULL CHECK (length(external_id) BETWEEN 1 AND 200),
  resolved_from_shortcut_id text,                    -- Drive shortcut that was resolved to external_id
  drive_id            text,                           -- Shared Drive id (null for My Drive)
  title               text,
  mime_type           text,
  size_bytes          bigint,
  source_version      text,                           -- Drive version / Notion last_edited_time
  source_modified_at  timestamptz,
  source_checksum     text,                           -- Drive md5Checksum (binary files only)
  -- linked: readable now; access_lost: provider denied/404; removed: trashed/deleted at source; disconnected: connection gone
  state               text NOT NULL DEFAULT 'linked' CHECK (state IN ('linked', 'access_lost', 'removed', 'disconnected')),
  state_detail        text,
  preview             jsonb,                          -- linked-source preview; cleared when access is lost/disconnected
  external_url        text,                           -- display only (never a media source for providers)
  change_detected_at  timestamptz,                    -- signal from watch/webhook (fetch on refresh)
  last_synced_at      timestamptz,
  last_snapshot_id    uuid,
  retention_hold      boolean NOT NULL DEFAULT false,
  created_by          uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, brand_id) REFERENCES brands(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, connection_id) REFERENCES content_connections(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, parent_item_id) REFERENCES source_items(workspace_id, id) ON DELETE CASCADE,
  CHECK (state = 'linked' OR preview IS NULL)
);
CREATE UNIQUE INDEX source_items_identity_uq ON source_items (connection_id, brand_id, item_kind, external_id);
CREATE INDEX source_items_brand_idx ON source_items (workspace_id, brand_id, updated_at DESC);
CREATE INDEX source_items_external_idx ON source_items (external_id);

-- Immutable, app-owned snapshot of what was read from the source (never updated; deleted by the retention/delete workflow).
CREATE TABLE source_snapshots (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id         uuid NOT NULL,
  brand_id             uuid NOT NULL,
  source_item_id       uuid NOT NULL,
  seq                  integer NOT NULL CHECK (seq > 0),
  content_kind         text NOT NULL CHECK (content_kind IN ('media', 'document', 'notion_page', 'notion_row')),
  fingerprint          text NOT NULL,                 -- sha256 of the normalized content / bytes
  checksum_sha256      text,                          -- bytes checksum (media)
  source_checksum      text,
  source_version       text,
  source_modified_at   timestamptz,
  title                text,
  content              jsonb NOT NULL DEFAULT '{}'::jsonb,  -- normalized sections/blocks (untrusted text, never instructions)
  warnings             jsonb NOT NULL DEFAULT '[]'::jsonb,
  incomplete           boolean NOT NULL DEFAULT false,
  asset_id             uuid,                          -- media snapshot → validated private asset
  imported_by          uuid REFERENCES users(id) ON DELETE SET NULL,
  imported_at          timestamptz NOT NULL DEFAULT now(),
  diff_from_snapshot_id uuid,
  diff                 jsonb,
  UNIQUE (workspace_id, id),
  UNIQUE (source_item_id, seq),
  FOREIGN KEY (workspace_id, source_item_id) REFERENCES source_items(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, brand_id) REFERENCES brands(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, asset_id) REFERENCES assets(workspace_id, id)
);
CREATE INDEX source_snapshots_item_idx ON source_snapshots (source_item_id, seq DESC);
CREATE TRIGGER source_snapshots_immutable BEFORE UPDATE ON source_snapshots FOR EACH ROW EXECUTE FUNCTION forbid_update();
ALTER TABLE source_items ADD FOREIGN KEY (workspace_id, last_snapshot_id) REFERENCES source_snapshots(workspace_id, id) ON DELETE SET NULL (last_snapshot_id);

-- Import requests. idempotency_key = sha256(source identity + version/fingerprint + brand + action + selection [+ explicit copy nonce]).
CREATE TABLE imports (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id     uuid NOT NULL,
  brand_id         uuid NOT NULL,
  connection_id    uuid NOT NULL,
  source_item_id   uuid,
  snapshot_id      uuid,
  action           text NOT NULL CHECK (action IN ('media_asset', 'doc_drafts', 'doc_campaign', 'notion_page_draft', 'notion_rows', 'refresh')),
  idempotency_key  text NOT NULL,
  status           text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'completed', 'partial', 'failed', 'cancelled')),
  options          jsonb NOT NULL DEFAULT '{}'::jsonb,
  result           jsonb NOT NULL DEFAULT '{}'::jsonb,
  error_code       text,
  error_message    text,
  attempts         integer NOT NULL DEFAULT 0,
  run_id           uuid,
  requested_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  started_at       timestamptz,
  completed_at     timestamptz,
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, idempotency_key),
  FOREIGN KEY (workspace_id, brand_id) REFERENCES brands(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, connection_id) REFERENCES content_connections(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, source_item_id) REFERENCES source_items(workspace_id, id) ON DELETE SET NULL (source_item_id),
  FOREIGN KEY (workspace_id, snapshot_id) REFERENCES source_snapshots(workspace_id, id) ON DELETE SET NULL (snapshot_id)
);
CREATE INDEX imports_brand_idx ON imports (workspace_id, brand_id, created_at DESC);
CREATE INDEX imports_queued_idx ON imports (status, created_at) WHERE status IN ('queued', 'running');

-- Drafts created from a source (for refresh/diff and writeback). imported_hash = hash of the text Relay wrote.
CREATE TABLE source_post_links (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id   uuid NOT NULL,
  brand_id       uuid NOT NULL,
  post_id        uuid NOT NULL,
  source_item_id uuid NOT NULL,
  snapshot_id    uuid,
  import_id      uuid,
  section_ids    text[] NOT NULL DEFAULT '{}',
  imported_hash  text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  superseded_at  timestamptz,
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, brand_id) REFERENCES brands(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, post_id) REFERENCES posts(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, source_item_id) REFERENCES source_items(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, snapshot_id) REFERENCES source_snapshots(workspace_id, id) ON DELETE SET NULL (snapshot_id),
  FOREIGN KEY (workspace_id, import_id) REFERENCES imports(workspace_id, id) ON DELETE SET NULL (import_id)
);
CREATE INDEX source_post_links_item_idx ON source_post_links (source_item_id) WHERE superseded_at IS NULL;
CREATE INDEX source_post_links_post_idx ON source_post_links (post_id);

-- Notion data source → Relay field mapping (+ opted-in statuses and field-scoped writeback). Property ids, not names, are stored.
CREATE TABLE import_mappings (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id       uuid NOT NULL,
  brand_id           uuid NOT NULL,
  source_item_id     uuid NOT NULL,                  -- the notion_data_source item
  version            integer NOT NULL DEFAULT 1,
  mapping            jsonb NOT NULL,                 -- {title, body, campaign, target_date, status, external_ref}: property ids | 'page_content'
  import_statuses    text[] NOT NULL DEFAULT '{}',
  writeback          jsonb NOT NULL DEFAULT '{}'::jsonb,  -- {status?: propId, scheduled_time?: propId, post_url?: propId}
  schema_fingerprint text,
  created_by         uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_by         uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id),
  UNIQUE (source_item_id),
  FOREIGN KEY (workspace_id, brand_id) REFERENCES brands(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, source_item_id) REFERENCES source_items(workspace_id, id) ON DELETE CASCADE
);

-- Change-notification / polling checkpoints (Drive changes page token + watch channel, Notion webhook state).
CREATE TABLE sync_checkpoints (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        uuid NOT NULL,
  connection_id       uuid NOT NULL,
  scope               text NOT NULL CHECK (length(scope) BETWEEN 1 AND 200),
  cursor              text,
  channel_id          text UNIQUE,
  channel_resource_id text,
  channel_token_hash  bytea,
  channel_expires_at  timestamptz,
  last_message_number bigint,
  last_run_at         timestamptz,
  last_error          text,
  stopped_at          timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id),
  UNIQUE (connection_id, scope),
  FOREIGN KEY (workspace_id, connection_id) REFERENCES content_connections(workspace_id, id) ON DELETE CASCADE
);

-- Verified inbound source notifications (dedupe) and pending Notion webhook verification handshakes.
CREATE TABLE content_source_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source        text NOT NULL CHECK (source IN ('google_drive', 'notion')),
  event_key     text NOT NULL,
  workspace_id  uuid REFERENCES workspaces(id) ON DELETE CASCADE,
  kind          text NOT NULL,
  summary       jsonb NOT NULL DEFAULT '{}'::jsonb,
  secret_enc    jsonb,                                -- Notion verification_token (handshake only), encrypted
  received_at   timestamptz NOT NULL DEFAULT now(),
  processed_at  timestamptz,
  UNIQUE (source, event_key)
);

-- Explicit exports (report/content plan → new Google Doc, Drive file, or Notion page). Never changes destination ACLs.
CREATE TABLE export_jobs (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id       uuid NOT NULL,
  brand_id           uuid,
  connection_id      uuid NOT NULL,
  destination_kind   text NOT NULL CHECK (destination_kind IN ('google_doc', 'drive_file', 'notion_page')),
  destination_parent_id text,
  title              text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  format             text NOT NULL CHECK (format IN ('html', 'markdown', 'csv', 'pdf', 'text')),
  content_ref        jsonb NOT NULL DEFAULT '{}'::jsonb,   -- what is exported + the permission it needs (re-checked at run)
  content_key        text,                              -- private object storage key of the payload
  content_sha256     text,
  content_bytes      integer,
  idempotency_key    text NOT NULL,
  status             text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
  sharing_warning    text,
  result             jsonb NOT NULL DEFAULT '{}'::jsonb,
  error_code         text,
  error_message      text,
  attempts           integer NOT NULL DEFAULT 0,
  requested_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  started_at         timestamptz,
  completed_at       timestamptz,
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, idempotency_key),
  FOREIGN KEY (workspace_id, brand_id) REFERENCES brands(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, connection_id) REFERENCES content_connections(workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX export_jobs_ws_idx ON export_jobs (workspace_id, created_at DESC);

-- Opt-in, field-scoped writeback of app-owned facts (status, scheduled time, post URLs) to mapped Notion properties.
CREATE TABLE writeback_jobs (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id          uuid NOT NULL,
  brand_id              uuid NOT NULL,
  connection_id         uuid NOT NULL,
  source_item_id        uuid NOT NULL,              -- the notion_row item
  mapping_id            uuid NOT NULL,
  post_id               uuid,
  field                 text NOT NULL CHECK (field IN ('status', 'scheduled_time', 'post_url')),
  property_id           text NOT NULL,
  desired_value         jsonb NOT NULL,
  desired_fingerprint   text NOT NULL,
  origin                text NOT NULL DEFAULT 'relay',
  origin_run_id         uuid NOT NULL,
  last_seen_fingerprint text,                       -- external value fingerprint Relay last observed/wrote
  written_fingerprint   text,
  status                text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'written', 'conflict', 'skipped', 'failed', 'cancelled')),
  conflict_detail       jsonb,
  attempts              integer NOT NULL DEFAULT 0,
  error_message         text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  completed_at          timestamptz,
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, brand_id) REFERENCES brands(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, connection_id) REFERENCES content_connections(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, source_item_id) REFERENCES source_items(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, mapping_id) REFERENCES import_mappings(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, post_id) REFERENCES posts(workspace_id, id) ON DELETE SET NULL (post_id)
);
CREATE UNIQUE INDEX writeback_jobs_active_uq ON writeback_jobs (source_item_id, field) WHERE status IN ('pending', 'running', 'conflict');
CREATE INDEX writeback_jobs_item_idx ON writeback_jobs (source_item_id, field, created_at DESC);
