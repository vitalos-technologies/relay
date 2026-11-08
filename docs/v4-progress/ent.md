# ENT — entitlements, usage, restriction policy (progress note / resume point)

Status: **done** — reported to lead.

## Decisions
- One resolver `entitlementsCore(db, ws)` (plan + features + allowance limits + access + reasons) used by every gate; the
  full DTO `entitlements(db, ws)` adds usage. Billing facts come only from `getBillingState()` (BIL) through
  `entitlements/source.ts` (local stub until BIL's `billing/state.ts` lands; stub ⇒ every workspace `legacy`).
- `legacy` = Professional features, every allowance unmetered by plan, access full ⇒ existing behaviour unchanged.
- Plan ceilings live inside `product/budgets.ts` (no fork): effective workspace cap = min(customer cap, plan ceiling).
  With a plan ceiling and no explicit customer cap, the old default AI cap (200k) does not apply (the plan is the cap).
- Period keys: trial ⇒ one bucket for the whole trial (`trial:YYYY-MM-DD`), subscription ⇒ `p:<period start date>`,
  otherwise (legacy/none) calendar `YYYY-MM` (unchanged). Storage is a gauge (`total`).
- Usage ledger `usage_events` (append-only, `UNIQUE(workspace_id, meter, dedupe_key)`); counters stay the fast path.
- Meter gates inside reserve/consume: ai.tokens ⇒ paid `ai_drafting`; storage.bytes ⇒ paid `media_library`; x.write ⇒
  paid `publishing`; integration.jobs ⇒ paid `integrations_business`; mcp.calls ⇒ feature `mcp`; exports.count and
  x.read ⇒ never gated by access (exports stay available; reconciliation reads must continue).
- Holds reuse existing mechanics: deliveries `state='blocked', last_error_code='entitlement_hold'` (like
  brand_rule_review), replies/sync jobs stay queued with `error_code='entitlement_hold'` and a later `next_attempt_at`.
  In-flight states (preparing/publishing/processing/unknown/handoff) are never touched.

## Status
- [x] contract `packages/core/src/contracts/v4-entitlements.ts`; `entitlement_required` (402) in core errors
- [x] migration `036_v4_entitlements.sql` — APPLIED to dev 08:0x (alone, via a MIGRATIONS_DIR without 034/035) + `db:roles`; frozen
- [x] services `packages/services/src/entitlements/**` (source → BIL `getBillingState` now that it exists), budgets extension
- [x] enforcement: engine gate (+ send-gate re-check), schedule/publish-now, replies (request + dispatch), sync jobs,
      GBP posts, Slack deliveries, automation runs + config, AI (reserve + run request + worker run), listening
      (search create gauge + matching), uploads/storage, exports (ceiling only), MCP tools + resources, connections gauge,
      multi-step approvals
- [x] worker: `billing.*` events → `onBillingAccessChanged` (engine/notify.ts), 5-min sweep (main.ts)
- [x] API routes, usage page, hook + prompts + shell strip, platform overrides panel
- [x] integration tests: v4-entitlements (16), v4-entitlements-workers (5), v4-entitlements-billing (1); unit (8)
- [x] full integration suite green: 64 files / 550 tests; unit 42 files / 600 tests; typecheck clean
- [x] docs: `docs/v4/FAILED_PAYMENT_AND_DOWNGRADE.md`, Entitlements section of `docs/v4/PLANS_AND_ENTITLEMENTS.md`
- [x] E2E `tests/e2e/v4-entitlements.spec.ts`: 4/4 (desktop 3 + @mobile 1; no page scroll 320–1440) + screenshots `evidence/v4/ent/`
- [x] also gated: saved analytics reports (analytics_advanced), SLA policies (care_advanced); upgrade prompts on Listening/Automation/Integrations

## Next
Nothing open. Gaps: AI workflows feature (V5) has no surface yet; reschedule() relies on the dispatch gate for held accounts; legacy rows in screenshots usage-*-1440-light/390 predate a copy tweak.

## Files
New: contracts/v4-entitlements.ts; db/migrations/036_v4_entitlements.sql; services/src/entitlements/{source,resolve,gauges,
holds,usage,overrides,actions,index}.ts; apps/web/app/api/entitlements/{route,selections/route}.ts;
apps/web/app/api/platform/entitlements/[workspaceId]/{route,overrides/[id]/revoke/route}.ts; apps/web/components/
entitlements/{use-entitlements.ts,prompts,workspace-usage,platform-entitlements,shell-strip}.tsx;
tests/integration/v4-entitlements{,-workers,-billing}.test.ts; tests/unit/v4-entitlements.test.ts.
Edited shared (small, additive): core/errors.ts (error code); infra/postgres/roles.sql (usage_events append-only);
product/budgets.ts + usage-admin.ts (owned extension); engine/process.ts (gate), engine/hooks.ts (reconnect never releases
entitlement_hold), engine/notify.ts (billing.* → ENT; threshold copy for non-X meters); apps/worker/src/main.ts (sweep);
mcp/tools.ts + principal.ts + resources.ts; inbox/replies.ts; connectors/jobs.ts; integrations-v35/{gbp,slack}/service.ts;
automation/{engine,rules,policies}.ts; assistant/runs.ts; listening/{searches,ingest}.ts; connections/{store,manage}.ts;
posts/{scheduling,approval-policy}.ts; apps/web/app/(admin)/admin/usage/page.tsx (owned);
apps/web/app/(admin)/admin/platform/workspaces/[id]/page.tsx (mount panel); apps/web/components/shell/shell-banners.tsx
(strip); apps/web/components/integrations/budgets-settings.tsx (copy); tests/integration/settings-v11.test.ts (2 new rows);
analytics/reports.ts, inbox/cases.ts (feature gates); apps/web/app/(app)/{listening,automation,integrations}/page.tsx (prompt);
docs/v4/PLANS_AND_ENTITLEMENTS.md (created with BIL placeholder comment + ENT section). New: tests/e2e/v4-entitlements.spec.ts,
docs/v4/FAILED_PAYMENT_AND_DOWNGRADE.md.

## Activation items
- Final per-plan allowances (defaults in `v4-plans.ts`) and grace length (BIL policy).

## Notes for lead
- engine/notify.ts handles `billing.access_changed|subscription_changed|trial_expired|subscription_ended|payment_recovered`
  for ENT; if BIL adds cases for the same event types there, merge them into one case (ENT's call is idempotent).
