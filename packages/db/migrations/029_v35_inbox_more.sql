-- V3.5 stream B — remaining inbox capabilities (brief docs/queue/03f_V3_5_PROMPT.md §10–13; contract docs/V3_5_WORKSTREAMS.md).
-- Additive only. Builds on 028 (inbox_channels, inbox_messages, inbox_reply_attempts, integration_cursors, …).
--  1. Channel settings + an encrypted per-channel secret (Telegram webhook secret token; never readable by clients).
--  2. Message metadata (provider references needed to reply, e.g. Bluesky uri/cid, review rating), moderation state.
--  3. Reply attempts: the exact WhatsApp template sent + the charge shown before sending + reply-target snapshot.
--  4. Durable store for inbound updates received on Relay-owned per-channel webhooks (Telegram), deduplicated.
--  5. Moderation actions (hide / unhide / delete own reply) with provider outcome.
--  6. Attachment fetches (metadata + safe fetch into private object storage; nothing is fetched automatically).
--  7. Customer satisfaction requests (explicitly enabled channels only; responses only from customer replies).
-- Rollback: DROP the four new tables and the added columns (nothing outside this file references them).

-- ------------------------------------------------------------------ 1. channels
ALTER TABLE inbox_channels ADD COLUMN IF NOT EXISTS settings jsonb NOT NULL DEFAULT '{}'::jsonb;  -- non-secret only
ALTER TABLE inbox_channels ADD COLUMN IF NOT EXISTS secret_enc jsonb;                               -- envelope-encrypted

-- ------------------------------------------------------------------ 2. messages
ALTER TABLE inbox_messages ADD COLUMN IF NOT EXISTS meta jsonb NOT NULL DEFAULT '{}'::jsonb;        -- provider refs, rating
ALTER TABLE inbox_messages ADD COLUMN IF NOT EXISTS hidden_at timestamptz;                           -- hidden at the provider
ALTER TABLE inbox_messages ADD COLUMN IF NOT EXISTS removed_at timestamptz;                          -- business deleted its own reply

-- ------------------------------------------------------------------ 3. reply attempts
ALTER TABLE inbox_reply_attempts ADD COLUMN IF NOT EXISTS template jsonb;      -- {name, language, category, params[]}
ALTER TABLE inbox_reply_attempts ADD COLUMN IF NOT EXISTS charge jsonb;        -- what was shown before sending; actual pricing from receipts
ALTER TABLE inbox_reply_attempts ADD COLUMN IF NOT EXISTS target_meta jsonb;   -- reply-target snapshot (provider refs) at request time
ALTER TABLE inbox_reply_attempts ADD COLUMN IF NOT EXISTS purpose text NOT NULL DEFAULT 'reply' CHECK (purpose IN ('reply','csat'));

-- ------------------------------------------------------------------ 4. inbound updates on Relay-owned channel webhooks
CREATE TABLE inbox_inbound_events (
  id           bigserial PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  channel_id   uuid NOT NULL REFERENCES inbox_channels(id) ON DELETE CASCADE,
  dedupe_key   text NOT NULL,
  body         jsonb,                                                   -- raw verified body, erased after 7 days
  state        text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','processed','ignored','failed')),
  attempts     integer NOT NULL DEFAULT 0,
  error        text,
  received_at  timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  UNIQUE (channel_id, dedupe_key)
);
CREATE INDEX inbox_inbound_pending_idx ON inbox_inbound_events(received_at) WHERE state IN ('pending','failed');

-- ------------------------------------------------------------------ 5. moderation
CREATE TABLE inbox_moderation_actions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES inbox_conversations(id) ON DELETE CASCADE,
  message_id      uuid NOT NULL REFERENCES inbox_messages(id) ON DELETE CASCADE,
  action          text NOT NULL CHECK (action IN ('hide','unhide','delete_own')),
  state           text NOT NULL CHECK (state IN ('done','failed')),
  error_code      text,
  error_message   text,
  is_simulated    boolean NOT NULL DEFAULT false,
  actor_id        uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX inbox_moderation_conv_idx ON inbox_moderation_actions(conversation_id, created_at);

-- ------------------------------------------------------------------ 6. attachments (fetched on request only)
CREATE TABLE inbox_attachments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  message_id   uuid NOT NULL REFERENCES inbox_messages(id) ON DELETE CASCADE,
  idx          integer NOT NULL CHECK (idx >= 0 AND idx < 10),
  state        text NOT NULL CHECK (state IN ('stored','failed','blocked')),
  mime         text,
  size         bigint,
  sha256       text,
  storage_key  text,
  error_code   text,
  error_message text,
  fetched_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  fetched_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (message_id, idx)
);

-- ------------------------------------------------------------------ 7. customer satisfaction
CREATE TABLE inbox_csat_requests (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  brand_id            uuid NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  conversation_id     uuid NOT NULL REFERENCES inbox_conversations(id) ON DELETE CASCADE,
  channel_id          uuid NOT NULL REFERENCES inbox_channels(id) ON DELETE CASCADE,
  case_id             uuid REFERENCES care_cases(id) ON DELETE SET NULL,
  reply_attempt_id    uuid REFERENCES inbox_reply_attempts(id) ON DELETE SET NULL,
  requested_by        uuid REFERENCES users(id) ON DELETE SET NULL,
  requested_at        timestamptz NOT NULL DEFAULT now(),
  expires_at          timestamptz NOT NULL,
  score               integer CHECK (score BETWEEN 1 AND 5),
  responded_at        timestamptz,
  response_message_id uuid REFERENCES inbox_messages(id) ON DELETE SET NULL,
  closed_at           timestamptz,                                       -- expired / send failed (no response recorded)
  is_simulated        boolean NOT NULL DEFAULT false
);
-- One open request per conversation; answered/expired ones stay for reporting.
CREATE UNIQUE INDEX inbox_csat_open_uniq ON inbox_csat_requests(conversation_id) WHERE responded_at IS NULL AND closed_at IS NULL;
CREATE INDEX inbox_csat_ws_idx ON inbox_csat_requests(workspace_id, requested_at DESC);
