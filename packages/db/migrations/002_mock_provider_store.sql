-- Durable store for SIMULATED provider objects (mock_ destinations only), so that
-- reconciliation of simulated Unknown outcomes survives worker restarts.
CREATE TABLE mock_provider_objects (
  provider    provider_kind NOT NULL,
  object_id   text NOT NULL CHECK (object_id LIKE 'mock\_%'),
  account_id  text NOT NULL CHECK (account_id LIKE 'mock\_%'),
  kind        text NOT NULL,
  data        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, object_id)
);
CREATE INDEX mock_provider_objects_account_idx ON mock_provider_objects(provider, account_id, kind, created_at DESC);

CREATE TABLE mock_provider_counters (
  key   text PRIMARY KEY,
  value integer NOT NULL DEFAULT 0
);
