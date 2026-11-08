# BIL — plans, billing, trials, seats (progress note / resume point)

Status: **DONE (ready for lead commit)** — 2026-11-08 ~09:10. Migration 035 applied to dev (035 only) + roles; web and worker
rebuilt/restarted; E2E green.

## Decisions
- Stripe Billing via plain `fetch` + form encoding + HMAC (no SDK). Pinned `Stripe-Version` `2026-10-28.endive`.
- **Env vars are Relay-namespaced**: `RELAY_STRIPE_SECRET_KEY`, `RELAY_STRIPE_WEBHOOK_SECRET`, `RELAY_STRIPE_WEBHOOK_SECRET_PREVIOUS`,
  `RELAY_STRIPE_API_VERSION`, `BILLING_LIVE_MODE=enabled` (live keys only with it). The shared host has a generic
  `STRIPE_SECRET_KEY` in its environment (not this project's, not printed, not used) — a test proves it is ignored.
- No keys → deterministic test double (`provider='test'`, non-production + mock providers only), labelled Test mode; hosted
  stand-ins at `/billing-test/checkout` and `/billing-test/portal`; outcomes arrive as signed events through the real webhook path.
- Webhook: verify (v1 HMAC, 300 s, rotation) → store (dedupe on event id) → process inline by RE-FETCHING the provider object →
  failures retried by the worker sweep (backoff, 10 attempts). Mapping via stored provider refs; metadata only if the customer matches.
- Workspaces without a `workspace_billing` row read as **legacy**; migration wrote explicit legacy rows for all existing workspaces.
  Product-created workspaces (`createWorkspace`, signup handoff) start a 14-day no-card trial (selected plan; onboarding default Standard).
- Upgrades / seat increases: immediate, `create_prorations` with previewed `proration_date`. Downgrades / seat reductions:
  provider updated with `proration_behavior=none`, Relay keeps current entitlements until period end (schedule recorded BEFORE
  the provider call so an early webhook sees it).
- Subscribing during the trial keeps the free period (`trial_end` ≥ 48 h, else `billing_cycle_anchor` + no proration).
- Seats: invites/accepts refused when a paid subscription has no free seat (pending member invites reserve seats); seat increases
  only in Billing with cost shown. Guest-only members free up to 5.
- Past-due grace 7 days (`PAST_DUE_GRACE_DAYS`, matches ENT's policy doc). Trial-ending notice 3 days before.
- Staff role `billing`; `requirePlatform(p, 'operator'|'support'|'billing'|'staff')` — `support` now excludes billing staff
  (support access = customer content); read-only metadata views use `staff`.
- For ENT: `getBillingState(db, ws)` in `services/billing/state.ts`. For SUP: `workspaceCommercialSummary(workspaceId)` (same file;
  metadata only, no provider refs).

## Files — new (owned)
`packages/db/migrations/035_v4_billing.sql`; `packages/providers/src/stripe/{signature,normalize,client,types}.ts`;
`packages/services/src/billing/{catalogue-def,catalogue,policy,store,seats,state,provider,test-provider,sync,webhooks,trials,manage,platform,reconcile,notify,signup,test-pages}.ts`;
`packages/core/src/contracts/v4-billing-dto.ts`; `apps/web/app/api/billing/**`, `apps/web/app/api/webhooks/stripe/route.ts`,
`apps/web/app/api/platform/billing/**`; `apps/web/app/signup/**` (top-level, not under `(app)`: public / pre-workspace),
`apps/web/app/billing-test/**`; `apps/web/app/(admin)/admin/platform/{billing,plans}/page.tsx`; `apps/web/components/billing/*`;
tests `tests/unit/v4-billing-stripe.test.ts`, `tests/integration/v4-billing.test.ts`, `tests/e2e/v4-billing.spec.ts`,
fixtures `tests/fixtures/stripe/*.json`; docs `docs/v4/{BILLING_LIFECYCLE_AND_WEBHOOKS,TENANT_LIFECYCLE_RUNBOOK}.md` +
BIL section of `docs/v4/PLANS_AND_ENTITLEMENTS.md`; screenshots `evidence/v4/bil/` (18).

## Files — edited shared (small, additive)
`packages/services/src/outbox.ts` (BillingEvent in union) · `packages/services/src/engine/notify.ts` (billing notify hook, no return) ·
`apps/worker/src/main.ts` (`billing-sweep` every 60 s) · `packages/services/src/admin/platform.ts` (requirePlatform levels, read views →
`staff`, grant role enum + billing, `suspendWorkspaceTx` extracted for scheduled suspensions) · `packages/core/src/contracts/v31-admin.ts`
(PLATFORM_ROLES + billing) · `packages/services/src/workspaces.ts` (platform_role type; `createWorkspace(..., opts)` starts the trial) ·
`packages/services/src/auth/invitations.ts` (seat check on invite + accept) · `infra/postgres/roles.sql` (REVOKEs: billing_lifecycle_events,
billing_trial_redemptions) · `scripts/seed-e2e.ts` (E2E Billing / E2E Billing Mobile fixtures reset to a fresh trial) ·
`scripts/platform-operator.ts` (billing role) · `apps/web/lib/client/types.ts` (platform_role) · `apps/web/components/admin/nav.tsx`
(Billing group; Support access hidden from billing staff; Plan and billing in workspace admin) · `apps/web/components/settings-shell/registry.tsx`
(Workspace → Plan and billing) · `apps/web/app/(admin)/admin/platform/workspaces/[id]/page.tsx` (billing panel; no support-access button for
billing staff) · `apps/web/app/(admin)/admin/platform/operators/page.tsx` (billing role option).

## Tests
Unit 17 (signature incl. rotation/v0/tolerance, fixtures, normalisers, Stripe request encoding with stubbed fetch, policy, prices).
Integration 25 (`v4-billing.test.ts`). Full integration suite 64 files / 551 tests green after my shared edits; unit 42 files / 600.
E2E `v4-billing.spec.ts`: 6 passed (desktop 5 + mobile 1; 1 intentional skip).

## Activation items
Stripe account + `RELAY_STRIPE_SECRET_KEY` (test first) and webhook endpoint `<APP_BASE_URL>/api/webhooks/stripe` with
`RELAY_STRIPE_WEBHOOK_SECRET` and the event list in BILLING_LIFECYCLE_AND_WEBHOOKS.md; create Products/Prices (£10 / £25 GBP monthly
per unit) and map them in Platform → Plans; Customer Portal configuration (payment method update, cancel at period end, no plan
switching there); tax settings + copy; live: `sk_live_` + `BILLING_LIVE_MODE=enabled`; Keycloak self-registration (realm has
`registrationAllowed: false`) or another signup path for the marketing handoff; billing staff assignments.
