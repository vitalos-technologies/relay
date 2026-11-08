# V3.5 foundation stream — progress (resume point)

Brief: `docs/queue/03f_V3_5_PROMPT.md` §23 steps 1–3 + stream contract (`docs/V3_5_WORKSTREAMS.md`).
Migration: `028_v35_foundation.sql` — **applied to dev 2026-11-07, frozen** (+ `pnpm db:roles` re-run). No git.
Checkpoints → `evidence/v3-5/foundation/checkpoints/<n>-<area>-<theme>.png`.

## Decisions
- Adapter #1 = **Facebook Page** (Messenger DMs + Page post comments) via the existing Meta connector + webhook ingress.
  Telegram rejected for #1: Relay never calls setWebhook/getUpdates (existing-webhook rule), so a bot's update stream needs
  an explicit ownership plan (stream B). Live use needs Meta App Review; everything is exercised on the simulated transport.
- Inbox channels are an explicit opt-in per connected account (`inbox_channels`); missing messaging permissions are shown.
  Live scopes requested only when `META_REQUEST_INBOX=true`; Human Agent tag only with `META_HUMAN_AGENT_APPROVED=true`.
- Integrations live in `integration_connections` (credentials in the existing `credentials` vault), separate from social
  `connections`; generic verified webhook ingress `/api/connectors/webhooks/:connector`; durable sync jobs with idempotency
  keys, origin markers, reconcile-on-unknown.
- Internal notes = separate table + endpoint (`inbox_notes`); no outbound code path reads it.
- Send-once: idempotency key + locked conversation version check (version the agent saw when they STARTED writing) +
  partial unique index (one queued/sending per conversation); Unknown outcomes reconciled through provider lookup, never
  resent automatically; people settle Unknown explicitly.
- New permissions reserved for all V3.5 streams (core/authz.ts) + `care_agent` preset (028 widens the grants check).
- New workload classes: customer_reply / inbox_ingest (main pool, never deferred); integration_sync / listening_ingest /
  ai_assist (bulk pool).
- Generic UI components (`components/conversation/*`) carry no inbox types (V4 reuse).

## Status
- Done: research + `docs/v3-5/CAPABILITY_MATRIX.md`; contracts `packages/core/src/contracts/v35-{connectors,events,inbox,sla}.ts`;
  migration 028 (applied); services `connectors/*`, `inbox/*`; Meta inbox adapter + simulated API; worker wiring (rebuilt +
  restarted); API routes; UI (/inbox, Settings → Inbox (Channels, Service levels, Saved replies), Admin → Inbox health, nav);
  docs (matrix, workstreams, data model, inbox guide); demo seed + screenshot script.
- Lead review notes (checkpoints 1–2) addressed: composer always fully visible (panes sized to the viewport below the
  shell), list-row meta on one line (waiting time under the timestamp), channels list shows page name first + network icon.

## Verification (2026-11-08, production build on :3000, worker rebuilt)
- `pnpm typecheck` clean; ESLint clean on new web files.
- `pnpm test` (unit + contracts) **518/518** (incl. `tests/unit/v35-foundation.test.ts` 13).
- Integration (disposable DB) **427/427, 54 files** (incl. `v35-inbox` 8, `v35-connectors` 6).
- Full E2E **59 passed, 2 skipped** (desktop-only skips of @mobile tests): admin 5+1, collaboration 4+1, inbox 2+1,
  publishing 17+9, security 8, v2-product 4+1, v31-ui 6.
- Mobile QA: 8 screens × 7 widths (320–1440) — 0 page-level horizontal scroll.
- Secret scan (tracked + untracked) clean.
- §22 in scope: AT1, AT2, AT3, AT13 covered by integration + E2E (AT2/AT13 also include lease-expiry and lost-response cases).

## Decisions needed (lead)
1. Inbox in the phone bottom bar? Today it is in "More" (bottom bar keeps Overview/Planner/Create/Approvals). Agents may want
   it in the bar for users with `inbox.read`.
2. `care_agent` preset includes `integrations.read` (so agents can create HubSpot tickets/Asana tasks from cases through
   installed integrations). Confirm.
3. Editors get `listening.read` + `ai.use`, analysts `listening.read` (reserved now, used by D/E). Confirm before streams ship.
4. Meta App Review scope request for inbox (`pages_messaging`, `pages_manage_engagement`, `pages_read_user_content`) → add to
   the activation checklist with the Human Agent feature.

## Files
- new: `packages/db/migrations/028_v35_foundation.sql`; `packages/core/src/contracts/v35-{connectors,events,inbox,sla}.ts`;
  `packages/services/src/connectors/{index,registry,verify,store,jobs}.ts`;
  `packages/services/src/inbox/{index,shared,capabilities,channels,ingest,conversations,replies,cases,saved,simulate,hooks,admin,worker}.ts`;
  `packages/providers/src/meta/{inbox,inbox-fake}.ts`, `packages/providers/src/inbox-registry.ts`;
  `apps/web/app/api/{inbox,connectors,admin/inbox}/**`; `apps/web/app/(app)/inbox/page.tsx`; `apps/web/app/(admin)/admin/inbox/page.tsx`;
  `apps/web/components/{conversation,inbox}/**`; `scripts/{seed-inbox-demo.ts,inbox-shots.mjs}`;
  `tests/unit/v35-foundation.test.ts`, `tests/integration/v35-{inbox,connectors}.test.ts`, `tests/e2e/inbox.spec.ts`;
  `docs/v3-5/{CAPABILITY_MATRIX,DATA_MODEL_AND_EVENTS,INBOX_AND_CARE}.md`, `docs/V3_5_WORKSTREAMS.md`, this file.
- edited (shared, small/additive): `packages/core/src/authz.ts` (V3.5 permissions + care_agent), `packages/core/src/contracts/v31-perf.ts`
  (workload classes), `packages/services/src/workload/policy.ts` (class defaults + queue map), `packages/services/src/outbox.ts`
  (event types), `packages/services/src/engine/outbox-dispatcher.ts` (V3.5 queue routing), `packages/services/src/webhooks.ts`
  (Meta page events → inbox), `packages/services/src/settings.ts` (META_REQUEST_INBOX, META_HUMAN_AGENT_APPROVED),
  `packages/services/src/connections/runtime.ts` (meta_inbox feature flag), `packages/providers/src/meta/{connector,fake,index}.ts`,
  `packages/providers/src/index.ts`, `apps/worker/src/main.ts` (one registerV35Workers call), `infra/postgres/roles.sql`
  (care_case_events append-only), `apps/web/components/shell/app-shell.tsx` (Inbox nav), `apps/web/components/settings-shell/registry.tsx`
  (Inbox group), `apps/web/components/admin/nav.tsx` (Inbox and integrations group), `apps/web/components/team/shared.tsx` +
  `apps/web/components/settings/security-policy.tsx` (Care agent label).
