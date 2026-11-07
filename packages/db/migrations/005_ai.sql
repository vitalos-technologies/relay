-- AI caption assistance (V1.1). One row per model call (or fixture call) for accounting and audit.
-- Never stores prompts or generated text: IDs, model, task and token counts only.
-- The monthly cap itself is enforced atomically on usage_counters (meter 'ai.tokens').
CREATE TABLE ai_usage (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id     uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  brand_id         uuid NOT NULL,
  post_id          uuid,                                   -- kept after the post is deleted (accounting)
  user_id          uuid REFERENCES users(id) ON DELETE SET NULL,
  model            text NOT NULL,
  task             text NOT NULL CHECK (task IN ('shorten','tone','variants','hashtags','repurpose')),
  status           text NOT NULL CHECK (status IN ('ok','failed','refused','fixture')),
  period           text NOT NULL,                          -- 'YYYY-MM' UTC, matches usage_counters.period
  reserved_tokens  integer NOT NULL DEFAULT 0,
  input_tokens     integer NOT NULL DEFAULT 0,
  output_tokens    integer NOT NULL DEFAULT 0,
  cost_estimate_usd numeric(12,6) NOT NULL DEFAULT 0,
  correlation_id   text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, brand_id) REFERENCES brands(workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX ai_usage_workspace_idx ON ai_usage(workspace_id, created_at DESC);
