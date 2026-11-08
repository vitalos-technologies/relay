# V3.1 workstreams — contracts and ownership

Brief: `docs/queue/03b_V3_1_PROMPT.md` (read all of it). Started early (backend only) while the V3 UX redesign
(`docs/queue/018_UX_REDESIGN_BRIEF.md`) owns every screen. V3.1 UI work is a later stream, built on the redesigned components.

All V2/V3 contracts still apply (`docs/V2_WORKSTREAMS.md`, `docs/V3_WORKSTREAMS.md`):
- `requireAction`/`authorizeCtx`/`assertBrand` on every route, job and MCP tool.
- `v2Ctx` tests.
- Policy versions + audit.
- No tenant id from payloads alone.
- No external calls in page requests.
- Outbox → pg-boss with deterministic ids.
- Secrets envelope-encrypted.
- Simulated/demo data never mixed into live data.

## Rules for every V3.1 stream
- **Ownership:** backend only (services, migrations, API routes, worker wiring, tests, docs). Do not edit `apps/web/app/(app)/**` pages or `apps/web/components/**` (UX owns them). Expose typed contracts in `packages/core/src/contracts/v31-<area>.ts` and API routes, for the UI stream.
- **Migrations:** one file per stream (below); never edit an applied migration. Don't apply to the dev DB; the lead applies.
- **Shared dev server:** it runs the shared working tree live. Code in shared read paths must only reference applied schema. **021 and 022 were applied to dev on 2026-11-07 ~08:35 UTC and are frozen**; further changes go in `023_v31_data_more.sql` (DATA) and `024_v31_gov_more.sql` (GOV).
- **Shared files** (`apps/worker/src/main.ts`, `packages/services/src/outbox.ts`, `engine/outbox-dispatcher.ts`, `services/index.ts`): re-read before editing, keep diffs small and additive.
- **Git and dependencies:** no git commits/stash/checkout/reset; the lead commits. No new dependencies without stating why in the report.
- **Measurement:** measure before optimising; report sample counts and conditions. No performance claims from one run.
- **Progress note:** keep `docs/v3-1-progress/<stream>.md` current (done / next / files). Container restarts happen; it's your resume point.

## Streams

| Stream | Migration | Owns (brief §) |
|---|---|---|
| **PERF** Performance & workload isolation | `020_v31_perf.sql` | §2 baseline + reproducible benchmark harness (Small/Medium/Large synthetic datasets in throwaway DBs; DB/API/worker side; browser metrics are measured later on the redesigned UI), §3 budgets (server-side now), §5 backend/DB/caching (indexes, N+1, cursor pagination, bounded queries, cache keys incl. authz dims, invalidation), §6 workload classes / publishing capacity reservation / per-workspace + per-provider limits / backpressure / queue-age vs dispatch-delay vs processing metrics, §17 MCP latency measurement. Docs: PERFORMANCE_BASELINE.md, PERFORMANCE_BUDGETS.md, PERFORMANCE_RESULTS.md (server side). |
| **DATA** Drafts, recovery, trash, bulk, search | `021_v31_data.sql` | §9 draft resilience server side (autosave API with revisions, optimistic concurrency + conflict, recovery rules, workspace policy to disable local recovery), §10 undo/trash/soft delete + restore + asset-reference checks + audit, §11 bulk workflows as durable jobs with per-item results + idempotent retries + preview, §8 global search API (authorized results, snippets that don't leak, bounded, revocation-safe), §17 MCP tools for search / draft recovery status / bulk-job status. |
| **GOV** Brand safeguards, reuse, links, diagnostics, release | `022_v31_gov.sql` | §12 brand profile rules + asset governance (expiry/superseded, advisory vs mandatory, affected-schedules review, TipSignal fact preservation), §13 content reuse + queues (evergreen eligibility; never recycle time-sensitive picks), §14 campaign links/UTM (no open redirect), §15 integration diagnostics API (read-only; never publishes), §16 feature flags (workspace-scoped, safe defaults), error/support reports with redaction, changelog data, §7 onboarding checklist state API, §17 MCP tools for brand rules + diagnostics. |
| UI (later, after UX) | – | All V3.1 screens on the redesigned components: onboarding, Cmd+K, autosave states, trash/undo, bulk selection, brand rules, queues, link builder, diagnostics, release notes. Browser performance measurement (§3/§4). |
| Lead | – | Integration, V3 docs, regression + E2E, V3.1 docs: requirements matrix, architecture changes, test report, migration/rollback, gaps, activation. |
