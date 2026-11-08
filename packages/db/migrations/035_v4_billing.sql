-- V4 billing (brief docs/queue/03g_V4_PROMPT.md §9–11, §14; V5 §5–8). Additive only. Stream BIL.
--
-- Catalogue: billing_plans → immutable billing_plan_versions (seeded from packages/core/src/contracts/v4-plans.ts; a
--   price/feature change is a NEW version, existing subscriptions keep theirs) → billing_provider_prices (provider price
--   ids per version and mode). The 'test' rows belong to the deterministic test double; Stripe price ids are recorded by an
--   operator in Platform → Plans (activation item).
-- Per workspace: workspace_billing (one row; status, plan version, seats, provider refs, trial, period, cancellation,
--   scheduled change, grace, payment-method summary, derived access level). Billing status, service suspension
--   (workspaces.state) and access level are separate dimensions; access is derived (services/billing/state.ts).
--   Every workspace that exists when this migration runs is assigned the non-purchasable 'legacy' plan (Professional
--   features, no price, not metered by plan) so nothing existing changes. Workspaces with no row (created later by
--   seed/CLI scripts, not through signup) are also read as legacy; product signups get an explicit trial row.
-- Trials: billing_trial_redemptions — at most ONE per workspace, ever (PK), with the redeeming user. Joining, plan changes,
--   refreshes and replays never create or extend one; only an audited staff extension moves ends_at.
-- Evidence: billing_webhook_events (verified provider events, deduplicated by provider event id; processed by re-fetching
--   the provider object so out-of-order delivery converges), billing_lifecycle_events (append-only history),
--   billing_invoices (provider invoice links cache), billing_checkout_sessions (one open checkout per workspace).
-- Staff: platform_operators.role gains 'billing' (billing records + plan/trial/override actions; no ticket internal notes,
--   no customer content, no support-access requests).
-- Rollback: DROP TABLE billing_scheduled_actions, billing_test_objects, billing_invoices, billing_lifecycle_events,
--   billing_webhook_events, billing_checkout_sessions, billing_trial_redemptions, workspace_billing, billing_provider_prices,
--   billing_plan_versions, billing_plans; DROP FUNCTION billing_plan_versions_immutable, billing_trial_redemption_guard;
--   restore platform_operators_role_check to ('operator','support') after re-assigning billing staff.

ALTER TABLE platform_operators DROP CONSTRAINT IF EXISTS platform_operators_role_check;
ALTER TABLE platform_operators ADD CONSTRAINT platform_operators_role_check CHECK (role IN ('operator','support','billing'));

-- ------------------------------------------------------------------ catalogue
CREATE TABLE billing_plans (
  id          text PRIMARY KEY CHECK (id ~ '^[a-z][a-z0-9_]{1,39}$'),
  public      boolean NOT NULL DEFAULT false,
  sort        int NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now()
);
INSERT INTO billing_plans(id, public, sort) VALUES ('standard', true, 1), ('professional', true, 2), ('legacy', false, 9);

CREATE TABLE billing_plan_versions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id           text NOT NULL REFERENCES billing_plans(id),
  version           int NOT NULL CHECK (version >= 1),
  name              text NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  summary           text NOT NULL DEFAULT '' CHECK (length(summary) <= 200),
  unit_amount_minor int CHECK (unit_amount_minor IS NULL OR unit_amount_minor >= 0),
  currency          text NOT NULL CHECK (currency = 'GBP'),
  interval          text NOT NULL CHECK (interval IN ('month','year')),
  per_seat          boolean NOT NULL DEFAULT true,
  trial_days        int NOT NULL CHECK (trial_days BETWEEN 0 AND 90),
  features          jsonb NOT NULL,
  allowances        jsonb NOT NULL,
  trial_allowances  jsonb NOT NULL,
  highlights        jsonb NOT NULL DEFAULT '[]'::jsonb,
  purchasable       boolean NOT NULL,
  catalogue_hash    text NOT NULL CHECK (length(catalogue_hash) = 64),
  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by        uuid REFERENCES users(id),
  -- Retired versions are no longer offered for new purchases; subscriptions bound to them keep them.
  retired_at        timestamptz,
  UNIQUE (plan_id, version),
  CHECK (NOT purchasable OR unit_amount_minor IS NOT NULL)
);
CREATE UNIQUE INDEX billing_plan_versions_current_idx ON billing_plan_versions (plan_id) WHERE retired_at IS NULL;

-- Plan versions are immutable: only retired_at may be set (once). Deleting is refused.
CREATE FUNCTION billing_plan_versions_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'billing plan versions are immutable'; END IF;
  IF (to_jsonb(NEW) - 'retired_at') IS DISTINCT FROM (to_jsonb(OLD) - 'retired_at') OR (OLD.retired_at IS NOT NULL AND NEW.retired_at IS DISTINCT FROM OLD.retired_at) THEN
    RAISE EXCEPTION 'billing plan versions are immutable (publish a new version instead)';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER billing_plan_versions_immutable BEFORE UPDATE OR DELETE ON billing_plan_versions FOR EACH ROW EXECUTE FUNCTION billing_plan_versions_immutable();

INSERT INTO billing_plan_versions(plan_id, version, name, summary, unit_amount_minor, currency, interval, per_seat, trial_days, features, allowances, trial_allowances, highlights, purchasable, catalogue_hash) VALUES
  ('standard', 1, 'Standard', 'Plan, publish and reply together.', 1000, 'GBP', 'month', true, 14,
   '["publishing","media_library","collaboration","analytics_standard","inbox","ai_drafting","support"]'::jsonb,
   '{"ai_tokens":{"base":100000,"per_seat":50000},"storage_bytes":{"base":10737418240,"per_seat":5368709120},"exports":{"base":20,"per_seat":0},"x_writes":null,"x_reads":null,"listening_searches":{"base":0,"per_seat":0},"social_accounts":{"base":5,"per_seat":3},"integration_jobs":{"base":0,"per_seat":0},"mcp_calls":{"base":0,"per_seat":0}}'::jsonb,
   '{"ai_tokens":{"base":100000,"per_seat":0},"storage_bytes":{"base":2147483648,"per_seat":0},"exports":{"base":5,"per_seat":0},"x_writes":{"base":0,"per_seat":0},"x_reads":{"base":0,"per_seat":0},"listening_searches":{"base":0,"per_seat":0},"social_accounts":{"base":5,"per_seat":0},"integration_jobs":{"base":0,"per_seat":0},"mcp_calls":{"base":0,"per_seat":0}}'::jsonb,
   '["Publishing and scheduling","Shared calendar and media library","Team collaboration","Social inbox","Standard analytics","AI drafting help"]'::jsonb, true, 'f35e94ff2a4f466be4a125db5cdec8cf6e5d19f4fd5b237febcd046e003ed80d'),
  ('professional', 1, 'Professional', 'Everything in Standard, plus advanced workflows.', 2500, 'GBP', 'month', true, 14,
   '["publishing","media_library","collaboration","analytics_standard","inbox","ai_drafting","support","analytics_advanced","listening","approvals_advanced","care_advanced","ai_workflows","automation","integrations_business","mcp"]'::jsonb,
   '{"ai_tokens":{"base":500000,"per_seat":200000},"storage_bytes":{"base":53687091200,"per_seat":10737418240},"exports":{"base":200,"per_seat":0},"x_writes":null,"x_reads":null,"listening_searches":{"base":5,"per_seat":2},"social_accounts":{"base":10,"per_seat":5},"integration_jobs":{"base":5000,"per_seat":1000},"mcp_calls":{"base":10000,"per_seat":2000}}'::jsonb,
   '{"ai_tokens":{"base":100000,"per_seat":0},"storage_bytes":{"base":2147483648,"per_seat":0},"exports":{"base":5,"per_seat":0},"x_writes":{"base":0,"per_seat":0},"x_reads":{"base":0,"per_seat":0},"listening_searches":{"base":2,"per_seat":0},"social_accounts":{"base":5,"per_seat":0},"integration_jobs":{"base":200,"per_seat":0},"mcp_calls":{"base":500,"per_seat":0}}'::jsonb,
   '["Everything in Standard","Advanced analytics and reports","Listening on activated sources","Advanced approvals and customer care","AI workflows and automation","Business integrations and MCP"]'::jsonb, true, 'cf7e57b1d513dfd0f139524c1161b6bb6e5817904a68a1e5989e0f026987b3da'),
  ('legacy', 1, 'Legacy', 'Workspaces created before plans existed.', NULL, 'GBP', 'month', true, 0,
   '["publishing","media_library","collaboration","analytics_standard","inbox","ai_drafting","support","analytics_advanced","listening","approvals_advanced","care_advanced","ai_workflows","automation","integrations_business","mcp"]'::jsonb,
   '{"ai_tokens":null,"storage_bytes":null,"exports":null,"x_writes":null,"x_reads":null,"listening_searches":null,"social_accounts":null,"integration_jobs":null,"mcp_calls":null}'::jsonb,
   '{"ai_tokens":null,"storage_bytes":null,"exports":null,"x_writes":null,"x_reads":null,"listening_searches":null,"social_accounts":null,"integration_jobs":null,"mcp_calls":null}'::jsonb,
   '[]'::jsonb, false, 'f48a4b22c6602e58570b0296f0eb5d3d0eead3dcb4750556ed0c1f54fcfbf252');

CREATE TABLE billing_provider_prices (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_version_id uuid NOT NULL REFERENCES billing_plan_versions(id),
  provider        text NOT NULL CHECK (provider IN ('stripe','test')),
  livemode        boolean NOT NULL DEFAULT false,
  price_ref       text NOT NULL CHECK (length(price_ref) BETWEEN 3 AND 120),
  product_ref     text CHECK (product_ref IS NULL OR length(product_ref) <= 120),
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid REFERENCES users(id),
  retired_at      timestamptz,
  UNIQUE (provider, price_ref),
  CHECK (provider <> 'test' OR NOT livemode)
);
CREATE UNIQUE INDEX billing_provider_prices_current_idx ON billing_provider_prices (provider, livemode, plan_version_id) WHERE retired_at IS NULL;
INSERT INTO billing_provider_prices(plan_version_id, provider, livemode, price_ref, product_ref)
  SELECT id, 'test', false, 'price_test_' || plan_id || '_v' || version, 'prod_test_' || plan_id FROM billing_plan_versions WHERE purchasable;

-- ------------------------------------------------------------------ per workspace
CREATE TABLE workspace_billing (
  workspace_id               uuid PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  plan_id                    text NOT NULL REFERENCES billing_plans(id),
  plan_version_id            uuid REFERENCES billing_plan_versions(id),
  status                     text NOT NULL CHECK (status IN ('trialing','active','payment_action_required','past_due','cancel_scheduled','cancelled','expired','incomplete','none','legacy')),
  seats                      int NOT NULL DEFAULT 0 CHECK (seats >= 0 AND seats <= 10000),
  provider                   text CHECK (provider IS NULL OR provider IN ('stripe','test')),
  livemode                   boolean,
  provider_customer_ref      text CHECK (provider_customer_ref IS NULL OR length(provider_customer_ref) <= 120),
  provider_subscription_ref  text CHECK (provider_subscription_ref IS NULL OR length(provider_subscription_ref) <= 120),
  provider_item_ref          text CHECK (provider_item_ref IS NULL OR length(provider_item_ref) <= 120),
  provider_price_ref         text CHECK (provider_price_ref IS NULL OR length(provider_price_ref) <= 120),
  provider_status            text CHECK (provider_status IS NULL OR length(provider_status) <= 40),
  trial_started_at           timestamptz,
  trial_ends_at              timestamptz,
  trial_plan_id              text REFERENCES billing_plans(id),
  current_period_start       timestamptz,
  current_period_end         timestamptz,
  cancel_at_period_end       boolean NOT NULL DEFAULT false,
  cancel_at                  timestamptz,
  cancelled_at               timestamptz,
  ended_at                   timestamptz,
  scheduled_plan_version_id  uuid REFERENCES billing_plan_versions(id),
  scheduled_seats            int CHECK (scheduled_seats IS NULL OR scheduled_seats >= 1),
  scheduled_effective_at     timestamptz,
  past_due_since             timestamptz,
  grace_ends_at              timestamptz,
  payment_action_required    boolean NOT NULL DEFAULT false,
  payment_method             jsonb,
  provider_synced_at         timestamptz,
  access_level               text NOT NULL DEFAULT 'full' CHECK (access_level IN ('full','restricted','suspended')),
  access_reason              text CHECK (access_reason IS NULL OR length(access_reason) <= 300),
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  version                    int NOT NULL DEFAULT 0,
  CHECK (scheduled_effective_at IS NOT NULL OR (scheduled_plan_version_id IS NULL AND scheduled_seats IS NULL))
);
CREATE UNIQUE INDEX workspace_billing_sub_idx ON workspace_billing (provider, provider_subscription_ref) WHERE provider_subscription_ref IS NOT NULL;
CREATE UNIQUE INDEX workspace_billing_customer_idx ON workspace_billing (provider, provider_customer_ref) WHERE provider_customer_ref IS NOT NULL;
CREATE INDEX workspace_billing_status_idx ON workspace_billing (status, trial_ends_at);
CREATE INDEX workspace_billing_sync_idx ON workspace_billing (provider_synced_at) WHERE provider_subscription_ref IS NOT NULL;

-- Existing workspaces keep everything they had: legacy plan (documented in docs/v4/PLANS_AND_ENTITLEMENTS.md "Migration").
INSERT INTO workspace_billing(workspace_id, plan_id, plan_version_id, status, seats)
  SELECT w.id, 'legacy', (SELECT id FROM billing_plan_versions WHERE plan_id='legacy' AND version=1), 'legacy', 0 FROM workspaces w;

CREATE TABLE billing_trial_redemptions (
  workspace_id     uuid PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  plan_id          text NOT NULL REFERENCES billing_plans(id),
  plan_version_id  uuid NOT NULL REFERENCES billing_plan_versions(id),
  redeemed_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  source           text NOT NULL CHECK (source IN ('signup','onboarding','settings','staff')),
  started_at       timestamptz NOT NULL,
  ends_at          timestamptz NOT NULL,
  original_ends_at timestamptz NOT NULL,
  extensions       int NOT NULL DEFAULT 0 CHECK (extensions BETWEEN 0 AND 3),
  created_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > started_at AND ends_at >= original_ends_at)
);
-- Redemptions are never deleted directly (only by the workspace's own deletion cascading — trigger depth > 1), and
-- started_at / original_ends_at never change. ends_at only moves forward.
CREATE FUNCTION billing_trial_redemption_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF pg_trigger_depth() > 1 THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'trial redemptions are permanent';
  END IF;
  IF NEW.started_at <> OLD.started_at OR NEW.original_ends_at <> OLD.original_ends_at OR NEW.redeemed_by IS DISTINCT FROM OLD.redeemed_by
     OR NEW.ends_at < OLD.ends_at OR NEW.extensions < OLD.extensions THEN
    RAISE EXCEPTION 'trial redemption can only be extended';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER billing_trial_redemption_guard BEFORE UPDATE OR DELETE ON billing_trial_redemptions FOR EACH ROW EXECUTE FUNCTION billing_trial_redemption_guard();

CREATE TABLE billing_checkout_sessions (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id               uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  provider                   text NOT NULL CHECK (provider IN ('stripe','test')),
  livemode                   boolean NOT NULL DEFAULT false,
  provider_session_ref       text CHECK (provider_session_ref IS NULL OR length(provider_session_ref) <= 200),
  plan_version_id            uuid NOT NULL REFERENCES billing_plan_versions(id),
  seats                      int NOT NULL CHECK (seats >= 1),
  first_charge_at            timestamptz,
  status                     text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','open','completed','expired','cancelled','failed')),
  url                        text CHECK (url IS NULL OR length(url) <= 2000),
  created_by                 uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  expires_at                 timestamptz NOT NULL,
  completed_at               timestamptz,
  provider_subscription_ref  text,
  error_code                 text CHECK (error_code IS NULL OR length(error_code) <= 80)
);
CREATE UNIQUE INDEX billing_checkout_one_open_idx ON billing_checkout_sessions (workspace_id) WHERE status IN ('pending','open');
CREATE UNIQUE INDEX billing_checkout_ref_idx ON billing_checkout_sessions (provider, provider_session_ref) WHERE provider_session_ref IS NOT NULL;
CREATE INDEX billing_checkout_ws_idx ON billing_checkout_sessions (workspace_id, created_at DESC);

CREATE TABLE billing_webhook_events (
  id                  bigserial PRIMARY KEY,
  provider            text NOT NULL CHECK (provider IN ('stripe','test')),
  provider_event_id   text NOT NULL CHECK (length(provider_event_id) BETWEEN 3 AND 120),
  type                text NOT NULL CHECK (length(type) <= 120),
  livemode            boolean NOT NULL DEFAULT false,
  provider_created_at timestamptz NOT NULL,
  received_at         timestamptz NOT NULL DEFAULT now(),
  object_type         text,
  object_ref          text,
  workspace_id        uuid REFERENCES workspaces(id) ON DELETE SET NULL,
  status              text NOT NULL DEFAULT 'received' CHECK (status IN ('received','processed','ignored','failed')),
  attempts            int NOT NULL DEFAULT 0,
  last_error          text CHECK (last_error IS NULL OR length(last_error) <= 500),
  processed_at        timestamptz,
  next_attempt_at     timestamptz NOT NULL DEFAULT now(),
  -- The verified event body (needed for re-processing). Purged after 90 days by the billing sweep (metadata stays).
  payload             jsonb,
  UNIQUE (provider, provider_event_id)
);
CREATE INDEX billing_webhook_pending_idx ON billing_webhook_events (next_attempt_at) WHERE status IN ('received','failed');
CREATE INDEX billing_webhook_ws_idx ON billing_webhook_events (workspace_id, id DESC) WHERE workspace_id IS NOT NULL;

CREATE TABLE billing_lifecycle_events (
  id                bigserial PRIMARY KEY,
  workspace_id      uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind              text NOT NULL CHECK (length(kind) BETWEEN 3 AND 60),
  from_status       text,
  to_status         text,
  from_plan         text,
  to_plan           text,
  seats             int,
  source            text NOT NULL CHECK (source IN ('user','staff','webhook','reconcile','system','signup','migration')),
  actor_user_id     uuid REFERENCES users(id) ON DELETE SET NULL,
  actor_service     text,
  provider_event_id text,
  reason            text CHECK (reason IS NULL OR length(reason) <= 500),
  detail            jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX billing_lifecycle_ws_idx ON billing_lifecycle_events (workspace_id, id DESC);
CREATE INDEX billing_lifecycle_kind_idx ON billing_lifecycle_events (workspace_id, kind);
INSERT INTO billing_lifecycle_events(workspace_id, kind, to_status, to_plan, source, actor_service)
  SELECT w.id, 'legacy_assigned', 'legacy', 'legacy', 'migration', '035_v4_billing' FROM workspaces w;

CREATE TABLE billing_invoices (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id          uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  provider              text NOT NULL CHECK (provider IN ('stripe','test')),
  provider_invoice_ref  text NOT NULL,
  number                text,
  status                text NOT NULL CHECK (length(status) <= 30),
  currency              text NOT NULL,
  amount_due_minor      int NOT NULL DEFAULT 0,
  amount_paid_minor     int NOT NULL DEFAULT 0,
  total_minor           int NOT NULL DEFAULT 0,
  hosted_url            text CHECK (hosted_url IS NULL OR length(hosted_url) <= 2000),
  pdf_url               text CHECK (pdf_url IS NULL OR length(pdf_url) <= 2000),
  period_start          timestamptz,
  period_end            timestamptz,
  provider_created_at   timestamptz NOT NULL,
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_invoice_ref)
);
CREATE INDEX billing_invoices_ws_idx ON billing_invoices (workspace_id, provider_created_at DESC);

-- Staff-scheduled lifecycle changes (e.g. a service suspension on a date). Applied by the worker sweep, audited.
CREATE TABLE billing_scheduled_actions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  action        text NOT NULL CHECK (action IN ('suspend')),
  run_at        timestamptz NOT NULL,
  reason        text NOT NULL CHECK (length(reason) BETWEEN 10 AND 500),
  status        text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','done','cancelled','failed')),
  created_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  done_at       timestamptz,
  cancelled_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  result        jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE UNIQUE INDEX billing_scheduled_one_idx ON billing_scheduled_actions (workspace_id, action) WHERE status = 'scheduled';
CREATE INDEX billing_scheduled_due_idx ON billing_scheduled_actions (run_at) WHERE status = 'scheduled';

-- Deterministic test double store (non-production only; Stripe-shaped objects so the real normaliser is exercised).
CREATE TABLE billing_test_objects (
  kind        text NOT NULL CHECK (kind IN ('customer','checkout_session','subscription','invoice','portal_session','price')),
  ref         text NOT NULL,
  data        jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (kind, ref)
);
