-- V3 stream MCP: first-party MCP server (docs/V3_MCP_GUIDE.md).
--   mcp_clients              consent/registry of MCP clients per (owner user, OAuth client id | API key, workspace):
--                            granted scopes, consented brands, last activity, revocation. Checked on EVERY call.
--   mcp_audit                one row per tool/resource/prompt call: actor, client, tool, resource ids, result, error
--                            code, correlation id, latency. Never stores prompts, post text, tokens or arguments.
--   mcp_publication_intents  prepare/commit publication intents (exact revision, destinations, time, content hash,
--                            expiry) with the server-side trusted confirmation recorded by the Relay web app.
--   mcp_policy_grants        optional pre-authorised automation policy (actor/client/brand/destinations/time window/
--                            content limits); revocable; created with step-up in the web app.
--   mcp_jobs                 asynchronous work started by MCP tools (report exports), polled with get_job_status.

CREATE TABLE mcp_clients (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- NULL only while the registration is pending (a valid token was presented but the user has not consented yet).
  workspace_id       uuid REFERENCES workspaces(id) ON DELETE CASCADE,
  owner_user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind               text NOT NULL CHECK (kind IN ('oauth', 'api_key')),
  -- OAuth: the authorization server's client id (token azp). API key: the non-secret key prefix.
  client_id          text NOT NULL CHECK (length(client_id) BETWEEN 1 AND 300),
  issuer             text,
  service_account_id uuid REFERENCES service_accounts(id) ON DELETE CASCADE,
  api_key_id         uuid REFERENCES api_key_hashes(id) ON DELETE CASCADE,
  name               text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  requested_scopes   text[] NOT NULL DEFAULT '{}',
  granted_scopes     text[] NOT NULL DEFAULT '{}',
  -- Consented brands. NULL = every brand the owner can access in the workspace (evaluated per call).
  brand_ids          uuid[],
  status             text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'revoked')),
  consented_at       timestamptz,
  consented_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  last_activity_at   timestamptz,
  last_tool          text,
  revoked_at         timestamptz,
  revoked_by         uuid REFERENCES users(id) ON DELETE SET NULL,
  revoked_reason     text,
  CHECK (status = 'pending' OR workspace_id IS NOT NULL),
  CHECK (kind = 'oauth' OR (service_account_id IS NOT NULL AND api_key_id IS NOT NULL))
);
-- One live registration per (owner, client, workspace); one pending registration per (owner, client).
CREATE UNIQUE INDEX mcp_clients_live_uniq ON mcp_clients (owner_user_id, kind, client_id, workspace_id)
  WHERE status = 'active';
CREATE UNIQUE INDEX mcp_clients_pending_uniq ON mcp_clients (owner_user_id, kind, client_id)
  WHERE status = 'pending';
CREATE INDEX mcp_clients_workspace_idx ON mcp_clients (workspace_id, status, last_activity_at DESC);
CREATE INDEX mcp_clients_lookup_idx ON mcp_clients (kind, client_id, owner_user_id);

CREATE TABLE mcp_audit (
  id                        bigserial PRIMARY KEY,
  workspace_id              uuid REFERENCES workspaces(id) ON DELETE CASCADE,
  client_row_id             uuid REFERENCES mcp_clients(id) ON DELETE SET NULL,
  actor_user_id             uuid REFERENCES users(id) ON DELETE SET NULL,
  actor_service_account_id  uuid REFERENCES service_accounts(id) ON DELETE SET NULL,
  client_id                 text,
  tool                      text NOT NULL CHECK (length(tool) <= 120),
  -- Ids only (workspace/brand/post/schedule/intent/job/connection), never text or arguments.
  resource_ids              jsonb NOT NULL DEFAULT '{}'::jsonb,
  result                    text NOT NULL CHECK (result IN ('ok', 'error', 'denied', 'cancelled')),
  error_code                text,
  correlation_id            text NOT NULL,
  latency_ms                integer NOT NULL DEFAULT 0,
  created_at                timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX mcp_audit_workspace_idx ON mcp_audit (workspace_id, created_at DESC);
CREATE INDEX mcp_audit_client_idx ON mcp_audit (client_row_id, created_at DESC);

-- The audit trail is append-only (deletion only through workspace/client cascades and retention).
CREATE FUNCTION mcp_audit_no_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'mcp_audit is append-only';
END $$;
CREATE TRIGGER mcp_audit_append_only BEFORE UPDATE ON mcp_audit FOR EACH ROW EXECUTE FUNCTION mcp_audit_no_update();

CREATE TABLE mcp_policy_grants (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id       uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  client_row_id      uuid NOT NULL REFERENCES mcp_clients(id) ON DELETE CASCADE,
  -- The person whose MCP actions this policy pre-authorises (always the client's owner).
  actor_user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  brand_id           uuid NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  -- Allowed destinations (NULL = any destination of the brand).
  connection_ids     uuid[],
  allow_immediate    boolean NOT NULL DEFAULT false,
  valid_from         timestamptz NOT NULL DEFAULT now(),
  valid_until        timestamptz NOT NULL,
  -- Scheduled time limits: at most this many days ahead, within [start_hour, end_hour) local brand time.
  max_days_ahead     integer NOT NULL DEFAULT 14 CHECK (max_days_ahead BETWEEN 0 AND 90),
  local_start_hour   smallint NOT NULL DEFAULT 0 CHECK (local_start_hour BETWEEN 0 AND 23),
  local_end_hour     smallint NOT NULL DEFAULT 24 CHECK (local_end_hour BETWEEN 1 AND 24),
  -- Content limits.
  max_per_day        integer NOT NULL DEFAULT 3 CHECK (max_per_day BETWEEN 1 AND 50),
  max_text_length    integer CHECK (max_text_length IS NULL OR max_text_length BETWEEN 1 AND 100000),
  allow_links        boolean NOT NULL DEFAULT true,
  allow_media        boolean NOT NULL DEFAULT true,
  note               text CHECK (note IS NULL OR length(note) <= 300),
  created_by         uuid NOT NULL REFERENCES users(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  revoked_at         timestamptz,
  revoked_by         uuid REFERENCES users(id) ON DELETE SET NULL,
  CHECK (valid_until > valid_from),
  CHECK (local_end_hour > local_start_hour)
);
CREATE INDEX mcp_policy_grants_lookup_idx ON mcp_policy_grants (client_row_id, brand_id) WHERE revoked_at IS NULL;
CREATE INDEX mcp_policy_grants_workspace_idx ON mcp_policy_grants (workspace_id, created_at DESC);

CREATE TABLE mcp_publication_intents (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id       uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  brand_id           uuid NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  post_id            uuid NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  client_row_id      uuid NOT NULL REFERENCES mcp_clients(id) ON DELETE CASCADE,
  actor_user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  post_version       integer NOT NULL,
  revision_hash      text NOT NULL,        -- contentHash() of the exact text/link/media/variants that would be snapshotted
  connection_ids     uuid[] NOT NULL,
  mode               text NOT NULL CHECK (mode IN ('scheduled', 'immediate')),
  input_local_time   text,
  input_timezone     text NOT NULL,
  input_offset       text,
  deadline_minutes   integer NOT NULL,
  due_at             timestamptz,           -- NULL for immediate
  intent_hash        text NOT NULL,         -- sha256 over every field above; the client must echo it on commit
  status             text NOT NULL DEFAULT 'prepared' CHECK (status IN ('prepared', 'confirmed', 'committed', 'invalidated', 'expired', 'failed')),
  invalid_reason     text,
  expires_at         timestamptz NOT NULL,
  confirmed_at       timestamptz,
  confirmed_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  confirmed_session  uuid,
  confirmed_mfa      boolean,
  policy_grant_id    uuid REFERENCES mcp_policy_grants(id) ON DELETE SET NULL,
  committed_at       timestamptz,
  schedule_id        uuid REFERENCES schedules(id) ON DELETE SET NULL,
  result             jsonb,
  correlation_id     text,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX mcp_intents_workspace_idx ON mcp_publication_intents (workspace_id, created_at DESC);
CREATE INDEX mcp_intents_grant_day_idx ON mcp_publication_intents (policy_grant_id, committed_at) WHERE status = 'committed';

CREATE TABLE mcp_jobs (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id       uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  client_row_id      uuid NOT NULL REFERENCES mcp_clients(id) ON DELETE CASCADE,
  actor_user_id      uuid REFERENCES users(id) ON DELETE SET NULL,
  actor_service_account_id uuid REFERENCES service_accounts(id) ON DELETE SET NULL,
  brand_id           uuid REFERENCES brands(id) ON DELETE CASCADE,
  kind               text NOT NULL CHECK (kind IN ('report_export')),
  params             jsonb NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key    text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 200),
  request_hash       text NOT NULL,
  status             text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  attempts           integer NOT NULL DEFAULT 0,
  lease_until        timestamptz,
  result             jsonb,                 -- metadata only (rows, bytes, filename, target)
  output             text,                  -- bounded CSV body for target 'relay_download' (≤ 5 MB), cleared at expiry
  error_code         text,
  error_message      text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  finished_at        timestamptz,
  expires_at         timestamptz NOT NULL DEFAULT now() + interval '7 days',
  UNIQUE (workspace_id, client_row_id, idempotency_key)
);
CREATE INDEX mcp_jobs_due_idx ON mcp_jobs (created_at) WHERE status IN ('queued', 'running');
CREATE INDEX mcp_jobs_workspace_idx ON mcp_jobs (workspace_id, created_at DESC);
