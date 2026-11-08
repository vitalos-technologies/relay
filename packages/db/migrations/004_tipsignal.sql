-- Optional TipSignal source integration (V1.1). Events create DRAFTS bound to one configured brand.
CREATE TABLE integration_bindings (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind         text NOT NULL CHECK (kind IN ('tipsignal')),
  workspace_id uuid NOT NULL,
  brand_id     uuid NOT NULL,
  acting_user_id uuid NOT NULL REFERENCES users(id),   -- drafts are attributed to this member
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (kind),
  FOREIGN KEY (workspace_id, brand_id) REFERENCES brands(workspace_id, id) ON DELETE CASCADE
);

CREATE TABLE source_events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source          text NOT NULL,
  source_event_id text NOT NULL,
  event_type      text NOT NULL,
  schema_version  integer NOT NULL,
  workspace_id    uuid NOT NULL,
  brand_id        uuid NOT NULL,
  payload         jsonb NOT NULL,
  status          text NOT NULL DEFAULT 'received' CHECK (status IN ('received','draft_created','rejected')),
  reason          text,
  post_id         uuid,
  received_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source, source_event_id)
);
