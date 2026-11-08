-- V2 tenancy & lifecycle (stream B): invitations v2 (scoped grants, resend, bulk, guest expiry,
-- identity-bound acceptance), ownership transfer, connection verification flags after offboarding,
-- publication authority (recorded at schedule time, revalidated at dispatch) and adoption events.
-- Additive only. memberships.role stays as a legacy summary derived from scoped_role_grants.

-- ---------------------------------------------------------------- invitations v2
-- grants: [{role, scope_type, brand_id, connection_id}] — validated server-side at create AND accept.
ALTER TABLE invitations ADD COLUMN grants jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE invitations ADD COLUMN team_ids uuid[] NOT NULL DEFAULT '{}';
ALTER TABLE invitations ADD COLUMN kind text NOT NULL DEFAULT 'member' CHECK (kind IN ('member','guest'));
-- Guests: the resulting grants expire at this instant (required for guests).
ALTER TABLE invitations ADD COLUMN access_expires_at timestamptz;
ALTER TABLE invitations ADD COLUMN resent_count integer NOT NULL DEFAULT 0;
ALTER TABLE invitations ADD COLUMN last_sent_at timestamptz;
ALTER TABLE invitations ADD COLUMN revoked_by uuid REFERENCES users(id);
ALTER TABLE invitations ADD COLUMN batch_id uuid;
-- Identity that accepted (issuer + subject), never just an email string.
ALTER TABLE invitations ADD COLUMN accepted_issuer text;
ALTER TABLE invitations ADD COLUMN accepted_subject text;
ALTER TABLE invitations ADD CONSTRAINT invitations_guest_expiry CHECK (kind <> 'guest' OR access_expires_at IS NOT NULL);
ALTER TABLE invitations ADD CONSTRAINT invitations_single_accept CHECK ((accepted_at IS NULL) = (accepted_by IS NULL)) NOT VALID;
CREATE INDEX invitations_ws_open_idx ON invitations(workspace_id, created_at DESC) WHERE accepted_at IS NULL AND revoked_at IS NULL;

-- Default invite TTL is 72 h (security_policy.invite_ttl_hours); guests default to 30 days, max guest_max_days.
UPDATE workspaces SET security_policy = security_policy || '{"guest_default_days":30}'::jsonb
 WHERE NOT security_policy ? 'guest_default_days';
ALTER TABLE workspaces ALTER COLUMN security_policy SET DEFAULT
  '{"mfa_required_for":["owner","admin","publisher","brand_manager"],"mfa_required_all":false,"step_up_seconds":300,"guest_max_days":90,"guest_default_days":30,"invite_ttl_hours":72}'::jsonb;

-- ---------------------------------------------------------------- grants bookkeeping
ALTER TABLE scoped_role_grants ADD COLUMN revoke_reason text;
ALTER TABLE access_restrictions ADD COLUMN revoked_by uuid REFERENCES users(id);
CREATE INDEX access_restrictions_user_idx ON access_restrictions(workspace_id, user_id) WHERE revoked_at IS NULL;
CREATE INDEX team_memberships_team_idx ON team_memberships(workspace_id, team_id);

-- ---------------------------------------------------------------- ownership transfer
-- Two-step: the owner proposes (fresh authentication), the new owner accepts. One pending per workspace.
CREATE TABLE ownership_transfers (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  from_user_id  uuid NOT NULL REFERENCES users(id),
  to_user_id    uuid NOT NULL REFERENCES users(id),
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','cancelled','declined','expired')),
  keep_previous_owner_as text CHECK (keep_previous_owner_as IN ('admin','none')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  decided_at    timestamptz,
  decided_by    uuid REFERENCES users(id),
  CHECK (from_user_id <> to_user_id)
);
CREATE UNIQUE INDEX ownership_transfers_one_pending ON ownership_transfers(workspace_id) WHERE status = 'pending';

-- ---------------------------------------------------------------- connection verification after offboarding
-- A connection authorised by a departing member may depend on that person's provider access. We flag it;
-- we never claim that a local reassignment moves provider ownership.
ALTER TABLE connections ADD COLUMN verification_requested_at timestamptz;
ALTER TABLE connections ADD COLUMN verification_reason text;

-- ---------------------------------------------------------------- publication authority
-- Recorded when a schedule becomes active (timed/immediate schedule, or approval activation).
-- The worker revalidates it at dispatch; failures HOLD (deliveries 'blocked', code authority_hold)
-- for adoption by an authorised publisher. Loosening policy never auto-releases a hold.
CREATE TABLE publication_authorizations (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id       uuid NOT NULL,
  brand_id           uuid NOT NULL,
  schedule_id        uuid NOT NULL,
  post_id            uuid NOT NULL,
  revision_id        uuid NOT NULL,
  connection_ids     uuid[] NOT NULL,
  -- 'scheduler': the principal scheduled it and must still hold principal_permission on the brand.
  -- 'approval': activated by approval; the recorded approvers must still hold content.approve.
  basis              text NOT NULL CHECK (basis IN ('scheduler','approval')),
  principal_user_id  uuid REFERENCES users(id),
  principal_permission text NOT NULL CHECK (principal_permission IN ('content.schedule','content.publish','content.submit')),
  approval_ids       uuid[] NOT NULL DEFAULT '{}',
  approver_user_ids  uuid[] NOT NULL DEFAULT '{}',
  policy_version     bigint NOT NULL,
  status             text NOT NULL DEFAULT 'active' CHECK (status IN ('active','held')),
  hold_code          text,
  hold_detail        text,
  held_at            timestamptz,
  last_validated_at  timestamptz,
  last_validated_policy_version bigint,
  adopted_by         uuid REFERENCES users(id),
  adopted_at         timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (schedule_id),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, schedule_id) REFERENCES schedules(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, brand_id) REFERENCES brands(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, revision_id) REFERENCES post_revisions(workspace_id, id)
);
CREATE INDEX publication_authorizations_held_idx ON publication_authorizations(workspace_id, brand_id) WHERE status = 'held';
CREATE INDEX publication_authorizations_principal_idx ON publication_authorizations(workspace_id, principal_user_id);

-- The scope a publication was authorised for is immutable (revision, destinations, tenant, brand, schedule).
CREATE FUNCTION publication_authorizations_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.workspace_id <> OLD.workspace_id OR NEW.brand_id <> OLD.brand_id OR NEW.schedule_id <> OLD.schedule_id
     OR NEW.post_id <> OLD.post_id OR NEW.revision_id <> OLD.revision_id OR NEW.connection_ids <> OLD.connection_ids
     OR NEW.approval_ids <> OLD.approval_ids OR NEW.basis <> OLD.basis THEN
    RAISE EXCEPTION 'publication_authorizations scope is immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER publication_authorizations_immutable BEFORE UPDATE ON publication_authorizations
  FOR EACH ROW EXECUTE FUNCTION publication_authorizations_immutable();

CREATE TABLE adoption_events (
  id                 bigserial PRIMARY KEY,
  workspace_id       uuid NOT NULL,
  brand_id           uuid NOT NULL,
  schedule_id        uuid NOT NULL,
  authorization_id   uuid NOT NULL,
  from_user_id       uuid REFERENCES users(id),
  to_user_id         uuid NOT NULL REFERENCES users(id),
  hold_code          text,
  policy_version     bigint NOT NULL,
  requeued           integer NOT NULL DEFAULT 0,
  expired            integer NOT NULL DEFAULT 0,
  correlation_id     text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, authorization_id) REFERENCES publication_authorizations(workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX adoption_events_ws_idx ON adoption_events(workspace_id, created_at DESC);

-- ---------------------------------------------------------------- backfill
-- Live schedules created before V2 get an authority record naming their creator (scheduler) or approvers.
-- They are revalidated at dispatch like any other; nothing is broadened.
INSERT INTO publication_authorizations(workspace_id, brand_id, schedule_id, post_id, revision_id, connection_ids, basis,
                                       principal_user_id, principal_permission, approval_ids, approver_user_ids, policy_version)
SELECT s.workspace_id, s.brand_id, s.id, s.post_id, s.revision_id,
       coalesce((SELECT array_agg(v.connection_id ORDER BY v.connection_id) FROM variants v WHERE v.revision_id = s.revision_id), '{}'),
       CASE WHEN a.id IS NULL THEN 'scheduler' ELSE 'approval' END,
       s.created_by,
       CASE WHEN a.id IS NOT NULL THEN 'content.submit' WHEN s.is_immediate THEN 'content.publish' ELSE 'content.schedule' END,
       CASE WHEN a.id IS NULL THEN '{}'::uuid[] ELSE ARRAY[a.id] END,
       CASE WHEN a.reviewer_id IS NULL THEN '{}'::uuid[] ELSE ARRAY[a.reviewer_id] END,
       w.policy_version
  FROM schedules s JOIN workspaces w ON w.id = s.workspace_id
  LEFT JOIN LATERAL (SELECT id, reviewer_id FROM approvals WHERE schedule_id = s.id AND decision = 'approved' ORDER BY decided_at DESC LIMIT 1) a ON true
 WHERE s.status = 'active'
ON CONFLICT (schedule_id) DO NOTHING;
