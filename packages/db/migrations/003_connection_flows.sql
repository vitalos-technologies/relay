-- Pending OAuth connection flows: tokens obtained, destinations listed, awaiting the user's
-- explicit selection (AC-02). Tokens are envelope-encrypted; rows expire after 15 minutes.
CREATE TABLE connection_flows (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  brand_id        uuid NOT NULL,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider        provider_kind NOT NULL,
  reconnect_connection_id uuid,
  tokens_enc      jsonb NOT NULL,
  candidates      jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  consumed_at     timestamptz,
  FOREIGN KEY (workspace_id, brand_id) REFERENCES brands(workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX connection_flows_user_idx ON connection_flows(user_id, created_at DESC);
