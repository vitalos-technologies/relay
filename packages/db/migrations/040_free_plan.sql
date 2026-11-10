-- D33 Free plan + new public prices (stream PL; docs/DECISIONS.md D33, docs/v4/PLANS_AND_ENTITLEMENTS.md). Additive.
--
-- Catalogue: a 'free' plan (public, £0, never purchasable: no checkout, no provider price) and NEW immutable versions
--   seeded from packages/core/src/contracts/v4-plans.ts: Standard £5 (500), Professional £15 (1500), Free £0, and a legacy
--   version carrying the three new allowance keys (unmetered). The previous current versions are RETIRED FOR NEW PURCHASES
--   ONLY: every workspace_billing row keeps the plan_version_id it has (no silent repricing — a Standard v1 subscription
--   still bills its v1 provider price, £10). A version is only inserted when no current version already matches the hash.
-- Status 'free' on workspace_billing: Free workspaces have no provider customer/subscription. Rows that are 'expired'
--   (no-card trial ended) or 'cancelled' (subscription ended) with no live provider subscription move to Free now — the
--   D33 rule that replaces "expired/cancelled ⇒ restricted". Nothing is deleted; over-limit resources are held by the
--   entitlement service (selections below), never disconnected.
-- Entitlements: downgrade choices extend to brands and members; customer budgets may cap the new posts.scheduled meter.
-- Rollback: UPDATE workspace_billing SET status='expired', plan_id=trial_plan_id ... WHERE status='free' (restricted again);
--   DELETE FROM billing_provider_prices/billing_plan_versions rows created here is refused by the immutability trigger —
--   retire them instead (retired_at) and un-retire is not possible: publish matching versions from Platform → Plans;
--   restore the three CHECK constraints below to their 035/036 lists after moving rows off the new values.

INSERT INTO billing_plans(id, public, sort) VALUES ('free', true, 0) ON CONFLICT (id) DO NOTHING;

ALTER TABLE workspace_billing DROP CONSTRAINT IF EXISTS workspace_billing_status_check;
ALTER TABLE workspace_billing ADD CONSTRAINT workspace_billing_status_check
  CHECK (status IN ('trialing','active','payment_action_required','past_due','cancel_scheduled','cancelled','expired','incomplete','none','legacy','free'));

ALTER TABLE entitlement_selections DROP CONSTRAINT IF EXISTS entitlement_selections_allowance_check;
ALTER TABLE entitlement_selections ADD CONSTRAINT entitlement_selections_allowance_check
  CHECK (allowance IN ('social_accounts','listening_searches','brands','members'));

ALTER TABLE usage_budgets DROP CONSTRAINT IF EXISTS usage_budgets_meter_check;
ALTER TABLE usage_budgets ADD CONSTRAINT usage_budgets_meter_check
  CHECK (meter IN ('ai.tokens','x.write','x.read','storage.bytes','exports.count','mcp.calls','integration.jobs','posts.scheduled'));

-- ------------------------------------------------------------------ new plan versions (catalogue_hash = catalogue-def.ts)
CREATE TEMP TABLE pl_new_versions (plan_id text, name text, summary text, unit_amount_minor int, trial_days int, features jsonb, allowances jsonb,
  trial_allowances jsonb, highlights jsonb, purchasable boolean, catalogue_hash text) ON COMMIT DROP;
INSERT INTO pl_new_versions VALUES
  ('free', 'Free', 'For one person getting started.', 0, 0,
   '["publishing","media_library","ai_drafting","support"]'::jsonb,
   '{"ai_tokens":{"base":20000,"per_seat":0},"storage_bytes":{"base":524288000,"per_seat":0},"exports":{"base":0,"per_seat":0},"x_writes":{"base":0,"per_seat":0},"x_reads":{"base":0,"per_seat":0},"listening_searches":{"base":0,"per_seat":0},"social_accounts":{"base":2,"per_seat":0},"integration_jobs":{"base":0,"per_seat":0},"mcp_calls":{"base":0,"per_seat":0},"scheduled_posts":{"base":10,"per_seat":0},"brands":{"base":1,"per_seat":0},"members":{"base":1,"per_seat":0}}'::jsonb,
   '{"ai_tokens":{"base":20000,"per_seat":0},"storage_bytes":{"base":524288000,"per_seat":0},"exports":{"base":0,"per_seat":0},"x_writes":{"base":0,"per_seat":0},"x_reads":{"base":0,"per_seat":0},"listening_searches":{"base":0,"per_seat":0},"social_accounts":{"base":2,"per_seat":0},"integration_jobs":{"base":0,"per_seat":0},"mcp_calls":{"base":0,"per_seat":0},"scheduled_posts":{"base":10,"per_seat":0},"brands":{"base":1,"per_seat":0},"members":{"base":1,"per_seat":0}}'::jsonb,
   '["1 user","1 brand and 2 social accounts","10 scheduled posts a month","Planner, composer and 500 MB media","Help Centre support"]'::jsonb, false, '8cb5af26582f1e2c8ba5332d4549f009d8bab82e5fcdb065a4117c1b3f2c7078'),
  ('standard', 'Standard', 'Plan, publish and reply together.', 500, 14,
   '["publishing","media_library","collaboration","analytics_standard","inbox","ai_drafting","support"]'::jsonb,
   '{"ai_tokens":{"base":100000,"per_seat":50000},"storage_bytes":{"base":10737418240,"per_seat":5368709120},"exports":{"base":20,"per_seat":0},"x_writes":null,"x_reads":null,"listening_searches":{"base":0,"per_seat":0},"social_accounts":{"base":5,"per_seat":3},"integration_jobs":{"base":0,"per_seat":0},"mcp_calls":{"base":0,"per_seat":0},"scheduled_posts":null,"brands":null,"members":null}'::jsonb,
   '{"ai_tokens":{"base":100000,"per_seat":0},"storage_bytes":{"base":2147483648,"per_seat":0},"exports":{"base":5,"per_seat":0},"x_writes":{"base":0,"per_seat":0},"x_reads":{"base":0,"per_seat":0},"listening_searches":{"base":0,"per_seat":0},"social_accounts":{"base":5,"per_seat":0},"integration_jobs":{"base":0,"per_seat":0},"mcp_calls":{"base":0,"per_seat":0},"scheduled_posts":null,"brands":null,"members":null}'::jsonb,
   '["Publishing and scheduling","Shared calendar and media library","Team collaboration","Social inbox","Standard analytics","AI drafting help"]'::jsonb, true, '5789b657a52025f303bca9eb7bbef350858b6d2c92a5fee64ab3110f726d16d4'),
  ('professional', 'Professional', 'Everything in Standard, plus advanced workflows.', 1500, 14,
   '["publishing","media_library","collaboration","analytics_standard","inbox","ai_drafting","support","analytics_advanced","listening","approvals_advanced","care_advanced","ai_workflows","automation","integrations_business","mcp"]'::jsonb,
   '{"ai_tokens":{"base":500000,"per_seat":200000},"storage_bytes":{"base":53687091200,"per_seat":10737418240},"exports":{"base":200,"per_seat":0},"x_writes":null,"x_reads":null,"listening_searches":{"base":5,"per_seat":2},"social_accounts":{"base":10,"per_seat":5},"integration_jobs":{"base":5000,"per_seat":1000},"mcp_calls":{"base":10000,"per_seat":2000},"scheduled_posts":null,"brands":null,"members":null}'::jsonb,
   '{"ai_tokens":{"base":100000,"per_seat":0},"storage_bytes":{"base":2147483648,"per_seat":0},"exports":{"base":5,"per_seat":0},"x_writes":{"base":0,"per_seat":0},"x_reads":{"base":0,"per_seat":0},"listening_searches":{"base":2,"per_seat":0},"social_accounts":{"base":5,"per_seat":0},"integration_jobs":{"base":200,"per_seat":0},"mcp_calls":{"base":500,"per_seat":0},"scheduled_posts":null,"brands":null,"members":null}'::jsonb,
   '["Everything in Standard","Advanced analytics and reports","Listening on activated sources","Advanced approvals and customer care","AI workflows and automation","Business integrations and MCP"]'::jsonb, true, 'd7b05ad0d857e1fa89aa5ce38aa79e38ee33ad09e3ce5cdec6f764afa723a560'),
  ('legacy', 'Legacy', 'Workspaces created before plans existed.', NULL, 0,
   '["publishing","media_library","collaboration","analytics_standard","inbox","ai_drafting","support","analytics_advanced","listening","approvals_advanced","care_advanced","ai_workflows","automation","integrations_business","mcp"]'::jsonb,
   '{"ai_tokens":null,"storage_bytes":null,"exports":null,"x_writes":null,"x_reads":null,"listening_searches":null,"social_accounts":null,"integration_jobs":null,"mcp_calls":null,"scheduled_posts":null,"brands":null,"members":null}'::jsonb,
   '{"ai_tokens":null,"storage_bytes":null,"exports":null,"x_writes":null,"x_reads":null,"listening_searches":null,"social_accounts":null,"integration_jobs":null,"mcp_calls":null,"scheduled_posts":null,"brands":null,"members":null}'::jsonb,
   '[]'::jsonb, false, '5d48b71242ac316d125b6fe4f5f0b07fc3eae7a91a2943350b029d27991f1c64');

-- Retire the current version of each plan whose definition changed (new purchases only; subscriptions keep theirs).
UPDATE billing_plan_versions v SET retired_at=now()
  FROM pl_new_versions n WHERE v.plan_id=n.plan_id AND v.retired_at IS NULL AND v.catalogue_hash <> n.catalogue_hash;

INSERT INTO billing_plan_versions(plan_id, version, name, summary, unit_amount_minor, currency, interval, per_seat, trial_days, features, allowances, trial_allowances, highlights, purchasable, catalogue_hash)
  SELECT n.plan_id, coalesce((SELECT max(version) FROM billing_plan_versions x WHERE x.plan_id=n.plan_id), 0) + 1, n.name, n.summary, n.unit_amount_minor, 'GBP', 'month', true,
         n.trial_days, n.features, n.allowances, n.trial_allowances, n.highlights, n.purchasable, n.catalogue_hash
    FROM pl_new_versions n
   WHERE NOT EXISTS (SELECT 1 FROM billing_plan_versions v WHERE v.plan_id=n.plan_id AND v.retired_at IS NULL);

-- The deterministic test double gets a price for each new purchasable version (Stripe prices are mapped by staff in
-- Platform → Plans — activation item: £5 / £15 monthly GBP prices; no Stripe product or price for Free).
INSERT INTO billing_provider_prices(plan_version_id, provider, livemode, price_ref, product_ref)
  SELECT v.id, 'test', false, 'price_test_' || v.plan_id || '_v' || v.version, 'prod_test_' || v.plan_id
    FROM billing_plan_versions v
   WHERE v.purchasable AND v.retired_at IS NULL
     AND NOT EXISTS (SELECT 1 FROM billing_provider_prices p WHERE p.plan_version_id=v.id AND p.provider='test' AND p.retired_at IS NULL)
  ON CONFLICT DO NOTHING;

-- ------------------------------------------------------------------ ended trials / subscriptions → Free (D33)
INSERT INTO billing_lifecycle_events(workspace_id, kind, from_status, to_status, from_plan, to_plan, seats, source, actor_service, detail)
  SELECT b.workspace_id, 'moved_to_free', b.status, 'free', b.plan_id, 'free', 0, 'migration', '040_free_plan', '{"rule":"D33"}'::jsonb
    FROM workspace_billing b
   WHERE b.status IN ('expired','cancelled')
     AND (b.provider_subscription_ref IS NULL OR b.provider_status IS NULL OR b.provider_status IN ('canceled','incomplete_expired'));

UPDATE workspace_billing b SET status='free', plan_id='free',
       plan_version_id=(SELECT id FROM billing_plan_versions WHERE plan_id='free' AND retired_at IS NULL),
       seats=0, scheduled_plan_version_id=NULL, scheduled_seats=NULL, scheduled_effective_at=NULL, past_due_since=NULL, grace_ends_at=NULL,
       payment_action_required=false, access_level='full', access_reason=NULL, updated_at=now(), version=b.version+1
 WHERE b.status IN ('expired','cancelled')
   AND (b.provider_subscription_ref IS NULL OR b.provider_status IS NULL OR b.provider_status IN ('canceled','incomplete_expired'));
