-- V3 social adapters: TikTok, YouTube, LinkedIn, Threads, Pinterest, Bluesky (docs/providers/<provider>.md).
-- ADD VALUE runs inside the migration transaction (PostgreSQL ≥ 12); the new labels are not used in this file.
ALTER TYPE provider_kind ADD VALUE IF NOT EXISTS 'tiktok';
ALTER TYPE provider_kind ADD VALUE IF NOT EXISTS 'youtube';
ALTER TYPE provider_kind ADD VALUE IF NOT EXISTS 'linkedin';
ALTER TYPE provider_kind ADD VALUE IF NOT EXISTS 'threads';
ALTER TYPE provider_kind ADD VALUE IF NOT EXISTS 'pinterest';
ALTER TYPE provider_kind ADD VALUE IF NOT EXISTS 'bluesky';

-- Scheduling owner per delivery (spec §7): 'app' = the worker dispatches at the due time (default, all V1/V2 rows);
-- 'provider' = the network holds the release (YouTube publishAt). Never both.
ALTER TABLE deliveries ADD COLUMN IF NOT EXISTS scheduling_owner text NOT NULL DEFAULT 'app'
  CHECK (scheduling_owner IN ('app', 'provider'));
-- Remote schedule state for provider-owned deliveries, e.g.
-- {"provider":"youtube","video_id":"…","publish_at":"…","state":"scheduled|cancelled|too_late|uncertain","checked_at":"…","message":"…"}
ALTER TABLE deliveries ADD COLUMN IF NOT EXISTS remote_schedule jsonb;
CREATE INDEX IF NOT EXISTS deliveries_provider_scheduled_idx ON deliveries (workspace_id, brand_id, connection_id)
  WHERE scheduling_owner = 'provider';
