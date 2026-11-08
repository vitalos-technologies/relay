-- V3.1 stream GOV: brand safeguards + asset governance (§12), content reuse + queues (§13), campaign links/UTM
-- (§14), release controls + support (§16), onboarding state (§7). Integration diagnostics (§15) are read-only and
-- need no tables. Additive only: no existing table, column or row is changed.

-- ================================================================ §12 brand profile + rules
-- One profile per brand: non-rule brand identity (tone, colours, approved logos, CTA default). rules_version is bumped
-- by every rule/profile/asset-governance change and stamps the review items that change created.
CREATE TABLE brand_profiles (
  workspace_id   uuid NOT NULL,
  brand_id       uuid NOT NULL PRIMARY KEY,
  rules_version  integer NOT NULL DEFAULT 0,
  tone           text CHECK (tone IS NULL OR length(tone) <= 1000),
  colours        jsonb NOT NULL DEFAULT '[]'::jsonb,       -- [{name, hex}]
  logo_asset_ids uuid[] NOT NULL DEFAULT '{}' CHECK (cardinality(logo_asset_ids) <= 20),
  cta_default    text CHECK (cta_default IS NULL OR length(cta_default) <= 300),
  updated_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, brand_id),
  FOREIGN KEY (workspace_id, brand_id) REFERENCES brands(workspace_id, id) ON DELETE CASCADE
);

-- Text/link rules. severity is explicit: 'mandatory' blocks schedule/submit/publish; 'advisory' only warns.
CREATE TABLE brand_rules (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  brand_id     uuid NOT NULL,
  kind         text NOT NULL CHECK (kind IN ('prohibited_phrase','discouraged_phrase','preferred_term','required_footer','required_disclaimer','approved_link_domain')),
  value        text NOT NULL CHECK (length(trim(value)) BETWEEN 1 AND 500),
  replacement  text CHECK (replacement IS NULL OR length(replacement) <= 200),
  severity     text NOT NULL CHECK (severity IN ('mandatory','advisory')),
  providers    text[] NOT NULL DEFAULT '{}',              -- empty = every destination
  note         text CHECK (note IS NULL OR length(note) <= 500),
  created_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  archived_at  timestamptz,
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, brand_id) REFERENCES brands(workspace_id, id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX brand_rules_active_uq ON brand_rules(brand_id, kind, lower(value)) WHERE archived_at IS NULL;
CREATE INDEX brand_rules_brand_idx ON brand_rules(workspace_id, brand_id) WHERE archived_at IS NULL;

-- Rule changes never rewrite content: affected drafts/schedules are listed here for explicit review.
CREATE TABLE brand_rule_reviews (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    uuid NOT NULL,
  brand_id        uuid NOT NULL,
  rules_version   integer NOT NULL,
  post_id         uuid NOT NULL,
  schedule_id     uuid,
  kind            text NOT NULL CHECK (kind IN ('draft','schedule')),
  findings        jsonb NOT NULL DEFAULT '[]'::jsonb,
  mandatory_count integer NOT NULL DEFAULT 0,
  advisory_count  integer NOT NULL DEFAULT 0,
  status          text NOT NULL DEFAULT 'open' CHECK (status IN ('open','decided','superseded')),
  decision        text CHECK (decision IS NULL OR decision IN ('keep','will_edit','cancel_schedule')),
  decided_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  decided_at      timestamptz,
  note            text CHECK (note IS NULL OR length(note) <= 500),
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'decided') = (decision IS NOT NULL)),
  FOREIGN KEY (workspace_id, post_id) REFERENCES posts(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, schedule_id) REFERENCES schedules(workspace_id, id) ON DELETE SET NULL (schedule_id)
);
CREATE UNIQUE INDEX brand_rule_reviews_open_uq ON brand_rule_reviews(post_id) WHERE status = 'open';
CREATE INDEX brand_rule_reviews_brand_idx ON brand_rule_reviews(workspace_id, brand_id, status, created_at DESC);

-- ================================================================ §12 asset governance
CREATE TABLE asset_governance (
  asset_id      uuid NOT NULL PRIMARY KEY,
  workspace_id  uuid NOT NULL,
  brand_id      uuid NOT NULL,
  ownership     text NOT NULL DEFAULT 'unknown' CHECK (ownership IN ('owned','licensed','stock','partner','user_generated','unknown')),
  owner_name    text CHECK (owner_name IS NULL OR length(owner_name) <= 200),
  licence       text CHECK (licence IS NULL OR length(licence) <= 200),
  licence_url   text CHECK (licence_url IS NULL OR (length(licence_url) <= 2048 AND licence_url ~ '^https?://')),
  notes         text CHECK (notes IS NULL OR length(notes) <= 2000),
  expires_at    timestamptz,
  lifecycle     text NOT NULL DEFAULT 'active' CHECK (lifecycle IN ('active','superseded','archived')),
  superseded_by uuid,
  updated_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (superseded_by IS NULL OR lifecycle = 'superseded'),
  CHECK (superseded_by IS NULL OR superseded_by <> asset_id),
  FOREIGN KEY (workspace_id, asset_id) REFERENCES assets(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, superseded_by) REFERENCES assets(workspace_id, id) ON DELETE SET NULL (superseded_by),
  FOREIGN KEY (workspace_id, brand_id) REFERENCES brands(workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX asset_governance_expiry_idx ON asset_governance(workspace_id, expires_at) WHERE expires_at IS NOT NULL;

-- ================================================================ §13 content reuse + queues
-- Provenance original → derived (duplicate/reuse). The original may later be deleted; the link keeps its id as text.
CREATE TABLE content_provenance (
  derived_post_id      uuid NOT NULL PRIMARY KEY,
  workspace_id         uuid NOT NULL,
  brand_id             uuid NOT NULL,
  original_post_id     uuid,
  original_post_ref    uuid NOT NULL,                     -- never nulled (audit trail)
  original_revision_id uuid,
  kind                 text NOT NULL CHECK (kind IN ('duplicate','reuse')),
  created_by           uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, derived_post_id) REFERENCES posts(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, original_post_id) REFERENCES posts(workspace_id, id) ON DELETE SET NULL (original_post_id)
);
CREATE INDEX content_provenance_original_idx ON content_provenance(workspace_id, original_post_ref);

-- Explicit evergreen eligibility (default: not eligible). Time-sensitive signals override it at check time.
CREATE TABLE content_reuse_policy (
  post_id      uuid NOT NULL PRIMARY KEY,
  workspace_id uuid NOT NULL,
  brand_id     uuid NOT NULL,
  evergreen    boolean NOT NULL DEFAULT false,
  expires_at   timestamptz,
  note         text CHECK (note IS NULL OR length(note) <= 500),
  marked_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  marked_at    timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, post_id) REFERENCES posts(workspace_id, id) ON DELETE CASCADE
);

CREATE TABLE content_queues (
  brand_id      uuid NOT NULL PRIMARY KEY,
  workspace_id  uuid NOT NULL,
  paused        boolean NOT NULL DEFAULT false,
  paused_reason text CHECK (paused_reason IS NULL OR length(paused_reason) <= 500),
  paused_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  paused_at     timestamptz,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, brand_id) REFERENCES brands(workspace_id, id) ON DELETE CASCADE
);

-- Each item is consumed at most once: a post scheduled from the queue can never be queued again
-- (slots never authorize recurring publication of the same content; reuse = a new derived draft).
CREATE TABLE content_queue_items (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id      uuid NOT NULL,
  brand_id          uuid NOT NULL,
  post_id           uuid NOT NULL,
  status            text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','scheduled','removed')),
  position          bigint NOT NULL,
  added_by          uuid REFERENCES users(id) ON DELETE SET NULL,
  added_at          timestamptz NOT NULL DEFAULT now(),
  schedule_id       uuid,
  scheduled_at      timestamptz,
  removed_by        uuid REFERENCES users(id) ON DELETE SET NULL,
  removed_at        timestamptz,
  removed_reason    text,
  FOREIGN KEY (workspace_id, post_id) REFERENCES posts(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, brand_id) REFERENCES brands(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, schedule_id) REFERENCES schedules(workspace_id, id) ON DELETE SET NULL (schedule_id)
);
CREATE UNIQUE INDEX content_queue_items_live_uq ON content_queue_items(post_id) WHERE status IN ('queued','scheduled');
CREATE INDEX content_queue_items_brand_idx ON content_queue_items(workspace_id, brand_id, status, position);

-- ================================================================ §14 campaign links + UTM
CREATE TABLE utm_defaults (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  brand_id     uuid NOT NULL,
  campaign_id  uuid,
  params       jsonb NOT NULL DEFAULT '{}'::jsonb,         -- {utm_source, utm_medium, utm_campaign, utm_term, utm_content}
  updated_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, brand_id) REFERENCES brands(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, brand_id, campaign_id) REFERENCES campaigns(workspace_id, brand_id, id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX utm_defaults_brand_uq ON utm_defaults(brand_id) WHERE campaign_id IS NULL;
CREATE UNIQUE INDEX utm_defaults_campaign_uq ON utm_defaults(campaign_id) WHERE campaign_id IS NOT NULL;

-- Short links: the redirect target is ONLY the stored, validated destination (never a request parameter), so the
-- redirect service cannot be used as an open redirect.
CREATE TABLE tracked_links (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    uuid NOT NULL,
  brand_id        uuid NOT NULL,
  campaign_id     uuid,
  post_id         uuid,
  code            text NOT NULL UNIQUE CHECK (code ~ '^[A-Za-z0-9_-]{10,32}$'),
  destination_url text NOT NULL CHECK (length(destination_url) <= 2048 AND destination_url ~ '^https?://'),
  created_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  disabled_at     timestamptz,
  disabled_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, brand_id) REFERENCES brands(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, brand_id, campaign_id) REFERENCES campaigns(workspace_id, brand_id, id) ON DELETE SET NULL (campaign_id),
  FOREIGN KEY (workspace_id, post_id) REFERENCES posts(workspace_id, id) ON DELETE SET NULL (post_id)
);
CREATE INDEX tracked_links_brand_idx ON tracked_links(workspace_id, brand_id, created_at DESC);
CREATE INDEX tracked_links_campaign_idx ON tracked_links(campaign_id) WHERE campaign_id IS NOT NULL;

-- App-observed clicks: daily counters only (no IP, user agent or referrer stored).
CREATE TABLE tracked_link_clicks_daily (
  link_id      uuid NOT NULL,
  workspace_id uuid NOT NULL,
  day          date NOT NULL,
  clicks       bigint NOT NULL DEFAULT 0 CHECK (clicks >= 0),
  PRIMARY KEY (link_id, day),
  FOREIGN KEY (workspace_id, link_id) REFERENCES tracked_links(workspace_id, id) ON DELETE CASCADE
);

-- ================================================================ §16 release controls + support
-- Installation-wide flag definitions (operators edit these rows; there is no API). Safe default: off.
-- Unknown keys evaluate to off. A workspace override wins over rollout_percent; killed forces off everywhere.
CREATE TABLE feature_flags (
  key             text PRIMARY KEY CHECK (key ~ '^[a-z0-9_.]{3,64}$'),
  description     text NOT NULL DEFAULT '',
  default_enabled boolean NOT NULL DEFAULT false,
  rollout_percent smallint NOT NULL DEFAULT 0 CHECK (rollout_percent BETWEEN 0 AND 100),
  killed          boolean NOT NULL DEFAULT false,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  updated_by      text
);
INSERT INTO feature_flags(key, description, updated_by) VALUES
  ('v31.onboarding_checklist', 'Guided onboarding checklist', 'migration'),
  ('v31.content_queue', 'Evergreen content queue', 'migration'),
  ('v31.tracked_links', 'Campaign short links with app-observed clicks', 'migration'),
  ('v31.brand_rules', 'Brand rules editor and review list', 'migration'),
  ('v31.integration_diagnostics', 'Integration test centre', 'migration'),
  ('v31.release_notes', 'In-app release notes', 'migration');

CREATE TABLE workspace_feature_flags (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  key          text NOT NULL REFERENCES feature_flags(key) ON DELETE CASCADE,
  enabled      boolean NOT NULL,
  updated_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, key)
);

-- Problem reports: redacted metadata only. Draft text appears only when the reporter explicitly selected it
-- (stored as a redacted, bounded excerpt). Never credentials.
CREATE TABLE support_reports (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id         uuid REFERENCES users(id) ON DELETE SET NULL,
  category        text NOT NULL CHECK (category IN ('bug','publishing','integration','performance','account','other')),
  summary         text NOT NULL CHECK (length(summary) BETWEEN 1 AND 2000),
  route           text CHECK (route IS NULL OR length(route) <= 300),
  app_version     text CHECK (app_version IS NULL OR length(app_version) <= 64),
  occurred_at     timestamptz,
  correlation_ids text[] NOT NULL DEFAULT '{}' CHECK (cardinality(correlation_ids) <= 20),
  attachments     jsonb NOT NULL DEFAULT '{}'::jsonb,
  redactions      integer NOT NULL DEFAULT 0,
  status          text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX support_reports_ws_idx ON support_reports(workspace_id, created_at DESC);

CREATE TABLE release_note_reads (
  user_id           uuid NOT NULL PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  last_seen_version text NOT NULL CHECK (length(last_seen_version) <= 32),
  seen_at           timestamptz NOT NULL DEFAULT now()
);

-- ================================================================ §7 onboarding checklist state
-- Progress is derived from real data; this row stores only per-user choices (dismissed, explicit acknowledgements).
CREATE TABLE onboarding_progress (
  workspace_id    uuid NOT NULL,
  user_id         uuid NOT NULL,
  dismissed_at    timestamptz,
  acknowledged    jsonb NOT NULL DEFAULT '{}'::jsonb,       -- {step_key: iso timestamp}
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id),
  FOREIGN KEY (workspace_id, user_id) REFERENCES memberships(workspace_id, user_id) ON DELETE CASCADE
);
