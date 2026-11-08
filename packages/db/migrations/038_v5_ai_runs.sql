-- V5 stream AIW: AI workspace + agent-like execution (brief §11–16). Additive; extends the V3.5 AI run system
-- (032_v35_ai_automation.sql) instead of adding a second one: a workflow run IS an ai_runs row (kind='workflow'),
-- queued on the same 'ai-assist' queue (ai_assist workload class) and executed by the worker.
-- Contracts: packages/core/src/contracts/v5-ai.ts. Services: packages/services/src/ai-workflows/**.
-- Privacy: step/event rows hold Relay-written progress text and record ids only (never prompts or customer text).
-- Generated result text (ai_run_results.body) and attachment text are kept 30 days, like V3.5 run output, then purged.
-- Rollback: DROP TABLE ai_run_results, ai_run_events, ai_run_steps, ai_attachments; drop the added ai_runs columns and
--   ai_proposed_actions columns; restore the four CHECK constraints below to their 032 definitions; DROP TABLE ai_threads.

-- ------------------------------------------------------------------ conversation threads (workspace history sidebar)
CREATE TABLE ai_threads (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,  -- threads are private to the person who started them
  brand_id     uuid NOT NULL,
  title        text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  archived_at  timestamptz,
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, brand_id) REFERENCES brands(workspace_id, id) ON DELETE CASCADE
);
-- Incremental history: keyset pagination on (updated_at, id).
CREATE INDEX ai_threads_user_idx ON ai_threads (workspace_id, user_id, updated_at DESC, id DESC) WHERE archived_at IS NULL;

-- ------------------------------------------------------------------ workflow runs on ai_runs
ALTER TABLE ai_runs
  ADD COLUMN kind                text NOT NULL DEFAULT 'task' CHECK (kind IN ('task', 'workflow')),
  ADD COLUMN thread_id           uuid,
  ADD COLUMN title               text CHECK (title IS NULL OR length(title) <= 200),
  -- Why a run stopped short (not_configured, budget_exhausted, blocked, timeout, entitlement, …); NULL when it did not.
  ADD COLUMN outcome_code        text CHECK (outcome_code IS NULL OR length(outcome_code) <= 40),
  -- needs_input: the question Relay asks (fields + options built by Relay; never model text).
  ADD COLUMN pending_input       jsonb,
  ADD COLUMN cancel_requested_at timestamptz,
  ADD COLUMN cancel_requested_by uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN deadline_at         timestamptz,
  ADD COLUMN last_event_seq      integer NOT NULL DEFAULT 0,
  ADD CONSTRAINT ai_runs_thread_fk FOREIGN KEY (workspace_id, thread_id) REFERENCES ai_threads(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ai_runs DROP CONSTRAINT ai_runs_surface_check;
ALTER TABLE ai_runs ADD CONSTRAINT ai_runs_surface_check CHECK (surface IN ('composer','inbox','listening','analytics','planner','content_hub','automation','workspace'));
ALTER TABLE ai_runs DROP CONSTRAINT ai_runs_task_check;
ALTER TABLE ai_runs ADD CONSTRAINT ai_runs_task_check CHECK (task IN ('draft_copy','summarize_conversation','suggest_reply','suggest_triage','translate','explain_analytics',
  'summarize_listening','campaign_brief','insight_to_draft','answer_question','auto_reply',
  'campaign_from_brief','inbox_assistance','performance_analysis','weekly_planning','content_adaptation','ask'));
-- Workflow lifecycle (V5 §13): preparing → working → needs_input / needs_review → completed / partially_completed / failed / cancelled.
-- V3.5 single-task runs keep their statuses.
ALTER TABLE ai_runs DROP CONSTRAINT ai_runs_status_check;
ALTER TABLE ai_runs ADD CONSTRAINT ai_runs_status_check CHECK (status IN ('queued','running','succeeded','failed','refused','not_configured','budget_exhausted','blocked','cancelled',
  'preparing','working','needs_input','needs_review','completed','partially_completed'));
ALTER TABLE ai_runs ADD CONSTRAINT ai_runs_workflow_shape CHECK (kind = 'task' OR (thread_id IS NOT NULL AND surface = 'workspace' AND deadline_at IS NOT NULL));

CREATE INDEX ai_runs_thread_idx ON ai_runs (thread_id, created_at) WHERE thread_id IS NOT NULL;
CREATE INDEX ai_runs_workflow_due_idx ON ai_runs (created_at) WHERE kind = 'workflow' AND status IN ('preparing', 'working');
CREATE INDEX ai_runs_workflow_admin_idx ON ai_runs (workspace_id, created_at DESC) WHERE kind = 'workflow';

-- ------------------------------------------------------------------ steps (persisted plan + state)
CREATE TABLE ai_run_steps (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  run_id       uuid NOT NULL,
  seq          smallint NOT NULL,
  key          text NOT NULL CHECK (length(key) <= 60),
  -- read/validate: re-run on resume (cheap, re-check access); model: output kept so a retry does not pay twice;
  -- write: internal saves with deterministic idempotency keys (a retry returns the same records);
  -- external: never executed by the run — only prepared as a previewed action a person confirms.
  kind         text NOT NULL CHECK (kind IN ('read','model','validate','write','external')),
  label        text NOT NULL CHECK (length(label) <= 120),
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','succeeded','failed','skipped','cancelled','not_configured')),
  detail       text CHECK (detail IS NULL OR length(detail) <= 300),
  result       jsonb NOT NULL DEFAULT '{}',    -- ids, counts and (model steps) the checked output, purged with run output
  attempts     integer NOT NULL DEFAULT 0,
  started_at   timestamptz,
  finished_at  timestamptz,
  UNIQUE (run_id, key),
  UNIQUE (run_id, seq),
  FOREIGN KEY (workspace_id, run_id) REFERENCES ai_runs(workspace_id, id) ON DELETE CASCADE
);

-- ------------------------------------------------------------------ progress events (observable actions, no reasoning)
CREATE TABLE ai_run_events (
  id           bigserial PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  run_id       uuid NOT NULL,
  seq          integer NOT NULL,
  step_key     text,
  level        text NOT NULL CHECK (level IN ('info','success','warn','error')),
  message      text NOT NULL CHECK (length(message) BETWEEN 1 AND 300),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, seq),
  FOREIGN KEY (workspace_id, run_id) REFERENCES ai_runs(workspace_id, id) ON DELETE CASCADE
);

-- ------------------------------------------------------------------ structured results (cards with links to real records)
CREATE TABLE ai_run_results (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  run_id       uuid NOT NULL,
  step_key     text NOT NULL,
  item_key     text NOT NULL,                  -- stable per step (idempotent upsert on retry)
  kind         text NOT NULL CHECK (kind IN ('post_draft','campaign','outline','reply_draft','report','task','schedule_plan','variant','summary','answer','notice')),
  title        text NOT NULL CHECK (length(title) <= 200),
  body         text,                           -- generated or computed text shown to the requester; purged after 30 days
  data         jsonb NOT NULL DEFAULT '{}',    -- structured fields (dates, coverage, evidence refs, issues, destinations)
  record_type  text CHECK (record_type IS NULL OR record_type IN ('post','campaign','conversation','task','analytics')),
  record_id    uuid,
  generated    boolean NOT NULL DEFAULT false, -- true: written by the AI model; false: Relay data/computation
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, step_key, item_key),
  FOREIGN KEY (workspace_id, run_id) REFERENCES ai_runs(workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX ai_run_results_run_idx ON ai_run_results (run_id, created_at);
CREATE INDEX ai_run_results_purge_idx ON ai_run_results (created_at) WHERE body IS NOT NULL;

-- ------------------------------------------------------------------ composer attachments (untrusted text sources)
CREATE TABLE ai_attachments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  brand_id     uuid NOT NULL,
  filename     text NOT NULL CHECK (length(filename) BETWEEN 1 AND 200),
  mime         text NOT NULL CHECK (length(mime) <= 100),
  bytes        integer NOT NULL CHECK (bytes BETWEEN 1 AND 262144),
  sha256       text NOT NULL,
  text_content text,                           -- extracted plain text; purged after 30 days
  created_at   timestamptz NOT NULL DEFAULT now(),
  purged_at    timestamptz,
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, brand_id) REFERENCES brands(workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX ai_attachments_user_idx ON ai_attachments (workspace_id, user_id, created_at DESC);

-- ------------------------------------------------------------------ external actions as previews (V5 §15)
-- schedule_post / submit_for_approval / send_reply are prepared by a run and executed ONLY when the person confirms
-- the exact preview; the confirmation carries the reviewed hash and the normal service re-checks permissions,
-- approval policy and versions at dispatch (idempotency key per action: a retried confirm cannot act twice).
ALTER TABLE ai_proposed_actions DROP CONSTRAINT ai_proposed_actions_kind_check;
ALTER TABLE ai_proposed_actions ADD CONSTRAINT ai_proposed_actions_kind_check CHECK (kind IN ('use_reply_draft','apply_labels','set_priority','assign','add_note','use_copy','create_task',
  'schedule_post','submit_for_approval','send_reply'));
ALTER TABLE ai_proposed_actions
  ADD COLUMN bound_hash text,                   -- hash of what was prepared (destinations + revision + time / reply body)
  ADD COLUMN confirmed_hash text,               -- hash the person reviewed and confirmed
  ADD COLUMN result jsonb;                      -- ids returned by the service (schedule / approval / reply attempt)
