-- V3.5 stream E: Relay AI assistant + rules/bounded automation (brief §16–18). Additive.
-- Contracts: packages/core/src/contracts/v35-{ai,automation}.ts. Services: packages/services/src/{assistant,automation}/**.
-- Privacy: prompts are never stored; run OUTPUT (drafts/summaries shown to the requester) is kept 30 days then purged
-- (trace, source references, usage and latency are kept). Classifications store signals, never message text.
-- Rollback: drop the tables below and restore ai_usage_task_check to the five caption tasks (drop ai_usage.ai_run_id).

-- ------------------------------------------------------------------ approved brand knowledge (no shared store)
-- An administrator approves a Content Hub item or a saved reply as AI knowledge for ONE brand. Text is read live from
-- the source (latest snapshot / saved reply) at run time, after re-checking the requester's access; nothing is copied
-- into a workspace-wide index.
CREATE TABLE ai_knowledge_sources (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  brand_id      uuid NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('source_item', 'saved_reply')),
  ref_id        uuid NOT NULL,
  title         text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  topics        text[] NOT NULL DEFAULT '{}',
  review_by     date,
  approved_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  approved_at   timestamptz NOT NULL DEFAULT now(),
  revoked_at    timestamptz,
  revoked_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, brand_id) REFERENCES brands(workspace_id, id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX ai_knowledge_live_uq ON ai_knowledge_sources (brand_id, kind, ref_id) WHERE revoked_at IS NULL;
CREATE INDEX ai_knowledge_brand_idx ON ai_knowledge_sources (workspace_id, brand_id) WHERE revoked_at IS NULL;

-- ------------------------------------------------------------------ AI runs + proposed actions
CREATE TABLE ai_runs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id     uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  brand_id         uuid NOT NULL,
  surface          text NOT NULL CHECK (surface IN ('composer','inbox','listening','analytics','planner','content_hub','automation')),
  task             text NOT NULL CHECK (task IN ('draft_copy','summarize_conversation','suggest_reply','suggest_triage','translate','explain_analytics',
                                                 'summarize_listening','campaign_brief','insight_to_draft','answer_question','auto_reply')),
  context          jsonb NOT NULL,                 -- {type, id, ...}: ids only
  params           jsonb NOT NULL DEFAULT '{}',    -- target_language, prompt length (the person's prompt text is not stored)
  status           text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','succeeded','failed','refused','not_configured','budget_exhausted','blocked','cancelled')),
  status_detail    text,
  requested_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  automation_run_id uuid,                          -- set for policy-driven runs
  idempotency_key  text NOT NULL,
  output           jsonb,                          -- evidence/suggestions shown to the requester; purged after 30 days
  output_purged_at timestamptz,
  sources          jsonb NOT NULL DEFAULT '[]',    -- SourceRefDto[] (titles/ids/freshness — no bodies)
  trace            jsonb NOT NULL DEFAULT '[]',    -- action trace: steps, counts, checks (no content)
  provider         text,
  model            text,
  input_tokens     integer NOT NULL DEFAULT 0,
  output_tokens    integer NOT NULL DEFAULT 0,
  cost_estimate_usd numeric(12,6) NOT NULL DEFAULT 0,
  latency_ms       integer,
  attempts         integer NOT NULL DEFAULT 0,
  lease_owner      text,
  lease_expires_at timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  started_at       timestamptz,
  finished_at      timestamptz,
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, idempotency_key),
  FOREIGN KEY (workspace_id, brand_id) REFERENCES brands(workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX ai_runs_requester_idx ON ai_runs (workspace_id, requested_by, created_at DESC);
CREATE INDEX ai_runs_due_idx ON ai_runs (created_at) WHERE status IN ('queued','running');
CREATE INDEX ai_runs_purge_idx ON ai_runs (finished_at) WHERE output IS NOT NULL;
CREATE INDEX ai_runs_automation_idx ON ai_runs (automation_run_id) WHERE automation_run_id IS NOT NULL;

CREATE TABLE ai_proposed_actions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  run_id        uuid NOT NULL,
  brand_id      uuid NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('use_reply_draft','apply_labels','set_priority','assign','add_note','use_copy','create_task')),
  target_type   text NOT NULL CHECK (target_type IN ('conversation','post','brand')),
  target_id     uuid NOT NULL,
  preview       jsonb NOT NULL,                    -- {title, detail, params}: exactly what applying changes
  requires      text NOT NULL,                     -- permission re-checked on apply
  status        text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','applied','dismissed','expired','failed')),
  decided_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  decided_at    timestamptz,
  error         text,
  expires_at    timestamptz NOT NULL DEFAULT now() + interval '7 days',
  created_at    timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, run_id) REFERENCES ai_runs(workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX ai_proposed_actions_run_idx ON ai_proposed_actions (run_id);

-- Classification of inbound customer messages (before any routing or automatic reply). Signals only — no text.
CREATE TABLE ai_classifications (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES inbox_conversations(id) ON DELETE CASCADE,
  message_id      uuid NOT NULL REFERENCES inbox_messages(id) ON DELETE CASCADE,
  category        text NOT NULL,
  sentiment       text NOT NULL CHECK (sentiment IN ('negative','neutral','positive')),
  language        text,
  urgency         text NOT NULL CHECK (urgency IN ('low','normal','high')),
  signals         text[] NOT NULL DEFAULT '{}',
  injection_suspected boolean NOT NULL DEFAULT false,
  uncertain       boolean NOT NULL DEFAULT false,
  method          text NOT NULL CHECK (method IN ('rules','model')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (message_id, method)
);
CREATE INDEX ai_classifications_conv_idx ON ai_classifications (conversation_id, created_at DESC);

-- Usage accounting: assistant tasks share the monthly AI meter + ai_usage ledger with caption assistance.
ALTER TABLE ai_usage DROP CONSTRAINT ai_usage_task_check;
ALTER TABLE ai_usage ADD CONSTRAINT ai_usage_task_check CHECK (task IN ('shorten','tone','variants','hashtags','repurpose',
  'draft_copy','summarize_conversation','suggest_reply','suggest_triage','translate','explain_analytics','summarize_listening','campaign_brief',
  'insight_to_draft','answer_question','auto_reply'));
ALTER TABLE ai_usage ADD COLUMN ai_run_id uuid;

-- ------------------------------------------------------------------ automation
-- Workspace-wide emergency stop (owner/admin with automation.manage). While active, no rule runs and queued automated
-- replies are cancelled.
CREATE TABLE automation_settings (
  workspace_id    uuid PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  emergency_stop  boolean NOT NULL DEFAULT false,
  stopped_at      timestamptz,
  stopped_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE automation_policies (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id          uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name                  text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  status                text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','paused','stopped','expired')),
  brand_ids             uuid[] NOT NULL CHECK (cardinality(brand_ids) BETWEEN 1 AND 50),
  channel_ids           uuid[] NOT NULL CHECK (cardinality(channel_ids) BETWEEN 1 AND 200),
  allowed_actions       text[] NOT NULL CHECK (cardinality(allowed_actions) >= 1),
  knowledge_source_ids  uuid[] NOT NULL DEFAULT '{}',
  reply_categories      text[] NOT NULL DEFAULT '{}',
  max_actions_per_hour  integer NOT NULL DEFAULT 60 CHECK (max_actions_per_hour BETWEEN 1 AND 10000),
  max_auto_replies_per_day integer NOT NULL DEFAULT 0 CHECK (max_auto_replies_per_day BETWEEN 0 AND 10000),
  monthly_token_budget  integer NOT NULL DEFAULT 0 CHECK (monthly_token_budget BETWEEN 0 AND 100000000),
  escalation            jsonb NOT NULL DEFAULT '{}',
  expires_at            timestamptz NOT NULL,
  review_by             date,
  owner_id              uuid REFERENCES users(id) ON DELETE SET NULL,
  activated_at          timestamptz,
  activated_by          uuid REFERENCES users(id) ON DELETE SET NULL,
  stopped_at            timestamptz,
  stopped_by            uuid REFERENCES users(id) ON DELETE SET NULL,
  stop_reason           text,
  version               integer NOT NULL DEFAULT 1,
  created_by            uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id),
  -- Customer replies need a daily cap; AI replies need approved knowledge.
  CHECK (NOT ('reply_saved' = ANY(allowed_actions) OR 'reply_ai' = ANY(allowed_actions)) OR max_auto_replies_per_day > 0),
  CHECK (NOT ('reply_ai' = ANY(allowed_actions)) OR (cardinality(knowledge_source_ids) >= 1 AND monthly_token_budget > 0))
);
CREATE INDEX automation_policies_ws_idx ON automation_policies (workspace_id, status);

CREATE TABLE automation_rules (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  policy_id       uuid NOT NULL,
  name            text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  trigger         text NOT NULL CHECK (trigger IN ('inbox.message_received','case.sla_nearing','case.changed','listening.alert','content.approved')),
  trigger_params  jsonb NOT NULL DEFAULT '{}',
  conditions      jsonb NOT NULL DEFAULT '[]',
  actions         jsonb NOT NULL CHECK (jsonb_typeof(actions) = 'array' AND jsonb_array_length(actions) BETWEEN 1 AND 10),
  scope           jsonb NOT NULL,
  schedule        jsonb NOT NULL DEFAULT '{"mode":"always"}',
  limits          jsonb NOT NULL DEFAULT '{"max_per_hour":30,"per_conversation_cooldown_minutes":60}',
  enabled         boolean NOT NULL DEFAULT false,
  position        integer NOT NULL DEFAULT 0,
  version         integer NOT NULL DEFAULT 1,
  created_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz,
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, policy_id) REFERENCES automation_policies(workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX automation_rules_trigger_idx ON automation_rules (workspace_id, trigger) WHERE enabled AND deleted_at IS NULL;

-- Execution history. UNIQUE(rule_id, event_key): one run per rule per event (at-least-once delivery ⇒ exactly one run).
CREATE TABLE automation_runs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  rule_id         uuid,
  policy_id       uuid,
  trigger         text NOT NULL,
  event_key       text NOT NULL,
  subject_type    text NOT NULL CHECK (subject_type IN ('conversation','case','post','listening_alert')),
  subject_id      uuid NOT NULL,
  brand_id        uuid,
  outcome         text NOT NULL DEFAULT 'skipped' CHECK (outcome IN ('pending','succeeded','partial','skipped','blocked','escalated','failed','test')),
  reason          text,
  conditions      jsonb NOT NULL DEFAULT '[]',     -- [{field, matched}] — no values from customer content
  actions         jsonb NOT NULL DEFAULT '[]',     -- RunActionResult[]
  is_test         boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  finished_at     timestamptz,
  FOREIGN KEY (workspace_id, rule_id) REFERENCES automation_rules(workspace_id, id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX automation_runs_event_uq ON automation_runs (rule_id, event_key) WHERE NOT is_test;
CREATE INDEX automation_runs_ws_idx ON automation_runs (workspace_id, created_at DESC);
CREATE INDEX automation_runs_rule_idx ON automation_runs (rule_id, created_at DESC);
CREATE INDEX automation_runs_subject_idx ON automation_runs (subject_id, created_at DESC);
CREATE INDEX automation_runs_policy_idx ON automation_runs (policy_id, created_at DESC);

-- Automated customer replies (link from the inbox reply attempt's idempotency key to the policy that sent it).
-- Written BEFORE requestReply; the reply dispatcher re-checks the policy (active, unexpired, not stopped, owner still
-- allowed) for every automated attempt and refuses attempts without a row here.
CREATE TABLE automation_sends (
  workspace_id    uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  idempotency_key text NOT NULL,
  policy_id       uuid NOT NULL,
  rule_id         uuid,
  run_id          uuid NOT NULL,
  conversation_id uuid NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, idempotency_key),
  FOREIGN KEY (workspace_id, policy_id) REFERENCES automation_policies(workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX automation_sends_policy_idx ON automation_sends (policy_id, created_at DESC);
