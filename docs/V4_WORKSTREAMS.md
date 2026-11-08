# V4 workstreams — contracts and ownership

Brief: `docs/queue/03g_V4_PROMPT.md` (read all of it). Baseline: `docs/v4/BASELINE.md` (what exists, with file refs — read
before touching anything). V5 (`docs/queue/03h_V5_PROMPT.md`) follows V4 and builds on it: read V5 §5–10 so V4's data model
does not have to be redone (pricing, trials, seats, support widget).

All earlier contracts still apply (`docs/V2_WORKSTREAMS.md`, `docs/V3_WORKSTREAMS.md`, `docs/V3_1_WORKSTREAMS.md`,
`docs/V3_5_WORKSTREAMS.md`): `requireAction`/`authorizeCtx`/brand checks on every route, job and MCP tool; audit (both
audits for workspace-touching platform actions); no tenant id from payloads; no provider calls in page requests; outbox →
pg-boss with deterministic ids; secrets envelope-encrypted; missing credentials never become success.

## Lead decisions (already taken)
- **Catalogue:** `packages/core/src/contracts/v4-plans.ts` is the single source for public plans, prices, trial length,
  features and default allowances: **Standard £10 / Professional £25 per billable user per month, GBP, 14-day trial, no
  card required**, monthly only. `legacy` (non-purchasable, Professional features, no price, unmetered by plan) is assigned
  to every pre-V4 workspace by BIL's migration so nothing existing breaks; documented as migration behaviour. No other
  prices anywhere; no "test price" placeholders (V5 supersedes V4 §9's "don't invent prices").
- **Permissions** (core/authz.ts, done): `billing.read`, `billing.manage` (sensitive ⇒ MFA), `support.workspace`. Owner and
  admin presets include them (admin = ALL minus transfer/security). Any active member may create/read their **own** support
  requests (no permission). Billing never implies content access; support access never implies billing.
- **Staff roles:** `platform_operators.role` gains `billing` (BIL migration). `operator` ⊇ everything; `support` = tickets +
  support-access requests, **no billing actions**; `billing` = billing records + plan/trial/override actions, **no ticket
  internal notes or customer content**. Privileged staff actions use `requireFresh` (step-up).
- **Provider:** Stripe Billing behind `BillingProvider` (BIL). No keys here: deterministic test double + locally signed
  webhook fixtures (same signing scheme as Stripe's `Stripe-Signature` v1 HMAC, verified with the official algorithm from
  current Stripe docs). Hosted Checkout + Customer Portal only; never store card data. Live mode is an activation item.
- **Contract between BIL and ENT:** `packages/core/src/contracts/v4-billing.ts` (`BillingState`, `BILLING_EVENTS`). BIL
  implements `getBillingState(db, workspaceId)` in `packages/services/src/billing/state.ts`; ENT consumes it and never reads
  billing tables directly. Until BIL lands it, ENT may code against a local stub with the same signature.
- **V5 forward-compatibility (do not build V5, just don't block it):** support tickets allow a *visitor* requester (no
  workspace/user; `requester_kind in ('member','visitor')`, `visitor_id`), `source in ('app','problem_report','widget',
  'staff')`; trials are recorded per workspace in a redemption table (one ever per workspace) with the redeeming user;
  seat counting is one function (`billableSeats(db, workspaceId)`) used by checkout, settings, admin and webhooks.

## Rules for every V4 stream
- **Use shared services, don't fork them:** notifications (`collab/notifications.ts`, outbox → pg-boss), email
  (`email.ts`), storage (`storage.ts` presign + signed GET), rate limits (`ratelimit.ts`), idempotency (`idempotency.ts`),
  audits (`audit.ts`, `platformAudit`), budgets (`product/budgets.ts` — ENT extends it, nobody else), support access
  (`admin/support-access.ts`), conversation UI (`components/conversation/*`, keep generic).
- **Migrations:** one file per stream, additive: SUP `034_v4_support.sql`, BIL `035_v4_billing.sql`, ENT
  `036_v4_entitlements.sql`. Apply to dev when stable (`pnpm db:migrate` then `pnpm db:roles`, under the lock), then frozen;
  follow-ups get a new number from the lead (037+). Append-only tables: add the REVOKE in `infra/postgres/roles.sql`.
- **Shared files** (re-read right before editing; small additive diffs; list them in your progress note):
  `apps/worker/src/main.ts`, `packages/services/src/outbox.ts` (`OutboxEventType` union — append only),
  `engine/outbox-dispatcher.ts`, `engine/notify.ts`, `workload/policy.ts`, `packages/core/src/authz.ts` (lead only),
  `apps/web/components/shell/app-shell.tsx` + `user-menu.tsx` (nav), `apps/web/components/settings-shell/registry.tsx`,
  `apps/web/components/admin/nav.tsx`, `apps/web/lib/api.ts`, `infra/postgres/roles.sql`, `packages/services/src/collab/notifications.ts`,
  `packages/services/src/admin/platform.ts`, `packages/services/src/admin/support-access.ts`, `scripts/seed-e2e.ts`.
- **UI:** Relay design system, concise copy, no explanatory paragraphs on every screen, settings/subsections in the left
  sidebar, no page-level horizontal scroll at 320–1440 px. No payment-provider, email or AI calls during page render.
- **Honesty:** test mode is labelled; nothing claims payment, refund, delivery, or a fix without evidence from the
  service; no fake invoices; email replies are not claimed (no inbound email pipeline).
- **Git:** no commits/stash/checkout/reset; the lead commits. No new dependencies without a reason in your report.

## Streams

| Stream | Migration | Owns (brief §) | Owned files/dirs |
|---|---|---|---|
| **SUP** Relay support | `034_v4_support.sql` | §3–8, §15 (support parts), §16. Customer Help → Contact support / My requests (category, subject, message, attachments, status, reply/resolve/reopen, stable reference e.g. `RLY-48213`, visibility policy incl. restricted category, `support.workspace` for owners). Platform → Support inbox (queues new/unassigned, mine, waiting on Relay, waiting on customer, resolved, archived; assign, priority, category, search, filters, workspace context card from metadata only, public reply vs internal note visually distinct, attachments, saved replies, related problem reports + billing/ops records (read BIL/ENT services when present), history, duplicates, resolution reason, reopen). Separation from the social inbox (own tables, authz, notifications, retention, search). Problem report → "Send to Relay support" review-then-submit flow (diagnostics: app version, safe route, timestamp, browser family, correlation id, error code; nothing else by default). Durable notifications: customer in-app + email (link only, minimal preview), staff assignment/new-reply notifications **without a workspace** (extend the pipeline: platform-scope notifications + platform-scope idempotency), dedupe, retries, permission re-check, read/unread, failures shown separately. Support access from a ticket (reason, scope, duration, ticket FK), **owner notification on request**, worker sweep for expiry, usage visible both sides. Private attachments (allow-list, size, magic-byte sniff, quarantine until validated, short-lived signed URLs, per-requester authz; AV scanning = documented gap unless a scanner exists). Rate limits on create/reply/attach. AI assist for staff (summarize, draft, category, related) as drafts only, through existing `services/ai/*` and budgets; ticket text cannot trigger tools. Retention policy doc. | `packages/services/src/support/**`, `packages/core/src/contracts/v4-support.ts`, `apps/web/app/(app)/help/**`, `apps/web/app/api/support/**` (extend; keep `reports`), `apps/web/app/api/platform/support/**`, `apps/web/app/(admin)/admin/platform/support/**` (replace the support-access-only page; keep that list as a tab), `apps/web/components/support/**`, `apps/web/components/platform-support/**`, `tests/integration/v4-support*.test.ts`, `tests/e2e/v4-support.spec.ts` |
| **BIL** Plans, billing, trials, seats | `035_v4_billing.sql` | §9–11, §14 (billing/tenant parts), §10 lifecycle. Persist the catalogue (plans → immutable plan versions → provider price refs; seed from `v4-plans.ts`; `legacy` for existing workspaces). `BillingProvider` interface + Stripe adapter (hosted Checkout in `subscription` mode with per-seat quantity, Customer Portal, subscription update for seats/plan with provider proration preview, cancel at period end, reactivate, invoices list links, payment-method summary) + test double; webhook endpoint with signature verification, event store (dedupe by provider event id), out-of-order handling (provider `created` + object state re-fetch), reconciliation sweep. Subscription state machine (`SUBSCRIPTION_STATUSES`) + documented transitions; billing status vs service suspension vs access level as separate dimensions; `getBillingState()` (contract). **Trials:** no-card trial on the selected plan, started server-side once per workspace (redemption record; joining/plan change/refresh/replay never restarts or extends; operators may extend an eligible trial with reason + audit), exact `started_at`/`ends_at`, trial-ending/expired events; subscribing during the trial keeps the free period (first charge date = trial end, shown). **Seats:** `billableSeats()` per `v4-plans.ts` rules (owner + active accepted members; not pending invites, support-access operators, service accounts; free guests capped); ≥ 1 paid seat; seat increases show count + recurring total and require `billing.manage`; reductions/downgrades at period end (scheduled change); invite/accept flows check seat consequences (show cost; never silently add paid seats — follow the brief). Idempotency + concurrency on checkout/seat/plan changes (one open checkout per workspace; advisory lock). Settings → Billing (plan, status, trial/renewal, seats, usage summary from ENT when present, payment method summary, invoices, change plan, seats, portal, cancel/reactivate) and the selected-plan handoff route (`/signup?plan=standard` → workspace → trial) that V5's marketing page will link to. Platform: billing panel on Workspaces/[id] (status, dates, provider refs + "open in provider" link, lifecycle history, extend trial, schedule lifecycle change, suspend ≠ cancel), Platform → Plans (catalogue read-only + versions), billing staff role. Refunds: link to provider, no button. | `packages/services/src/billing/**`, `packages/providers/src/stripe/**`, `apps/web/app/api/billing/**`, `apps/web/app/api/webhooks/stripe/**` (or `/api/billing/webhook`), `apps/web/app/api/platform/billing/**`, `apps/web/app/(app)/settings/billing/**` or a settings-registry entry, `apps/web/app/(app)/signup/**` (handoff), `apps/web/app/(admin)/admin/platform/{plans,billing}/**`, `apps/web/components/billing/**`, `tests/integration/v4-billing*.test.ts`, `tests/e2e/v4-billing.spec.ts`, fixtures `tests/fixtures/stripe/**` |
| **ENT** Entitlements, usage, restriction policy | `036_v4_entitlements.sql` | §12–13. One shared entitlement service (`entitlements(db, workspaceId)` → plan, features, allowances (included/used/reserved/hard limit/warning), access level, reasons; cached per request; invalidated on `billing.access_changed` + overrides). Plan-derived ceilings that the **platform** controls, layered under the existing customer-set budgets (`product/budgets.ts`: customer caps can only lower, never raise, the plan ceiling). Durable, deduplicated usage events per billing period with a reset policy; race-free consumption of the last unit (reuse `reserveUsage`). Overrides (reason, scope, expiry, audit; operator/billing staff with step-up). Enforcement in **UI** (hook + upgrade prompts), **API** (`requireFeature`/`requireAllowance` on routes), **workers** (dispatch-time re-check: scheduled posts **held** with a reason, never dropped or duplicated — reuse the existing hold/pause mechanics and in-flight/unknown rules), queued replies, approvals, automations, AI jobs, listening ingestion, storage uploads, exports, integrations, **MCP** tools. Restricted access keeps read, billing, support and exports available. Downgrade over-limit: customer chooses which social accounts / searches / automations stay active; nothing deleted or disconnected. Documented grace + restriction policy (`docs/v4/FAILED_PAYMENT_AND_DOWNGRADE.md`). Workspace usage page (replace the "no billing system yet" card in `admin/usage`). | `packages/services/src/entitlements/**`, `packages/core/src/contracts/v4-entitlements.ts`, edits in `product/budgets.ts`, `engine/*` dispatch checks, `mcp/*` guard, `ai/*` guard, `listening/ingest.ts`, `media/assets.ts`, `automation/engine.ts`, `connectors/jobs.ts` (small, additive, noted), `apps/web/app/api/entitlements/**`, `apps/web/app/(admin)/admin/usage/**`, `apps/web/components/entitlements/**`, `tests/integration/v4-entitlements*.test.ts`, `tests/e2e/v4-entitlements.spec.ts` |
| **F4** Final (lead) | 037 only if needed | §17–19: cross-stream wiring, Platform overview counts, full E2E, mobile QA (320/360/390/430/768/1440), performance, security review, all §19 docs, final activation checklist. | `docs/v4/*` final versions, `scripts/v4-*.mjs` |

Order: SUP, BIL and ENT start together. ENT codes against the `BillingState` contract (stub until BIL's `state.ts`
exists) and the existing budgets; BIL calls ENT's hooks (seat/plan change → re-evaluate) via the `billing.access_changed`
event, not direct imports. SUP reads BIL/ENT services for the ticket's workspace context card only when present (guarded
import or a small `workspaceCommercialSummary` function BIL exposes).

## Docs each stream writes (brief §19) — `docs/v4/`
SUP: `SUPPORT_USER_GUIDE.md`, `PLATFORM_SUPPORT_GUIDE.md`, `SUPPORT_VISIBILITY_MATRIX.md`, `SUPPORT_ACCESS_WORKFLOW.md`,
retention section. BIL: `PLANS_AND_ENTITLEMENTS.md` (catalogue, seats, migration of existing workspaces),
`BILLING_LIFECYCLE_AND_WEBHOOKS.md`, `TENANT_LIFECYCLE_RUNBOOK.md`. ENT: `FAILED_PAYMENT_AND_DOWNGRADE.md`, entitlement
section of `PLANS_AND_ENTITLEMENTS.md` (coordinate: ENT appends its own section). Lead: `MOBILE_QA.md`, `TEST_REPORT.md`,
`IMPLEMENTATION_GAPS.md`, `FINAL_ACTIVATION_CHECKLIST.md`.
