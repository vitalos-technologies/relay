-- V2 identity & security (stream A): session assurance plumbing, step-up/IdP-action states,
-- back-channel logout replay protection, service accounts + API keys, TipSignal as a service account.
-- Database least-privilege roles/grants are applied by scripts/db-roles.ts (infra/postgres/roles.sql),
-- not here: roles are cluster objects created by the platform, and grants must follow every migration.

-- ---------------------------------------------------------------- sessions
-- Assurance columns (acr, amr, auth_time, mfa_verified, rotated_from, idp_session_id) were added in 009.
ALTER TABLE sessions ADD COLUMN id_token_enc jsonb;          -- encrypted ID token: id_token_hint for RP-initiated logout only
ALTER TABLE sessions ADD COLUMN revoked_reason text;
ALTER TABLE sessions ADD COLUMN idp_subject text;           -- IdP subject the assurance was issued for (step-up must match)
CREATE INDEX sessions_idp_sid_idx ON sessions(idp_session_id) WHERE idp_session_id IS NOT NULL AND revoked_at IS NULL;
CREATE INDEX sessions_user_live_idx ON sessions(user_id, last_seen_at DESC) WHERE revoked_at IS NULL;

-- ---------------------------------------------------------------- OIDC state purposes
-- step_up: re-authentication bound to the current session; idp_action: Keycloak application-initiated action.
ALTER TABLE oauth_states DROP CONSTRAINT oauth_states_purpose_check;
ALTER TABLE oauth_states ADD CONSTRAINT oauth_states_purpose_check CHECK (purpose IN ('login','connect','step_up','idp_action'));
ALTER TABLE oauth_states ADD COLUMN session_id uuid REFERENCES sessions(id) ON DELETE CASCADE;
ALTER TABLE oauth_states ADD COLUMN idp_action text;

-- Back-channel logout tokens already processed (jti replay protection; pruned after 1 day).
CREATE TABLE idp_logout_tokens (
  jti         text PRIMARY KEY,
  sid         text,
  received_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- service accounts + API keys
ALTER TABLE service_accounts ADD COLUMN description text;
ALTER TABLE service_accounts ADD COLUMN purpose text NOT NULL DEFAULT 'api' CHECK (purpose IN ('api','tipsignal'));
ALTER TABLE service_accounts ADD COLUMN disabled_by uuid REFERENCES users(id);
ALTER TABLE service_accounts ADD CONSTRAINT service_accounts_name_check CHECK (length(trim(name)) BETWEEN 1 AND 80);
CREATE UNIQUE INDEX service_accounts_live_name ON service_accounts(workspace_id, lower(name)) WHERE disabled_at IS NULL;

ALTER TABLE api_key_hashes ADD COLUMN label text;
ALTER TABLE api_key_hashes ADD COLUMN rotated_from uuid REFERENCES api_key_hashes(id);
ALTER TABLE api_key_hashes ADD COLUMN revoked_reason text;
ALTER TABLE api_key_hashes ADD CONSTRAINT api_key_prefix_format CHECK (prefix ~ '^sl_live_[a-z0-9]{8,16}$');
CREATE INDEX api_key_hashes_sa_idx ON api_key_hashes(workspace_id, service_account_id);

-- ---------------------------------------------------------------- TipSignal → service-account principal
-- V1 bound TipSignal to a human "acting member". V2: drafts are created by a service account holding an
-- `integration` grant (content.create_draft only) on the bound brand. The acting member becomes the named owner.
ALTER TABLE integration_bindings ADD COLUMN service_account_id uuid;
ALTER TABLE integration_bindings ADD CONSTRAINT integration_bindings_sa_fk
  FOREIGN KEY (workspace_id, service_account_id) REFERENCES service_accounts(workspace_id, id);
ALTER TABLE integration_bindings ALTER COLUMN acting_user_id DROP NOT NULL;

INSERT INTO service_accounts(workspace_id, name, owner_user_id, purpose, created_by, description)
SELECT ib.workspace_id, 'TipSignal', ib.acting_user_id, 'tipsignal', ib.acting_user_id, 'Created by migration 010 from the V1 acting-member binding'
  FROM integration_bindings ib WHERE ib.kind = 'tipsignal' AND ib.acting_user_id IS NOT NULL;
UPDATE integration_bindings ib SET service_account_id = sa.id
  FROM service_accounts sa
 WHERE ib.kind = 'tipsignal' AND sa.workspace_id = ib.workspace_id AND sa.purpose = 'tipsignal' AND sa.disabled_at IS NULL;
INSERT INTO scoped_role_grants(workspace_id, principal_type, service_account_id, role, scope_type, brand_id, granted_by, source)
SELECT ib.workspace_id, 'service_account', ib.service_account_id, 'integration', 'brand', ib.brand_id, ib.acting_user_id, 'v1_backfill'
  FROM integration_bindings ib WHERE ib.kind = 'tipsignal' AND ib.service_account_id IS NOT NULL;
DELETE FROM integration_bindings WHERE service_account_id IS NULL;
ALTER TABLE integration_bindings ALTER COLUMN service_account_id SET NOT NULL;
UPDATE workspaces w SET policy_version = policy_version + 1 WHERE EXISTS (SELECT 1 FROM integration_bindings ib WHERE ib.workspace_id = w.id);

-- Posts/assets created by a service account carry no human author; attribution is in audit (actor_service).
-- (posts.created_by and assets.uploaded_by are already nullable.)

-- ---------------------------------------------------------------- local identity-provider switch (Dex → Keycloak)
-- Development-only: users bound to the retired local Dex issuer are returned to the "pending" state so the next
-- VERIFIED login through the local Keycloak realm re-binds them by email. Matches nothing outside local dev.
UPDATE users SET oidc_issuer = 'pending', oidc_subject = 'pending:' || email
 WHERE oidc_issuer = 'http://localhost:5556/dex';
