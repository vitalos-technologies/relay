# V3.1 test report

**Run 2026-11-07 16:50 UTC** on `main` @ 89286a7 (the following docs commit b7bf474 changes no code).

Environment:
- Linux container (shared 4-vCPU host), Node 22, Vitest 3.2.7;
- PostgreSQL 16, SeaweedFS (S3), Keycloak 26.4, Mailpit;
- Playwright Chromium for E2E.

All social, Google and Notion traffic goes to labelled simulators. Nothing was verified live.

## 1. Results

| Suite | Command | Files | Tests | Result |
|---|---|---|---|---|
| Unit | `pnpm -s test` (project `unit`) | 15 | 138 | **138 passed** |
| Provider contracts | `pnpm -s test` (project `contracts`) | 16 | 352 | **352 passed** |
| Integration (real Postgres + S3 + Keycloak; disposable DB migrated 001–025 per run) | `set -a; . ./.env; set +a; npx vitest run --project integration` | 49 | 375 | **375 passed** (116 s) |
| Full E2E on a **production build** (`next build --webpack` + `next start`) | `pnpm test:e2e` | 4 specs | 45 | **45 passed** (20.8 min). UI stream run, log `.data/e2e-full.log` / `.data/e2e-final.log` (`45 passed (20.8m)`, `exit=0`) |
| Typecheck | `tsc` root + web | – | – | Clean (UI stream, final build); not re-run here |
| Lint | `pnpm lint` | – | – | Not in the gate; react-hooks rule errors remain (V2 gap G18) |

Verbatim summaries from this run:

```
unit + contracts:  Test Files  31 passed (31)
                        Tests  490 passed (490)
                     Duration  8.29s
integration:       Test Files  49 passed (49)
                        Tests  375 passed (375)
                     Duration  116.40s
```

Failures: **none.** The flaky V3 `engine-handoff` case was fixed in b97a9d2 (the test now claims and reconciles only its own delivery) and passed here.

E2E timing caveat: the 45/45 log was written at 16:46. The lead commit 89286a7 (16:49) came after it: reschedule now enforces brand rules, bulk skip reasons are more specific, onboarding links changed. That commit is covered by unit + integration (`v31-brand-rule-hold` "reschedule re-checks mandatory brand rules…") but not by an E2E re-run.

## 2. V3.1 suites

| File | Tests | Proves |
|---|---|---|
| `integration/v31-data.test.ts` | 20 | Autosave revisions, lost-response retry, out-of-order and no-op saves; two-tab conflict keeps a copy; recover never overwrites or schedules and re-checks permission; workspace policy disables local recovery; trash hides everywhere; restore with undo; never republishes; live/published refused; asset references defer purge; permission + isolation; purge after retention; bulk partial failure + idempotent retry, stale preview, revocation before run, no access broadening, crash-safe duplicate, reschedule keeps approval rules, undo with concurrency check; search authorization, safe snippets, trash excluded, revocation, SQL cancellation |
| `integration/v31-data-mcp.test.ts` | 4 | MCP data tools read-only, no bulk start/undo or confirmation inputs; consented brands only; revocation |
| `integration/v31-gov.test.ts` | 19 | Mandatory vs advisory rules; rule changes → review, never rewrite; asset governance; profile; TipSignal facts and promise language; picks never recycled; reuse with provenance; queue semantics; UTM layering; no open redirect; diagnostics never publish or leak; workspace flags + kill switch; support redaction; release notes; **dispatch version guard**; onboarding; cross-workspace 404; MCP gov tools |
| `integration/v31-perf.test.ts` | 4 | Per-provider cap exact with concurrent claimers, no duplicates; revoked approver loses `can_decide` at once; planner/dashboard truncation flags; workload samples per workspace |
| `integration/v31-analytics-summary.test.ts` | 3 | Per-day summary equals rollups in six zones incl. DST and :30/:45 offsets; incremental via the real ingest path; dataset isolation; rebuild keeps equality |
| `integration/v31-brand-rule-hold.test.ts` | 2 | Held delivery while a mandatory review is open; reschedule re-checks mandatory rules |
| `integration/api-fixes-v3.test.ts` | 2 | Provider setting keys; `status=draft` filter |
| `unit/v31-{perf,gov,data}.test.ts` | 11 / 19 / 4 | Workload gate (caps, no head-of-line blocking, bounded deferral, pools, provider caps); rules engine, TipSignal, UTM, flags, rollout buckets, redaction; search tokens, snippets, bulk permissions/validation |
| `e2e/v31-ui.spec.ts` | 6 | Autosave + conflict + recovery; trash consequences + restore; bulk partial failure + retry of the failed item; Cmd/Ctrl+K + recent; mandatory brand rule blocks Schedule (server 422 too); onboarding in a new workspace |

V1, V2 and V3 suites all passed in the same runs (regression).

## 3. Performance (from the stream docs; not re-run here)

| Area | Result | Source |
|---|---|---|
| Server, Large (250k posts), before → after p95 | Dashboard 1,342 → 33 ms; history 639 → 11 ms; approval inbox 1,094 → 64 ms; posts list 180 → 7.4 ms; analytics overview 365 d 5,476 → 1,538 ms (budget 1,600) | [PERFORMANCE_RESULTS.md](PERFORMANCE_RESULTS.md), n = 30 |
| Worker isolation under a bulk burst | Dispatch delay p95 3.37 → 1.14 s; queue age p95 3.72 → 1.08 s; 0 duplicates over 1,080 deliveries | `evidence/perf/isolation.json`, 3 runs each |
| Search (server) | FTS p95 15.1 ms at 50k posts | `scripts/v31-search-bench.ts` |
| Still over budget | Planner payload ~700–800 KB (all brands, Medium/Large) vs 300 KB; Medium planner-week p95 | PERFORMANCE_RESULTS "Open items" |

**Browser (lab).** Production build on localhost, no network or CPU throttling, headless Chromium 1440×900, Demo Workspace (907 posts), n = 10 cold loads per route + 10 warm laps. Evidence: `evidence/v3-1/perf/browser-{initial,after,budget-check}.json`.

| Measure | Result (worst route) | Target |
|---|---|---|
| LCP p75 | ≤ 556 ms (Analytics) | ≤ 2 s |
| CLS p75 | ≤ 0.032 (Overview); Connections 0.222 → 0 | ≤ 0.1 |
| INP proxy p75 (one scripted interaction) | ≤ 64 ms; Cmd+K keystrokes 100–140 → 16–24 ms after removing `backdrop-filter` | ≤ 200 ms |
| Warm navigation p95 | ≤ 202 ms (Overview) | ≤ 300 ms |
| Route JS (compressed) | 286–352 KB, all within budgets (`--check`) | per route |

**Limits:**
- p95 of 10 runs is the slowest run.
- INP is a lab proxy.
- There is no throttled series.
- There is no real-user data.
- Autosave ack, search, analytics filter and bulk ack are not timed end to end in the browser.

## 4. Not run / limits

- No live provider, Google, Notion or real MCP client.
- Migration rehearsal (`scripts/migration-rehearsal.sh`, V1.1 data → all migrations incl. 020–025): **PASS** 2026-11-07 ~16:55 UTC (lead re-run; 10/10 checks).
- No mixed-version (rolling deploy) rehearsal of the dispatch-version guard beyond `v31-gov`.
- Not a penetration test or security certification.
