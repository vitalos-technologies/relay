-- Shared rate-limit buckets (correct across multiple web replicas) and provider data-deletion requests.
CREATE TABLE rate_limit_buckets (
  key        text PRIMARY KEY,
  tokens     double precision NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Meta "Data Deletion Request" / deauthorization callbacks (required before external customers).
CREATE TABLE data_deletion_requests (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider          text NOT NULL,
  provider_user_id  text NOT NULL,
  confirmation_code text NOT NULL UNIQUE,
  kind              text NOT NULL CHECK (kind IN ('deauthorize','data_deletion')),
  status            text NOT NULL DEFAULT 'received' CHECK (status IN ('received','completed','failed')),
  affected_connections integer NOT NULL DEFAULT 0,
  received_at       timestamptz NOT NULL DEFAULT now(),
  completed_at      timestamptz
);
