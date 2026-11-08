-- V4 stream ENT: entitlements, usage ledger, overrides, downgrade selections (brief §12–13). Additive.
-- Contracts: packages/core/src/contracts/v4-entitlements.ts (+ v4-plans.ts, v4-billing.ts). Services:
-- packages/services/src/entitlements/** and product/budgets.ts (plan ceilings + usage ledger in the shared reservations).
-- Billing facts are never stored here: they come from the billing stream's getBillingState().
-- Rollback: DROP TABLE usage_events, entitlement_overrides, entitlement_selections, workspace_entitlement_state;
--   restore usage_budgets_meter_check to the five V2 meters; drop the *_entitlement_hold_idx indexes.

-- ------------------------------------------------------------------ usage ledger (durable, deduplicated)
-- One row per settled consumption. usage_counters remain the fast aggregate used by reservations; this ledger is the
-- durable record per billing period (period = the same opaque key as the counter row). A repeated consumption with the
-- same dedupe key (retried MCP call, re-run sync job, re-settled reservation) is recorded once and charged once.
-- Append-only for application roles (infra/postgres/roles.sql).
CREATE TABLE usage_events (
  id             bigserial PRIMARY KEY,
  workspace_id   uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  meter          text NOT NULL CHECK (length(meter) <= 40),
  period         text NOT NULL CHECK (length(period) <= 40),
  amount         bigint NOT NULL CHECK (amount >= 0),
  dedupe_key     text NOT NULL CHECK (length(dedupe_key) BETWEEN 1 AND 240),
  source         text NOT NULL CHECK (source IN ('reservation','consume')),
  ref            text CHECK (ref IS NULL OR length(ref) <= 200),
  actor_user_id  uuid REFERENCES users(id) ON DELETE SET NULL,
  occurred_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, meter, dedupe_key)
);
CREATE INDEX usage_events_period_idx ON usage_events(workspace_id, meter, period);

-- Two more metered allowances share the budget machinery (team budgets may cap them too).
ALTER TABLE usage_budgets DROP CONSTRAINT IF EXISTS usage_budgets_meter_check;
ALTER TABLE usage_budgets ADD CONSTRAINT usage_budgets_meter_check
  CHECK (meter IN ('ai.tokens','x.write','x.read','storage.bytes','exports.count','mcp.calls','integration.jobs'));

-- ------------------------------------------------------------------ platform overrides (audited)
-- Applied by Relay operator/billing staff with step-up; reason + optional expiry; every change is in the platform audit
-- AND the workspace audit. Expired rows stop applying at read time (no job needed); revocation keeps the row.
--   feature   : key = Feature,   value = {"enabled": true|false}
--   allowance : key = Allowance, value = {"limit": <int>|null}   (null = unmetered by plan)
--   access    : key = 'full',    value = {"level": "full"}       (temporary full access during a billing problem;
--               never lifts a staff service suspension; expiry required)
CREATE TABLE entitlement_overrides (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind            text NOT NULL CHECK (kind IN ('feature','allowance','access')),
  key             text NOT NULL CHECK (length(key) BETWEEN 1 AND 60),
  value           jsonb NOT NULL,
  reason          text NOT NULL CHECK (length(reason) BETWEEN 10 AND 500),
  expires_at      timestamptz,
  created_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  revoked_at      timestamptz,
  revoked_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  revoked_reason  text CHECK (revoked_reason IS NULL OR length(revoked_reason) <= 500),
  CHECK (kind <> 'access' OR expires_at IS NOT NULL)
);
CREATE UNIQUE INDEX entitlement_overrides_live_uq ON entitlement_overrides(workspace_id, kind, key) WHERE revoked_at IS NULL;
CREATE INDEX entitlement_overrides_ws_idx ON entitlement_overrides(workspace_id, created_at DESC);

-- ------------------------------------------------------------------ downgrade selections
-- When a lowered limit leaves more active resources than allowed, the customer chooses which stay active. Rows record
-- the chosen resources; nothing is deleted or disconnected. Unchosen resources beyond the limit are HELD (publishing to
-- a held account is held; a held search does not match new items). Without a choice, the oldest resources stay active.
CREATE TABLE entitlement_selections (
  workspace_id  uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  allowance     text NOT NULL CHECK (allowance IN ('social_accounts','listening_searches')),
  resource_id   uuid NOT NULL,
  chosen_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  chosen_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, allowance, resource_id)
);

-- ------------------------------------------------------------------ last evaluated access (transitions + sweep)
CREATE TABLE workspace_entitlement_state (
  workspace_id  uuid PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  plan_id       text,
  access        text NOT NULL CHECK (access IN ('full','restricted','suspended')),
  reason        text,
  evaluated_at  timestamptz NOT NULL DEFAULT now(),
  changed_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX workspace_entitlement_state_access_idx ON workspace_entitlement_state(access) WHERE access <> 'full';

-- ------------------------------------------------------------------ hold lookups (release on access return)
CREATE INDEX deliveries_entitlement_hold_idx ON deliveries(workspace_id) WHERE state = 'blocked' AND last_error_code = 'entitlement_hold';
CREATE INDEX inbox_reply_attempts_entitlement_hold_idx ON inbox_reply_attempts(workspace_id) WHERE state = 'queued' AND error_code = 'entitlement_hold';
CREATE INDEX integration_sync_jobs_entitlement_hold_idx ON integration_sync_jobs(workspace_id) WHERE last_error_code = 'entitlement_hold';
