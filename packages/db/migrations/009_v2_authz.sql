-- V2 authorization model: teams, scoped role grants (users, teams, service accounts), explicit
-- restrictions (deny), membership status, policy versions, MFA policy, service accounts.
-- Additive: V1 memberships.role is kept for compatibility and backfilled into scoped grants.

-- ---------------------------------------------------------------- membership status
ALTER TABLE memberships ADD COLUMN status text NOT NULL DEFAULT 'active'
  CHECK (status IN ('active','suspended','removed'));
UPDATE memberships SET status = 'removed' WHERE removed_at IS NOT NULL;
ALTER TABLE memberships ADD COLUMN suspended_at timestamptz;
ALTER TABLE memberships ADD COLUMN suspended_by uuid REFERENCES users(id);
ALTER TABLE memberships ADD COLUMN status_reason text;

CREATE TABLE membership_status_history (
  id            bigserial PRIMARY KEY,
  workspace_id  uuid NOT NULL,
  user_id       uuid NOT NULL,
  from_status   text,
  to_status     text NOT NULL,
  actor_user_id uuid REFERENCES users(id),
  reason        text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, user_id) REFERENCES memberships(workspace_id, user_id) ON DELETE CASCADE
);

-- ---------------------------------------------------------------- policy versions
-- Bumped on every grant/membership/policy change; authorization results report the version used.
ALTER TABLE workspaces ADD COLUMN policy_version bigint NOT NULL DEFAULT 1;
ALTER TABLE workspaces ADD COLUMN security_policy jsonb NOT NULL DEFAULT
  '{"mfa_required_for":["owner","admin","publisher","brand_manager"],"mfa_required_all":false,"step_up_seconds":300,"guest_max_days":90,"invite_ttl_hours":72}'::jsonb;

-- ---------------------------------------------------------------- teams
CREATE TABLE teams (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name         text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 80),
  description  text,
  created_by   uuid REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  archived_at  timestamptz,
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, name)
);

CREATE TABLE team_memberships (
  workspace_id uuid NOT NULL,
  team_id      uuid NOT NULL,
  user_id      uuid NOT NULL,
  is_manager   boolean NOT NULL DEFAULT false,
  added_by     uuid REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (team_id, user_id),
  FOREIGN KEY (workspace_id, team_id) REFERENCES teams(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, user_id) REFERENCES memberships(workspace_id, user_id) ON DELETE CASCADE
);
CREATE INDEX team_memberships_user_idx ON team_memberships(workspace_id, user_id);

-- Delegation ceiling for team managers: the roles and brands they may grant (to their team).
CREATE TABLE delegation_limits (
  workspace_id uuid NOT NULL,
  team_id      uuid NOT NULL,
  grantable_roles text[] NOT NULL DEFAULT '{}',
  brand_ids    uuid[] NOT NULL DEFAULT '{}',
  updated_by   uuid REFERENCES users(id),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (team_id),
  FOREIGN KEY (workspace_id, team_id) REFERENCES teams(workspace_id, id) ON DELETE CASCADE
);

-- ---------------------------------------------------------------- service accounts
CREATE TABLE service_accounts (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id   uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name           text NOT NULL,
  owner_user_id  uuid NOT NULL REFERENCES users(id),
  expires_at     timestamptz,
  disabled_at    timestamptz,
  last_used_at   timestamptz,
  created_by     uuid REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id)
);

CREATE TABLE api_key_hashes (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id       uuid NOT NULL,
  service_account_id uuid NOT NULL,
  prefix             text NOT NULL UNIQUE,          -- non-secret lookup prefix, e.g. sl_live_ab12cd34
  key_hash           bytea NOT NULL,                -- sha256 of the full key; key shown once
  created_by         uuid REFERENCES users(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  expires_at         timestamptz,
  revoked_at         timestamptz,
  revoked_by         uuid REFERENCES users(id),
  last_used_at       timestamptz,
  FOREIGN KEY (workspace_id, service_account_id) REFERENCES service_accounts(workspace_id, id) ON DELETE CASCADE
);

-- ---------------------------------------------------------------- scoped role grants
-- One row = principal holds role preset on scope. Effective permissions = union of active grants
-- (direct + via teams), minus restrictions, gated by membership status and mandatory policy.
CREATE TABLE scoped_role_grants (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id       uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  principal_type     text NOT NULL CHECK (principal_type IN ('user','team','service_account')),
  user_id            uuid,
  team_id            uuid,
  service_account_id uuid,
  role               text NOT NULL CHECK (role IN ('owner','admin','team_manager','brand_manager','editor','approver','publisher','analyst','viewer','exporter','guest','integration')),
  scope_type         text NOT NULL CHECK (scope_type IN ('workspace','brand','connection')),
  brand_id           uuid,
  connection_id      uuid,
  expires_at         timestamptz,
  granted_by         uuid REFERENCES users(id),
  source             text NOT NULL DEFAULT 'manual',   -- manual | invitation | v1_backfill | delegation
  created_at         timestamptz NOT NULL DEFAULT now(),
  revoked_at         timestamptz,
  revoked_by         uuid REFERENCES users(id),
  CHECK ((principal_type='user') = (user_id IS NOT NULL)),
  CHECK ((principal_type='team') = (team_id IS NOT NULL)),
  CHECK ((principal_type='service_account') = (service_account_id IS NOT NULL)),
  CHECK ((scope_type='workspace') = (brand_id IS NULL AND connection_id IS NULL)),
  CHECK (scope_type <> 'brand' OR (brand_id IS NOT NULL AND connection_id IS NULL)),
  CHECK (scope_type <> 'connection' OR (brand_id IS NOT NULL AND connection_id IS NOT NULL)),
  -- workspace-level presets only at workspace scope
  CHECK (role NOT IN ('owner','admin','team_manager') OR scope_type = 'workspace'),
  -- guests: brand/connection scope only and must expire
  CHECK (role <> 'guest' OR (scope_type <> 'workspace' AND expires_at IS NOT NULL)),
  -- service accounts never hold human administrative roles
  CHECK (principal_type <> 'service_account' OR role IN ('integration','viewer','editor')),
  FOREIGN KEY (workspace_id, user_id) REFERENCES memberships(workspace_id, user_id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, team_id) REFERENCES teams(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, service_account_id) REFERENCES service_accounts(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, brand_id) REFERENCES brands(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, connection_id) REFERENCES connections(workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX srg_user_idx ON scoped_role_grants(workspace_id, user_id) WHERE revoked_at IS NULL;
CREATE INDEX srg_team_idx ON scoped_role_grants(workspace_id, team_id) WHERE revoked_at IS NULL;
CREATE INDEX srg_sa_idx ON scoped_role_grants(workspace_id, service_account_id) WHERE revoked_at IS NULL;
CREATE UNIQUE INDEX srg_unique_active ON scoped_role_grants(
  workspace_id, principal_type, coalesce(user_id, team_id, service_account_id), role, scope_type,
  coalesce(brand_id, '00000000-0000-0000-0000-000000000000'::uuid), coalesce(connection_id, '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE revoked_at IS NULL;

-- Explicit restrictions (deny overrides allow) for a user on a scope.
CREATE TABLE access_restrictions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  user_id      uuid NOT NULL,
  brand_id     uuid,                 -- NULL = whole workspace
  actions      text[] NOT NULL,      -- permission identifiers denied, or '*'
  reason       text,
  expires_at   timestamptz,
  created_by   uuid REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  revoked_at   timestamptz,
  FOREIGN KEY (workspace_id, user_id) REFERENCES memberships(workspace_id, user_id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, brand_id) REFERENCES brands(workspace_id, id) ON DELETE CASCADE
);

-- ---------------------------------------------------------------- session assurance (server-trusted)
ALTER TABLE sessions ADD COLUMN acr text;
ALTER TABLE sessions ADD COLUMN amr text[] NOT NULL DEFAULT '{}';
ALTER TABLE sessions ADD COLUMN auth_time timestamptz;
ALTER TABLE sessions ADD COLUMN mfa_verified boolean NOT NULL DEFAULT false;
ALTER TABLE sessions ADD COLUMN rotated_from uuid;
ALTER TABLE sessions ADD COLUMN idp_session_id text;

-- ---------------------------------------------------------------- V1 backfill (no broadening)
-- owner/admin => workspace grants; editor/approver/viewer => workspace grant when unrestricted,
-- otherwise one brand grant per V1 brand grant. V1 "editors_can_publish" and V1 approver scheduling are
-- NOT converted into publisher grants (V2: approval does not grant publishing); they are listed for review.
INSERT INTO scoped_role_grants(workspace_id, principal_type, user_id, role, scope_type, source)
SELECT m.workspace_id, 'user', m.user_id, m.role::text, 'workspace', 'v1_backfill'
  FROM memberships m WHERE m.status <> 'removed' AND (m.role IN ('owner','admin') OR NOT m.brand_restricted);
INSERT INTO scoped_role_grants(workspace_id, principal_type, user_id, role, scope_type, brand_id, source)
SELECT m.workspace_id, 'user', m.user_id, m.role::text, 'brand', g.brand_id, 'v1_backfill'
  FROM memberships m JOIN membership_brand_grants g ON g.workspace_id=m.workspace_id AND g.user_id=m.user_id
 WHERE m.status <> 'removed' AND m.brand_restricted AND m.role NOT IN ('owner','admin');

CREATE TABLE migration_review_items (
  id           bigserial PRIMARY KEY,
  workspace_id uuid,
  kind         text NOT NULL,
  detail       jsonb NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  resolved_at  timestamptz
);
INSERT INTO migration_review_items(workspace_id, kind, detail)
SELECT b.workspace_id, 'v1_editors_can_publish', jsonb_build_object('brand_id', b.id, 'brand', b.name,
       'note', 'V1 let editors schedule on this brand. V2 requires an explicit publisher grant; none was created automatically.')
  FROM brands b WHERE b.editors_can_publish;
INSERT INTO migration_review_items(workspace_id, kind, detail)
SELECT m.workspace_id, 'v1_approver_scheduling', jsonb_build_object('user_id', m.user_id,
       'note', 'V1 approvers could schedule approved content. V2 approvers cannot publish; grant "publisher" if intended.')
  FROM memberships m WHERE m.role='approver' AND m.status <> 'removed';
