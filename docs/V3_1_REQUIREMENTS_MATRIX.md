# V3.1 requirements matrix

One row per requirement in the V3.1 brief ([docs/queue/03b_V3_1_PROMPT.md](queue/03b_V3_1_PROMPT.md); § numbers match). As of 2026-11-07, `main` @ b7bf474.

**Status values:**
- **Locally verified:** an automated test or a recorded local measurement covers it.
- **Implemented:** code exists, no test.
- **Live verified:** nothing yet.
- **Awaiting external activation:** needs something outside the code ([V3_1_FINAL_ACTIVATION_CHECKLIST.md](V3_1_FINAL_ACTIVATION_CHECKLIST.md)).
- **Incomplete:** not built, or only partly built ([V3_1_IMPLEMENTATION_GAPS.md](V3_1_IMPLEMENTATION_GAPS.md)).

Results: [V3_1_TEST_REPORT.md](V3_1_TEST_REPORT.md). Design: [V3_1_ARCHITECTURE_CHANGES.md](V3_1_ARCHITECTURE_CHANGES.md).

**Feature flags:** six V3.1 UI features sit behind workspace feature flags that default **off**:
- onboarding checklist;
- content queue;
- tracked links;
- brand rules editor;
- integration diagnostics;
- release notes.

They are on in the Demo and E2E workspaces. Turning them on in production is an activation step. The flags gate the UI only (gap G6).

Test keys (under `tests/`):

| Key | File | Key | File |
|---|---|---|---|
| **VD** | `integration/v31-data.test.ts` (20) | **VDM** | `integration/v31-data-mcp.test.ts` (4) |
| **VG** | `integration/v31-gov.test.ts` (19) | **VP** | `integration/v31-perf.test.ts` (4) |
| **VAS** | `integration/v31-analytics-summary.test.ts` (3) | **VBH** | `integration/v31-brand-rule-hold.test.ts` (2) |
| **UD / UG / UP** | `unit/v31-{data,gov,perf}.test.ts` (4 / 19 / 11) | **E31** | `e2e/v31-ui.spec.ts` (6) |
| **E2E** | full Playwright suite, 45/45 on a production build | | |

## §1 Execution rules and branding

| ID | Requirement | Status | Evidence | Notes |
|---|---|---|---|---|
| 1.1 | Preserve V3 integrations, analytics, Drive/Docs/Notion, MCP, UI, left Settings | Locally verified | All V3 suites pass (unit + contracts 490, integration 375); E2E 45/45 | |
| 1.2 | Preserve V2 security, isolation, permissions, approvals, offboarding | Locally verified | V2 suites in the same run; VD/VG cross-workspace tests | |
| 1.3 | "Relay" in all user-facing text; compatibility identifiers kept | Implemented | `packages/core/src/brand.ts`; no "Social Lite" left in `apps/` or services | Demo seed image text still reads "Social Lite sample asset" (`scripts/seed-agency.ts`) |
| 1.4 | Test transports labelled; simulations never shown as live | Locally verified | V3 tests; design doc "demo shown once" | |
| 1.5 | Resumable build-status document | Implemented | `HANDOFF.md`, `docs/v3-1-progress/*.md`, `docs/BUILD_STATUS.md` | |
| 1.6 | Deploy to an authorized environment, else a reproducible package | Awaiting external activation | Dockerfiles + `scripts/dev.sh` (V1) | No authorized target |

## §2 Measured baseline

| ID | Requirement | Status | Evidence | Notes |
|---|---|---|---|---|
| 2.1 | Inspect bundles, queries, indexes, API, caching, worker, auth checks, page-time provider calls | Locally verified | [PERFORMANCE_BASELINE.md](PERFORMANCE_BASELINE.md) "Findings" | |
| 2.2 | Reproducible benchmark suite: Small / Medium / Large, multiple workspaces | Locally verified | `scripts/bench/*` (`pnpm bench`); `evidence/perf/baseline-*.json` | Large = 250k posts in the measured workspace |
| 2.3 | Conditions documented (hardware, DB size, cache, load) | Locally verified | PERFORMANCE_BASELINE "Conditions" | Shared host; load average reported |
| 2.4 | Real-browser workflows (cold, warm, typing, autosave, search, calendar change, analytics filter) | Incomplete | `scripts/v31-browser-perf.mjs`: cold loads, warm nav, composer typing and Cmd+K INP proxy | Autosave ack, search results, calendar drag and analytics filter change are not timed in the browser |

## §3 Performance contract

| ID | Requirement | Status | Evidence | Notes |
|---|---|---|---|---|
| 3.1 | LCP ≤ 2 s p75 | Locally verified (lab) | PERFORMANCE_RESULTS "Browser": ≤ 556 ms, n = 10/route | Unthrottled localhost; field data awaiting activation |
| 3.2 | INP ≤ 200 ms p75 | Locally verified (lab proxy) | ≤ 64 ms (one scripted interaction per route) | Not field INP |
| 3.3 | CLS ≤ 0.1 p75 | Locally verified (lab) | ≤ 0.032; Connections 0.222 → 0 | |
| 3.4 | Warm navigation ≤ 300 ms p95 | Locally verified (lab) | ≤ 202 ms, n = 10 | p95 of 10 = slowest run |
| 3.5 | Composer typing: no network-dependent input, no jank | Locally verified | Autosave debounced (800 ms) off the input path; composer INP proxy 40 ms | |
| 3.6 | Draft save server ack ≤ 500 ms p95 | Incomplete | Server autosave path tested (VD) | Not timed end to end |
| 3.7 | Search results ≤ 400 ms p95 | Locally verified (server) | `scripts/v31-search-bench.ts`: FTS p95 15.1 ms at 50k posts; budget row "posts search" | Browser end-to-end not timed |
| 3.8 | Analytics filter change ≤ 800 ms p95 | Locally verified (server) | Overview 28 d Large p95 435 ms (round 2) | Browser end-to-end not timed |
| 3.9 | Long-running ops: local feedback + job ack ≤ 500 ms p95 | Incomplete | Bulk start returns 202 with a job (VD); UI shows progress (E31 bulk) | Not timed |
| 3.10 | Route budgets (JS, requests, response size) set and enforced | Locally verified | [PERFORMANCE_BUDGETS.md](PERFORMANCE_BUDGETS.md); `pnpm bench:compare … --check`; `v31-browser-perf.mjs --check` | Planner payload still over budget at Medium/Large |
| 3.11 | Real-user Web Vitals | Awaiting external activation | — | No collection code and no endpoint (gap G2) |

## §4 Frontend

| ID | Requirement | Status | Evidence | Notes |
|---|---|---|---|---|
| 4.1 | Route/feature code splitting; lazy charts, video editing, Picker, integration setup | Locally verified | Settings sections, Content Hub panel, Content sources and Picker on demand (Settings JS 326 → 303 KB) | |
| 4.2 | Small app shell | Incomplete | ~230 KB shared baseline per route | `@social-lite/core` barrel pulls zod + all schemas into the browser (gap G1) |
| 4.3 | Persistent shell; conservative prefetch respecting data saver | Incomplete | Persistent shell (warm nav measured) | Next.js default prefetch; no Save-Data / connection check |
| 4.4 | Cancel obsolete requests; dedupe identical requests | Implemented | Cmd+K aborts the previous request; `use-api.ts` drops stale responses (sequence) | No general dedupe |
| 4.5 | Virtualize long lists; paginate big tables; thumbnails; reserved media size | Implemented | Cursor pagination (posts, history); bounded planner/dashboard; `Thumb` | No list virtualization |
| 4.6 | Fewer rerenders; heavy work off the main thread; restrained motion; no theme flash | Locally verified | INP fix: removed `backdrop-filter` (keystrokes 100–140 → 16–24 ms); theme boot script in `app/layout.tsx` | |
| 4.7 | Accessibility, permissions and recoverable errors preserved | Locally verified | E2E keyboard test; `app/(app)/error.tsx`, `global-error.tsx` | |

## §5 Backend, database, caching

| ID | Requirement | Status | Evidence | Notes |
|---|---|---|---|---|
| 5.1 | Page requests never wait on providers, Google, Notion or AI | Locally verified | PERFORMANCE_BUDGETS "Rules"; every page scenario is DB + CPU | |
| 5.2 | Bounded queries, cursors, composite indexes, no N+1, query plans | Locally verified | `mig/020` indexes; approval inbox 1,276 → 11 statements; harness records statement counts | |
| 5.3 | Precomputed/incremental analytics aggregates | Locally verified | `mig/025` `metric_rollup_days`; VAS | 365-day overview Large p95 2,052 → 1,538 ms |
| 5.4 | Pooling, timeouts, cancellation, small payloads | Locally verified | Search `pg_cancel_backend` + 2 s budget (VD "cancellation…"); dashboard `today` ≤ 200 | Planner payload ~700–800 KB at scale (gap G7) |
| 5.5 | Cache keys carry every auth dimension; revocation never survives a cache | Locally verified | No application cache added; VP "a revoked approver loses can_decide at once"; Cmd+K client cache keyed by workspace + policy version | |
| 5.6 | No Redis/microservices without measured reason | Locally verified | PERFORMANCE_RESULTS "Caching decision" | |

## §6 Background workload isolation

| ID | Requirement | Status | Evidence | Notes |
|---|---|---|---|---|
| 6.1 | Workload classes defined | Locally verified | `services/workload/policy.ts`; UP "defines every class…" | 8 classes |
| 6.2 | Reserved publishing capacity | Locally verified | Separate bulk pool (`runWithPool`); `evidence/perf/isolation.json` dispatch p95 3.37 → 1.14 s | 3 runs each |
| 6.3 | Per-workspace and per-provider limits, fairness, backpressure, bounded retries | Locally verified | UP caps/deferral tests; VP "never exceeds the provider cap…"; V2 fair dispatch | |
| 6.4 | Checkpoints, idempotency, Unknown kept; no duplicates | Locally verified | isolation load test: 0 duplicate sends over 1,080 deliveries; VP | |
| 6.5 | Queue age, dispatch delay, processing time reported separately; provider time apart | Locally verified | `workload_samples` (`mig/020`); `GET /api/ops/workload`; VP "records dispatch delay / processing / provider time…" | |

## §7 Guided onboarding

| ID | Requirement | Status | Evidence | Notes |
|---|---|---|---|---|
| 7.1 | Resumable checklist (seven steps) with progress, dismiss and resume | Locally verified | `services/gov/onboarding.ts`; VG "derived from real data, resumable and role-adapted"; E31 onboarding | Flag `v31.onboarding_checklist` |
| 7.2 | Role-adapted; guests never told to administer | Locally verified | VG, E31 "role-adapted next step" | |
| 7.3 | Connection readiness as five separate checks | Locally verified | E31 "…readiness"; `components/onboarding/checklist.tsx` | |

## §8 Global search and command menu

| ID | Requirement | Status | Evidence | Notes |
|---|---|---|---|---|
| 8.1 | Cmd/Ctrl+K: posts, campaigns, assets, brands, authorized settings, quick actions, recent items, keyboard | Locally verified | `components/shell/command-menu.tsx`; E31 "Cmd/Ctrl+K…"; VD search tests | |
| 8.2 | Help articles in search | Incomplete | — | No help content yet (Docs/Help stream) |
| 8.3 | Snippets never leak; server authorization per result | Locally verified | VD "authorized results only, safe snippets…"; VDM | |
| 8.4 | Debounce, cancellation, bounded results | Locally verified | VD "cancellation: an aborted request cancels the running SQL statement…"; 150 ms debounce | |
| 8.5 | Cached results vanish on revocation and workspace switch | Locally verified | VD "revocation: results and recent items vanish…"; client cache keyed by workspace + policy version | Client cache behaviour untested in a browser |

## §9 Draft resilience

| ID | Requirement | Status | Evidence | Notes |
|---|---|---|---|---|
| 9.1 | Debounced server autosave; Saving / Saved / Offline / Save failed | Locally verified | VD "autosave…"; E31 "Saved only after the server ack…" | |
| 9.2 | Optimistic concurrency, conflicts, multiple tabs | Locally verified | VD "concurrency: two tabs…"; E31 conflict | |
| 9.3 | Local recovery: namespaced, minimal, retention, cleared on logout; workspace can disable it | Locally verified | `lib/client/draft-recovery.ts`; VD "workspace policy disables persistent local recovery…"; E31 recovery | |
| 9.4 | Re-check permission and revision; never auto-publish or overwrite newer | Locally verified | VD "recover re-checks permission…", "recover: applied… never schedules" | |
| 9.5 | Offline = drafting only | Implemented | Offline blocks Schedule/Publish (`composer.tsx`) | No browser offline test |

## §10 Undo, trash, recoverability

| ID | Requirement | Status | Evidence | Notes |
|---|---|---|---|---|
| 10.1 | Trash for drafts/assets; consequences before deleting; soft delete with retention | Locally verified | `services/data/trash.ts`; VD "trash hides a post everywhere…"; E31 trash | 30 days |
| 10.2 | Asset references checked before physical deletion | Locally verified | VD "asset with a scheduled reference: trash refused; purge defers…" | Storage delete failure leaves an orphan (gap G4) |
| 10.3 | Restore never republishes; local delete never deletes external posts | Locally verified | VD "…never republishes", "refuses live schedules and published history…" | |
| 10.4 | Undo through a server operation with concurrency checks; audit | Locally verified | VD "restore with undo token", bulk "undo reverses succeeded items with a concurrency check" | |

## §11 Bulk workflows

| ID | Requirement | Status | Evidence | Notes |
|---|---|---|---|---|
| 11.1 | Assign, tags, campaign, duplicate, archive/restore, reschedule | Locally verified | `services/data/bulk.ts`; VD | |
| 11.2 | Preview with permission/policy consequences | Locally verified | VD "a stale preview is rejected…"; specific skip reasons (89286a7) | |
| 11.3 | Durable jobs, per-item results, idempotent retries | Locally verified | VD "partial failure, then idempotent retry…", "a crash between the change and the status update never repeats work"; E31 bulk | |
| 11.4 | No access broadening; reschedule keeps approval rules | Locally verified | VD "no access broadening…", "reschedule keeps approval rules…"; VBH "reschedule re-checks mandatory brand rules…" | |

## §12 Brand safeguards and asset governance

| ID | Requirement | Status | Evidence | Notes |
|---|---|---|---|---|
| 12.1 | Brand profile: logos, colours, tone, terms, phrases, footers, links/CTA, licence notes | Locally verified | `services/gov/brand-rules.ts`; VG "profile: approved logos…" | Flag `v31.brand_rules` (editor UI) |
| 12.2 | Asset expiry and superseded assets; advisory vs mandatory | Locally verified | VG "asset governance…"; UG | |
| 12.3 | Rule changes never rewrite scheduled content; explicit review | Locally verified | VG "rule changes never rewrite content…"; engine hold `brand_rule_review` (VBH) | |
| 12.4 | TipSignal facts preserved; no invented stats or promises | Locally verified | VG "…altered probability / invented stats / promise language are refused"; UG | |

## §13 Content reuse and queues

| ID | Requirement | Status | Evidence | Notes |
|---|---|---|---|---|
| 13.1 | Duplicate as new draft with provenance; similar-post warnings | Locally verified | VG "reuses a published post as a new draft with provenance…" | |
| 13.2 | Queue: explicit evergreen, pause, consumed once, never recurring | Locally verified | VG "queue: explicit evergreen only…" | Flag `v31.content_queue` |
| 13.3 | Never recycle picks, expired promotions or results | Locally verified | VG "picks are never recycled…"; UG | |

## §14 Campaign links and measurement

| ID | Requirement | Status | Evidence | Notes |
|---|---|---|---|---|
| 14.1 | UTM defaults per brand/campaign; preview/override; keep params; no duplicate keys | Locally verified | VG "layers brand → campaign defaults…"; UG | Flag `v31.tracked_links` |
| 14.2 | Validate destinations; no open redirect | Locally verified | VG "short links redirect only to the stored destination…" | Public `/api/l/:code` needs the production domain |
| 14.3 | Four measurement kinds kept apart; no revenue/ROI from clicks | Locally verified | `services/gov/links.ts` (website events `not_configured`, conversions `unavailable`) | |

## §15 Integration diagnostics

| ID | Requirement | Status | Evidence | Notes |
|---|---|---|---|---|
| 15.1 | Test centre: auth, account, capabilities, expiry, publishing, analytics, budget, affected work | Locally verified | VG "reports every check without publishing, calling providers or exposing secrets" | Flag `v31.integration_diagnostics` |
| 15.2 | Read-only; never posts on "Check connection"; no tokens | Locally verified | same test | No test-publication action exists |

## §16 Release engineering and support

| ID | Requirement | Status | Evidence | Notes |
|---|---|---|---|---|
| 16.1 | Feature flags: safe defaults, workspace-scoped rollout, kill switch | Locally verified | `services/gov/release.ts`; VG "flags are workspace-scoped…"; UG rollout buckets | Gate UI only (G6); rollout % set by SQL |
| 16.2 | DB compatibility during rollout; rehearse migrations and app rollback | Incomplete | Migrations apply on every integration run (fresh DB) | V1-backup rehearsal not re-run with 020–025; no app-rollback rehearsal |
| 16.3 | Never two scheduler versions dispatching | Locally verified | `engine/claim.ts` `dispatchEnabled`; VG "dispatch version guard…" | Operator procedure in the rollback doc |
| 16.4 | Error boundaries, recoverable screens | Implemented | `app/(app)/error.tsx`, `global-error.tsx` | |
| 16.5 | Structured error reporting, performance monitoring, provider/worker health | Awaiting external activation | Structured logs; `/api/ops/workload`; health centre | No external error/APM sink |
| 16.6 | Report-a-problem with explicit attachments and redaction | Locally verified | VG "support reports are redacted…"; UG redaction | The UI preview copies the server patterns (G3) |
| 16.7 | Changelog / release notes | Locally verified | VG "release notes track per-user seen version" | Flag `v31.release_notes` |

## §17 MCP

| ID | Requirement | Status | Evidence | Notes |
|---|---|---|---|---|
| 17.1 | Search, draft recovery status, bulk status, brand rules, diagnostics through shared services | Locally verified | `mcp/tools-data.ts`, `mcp/tools-gov.ts` (33 tools in total); VDM; VG "same services and permissions as the app…" | |
| 17.2 | No bulk start, destructive action or confirmation flag | Locally verified | VDM "catalogue: … no bulk start/undo or confirmation inputs" | |
| 17.3 | Tool latency measured separately | Locally verified | PERFORMANCE_RESULTS (`search_content` 63/79 → 7/11 ms) | |
| 17.4 | Scope, audience, revocation, stale intents, duplicates | Locally verified | V3 `mcp.test.ts`; VDM "revocation ends access" | Real clients: V3 activation |

## §18 Required tests

| ID | Requirement | Status | Evidence | Notes |
|---|---|---|---|---|
| 18.1 | Cold/warm route performance | Locally verified (lab) | browser harness, n = 10 | No throttled series |
| 18.2 | Composer typing + autosave during slow requests | Incomplete | E31 autosave; typing INP proxy | No slow-network case |
| 18.3 | Recovery after disconnect/restart; multi-tab conflicts | Locally verified | VD; E31 recovery | |
| 18.4 | Revocation with cached data; workspace switch without leakage | Locally verified | VP; VD search revocation | |
| 18.5 | Search cancellation and isolation | Locally verified | VD | |
| 18.6 | Undo/trash with scheduled asset references | Locally verified | VD | |
| 18.7 | Partial bulk failure + idempotent retry | Locally verified | VD; E31 | |
| 18.8 | Brand-rule / asset-expiry enforcement | Locally verified | VG; VBH; E31 | |
| 18.9 | Queue fairness during backfill/video/export | Locally verified | `pnpm load:isolation` (3 runs); UP | |
| 18.10 | Publishing during provider throttling + DB contention | Locally verified | VP provider cap; isolation test (simulated 150 ms provider latency) | Contention is synthetic |
| 18.11 | Tracking-link correctness + redirect restrictions | Locally verified | VG; UG | |
| 18.12 | Diagnostics never publish | Locally verified | VG | |
| 18.13 | Feature-flag rollback + migration compatibility | Incomplete | Flag kill switch (VG/UG) | Mixed-version run not rehearsed |
| 18.14 | Existing V3 integrations, analytics, sources, MCP | Locally verified | V3 suites in the same run | |
| 18.15 | Repeated perf runs with sample counts and variability | Locally verified | n = 30 server, 10 browser, 3 isolation; cv reported | |

## §20 Deliverables

| ID | Requirement | Status | Evidence | Notes |
|---|---|---|---|---|
| 20.1 | Source, migrations, tests, deployment changes | Locally verified | `mig/020`, `021`, `022`, `025`; tests above | |
| 20.2 | PERFORMANCE_BASELINE / BUDGETS / RESULTS | Locally verified | stream docs | |
| 20.3 | Requirements matrix, architecture changes, test report, migration and rollback, gaps, activation checklist | Implemented | this set | |
| 20.4 | Updated user/help docs | Incomplete | — | Queued as the last task (Docs + Help Centre) |
| 20.5 | Before/after under comparable conditions, incl. regressions | Locally verified | PERFORMANCE_RESULTS "What got worse" | |

## Totals

| Status | Rows |
|---|---|
| Locally verified | 83 (7 of them lab or server-side only, marked in the row) |
| Implemented | 7 |
| Incomplete | 10 |
| Awaiting external activation | 3 |
| Live verified | 0 |
| **Total** | **103** |

"Locally verified" means real PostgreSQL, simulated providers, and a production build on localhost for browser numbers. It does not mean verified live.
