-- V2 collaboration (stream C): campaigns, assignments, draft version history + conflict copies,
-- comments (internal vs shared) and mentions, approval policies (0/1/2 sequential stages, quorum of
-- distinct currently-eligible people, separation of duties, policy generations), immutable approval
-- decisions, guest review shares, notification preferences (in-app/email/digest, quiet hours).
-- Additive. brands.approval_required is kept as a DERIVED compatibility flag (stage_count > 0) that only
-- the approval-policy service may change.

-- ---------------------------------------------------------------- campaigns
CREATE TABLE campaigns (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  brand_id     uuid NOT NULL,
  name         text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 120),
  description  text CHECK (description IS NULL OR length(description) <= 2000),
  starts_on    date,
  ends_on      date,
  created_by   uuid REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  archived_at  timestamptz,
  CHECK (starts_on IS NULL OR ends_on IS NULL OR ends_on >= starts_on),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, brand_id, id),
  FOREIGN KEY (workspace_id, brand_id) REFERENCES brands(workspace_id, id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX campaigns_name_active ON campaigns(workspace_id, brand_id, lower(name)) WHERE archived_at IS NULL;

-- ---------------------------------------------------------------- post planning (campaign 0..1, assignee, due, owning team)
ALTER TABLE posts ADD COLUMN campaign_id uuid;
ALTER TABLE posts ADD COLUMN assignee_user_id uuid REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE posts ADD COLUMN due_at timestamptz;
ALTER TABLE posts ADD COLUMN team_id uuid;
-- A post's campaign must belong to the post's own brand (composite FK; NULL = no campaign).
ALTER TABLE posts ADD CONSTRAINT posts_campaign_fk FOREIGN KEY (workspace_id, brand_id, campaign_id)
  REFERENCES campaigns(workspace_id, brand_id, id) ON DELETE SET NULL (campaign_id);
ALTER TABLE posts ADD CONSTRAINT posts_team_fk FOREIGN KEY (workspace_id, team_id)
  REFERENCES teams(workspace_id, id) ON DELETE SET NULL (team_id);
CREATE INDEX posts_assignee_idx ON posts(workspace_id, assignee_user_id) WHERE assignee_user_id IS NOT NULL;
CREATE INDEX posts_campaign_idx ON posts(campaign_id) WHERE campaign_id IS NOT NULL;

-- ---------------------------------------------------------------- draft version history
-- Every committed draft save is a version. A save rejected by optimistic concurrency is kept as a
-- 'conflict' copy (version NULL) so neither editor's work is lost. Rows are immutable.
CREATE TABLE post_versions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL,
  post_id       uuid NOT NULL,
  version       integer,                 -- post version this snapshot became; NULL for a conflict copy
  base_version  integer NOT NULL,        -- version the editor started from
  kind          text NOT NULL CHECK (kind IN ('created','saved','conflict','restored')),
  title         text,
  draft         jsonb NOT NULL,
  saved_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  restored_from uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'conflict') = (version IS NULL)),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, post_id) REFERENCES posts(workspace_id, id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX post_versions_version_uq ON post_versions(post_id, version) WHERE version IS NOT NULL;
CREATE INDEX post_versions_post_idx ON post_versions(post_id, created_at DESC);
CREATE TRIGGER post_versions_immutable BEFORE UPDATE ON post_versions FOR EACH ROW EXECUTE FUNCTION forbid_update();
INSERT INTO post_versions(workspace_id, post_id, version, base_version, kind, title, draft, saved_by, created_at)
SELECT workspace_id, id, version, version, 'saved', title, draft, coalesce(updated_by, created_by), updated_at FROM posts;

-- ---------------------------------------------------------------- approval policies
-- One immutable row per policy generation; approval_policies points at the current generation.
CREATE TABLE approval_policy_versions (
  workspace_id         uuid NOT NULL,
  brand_id             uuid NOT NULL,
  generation           integer NOT NULL CHECK (generation >= 1),
  separation_of_duties boolean NOT NULL DEFAULT false,
  stage_count          smallint NOT NULL CHECK (stage_count BETWEEN 0 AND 2),
  created_by           uuid REFERENCES users(id),
  created_at           timestamptz NOT NULL DEFAULT now(),
  reason               text,
  PRIMARY KEY (brand_id, generation),
  FOREIGN KEY (workspace_id, brand_id) REFERENCES brands(workspace_id, id) ON DELETE CASCADE
);
CREATE TRIGGER approval_policy_versions_immutable BEFORE UPDATE ON approval_policy_versions FOR EACH ROW EXECUTE FUNCTION forbid_update();

CREATE TABLE approval_stages (
  workspace_id      uuid NOT NULL,
  brand_id          uuid NOT NULL,
  generation        integer NOT NULL,
  position          smallint NOT NULL CHECK (position IN (1, 2)),
  name              text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 60),
  quorum            smallint NOT NULL DEFAULT 1 CHECK (quorum BETWEEN 1 AND 10),
  -- empty = anyone holding content.approve on the brand; otherwise one of these presets must grant it
  eligible_roles    text[] NOT NULL DEFAULT '{}' CHECK (eligible_roles <@ ARRAY['owner','admin','approver']::text[]),
  -- empty = any team; otherwise the reviewer must belong to one of these teams
  eligible_team_ids uuid[] NOT NULL DEFAULT '{}',
  allow_guests      boolean NOT NULL DEFAULT false,
  PRIMARY KEY (brand_id, generation, position),
  FOREIGN KEY (brand_id, generation) REFERENCES approval_policy_versions(brand_id, generation) ON DELETE CASCADE
);
CREATE TRIGGER approval_stages_immutable BEFORE UPDATE ON approval_stages FOR EACH ROW EXECUTE FUNCTION forbid_update();

CREATE TABLE approval_policies (
  workspace_id uuid NOT NULL,
  brand_id     uuid PRIMARY KEY,
  generation   integer NOT NULL,
  updated_by   uuid REFERENCES users(id),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, brand_id) REFERENCES brands(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (brand_id, generation) REFERENCES approval_policy_versions(brand_id, generation)
);

-- Backfill: V1 approval_required=true => one stage, quorum 1, any approver; false => no approval.
INSERT INTO approval_policy_versions(workspace_id, brand_id, generation, separation_of_duties, stage_count, reason)
SELECT workspace_id, id, 1, false, CASE WHEN approval_required THEN 1 ELSE 0 END, 'v1_backfill' FROM brands;
INSERT INTO approval_stages(workspace_id, brand_id, generation, position, name, quorum)
SELECT workspace_id, id, 1, 1, 'Review', 1 FROM brands WHERE approval_required;
INSERT INTO approval_policies(workspace_id, brand_id, generation) SELECT workspace_id, id, 1 FROM brands;

-- New brands get a generation-1 policy matching their initial approval_required flag.
CREATE OR REPLACE FUNCTION brands_default_approval_policy() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO approval_policy_versions(workspace_id, brand_id, generation, separation_of_duties, stage_count, reason)
  VALUES (NEW.workspace_id, NEW.id, 1, false, CASE WHEN NEW.approval_required THEN 1 ELSE 0 END, 'initial');
  IF NEW.approval_required THEN
    INSERT INTO approval_stages(workspace_id, brand_id, generation, position, name, quorum) VALUES (NEW.workspace_id, NEW.id, 1, 1, 'Review', 1);
  END IF;
  INSERT INTO approval_policies(workspace_id, brand_id, generation) VALUES (NEW.workspace_id, NEW.id, 1);
  RETURN NEW;
END $$;
CREATE TRIGGER brands_default_approval_policy AFTER INSERT ON brands FOR EACH ROW EXECUTE FUNCTION brands_default_approval_policy();

-- approval_required is derived from the policy: only the policy service (which sets the transaction-local
-- flag) may change it, so no legacy path can silently weaken review.
CREATE OR REPLACE FUNCTION brands_guard_approval_required() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.approval_required IS DISTINCT FROM OLD.approval_required
     AND coalesce(current_setting('social_lite.approval_policy_write', true), '') <> 'on' THEN
    RAISE EXCEPTION 'brands.approval_required is derived from the approval policy; change the policy instead' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER brands_guard_approval_required BEFORE UPDATE OF approval_required ON brands FOR EACH ROW EXECUTE FUNCTION brands_guard_approval_required();

-- ---------------------------------------------------------------- review requests (approvals) bind policy + evidence
ALTER TABLE approvals ADD COLUMN policy_generation integer;
ALTER TABLE approvals ADD COLUMN stage_count smallint NOT NULL DEFAULT 1;
ALTER TABLE approvals ADD COLUMN current_stage smallint NOT NULL DEFAULT 1;
ALTER TABLE approvals ADD COLUMN binding_hash text;            -- revision + asset versions + destinations + links + schedule + policy generation
ALTER TABLE approvals ADD COLUMN binding jsonb;                -- safe summary of what the hash covers
ALTER TABLE approvals ADD COLUMN author_ids uuid[] NOT NULL DEFAULT '{}';  -- authors/editors of the revision (separation of duties)
ALTER TABLE approvals ADD COLUMN assignee_user_id uuid REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE approvals ADD COLUMN due_at timestamptz;
UPDATE approvals SET policy_generation = 1;
CREATE INDEX approvals_assignee_idx ON approvals(workspace_id, assignee_user_id) WHERE decision = 'pending';
CREATE INDEX approvals_post_idx ON approvals(post_id, requested_at DESC);

-- Immutable evidence: one row per reviewer per stage (a person counts once per stage).
CREATE TABLE approval_decisions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id      uuid NOT NULL,
  approval_id       uuid NOT NULL,
  stage             smallint NOT NULL CHECK (stage IN (1, 2)),
  user_id           uuid NOT NULL REFERENCES users(id),
  decision          text NOT NULL CHECK (decision IN ('approved','rejected')),
  reason            text,
  policy_generation integer NOT NULL,
  fingerprint       text NOT NULL,
  binding_hash      text,
  as_guest          boolean NOT NULL DEFAULT false,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (approval_id, stage, user_id),
  FOREIGN KEY (workspace_id, approval_id) REFERENCES approvals(workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX approval_decisions_approval_idx ON approval_decisions(approval_id);
CREATE TRIGGER approval_decisions_immutable BEFORE UPDATE ON approval_decisions FOR EACH ROW EXECUTE FUNCTION forbid_update();
INSERT INTO approval_decisions(workspace_id, approval_id, stage, user_id, decision, reason, policy_generation, fingerprint, created_at)
SELECT workspace_id, id, 1, reviewer_id, decision, reason, 1, fingerprint, coalesce(decided_at, requested_at)
  FROM approvals WHERE decision IN ('approved','rejected') AND reviewer_id IS NOT NULL;

-- ---------------------------------------------------------------- guest review shares (authenticated, resource-scoped)
-- A guest sees ONLY the review requests of posts explicitly shared with them (never drafts, library or other posts).
CREATE TABLE review_shares (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  post_id      uuid NOT NULL,
  user_id      uuid NOT NULL,
  shared_by    uuid REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  revoked_at   timestamptz,
  revoked_by   uuid REFERENCES users(id),
  FOREIGN KEY (workspace_id, post_id) REFERENCES posts(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, user_id) REFERENCES memberships(workspace_id, user_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX review_shares_active ON review_shares(post_id, user_id) WHERE revoked_at IS NULL;
CREATE INDEX review_shares_user_idx ON review_shares(workspace_id, user_id) WHERE revoked_at IS NULL;

-- ---------------------------------------------------------------- comments + mentions
CREATE TABLE comments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  brand_id     uuid NOT NULL,
  post_id      uuid NOT NULL,
  approval_id  uuid,
  visibility   text NOT NULL CHECK (visibility IN ('internal','shared')),
  author_id    uuid REFERENCES users(id) ON DELETE SET NULL,
  body         text NOT NULL CHECK (length(trim(body)) BETWEEN 1 AND 5000),
  created_at   timestamptz NOT NULL DEFAULT now(),
  deleted_at   timestamptz,
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, post_id) REFERENCES posts(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, brand_id) REFERENCES brands(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, approval_id) REFERENCES approvals(workspace_id, id) ON DELETE SET NULL (approval_id)
);
CREATE INDEX comments_post_idx ON comments(post_id, created_at);

CREATE TABLE comment_mentions (
  workspace_id   uuid NOT NULL,
  comment_id     uuid NOT NULL,
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  notified_at    timestamptz,
  skipped_reason text,
  PRIMARY KEY (comment_id, user_id),
  FOREIGN KEY (workspace_id, comment_id) REFERENCES comments(workspace_id, id) ON DELETE CASCADE
);

-- ---------------------------------------------------------------- notification preferences, digest, quiet hours
CREATE TABLE notification_preferences (
  workspace_id uuid NOT NULL,
  user_id      uuid NOT NULL,
  event_type   text NOT NULL CHECK (event_type IN ('mention','comment','review_requested','review_decided','assignment','publishing_problem','account_health','budget')),
  in_app       boolean NOT NULL DEFAULT true,
  email        boolean NOT NULL DEFAULT false,
  digest       boolean NOT NULL DEFAULT false,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id, event_type),
  FOREIGN KEY (workspace_id, user_id) REFERENCES memberships(workspace_id, user_id) ON DELETE CASCADE
);

CREATE TABLE notification_settings (
  workspace_id   uuid NOT NULL,
  user_id        uuid NOT NULL,
  timezone       text NOT NULL DEFAULT 'UTC',
  quiet_start    smallint CHECK (quiet_start BETWEEN 0 AND 1439),   -- minutes after local midnight
  quiet_end      smallint CHECK (quiet_end BETWEEN 0 AND 1439),
  digest_hour    smallint NOT NULL DEFAULT 8 CHECK (digest_hour BETWEEN 0 AND 23),
  last_digest_at timestamptz,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id),
  CHECK ((quiet_start IS NULL) = (quiet_end IS NULL)),
  FOREIGN KEY (workspace_id, user_id) REFERENCES memberships(workspace_id, user_id) ON DELETE CASCADE
);

ALTER TABLE notifications ADD COLUMN event_type text;
ALTER TABLE notifications ADD COLUMN brand_id uuid;                 -- re-checked at read and at email send
ALTER TABLE notifications ADD COLUMN required_permission text;      -- permission the recipient must still hold
ALTER TABLE notifications ADD COLUMN in_app boolean NOT NULL DEFAULT true;
ALTER TABLE notifications ADD COLUMN email_state text NOT NULL DEFAULT 'none' CHECK (email_state IN ('none','pending','digest','sent','skipped'));
ALTER TABLE notifications ADD COLUMN email_after timestamptz;
ALTER TABLE notifications ADD COLUMN critical_security boolean NOT NULL DEFAULT false;
CREATE INDEX notifications_email_pending_idx ON notifications(email_after) WHERE email_state = 'pending';
CREATE INDEX notifications_digest_idx ON notifications(workspace_id, user_id) WHERE email_state = 'digest';
