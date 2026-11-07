-- V1.1 richer media: video assets (probe facts + worker processing state) and video derivative facts.
-- Additive only: existing image rows default to media_kind 'image' and keep NULL video facts.
ALTER TABLE assets
  ADD COLUMN IF NOT EXISTS media_kind            text NOT NULL DEFAULT 'image' CHECK (media_kind IN ('image','video')),
  ADD COLUMN IF NOT EXISTS duration_ms           integer CHECK (duration_ms IS NULL OR duration_ms >= 0),
  ADD COLUMN IF NOT EXISTS video_codec           text,
  ADD COLUMN IF NOT EXISTS audio_codec           text,
  ADD COLUMN IF NOT EXISTS frame_rate            numeric(7,3),
  ADD COLUMN IF NOT EXISTS processing_attempts   integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS processing_started_at timestamptz;

-- Worker recovery scan: quarantined videos whose processing never finished.
CREATE INDEX IF NOT EXISTS assets_video_processing_idx ON assets(processing_started_at)
  WHERE status = 'quarantined' AND media_kind = 'video';

ALTER TABLE asset_derivatives
  ADD COLUMN IF NOT EXISTS duration_ms integer,
  ADD COLUMN IF NOT EXISTS video_codec text,
  ADD COLUMN IF NOT EXISTS audio_codec text,
  ADD COLUMN IF NOT EXISTS frame_rate  numeric(7,3);
