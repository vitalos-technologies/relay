# Stream PL — Free plan: billing, entitlements, enforcement (D33)

Status: **done** (2026-11-10), awaiting lead review/commit. Migration **040** (`packages/db/migrations/040_free_plan.sql`).

## Environment notes
- 2026-11-10: Docker was down after a container restart (stale `/var/run/docker.pid`). PL restarted `dockerd` + `docker compose
  -f infra/compose.yaml up -d --wait` under the lock (HANDOFF step 4). Web (:3000) and worker were rebuilt and restarted by PL under
  the lock (worker pid in `.data/worker.pid`); PM also rebuilt web in between.

## For PM (answers to pm.md "Assumptions about PL's API")
- `POST /api/billing/signup` accepts `plan: 'free'` → workspace on Free (status `free`, no trial, no card, no provider
  objects). `GET /api/billing/signup` → `catalogue` = `publicCatalogue()` = free, standard, professional.
- Onboarding without a plan (`POST /api/workspaces`) also starts on **Free** (decision; documented in PLANS_AND_ENTITLEMENTS).
- Trial end without subscription → Free. Cancellation reaching its date → Free. Over-limit work held, nothing deleted.
- `BillingOverviewDto` adds `upgrade_trial_days` (14 when an upgrade checkout includes the never-used trial, else 0) and
  `actions.downgrade_to_free`. `BillingState.status` / `EntitlementsDto.status` may be `'free'`. `EntitlementsDto.member_hold`
  (string | null) = the caller is over the plan's user limit (teammate on Free).
- Entitlement errors for Free limits: HTTP 402 `entitlement_required`, `details.reason` `allowance_exhausted`, `details.allowance`
  one of `scheduled_posts | brands | members | social_accounts`, `details.upgrade_to` `'standard'`.

## Decisions (PL)
- **Default onboarding without a plan = Free** (no trial, no card). Trials are an explicit choice (`?plan=standard|professional`
  or Settings / upgrade checkout). Documented in `docs/v4/PLANS_AND_ENTITLEMENTS.md`.
- **No paid plan in force ⇒ Free** (trial ended, subscription ended / cancellation date reached, first payment incomplete after
  the trial). **Past-due beyond grace stays restricted** (live, unpaid subscription; cancelling moves to Free). Rationale in
  `docs/v4/FAILED_PAYMENT_AND_DOWNGRADE.md` "D33 in one paragraph".
- `cancelled` / `expired` (not live) are persisted as `free` (sync + sweep); `getBillingState` derives Free from the clock before
  the sweep. Provider refs and trial dates stay on the row as history.
- Upgrade checkout from Free includes the never-used 14-day trial (provider trial); the redemption is written when the provider
  confirms the subscription (abandoned checkout never uses it). A no-card "Start free trial" from Free also exists.
- Scheduled posts: counted once per post per calendar month **of publication** (ledger key `post:<id>:<YYYY-MM>`), at
  schedule / publish-now and again (idempotently) at dispatch — the dispatch gate is the safety net for approval paths and
  for posts carried over from a trial (earliest-due first; the rest held).
- Members over the limit: owners always active; others keep membership but `loadAccess` gives no brands and `requireAction`
  only passes `workspace.read`, `billing.read|manage`, `support.workspace` (`MEMBER_HOLD_ALLOWED`, tenancy.ts).
- Route-level feature gate (`entitlements/routes.ts`, called from `apps/web/lib/api.ts route()`): `/api/analytics/**`,
  `/api/inbox/**`. Professional-only areas keep their existing finer gates (Standard can still read them).
- Data export never blocked by the plan: handover + activity exports reserve `exports.count` with `planExempt`.
- Server upgrade copy uses PM's `packages/core/src/contracts/plan-copy.ts` (`featureUpgradeMessage`, `limitUpgradeMessage`,
  `cheapestPlanWithMore`) so prompts name the plan and its price.

## Files
New: `packages/db/migrations/040_free_plan.sql`, `packages/services/src/billing/free.ts`,
`packages/services/src/entitlements/routes.ts`, `apps/web/components/entitlements/feature-gate.tsx`,
`tests/integration/v4-free-plan.test.ts`.
Edited (PL-owned): `packages/core/src/contracts/{v4-billing,v4-entitlements,v4-billing-dto}.ts`, `packages/services/src/billing/
{catalogue,catalogue-def,policy,state,store,sync,trials,manage,platform,reconcile,signup}.ts`, `packages/services/src/entitlements/
{resolve,gauges,actions,holds,usage}.ts`, billing/entitlement UI (`apps/web/components/billing/*`, `components/entitlements/
{workspace-usage,shell-strip}.tsx`, Platform plans/billing pages), tests (`tests/unit/v4-{plans,billing-stripe,entitlements}.test.ts`,
`tests/integration/v4-{billing,entitlements-billing}.test.ts`, `tests/e2e/v4-{billing,entitlements}.spec.ts`), docs
(`docs/v4/{PLANS_AND_ENTITLEMENTS,FAILED_PAYMENT_AND_DOWNGRADE,BILLING_LIFECYCLE_AND_WEBHOOKS}.md`, checklist §7.3).
Edited shared (small, additive): `packages/services/src/{context,tenancy,workspaces,brands}.ts`, `auth/invitations.ts`,
`posts/{scheduling,approval-policy}.ts`, `engine/process.ts`, `product/{budgets,handover,activity}.ts`, `apps/web/lib/api.ts`,
`apps/web/app/(app)/{overview,inbox}/page.tsx`, `apps/web/components/analytics/v3/analytics-shell.tsx`, `scripts/seed-e2e.ts`
("E2E Free" fixture).

## Status
- Migration 040 applied to dev (frozen). Typecheck clean. Unit 685/685. Integration full suite: 619/621 (2 timing flakes
  under load — collab event ordering, listening perf — both pass alone); PL files 33 + 4 + 1 + 16 + 5 green.
- docs-check, docs-api-check: ok (no route changes).
- E2E (under the lock, after `pnpm db:seed:e2e`): `v4-billing` + `v4-entitlements` 12 passed, 1 skipped (the mobile-only test
  in the desktop project, by design). Screenshots: `evidence/v4/bil/settings-billing-free-*`, `platform-workspace-billing-free-1440-light.png`,
  `evidence/v4/ent/usage-free-*`, `analytics-free-prompt-*`.
- Note: catalogue hashes in 040 match v4-plans.ts as of 2026-11-10 ~04:30. Any later edit to PLANS (names, summaries,
  highlights, allowances) shows "Catalogue changed" in Platform → Plans and fails the drift test → publish a new version
  (Platform → Plans) or ask PL for a follow-up migration number.

## Cross-stream note (platform status, not PL work)
`GET /api/platform/v1/status` (`packages/services/src/platform-status/`) reads billing **read-only**: one grouped aggregate
over `workspace_billing` (`status`, `trial_ends_at`, `grace_ends_at`, `cancel_at`, `provider_subscription_ref`,
`provider_status`) and `billing_webhook_events` (`status`, `received_at`), and imports `deriveAccess` +
`LIVE_PROVIDER_STATUSES` from `billing/policy.ts`. If any of these move or change meaning, `tests/unit/platform-status.test.ts`
and `tests/integration/platform-status.test.ts` will show it; an unknown billing status counts only in the tenant total.
