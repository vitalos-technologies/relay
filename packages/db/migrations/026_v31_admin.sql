-- V3.1 Admin (brief docs/queue/03c_V3_1_ADMIN_PROMPT.md). Additive only.
--
-- Two authority scopes:
--   * Workspace administration keeps using V2 scoped grants (authorize()); nothing here changes that path.
--   * Platform administration: `platform_operators` names the Relay operators of this installation. Operators see
--     aggregates and metadata only (no post text, media, documents or credentials). They gain access to a workspace's
--     private content only through `support_access_grants`: explicit, reasoned, time-boxed, approved by the
--     workspace's owner/admin, and realised as an ordinary expiring `viewer` grant (scoped_role_grants.expires_at), so
--     enforcement is the normal policy path. Both scopes are audited; the platform audit is append-only for app roles
--     (infra/postgres/roles.sql), like audit_events.
--   * Workspace lifecycle: a platform suspension (workspaces.state = 'suspended') blocks every member request
--     (loadAccess) and holds dispatch (engine gate) until reactivated. Reason/actor recorded here.
--   * Admin change feed (/api/admin/changes) reads max(updated_at) per workspace: two indexes make that a single
--     index probe. Dead-letter outbox rows get a small partial index for the per-workspace recovery list.
-- Rollback: DROP TABLE support_access_grants, platform_audit_events, platform_operators;
--   ALTER TABLE workspaces DROP COLUMN suspended_at, DROP COLUMN suspended_by, DROP COLUMN suspended_reason;
--   DROP INDEX deliveries_ws_updated_idx, posts_ws_updated_idx, outbox_dead_ws_idx, connections_ws_updated_idx.

CREATE TABLE platform_operators (
  user_id     uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  -- operator: platform administration (lifecycle, rollouts, dispatch, operators).
  -- support: read-only platform views + support-access requests.
  role        text NOT NULL CHECK (role IN ('operator','support')),
  granted_by  uuid REFERENCES users(id),
  granted_via text NOT NULL DEFAULT 'cli' CHECK (granted_via IN ('cli','seed','admin')),
  granted_at  timestamptz NOT NULL DEFAULT now(),
  revoked_at  timestamptz,
  revoked_by  uuid REFERENCES users(id),
  note        text CHECK (note IS NULL OR length(note) <= 200)
);
CREATE INDEX platform_operators_active_idx ON platform_operators (role) WHERE revoked_at IS NULL;

CREATE TABLE platform_audit_events (
  id             bigserial PRIMARY KEY,
  actor_user_id  uuid REFERENCES users(id) ON DELETE SET NULL,
  actor_service  text,
  action         text NOT NULL CHECK (length(action) BETWEEN 3 AND 80),
  target_type    text NOT NULL CHECK (length(target_type) BETWEEN 2 AND 40),
  target_id      text,
  workspace_id   uuid REFERENCES workspaces(id) ON DELETE SET NULL,
  reason         text CHECK (reason IS NULL OR length(reason) <= 500),
  outcome        text NOT NULL DEFAULT 'success' CHECK (outcome IN ('success','denied','failed')),
  diff           jsonb NOT NULL DEFAULT '{}'::jsonb,
  correlation_id text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (actor_user_id IS NOT NULL OR actor_service IS NOT NULL)
);
CREATE INDEX platform_audit_created_idx ON platform_audit_events (created_at DESC, id DESC);
CREATE INDEX platform_audit_ws_idx ON platform_audit_events (workspace_id, id DESC) WHERE workspace_id IS NOT NULL;
CREATE INDEX platform_audit_actor_idx ON platform_audit_events (actor_user_id, id DESC);

CREATE TABLE support_access_grants (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id       uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  operator_user_id   uuid NOT NULL REFERENCES users(id),
  reason             text NOT NULL CHECK (length(reason) BETWEEN 10 AND 500),
  ticket_ref         text CHECK (ticket_ref IS NULL OR length(ticket_ref) <= 80),
  -- Read-only content visibility (the `viewer` preset). Nothing broader exists by design.
  access             text NOT NULL DEFAULT 'read' CHECK (access = 'read'),
  duration_minutes   int NOT NULL CHECK (duration_minutes BETWEEN 15 AND 1440),
  status             text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','active','declined','ended','cancelled','lapsed')),
  requested_at       timestamptz NOT NULL DEFAULT now(),
  request_expires_at timestamptz NOT NULL,
  decided_by         uuid REFERENCES users(id),
  decided_at         timestamptz,
  decision_note      text CHECK (decision_note IS NULL OR length(decision_note) <= 500),
  starts_at          timestamptz,
  expires_at         timestamptz,
  ended_at           timestamptz,
  ended_by           uuid REFERENCES users(id),
  end_reason         text CHECK (end_reason IS NULL OR length(end_reason) <= 200),
  grant_id           uuid REFERENCES scoped_role_grants(id) ON DELETE SET NULL,
  created_membership boolean NOT NULL DEFAULT false,
  correlation_id     text,
  CHECK (status <> 'active' OR (starts_at IS NOT NULL AND expires_at IS NOT NULL))
);
CREATE UNIQUE INDEX support_access_one_open_idx ON support_access_grants (workspace_id, operator_user_id) WHERE status IN ('requested','active');
CREATE INDEX support_access_ws_idx ON support_access_grants (workspace_id, requested_at DESC);
CREATE INDEX support_access_operator_idx ON support_access_grants (operator_user_id, requested_at DESC);
CREATE INDEX support_access_open_idx ON support_access_grants (status, expires_at) WHERE status IN ('requested','active');

ALTER TABLE workspaces
  ADD COLUMN suspended_at     timestamptz,
  ADD COLUMN suspended_by     uuid REFERENCES users(id),
  ADD COLUMN suspended_reason text CHECK (suspended_reason IS NULL OR length(suspended_reason) <= 500);

CREATE INDEX deliveries_ws_updated_idx ON deliveries (workspace_id, updated_at DESC);
CREATE INDEX posts_ws_updated_idx ON posts (workspace_id, updated_at DESC);
CREATE INDEX connections_ws_updated_idx ON connections (workspace_id, updated_at DESC);
CREATE INDEX outbox_dead_ws_idx ON outbox (workspace_id, id DESC) WHERE dispatch_state = 'dead';
