-- V4 stream SUP: customer ↔ Relay support (brief docs/queue/03g_V4_PROMPT.md §3–8, §15–16). Additive.
-- Contracts: packages/core/src/contracts/v4-support.ts. Services: packages/services/src/support/**.
--  * Tickets are a conversation between a customer and Relay STAFF. They are not social-inbox conversations: own tables,
--    own authorization (requester / explicit participants / support.workspace holders; staff via platform_operators),
--    own change feed, own search document, own retention. Nothing here is reachable through inbox_* code paths.
--  * Internal notes live in their own table (support_notes) so no customer query can select them by accident.
--  * The search document holds the subject, the reference and PUBLIC messages only (never notes).
--  * V5 forward-compatibility: a ticket may belong to a visitor (no workspace/user; requester_kind='visitor', visitor_id)
--    and come from source 'widget'. No visitor flow exists yet; these columns only keep the model open.
--  * Staff notifications: notifications.workspace_id becomes nullable for scope='platform' rows (Relay staff have no
--    workspace). Workspace feeds always filter by workspace_id, so platform rows never appear in them.
--  * support_access_grants gains a real ticket foreign key; problem reports gain browser family / error code and a link
--    to the ticket they were explicitly shared to.
-- Retention (docs/v4/SUPPORT_VISIBILITY_MATRIX.md § Retention): tickets, messages, notes and attachments are deleted with
-- the workspace (cascade) and purged 24 months after archive by the worker; activity is append-only for app roles.
-- Rollback: DROP TABLE support_ai_drafts, support_saved_replies, support_activity, support_attachments, support_notes,
--   support_messages, support_ticket_reads, support_ticket_participants, support_tickets; ALTER TABLE support_access_grants DROP COLUMN
--   support_ticket_id; ALTER TABLE support_reports DROP COLUMN browser_family, error_code, support_ticket_id, shared_at,
--   shared_by; DELETE FROM notifications WHERE scope='platform'; ALTER TABLE notifications DROP COLUMN scope, ALTER
--   workspace_id SET NOT NULL; restore notification_preferences_event_type_check without 'support'.

CREATE TABLE support_tickets (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference           text NOT NULL UNIQUE CHECK (reference ~ '^RLY-[0-9]{5,10}$'),
  requester_kind      text NOT NULL DEFAULT 'member' CHECK (requester_kind IN ('member','visitor')),
  workspace_id        uuid REFERENCES workspaces(id) ON DELETE CASCADE,
  requester_user_id   uuid REFERENCES users(id) ON DELETE SET NULL,
  visitor_id          uuid,
  visitor_name        text CHECK (visitor_name IS NULL OR length(visitor_name) <= 120),
  visitor_email       citext CHECK (visitor_email IS NULL OR length(visitor_email) <= 254),
  source              text NOT NULL DEFAULT 'app' CHECK (source IN ('app','problem_report','widget','staff')),
  category            text NOT NULL CHECK (category IN ('account_access','billing','publishing','connections','analytics','technical','feature_request','security')),
  -- Restricted (security/account matters): requester + explicit participants only, never workspace owners by policy.
  restricted          boolean NOT NULL DEFAULT false,
  subject             text NOT NULL CHECK (length(subject) BETWEEN 1 AND 200),
  status              text NOT NULL DEFAULT 'new' CHECK (status IN ('new','waiting_on_relay','waiting_on_customer','resolved','archived')),
  priority            text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high','urgent')),
  assignee_user_id    uuid REFERENCES users(id) ON DELETE SET NULL,
  resolution_reason   text CHECK (resolution_reason IS NULL OR resolution_reason IN ('answered','fixed','duplicate','not_reproducible','wont_fix','customer_resolved','no_response','other')),
  duplicate_of        uuid REFERENCES support_tickets(id) ON DELETE SET NULL,
  problem_report_id   uuid REFERENCES support_reports(id) ON DELETE SET NULL,
  -- Safe technical context captured at creation (app version, route path, browser family, error code, correlation ids).
  diagnostics         jsonb NOT NULL DEFAULT '{}'::jsonb,
  search_doc          tsvector NOT NULL DEFAULT ''::tsvector,
  reopen_count        integer NOT NULL DEFAULT 0,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  last_customer_at    timestamptz,
  last_staff_reply_at timestamptz,
  resolved_at         timestamptz,
  archived_at         timestamptz,
  CHECK ((requester_kind = 'member' AND workspace_id IS NOT NULL AND requester_user_id IS NOT NULL) OR (requester_kind = 'visitor' AND visitor_id IS NOT NULL)),
  CHECK (status <> 'resolved' OR resolution_reason IS NOT NULL),
  CHECK (duplicate_of IS NULL OR duplicate_of <> id)
);
CREATE INDEX support_tickets_ws_idx ON support_tickets (workspace_id, updated_at DESC) WHERE workspace_id IS NOT NULL;
CREATE INDEX support_tickets_requester_idx ON support_tickets (requester_user_id, updated_at DESC);
CREATE INDEX support_tickets_queue_idx ON support_tickets (status, updated_at DESC);
CREATE INDEX support_tickets_assignee_idx ON support_tickets (assignee_user_id, status) WHERE assignee_user_id IS NOT NULL;
CREATE INDEX support_tickets_search_idx ON support_tickets USING gin (search_doc);
CREATE INDEX support_tickets_report_idx ON support_tickets (problem_report_id) WHERE problem_report_id IS NOT NULL;
CREATE INDEX support_tickets_visitor_idx ON support_tickets (visitor_id) WHERE visitor_id IS NOT NULL;

-- Explicitly permitted participants (members of the ticket's workspace added by the requester or a support.workspace holder).
CREATE TABLE support_ticket_participants (
  ticket_id   uuid NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  added_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  added_at    timestamptz NOT NULL DEFAULT now(),
  removed_at  timestamptz,
  PRIMARY KEY (ticket_id, user_id)
);
CREATE INDEX support_participants_user_idx ON support_ticket_participants (user_id) WHERE removed_at IS NULL;

-- Per-person read state (customers and staff): unread = newer counterpart message than last_read_at.
CREATE TABLE support_ticket_reads (
  ticket_id     uuid NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  last_read_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (ticket_id, user_id)
);

-- Customer-visible messages: customer messages and staff PUBLIC replies (plus customer-visible system lines).
CREATE TABLE support_messages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id       uuid NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
  author_kind     text NOT NULL CHECK (author_kind IN ('member','visitor','staff')),
  author_user_id  uuid REFERENCES users(id) ON DELETE SET NULL,
  body            text NOT NULL CHECK (length(body) BETWEEN 1 AND 10000),
  redactions      integer NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX support_messages_ticket_idx ON support_messages (ticket_id, created_at, id);

-- Staff-only internal notes (never selected by customer code paths, never indexed, never notified to customers).
CREATE TABLE support_notes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id       uuid NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
  author_user_id  uuid REFERENCES users(id) ON DELETE SET NULL,
  body            text NOT NULL CHECK (length(body) BETWEEN 1 AND 10000),
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX support_notes_ticket_idx ON support_notes (ticket_id, created_at, id);

-- Private attachments. Uploaded straight to private object storage (presigned POST), then QUARANTINED ('pending') until
-- the server has re-read the bytes: allow-listed type, size, magic-byte signature. Only 'ready' files can be attached;
-- rejected objects are deleted. No malware scanner is configured (documented gap): validation is the quarantine gate.
CREATE TABLE support_attachments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_kind      text NOT NULL CHECK (owner_kind IN ('member','visitor','staff')),
  owner_user_id   uuid REFERENCES users(id) ON DELETE SET NULL,
  workspace_id    uuid REFERENCES workspaces(id) ON DELETE CASCADE,
  ticket_id       uuid REFERENCES support_tickets(id) ON DELETE CASCADE,
  message_id      uuid REFERENCES support_messages(id) ON DELETE CASCADE,
  note_id         uuid REFERENCES support_notes(id) ON DELETE CASCADE,
  state           text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','ready','rejected','deleted')),
  filename        text NOT NULL CHECK (length(filename) BETWEEN 1 AND 160),
  declared_type   text NOT NULL CHECK (length(declared_type) <= 100),
  declared_size   bigint NOT NULL CHECK (declared_size > 0),
  mime            text,
  size            bigint,
  sha256          text,
  storage_key     text NOT NULL UNIQUE,
  error           text CHECK (error IS NULL OR length(error) <= 200),
  created_at      timestamptz NOT NULL DEFAULT now(),
  validated_at    timestamptz,
  attached_at     timestamptz,
  CHECK (message_id IS NULL OR note_id IS NULL),
  CHECK ((message_id IS NULL AND note_id IS NULL) OR ticket_id IS NOT NULL)
);
CREATE INDEX support_attachments_ticket_idx ON support_attachments (ticket_id) WHERE ticket_id IS NOT NULL;
CREATE INDEX support_attachments_pending_idx ON support_attachments (created_at) WHERE state IN ('pending','ready') AND ticket_id IS NULL;

-- Ticket history + content-free change feed (cursor = id). audience 'customer' rows are visible to the customer side;
-- 'staff' rows (notes, assignment, priority, links) only to support staff. Rows carry kind + reference ids, never text.
CREATE TABLE support_activity (
  id            bigserial PRIMARY KEY,
  ticket_id     uuid NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
  audience      text NOT NULL CHECK (audience IN ('customer','staff')),
  kind          text NOT NULL CHECK (length(kind) BETWEEN 3 AND 40),
  actor_kind    text NOT NULL CHECK (actor_kind IN ('member','visitor','staff','system')),
  actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  ref_id        uuid,
  detail        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX support_activity_ticket_idx ON support_activity (ticket_id, id);
CREATE TRIGGER support_activity_immutable BEFORE UPDATE ON support_activity FOR EACH ROW EXECUTE FUNCTION forbid_update();

-- Staff saved replies (platform-wide; staff-approved text, also the approved knowledge for AI drafts).
CREATE TABLE support_saved_replies (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title       text NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  body        text NOT NULL CHECK (length(body) BETWEEN 1 AND 5000),
  category    text CHECK (category IS NULL OR category IN ('account_access','billing','publishing','connections','analytics','technical','feature_request','security')),
  created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz
);

-- Staff AI assistance results (drafts only; never sent automatically). Output kept 30 days.
CREATE TABLE support_ai_drafts (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id      uuid NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
  requested_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  task           text NOT NULL CHECK (task IN ('summarize','draft_reply','suggest_category','related')),
  state          text NOT NULL CHECK (state IN ('succeeded','not_configured','failed','blocked')),
  output         jsonb NOT NULL DEFAULT '{}'::jsonb,
  provider       text,
  input_tokens   integer NOT NULL DEFAULT 0,
  output_tokens  integer NOT NULL DEFAULT 0,
  error          text CHECK (error IS NULL OR length(error) <= 300),
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX support_ai_drafts_ticket_idx ON support_ai_drafts (ticket_id, created_at DESC);

-- ------------------------------------------------------------------ links into existing V3.1 tables
ALTER TABLE support_access_grants ADD COLUMN support_ticket_id uuid REFERENCES support_tickets(id) ON DELETE SET NULL;
CREATE INDEX support_access_ticket_idx ON support_access_grants (support_ticket_id) WHERE support_ticket_id IS NOT NULL;

ALTER TABLE support_reports
  ADD COLUMN browser_family    text CHECK (browser_family IS NULL OR browser_family IN ('chrome','edge','firefox','safari','opera','samsung','other')),
  ADD COLUMN error_code        text CHECK (error_code IS NULL OR error_code ~ '^[a-z0-9_.-]{1,64}$'),
  ADD COLUMN support_ticket_id uuid REFERENCES support_tickets(id) ON DELETE SET NULL,
  ADD COLUMN shared_at         timestamptz,
  ADD COLUMN shared_by         uuid REFERENCES users(id) ON DELETE SET NULL;

-- ------------------------------------------------------------------ platform-scope notifications (Relay staff)
ALTER TABLE notifications ADD COLUMN scope text NOT NULL DEFAULT 'workspace' CHECK (scope IN ('workspace','platform'));
ALTER TABLE notifications ALTER COLUMN workspace_id DROP NOT NULL;
ALTER TABLE notifications ADD CONSTRAINT notifications_scope_workspace_check CHECK (scope = 'platform' OR workspace_id IS NOT NULL);
CREATE INDEX notifications_platform_feed_idx ON notifications (user_id, last_seen_at DESC, id DESC) WHERE scope = 'platform';

ALTER TABLE notification_preferences DROP CONSTRAINT IF EXISTS notification_preferences_event_type_check;
ALTER TABLE notification_preferences ADD CONSTRAINT notification_preferences_event_type_check
  CHECK (event_type IN ('mention','comment','review_requested','review_decided','assignment','reminder','publishing_problem','account_health','budget','support'));
