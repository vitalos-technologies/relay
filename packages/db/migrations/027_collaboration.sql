-- Collaboration completion (brief docs/queue/03d_COLLABORATION_PROMPT.md). Additive; extends V2 stream C (012).
--
--  * Threads: every comment belongs to a comment_threads row. Visibility (internal | shared) lives on the thread and a
--    trigger refuses a comment whose visibility differs from its thread, so an internal reply can never land in a
--    client-visible thread. Existing comments are backfilled as one-comment threads (thread id = comment id) and a
--    compat trigger does the same for any insert without a thread.
--  * Edit history (comment_edits, immutable) and tombstones (comments.deleted_at + deleted_by; body replaced).
--  * Per-user thread read state (unread indicators).
--  * Tasks (collab_tasks + followers + immutable events): linked to a post, campaign or review request; editorial due
--    dates are separate from publication time.
--  * Requested reviewers for a review request (eligibility is decided by the approval engine, never by this table).
--  * Presence heartbeats (short-lived; purged by the worker) and collab_events (content-free change feed for realtime).
--  * Notifications: deep link, actor, delivery diagnostics, failed / not_configured email states, 'reminder' type.
--  * Workspace collaboration settings (client discussion, task assignment, offboarding, reminders, notification defaults).
-- Rollback: DROP TABLE collab_events, post_presence, approval_reviewer_requests, collab_task_events, collab_task_followers,
--   collab_tasks, comment_thread_reads, comment_edits, workspace_collab_settings CASCADE; DROP TRIGGER comments_thread_compat,
--   comments_visibility_matches_thread ON comments; ALTER TABLE comments DROP COLUMN thread_id, edited_at, deleted_by,
--   client_key; DROP TABLE comment_threads; restore the 012 CHECK constraints on notifications / notification_preferences;
--   ALTER TABLE notifications DROP COLUMN link_path, actor_id, email_error, email_attempts; ALTER TABLE approvals DROP
--   COLUMN overdue_notified_at.

-- ---------------------------------------------------------------- threads
CREATE TABLE comment_threads (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id       uuid NOT NULL,
  brand_id           uuid NOT NULL,
  post_id            uuid NOT NULL,
  approval_id        uuid,
  visibility         text NOT NULL CHECK (visibility IN ('internal','shared')),
  created_by         uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  -- What the thread refers to: the draft version it was started on, the submitted revision (from a review) and an
  -- optional anchor ({kind:'text', field, connection_id?, quote, prefix, suffix} | {kind:'media', asset_id}).
  anchor_version     integer,
  anchor_revision_id uuid,
  anchor             jsonb,
  resolved_at        timestamptz,
  resolved_by        uuid REFERENCES users(id) ON DELETE SET NULL,
  last_activity_at   timestamptz NOT NULL DEFAULT now(),
  last_actor_id      uuid REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, post_id) REFERENCES posts(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, brand_id) REFERENCES brands(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, approval_id) REFERENCES approvals(workspace_id, id) ON DELETE SET NULL (approval_id),
  CHECK (anchor IS NULL OR (jsonb_typeof(anchor) = 'object' AND length(anchor::text) <= 2000))
);
CREATE INDEX comment_threads_post_idx ON comment_threads(post_id, last_activity_at DESC, id);
CREATE INDEX comment_threads_approval_idx ON comment_threads(approval_id) WHERE approval_id IS NOT NULL;

ALTER TABLE comments ADD COLUMN thread_id uuid;
ALTER TABLE comments ADD COLUMN edited_at timestamptz;
ALTER TABLE comments ADD COLUMN deleted_by uuid REFERENCES users(id) ON DELETE SET NULL;
-- Client-generated key: a retried post (lost response, reconnect) returns the original comment instead of a duplicate.
ALTER TABLE comments ADD COLUMN client_key text CHECK (client_key IS NULL OR client_key ~ '^[A-Za-z0-9_-]{8,64}$');

INSERT INTO comment_threads(id, workspace_id, brand_id, post_id, approval_id, visibility, created_by, created_at, last_activity_at, last_actor_id)
SELECT id, workspace_id, brand_id, post_id, approval_id, visibility, author_id, created_at, created_at, author_id FROM comments;
UPDATE comments SET thread_id = id;
ALTER TABLE comments ALTER COLUMN thread_id SET NOT NULL;
ALTER TABLE comments ADD CONSTRAINT comments_thread_fk FOREIGN KEY (workspace_id, thread_id) REFERENCES comment_threads(workspace_id, id) ON DELETE CASCADE;
CREATE INDEX comments_thread_idx ON comments(thread_id, created_at, id);
CREATE UNIQUE INDEX comments_client_key_uq ON comments(author_id, client_key) WHERE client_key IS NOT NULL;

-- Compat: an insert without a thread (older code paths) becomes its own thread.
CREATE OR REPLACE FUNCTION comments_thread_compat() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.thread_id IS NULL THEN
    INSERT INTO comment_threads(id, workspace_id, brand_id, post_id, approval_id, visibility, created_by, created_at, last_activity_at, last_actor_id)
    VALUES (NEW.id, NEW.workspace_id, NEW.brand_id, NEW.post_id, NEW.approval_id, NEW.visibility, NEW.author_id, NEW.created_at, NEW.created_at, NEW.author_id);
    NEW.thread_id := NEW.id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER comments_thread_compat BEFORE INSERT ON comments FOR EACH ROW EXECUTE FUNCTION comments_thread_compat();

-- A comment's visibility always equals its thread's (internal replies can never appear in a shared thread).
CREATE OR REPLACE FUNCTION comments_visibility_matches_thread() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE t record;
BEGIN
  SELECT visibility, post_id INTO t FROM comment_threads WHERE id = NEW.thread_id;
  IF t.visibility IS DISTINCT FROM NEW.visibility OR t.post_id IS DISTINCT FROM NEW.post_id THEN
    RAISE EXCEPTION 'comment visibility/post must match its thread' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER comments_visibility_matches_thread AFTER INSERT OR UPDATE OF visibility, thread_id ON comments
  FOR EACH ROW EXECUTE FUNCTION comments_visibility_matches_thread();

-- Edit history: previous bodies, immutable. Rows of a deleted comment are removed with the tombstone.
CREATE TABLE comment_edits (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  comment_id   uuid NOT NULL,
  body         text NOT NULL,
  edited_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, comment_id) REFERENCES comments(workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX comment_edits_comment_idx ON comment_edits(comment_id, created_at);
CREATE TRIGGER comment_edits_immutable BEFORE UPDATE ON comment_edits FOR EACH ROW EXECUTE FUNCTION forbid_update();

ALTER TABLE comment_mentions ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE comment_mentions ADD COLUMN removed_at timestamptz;

CREATE TABLE comment_thread_reads (
  workspace_id uuid NOT NULL,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  thread_id    uuid NOT NULL,
  read_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, thread_id),
  FOREIGN KEY (workspace_id, thread_id) REFERENCES comment_threads(workspace_id, id) ON DELETE CASCADE
);

-- ---------------------------------------------------------------- tasks
CREATE TABLE collab_tasks (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id       uuid NOT NULL,
  brand_id           uuid NOT NULL,
  post_id            uuid,
  campaign_id        uuid,
  approval_id        uuid,
  title              text NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 200),
  description        text CHECK (description IS NULL OR length(description) <= 4000),
  assignee_id        uuid REFERENCES users(id) ON DELETE SET NULL,
  created_by         uuid REFERENCES users(id) ON DELETE SET NULL,
  -- Editorial deadline: independent of any schedule (moving it never reschedules anything).
  due_at             timestamptz,
  due_timezone       text NOT NULL DEFAULT 'UTC' CHECK (length(due_timezone) BETWEEN 1 AND 64),
  priority           text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high','urgent')),
  status             text NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','blocked','completed','cancelled')),
  blocked_reason     text CHECK (blocked_reason IS NULL OR length(blocked_reason) <= 500),
  needs_reassignment boolean NOT NULL DEFAULT false,
  reassign_reason    text,
  version            integer NOT NULL DEFAULT 1,
  -- Bounded reminders: one "due soon" per due date, at most N overdue reminders (workspace setting).
  reminded_soon_for  timestamptz,
  overdue_reminders  smallint NOT NULL DEFAULT 0,
  last_reminded_at   timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  closed_at          timestamptz,
  closed_by          uuid REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, brand_id) REFERENCES brands(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, post_id) REFERENCES posts(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, brand_id, campaign_id) REFERENCES campaigns(workspace_id, brand_id, id) ON DELETE SET NULL (campaign_id),
  FOREIGN KEY (workspace_id, approval_id) REFERENCES approvals(workspace_id, id) ON DELETE SET NULL (approval_id),
  CHECK ((status IN ('completed','cancelled')) = (closed_at IS NOT NULL))
);
CREATE INDEX collab_tasks_assignee_idx ON collab_tasks(workspace_id, assignee_id, due_at NULLS LAST, id) WHERE status IN ('open','in_progress','blocked');
CREATE INDEX collab_tasks_creator_idx ON collab_tasks(workspace_id, created_by, updated_at DESC, id);
CREATE INDEX collab_tasks_due_idx ON collab_tasks(due_at) WHERE status IN ('open','in_progress','blocked') AND due_at IS NOT NULL;
CREATE INDEX collab_tasks_post_idx ON collab_tasks(post_id, created_at) WHERE post_id IS NOT NULL;
CREATE INDEX collab_tasks_reassign_idx ON collab_tasks(workspace_id) WHERE needs_reassignment;

CREATE TABLE collab_task_followers (
  workspace_id uuid NOT NULL,
  task_id      uuid NOT NULL,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (task_id, user_id),
  FOREIGN KEY (workspace_id, task_id) REFERENCES collab_tasks(workspace_id, id) ON DELETE CASCADE
);

CREATE TABLE collab_task_events (
  id           bigserial PRIMARY KEY,
  workspace_id uuid NOT NULL,
  task_id      uuid NOT NULL,
  actor_id     uuid REFERENCES users(id) ON DELETE SET NULL,
  actor_service text,
  kind         text NOT NULL CHECK (length(kind) BETWEEN 3 AND 40),
  detail       jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, task_id) REFERENCES collab_tasks(workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX collab_task_events_task_idx ON collab_task_events(task_id, id);
CREATE TRIGGER collab_task_events_immutable BEFORE UPDATE ON collab_task_events FOR EACH ROW EXECUTE FUNCTION forbid_update();

-- ---------------------------------------------------------------- review requests to named reviewers
CREATE TABLE approval_reviewer_requests (
  workspace_id uuid NOT NULL,
  approval_id  uuid NOT NULL,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  requested_by uuid REFERENCES users(id) ON DELETE SET NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (approval_id, user_id),
  FOREIGN KEY (workspace_id, approval_id) REFERENCES approvals(workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX approval_reviewer_requests_user_idx ON approval_reviewer_requests(workspace_id, user_id);
ALTER TABLE approvals ADD COLUMN overdue_notified_at timestamptz;
CREATE INDEX approvals_review_due_idx ON approvals(due_at) WHERE decision = 'pending' AND due_at IS NOT NULL AND overdue_notified_at IS NULL;

-- ---------------------------------------------------------------- presence (informational only; purged after 10 min)
CREATE TABLE post_presence (
  workspace_id uuid NOT NULL,
  post_id      uuid NOT NULL,
  user_id      uuid NOT NULL,
  client_id    text NOT NULL CHECK (client_id ~ '^[A-Za-z0-9_-]{8,64}$'),
  state        text NOT NULL CHECK (state IN ('viewing','editing')),
  started_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (post_id, user_id, client_id),
  FOREIGN KEY (workspace_id, post_id) REFERENCES posts(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, user_id) REFERENCES memberships(workspace_id, user_id) ON DELETE CASCADE
);
CREATE INDEX post_presence_seen_idx ON post_presence(last_seen_at);

-- ---------------------------------------------------------------- change feed (content-free; for realtime + reconnect)
-- audience: internal = comments.internal on the brand; shared = anyone who may read the post (staff or shared guest);
-- staff = staff content.read on the brand; user = only user_id.
CREATE TABLE collab_events (
  id           bigserial PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  brand_id     uuid,
  post_id      uuid,
  audience     text NOT NULL CHECK (audience IN ('internal','shared','staff','user')),
  user_id      uuid,
  kind         text NOT NULL CHECK (length(kind) BETWEEN 3 AND 40),
  ref_id       text,
  actor_id     uuid,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CHECK ((audience = 'user') = (user_id IS NOT NULL))
);
CREATE INDEX collab_events_post_idx ON collab_events(post_id, id) WHERE post_id IS NOT NULL;
CREATE INDEX collab_events_user_idx ON collab_events(user_id, id) WHERE user_id IS NOT NULL;
CREATE INDEX collab_events_created_idx ON collab_events(created_at);

-- ---------------------------------------------------------------- notifications
ALTER TABLE notifications ADD COLUMN link_path text CHECK (link_path IS NULL OR (link_path ~ '^/[A-Za-z0-9]' AND length(link_path) <= 300));
ALTER TABLE notifications ADD COLUMN actor_id uuid REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE notifications ADD COLUMN email_error text CHECK (email_error IS NULL OR length(email_error) <= 120);
ALTER TABLE notifications ADD COLUMN email_attempts smallint NOT NULL DEFAULT 0;
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_email_state_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_email_state_check
  CHECK (email_state IN ('none','pending','digest','sent','skipped','failed','not_configured'));
CREATE INDEX notifications_feed_idx ON notifications(workspace_id, user_id, last_seen_at DESC, id DESC) WHERE in_app;
CREATE INDEX notifications_email_problem_idx ON notifications(workspace_id, created_at DESC) WHERE email_state IN ('failed','not_configured','skipped');

ALTER TABLE notification_preferences DROP CONSTRAINT IF EXISTS notification_preferences_event_type_check;
ALTER TABLE notification_preferences ADD CONSTRAINT notification_preferences_event_type_check
  CHECK (event_type IN ('mention','comment','review_requested','review_decided','assignment','reminder','publishing_problem','account_health','budget'));

-- ---------------------------------------------------------------- workspace collaboration settings
CREATE TABLE workspace_collab_settings (
  workspace_id          uuid PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  client_comments       boolean NOT NULL DEFAULT true,     -- shared-review guests may post in shared threads
  task_assign           text NOT NULL DEFAULT 'contributors' CHECK (task_assign IN ('contributors','managers')),
  offboarding           text NOT NULL DEFAULT 'flag' CHECK (offboarding IN ('flag','unassign')),
  reminder_lead_hours   smallint NOT NULL DEFAULT 24 CHECK (reminder_lead_hours BETWEEN 1 AND 168),
  max_overdue_reminders smallint NOT NULL DEFAULT 3 CHECK (max_overdue_reminders BETWEEN 0 AND 10),
  presence_enabled      boolean NOT NULL DEFAULT true,
  -- Defaults for members who never changed a type: { "<event_type>": { "in_app": bool, "email": bool, "digest": bool } }
  notification_defaults jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(notification_defaults) = 'object'),
  updated_by            uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at            timestamptz NOT NULL DEFAULT now()
);

-- Activity for a post (composer Activity tab): audit rows that reference the post in their diff.
CREATE INDEX audit_events_post_ref_idx ON audit_events ((diff->>'post_id'), created_at DESC) WHERE diff ? 'post_id';
CREATE INDEX audit_events_resource_idx ON audit_events (resource_id, id DESC) WHERE resource_id IS NOT NULL;
