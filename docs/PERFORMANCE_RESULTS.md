# Relay V3.1 — performance results (server side)

Stream: PERF. Same harness, same generator, same host for before and after; numbers are not cherry-picked: every
scenario of the run is listed, including the ones that got worse. Before = `evidence/perf/baseline-*.json` (V3 code,
migrations without 020). After = `evidence/perf/after-*.json` (V3.1 PERF code + migration 020). An earlier after-run
with an intermediate claim implementation is kept in `evidence/perf/superseded/` (see "What got worse").
Reproduce: `pnpm bench --profile all --label after && pnpm bench:compare baseline after --check`.
Conditions (hardware, PostgreSQL settings, cache state, dataset sizes, host load): `docs/PERFORMANCE_BASELINE.md`.
Budgets: `docs/PERFORMANCE_BUDGETS.md`.

## Headline (Large profile: 100 brands, 500 connections, 250k posts in the measured workspace; 1.9–2.0 GB DB; n = 30 per page scenario, 500 deliveries for the worker)

| | Before p50 / p95 (ms) | After p50 / p95 (ms) | Cause |
|---|---|---|---|
| Dashboard | 828 / 1,342 (775 KB, 15 statements) | 25 / 33 (203 KB, 11 statements) | single attention query on a partial index; `today` bounded to 200 items |
| History, first page | 528 / 639 | 8.5 / 11 | `deliveries (workspace_id, due_at DESC, id DESC)` — no more on-disk sort |
| History, page 21 (cursor) | 656 / 880 | 8.3 / 13 | same index; keyset cursor now index-ordered |
| Approval inbox (pending) | 683 / 1,094 (1,276 statements) | 48 / 75 (11 statements) | N+1 removed: batched decisions, reviewer authority, teams, shares, policies |
| Posts list (first page) | 115 / 180 | 3.6 / 7.4 | summaries query gets the tenant predicate → `(workspace_id, post_id)` index |
| Post detail | 41 / 84 | 5.5 / 6.8 | same + `approvals (schedule_id, requested_at)` |
| Planner week, all brands | 161 / 270 | 65 / 83 | `schedules (workspace_id, due_at)`; Map grouping instead of nested filters |
| Analytics overview, 365 days | 3,999 / 5,476 | 1,695 / 2,052 | registry memo + per-connection grouping (still over budget — see open items) |
| Worker: processing (app time) | 97 / 156 | 23 / 34 | approval gate's `approvals by schedule` was a seq scan |
| MCP `search_content` (server) | 63 / 79 | 7 / 11 | posts summaries fix (shared service) |
| MCP `list_calendar` (server) | 80 / 96 | 36 / 52 | planner fixes (shared service) |

## Workload isolation (brief §6) — `pnpm load:isolation` → `evidence/perf/isolation.json`

Setup: disposable DB per phase run; 180 publishing deliveries in 3 workspaces on 30 simulated destinations (150 ms
simulated provider latency per request) released in 15 waves 2 s apart; at t=0 a bulk burst of 24 jobs in another
workspace through real code — analytics backfill (`rebuildAggregates` over 365 days of synthetic history), analytics
refresh (`bulkLoadSynthetic` ingest + rebuild), report export query phase (overview 365 d + content table), video
transcode (sharp, 3000×2000 → three renditions). 4 publishing slots running the real `claimDelivery` + `processDelivery`.
"Shared" = V3 topology (one pool of 10, V3 per-queue bulk concurrency, no backpressure, no provider cap); "isolated" =
V3.1 (`WorkloadRunner` with the **same** per-class concurrency, bulk on its own pool, deferral under publishing
pressure, per-provider cap). Three alternating runs of each:

| Publishing (seconds) | Shared runs | Isolated runs | Median shared → isolated |
|---|---|---|---|
| Dispatch delay (due → claimed) p50 | 0.35 / 0.39 / 0.47 | 0.33 / 0.30 / 0.35 | 0.39 → 0.33 |
| Dispatch delay p95 | 2.73 / 3.37 / 3.61 | 1.14 / 1.14 / 1.13 | **3.37 → 1.14** |
| Dispatch delay max | 3.99 / 5.17 / 6.15 | 1.56 / 1.75 / 1.64 | **5.17 → 1.64** |
| Queue age (oldest claimable due item, sampled every 250 ms) p95 | 2.46 / 3.72 / 5.20 | 0.92 / 1.17 / 1.08 | **3.72 → 1.08** |
| Processing, app time p95 | 0.30 / 0.50 / 0.63 | 0.24 / 0.18 / 0.44 | 0.50 → 0.24 |
| Processing, provider time p95 (simulated) | 0.39 / 0.38 / 0.32 | 0.33 / 0.34 / 0.29 | 0.38 → 0.33 |
| Bulk burst fully done after | 23.3 / 22.9 / 29.2 | 23.1 / 20.8 / 28.4 | 23.3 → 23.1 (bulk not starved) |

All 1,080 deliveries published in every run, all 144 bulk jobs completed, **0 duplicate sends**. Queue age, dispatch
delay and processing time are reported separately; provider time is measured inside the adapters and never counted as
app time. The production worker records the same three numbers per item in `workload_samples` and serves them at
`GET /api/ops/workload` (contract `packages/core/src/contracts/v31-perf.ts`).

What made the difference (no new infrastructure; Postgres + pg-boss only):
- **Reserved publishing capacity**: bulk classes run inside `runWithPool(bulkPool)` — every `getPool()` they make uses a
  separate pool (`WORKER_BULK_POOL_MAX`, default 6), so they can never take the main pool's connections that the claim
  loops use. Light essential work (notifications, connection health) stays on the main pool and is never deferred.
- **Backpressure**: analytics refresh/backfill, video and report exports wait (≤ 60 s, then run anyway) while all
  publishing slots are busy or claimable due work is older than `PUBLISHING_PRESSURE_DUE_AGE_SECONDS` (10 s; 2 s in the
  test). Interactive imports are not deferred (a person is waiting) but are capped.
- **Per-class and per-workspace caps** (in-process gate, FIFO without head-of-line blocking across workspaces; slot waits
  bounded below pg-boss expiry so a job is never re-delivered while it waits) on top of the existing pg-boss group
  concurrency and Content Hub per-workspace advisory slots.
- **Per-provider dispatch cap** across all workers (`DISPATCH_PROVIDER_CONCURRENCY`, default 8, per provider override),
  exact under concurrency (provider advisory lock + re-count), checked by `tests/integration/v31-perf.test.ts`.
- **Video on its own queue** (`media-transcode`) instead of sharing the `events` queue with notifications.
- Bounded retries are unchanged (pg-boss `retryLimit` 3–5 with backoff; Unknown is never auto-retried).

## Full before/after tables (every scenario; generated by `pnpm bench:compare baseline after`)

### Small (68 MB → 69 MB; load avg at end 2.76 → 6.12)

| Scenario | p50 before → after (ms) | p95 before → after (ms) | n | Δ p95 | queries | payload | budget (after) |
|---|---|---|---|---|---|---|---|
| request.context (loadAccess) | 2.51 → 2.73 | 3.3 → 5.36 | 30/30 | +62% | 5 → 5 | 664 B → 664 B | ok (≤ 10 ms) |
| planner.week (all brands) | 6.01 → 6.21 | 8.38 → 7.35 | 30/30 | −12% | 5 → 5 | 22 KB → 22 KB | ok (≤ 50 ms) |
| planner.month (all brands) | 9.54 → 9.15 | 13.16 → 12.69 | 30/30 | −4% | 5 → 5 | 82 KB → 80 KB | ok (≤ 50 ms) |
| planner.month (one brand) | 6.37 → 6.11 | 7.97 → 8.31 | 30/30 | +4% | 5 → 5 | 31 KB → 31 KB | ok (≤ 50 ms) |
| planner.month (brand-restricted editor) | 6.17 → 6.6 | 8.75 → 11.22 | 30/30 | +28% | 5 → 5 | 31 KB → 31 KB | ok (≤ 50 ms) |
| posts.list (first page) | 3.74 → 3.69 | 6.37 → 7.93 | 30/30 | +24% | 4 → 4 | 18 KB → 18 KB | ok (≤ 30 ms) |
| posts.list (page 5, cursor) | 3.78 → 4.35 | 5.88 → 16.47 | 30/30 | +180% | 4 → 4 | 18 KB → 18 KB | ok (≤ 30 ms) |
| posts.search (q=launch) | 4.68 → 4.4 | 5.34 → 5.32 | 30/30 | −0% | 4 → 4 | 18 KB → 18 KB | ok (≤ 50 ms) |
| post.detail | 6.04 → 5.46 | 11.39 → 9.12 | 30/30 | −20% | 10 → 10 | 7 KB → 5 KB | ok (≤ 30 ms) |
| dashboard | 25.73 → 12.32 | 39.85 → 16.79 | 30/30 | −58% | 15 → 11 | 35 KB → 35 KB | ok (≤ 50 ms) |
| history (first page) | 9.51 → 5.83 | 13.52 → 14.2 | 30/30 | +5% | 1 → 1 | 48 KB → 48 KB | ok (≤ 30 ms) |
| history (failed, one brand) | 3.1 → 4.05 | 6.57 → 7.47 | 30/30 | +14% | 1 → 1 | 35 KB → 35 KB | ok (≤ 30 ms) |
| history (page 21, cursor) | 9.19 → 5.88 | 11.9 → 12.16 | 30/30 | +2% | 1 → 1 | 52 KB → 52 KB | ok (≤ 30 ms) |
| history (brand-restricted editor) | 7.91 → 5.69 | 15.1 → 10.52 | 30/30 | −30% | 1 → 1 | 48 KB → 48 KB | ok (≤ 30 ms) |
| approvals (pending) | 67.13 → 16.12 | 94.1 → 21.78 | 30/30 | −77% | 148 → 11 | 15 KB → 15 KB | ok (≤ 50 ms) |
| approvals (decided) | 19.19 → 23.83 | 37.19 → 28.45 | 30/30 | −24% | 4 → 1 | 132 KB → 132 KB | ok (≤ 50 ms) |
| ops (operations) | 5.32 → 5.22 | 7.89 → 7.53 | 30/30 | −5% | 9 → 9 | 986 B → 986 B | ok (≤ 30 ms) |
| analytics.overview (28 d) | 114.88 → 130.42 | 142.9 → 180.14 | 30/30 | +26% | 15 → 15 | 118 KB → 119 KB | ok (≤ 400 ms) |
| analytics.overview (365 d) | 189.23 → 167.02 | 224.96 → 237.66 | 30/30 | +6% | 15 → 15 | 654 KB → 655 KB | ok (≤ 800 ms) |
| analytics.content (28 d, sort ER) | 49.93 → 40.31 | 64.73 → 55.27 | 30/30 | −15% | 11 → 11 | 84 KB → 85 KB | ok (≤ 200 ms) |
| worker: claim | 7.96 → 11.15 | 14.09 → 18.04 | 100/100 | +28% | | | ok (≤ 25 ms) |
| worker: idle_claim | 3.73 → 4.82 | 8.21 → 8.23 | 30/30 | +0% | | | ok (≤ 15 ms) |
| worker: process_app | 21.92 → 24.91 | 36.15 → 45.23 | 100/100 | +25% | | | ok (≤ 60 ms) |
| worker: process_provider | 1.23 → 1.68 | 6.29 → 4.87 | 100/100 | −23% | | |  |
| worker: outbox_batch50 | 11.03 → 20.65 | 14.85 → 26.94 | 2/2 | +81% | | |  |
| MCP list_workspaces (client / server) | 9.78 / 2 → 5.91 / 1 | 22.35 / 5 → 16.28 / 2 | 30/30 | −27% | | | ok (server ≤ 100 ms) |
| MCP list_brands (client / server) | 8.05 / 3 → 8.58 / 3 | 18.28 / 7 → 15.07 / 7 | 30/30 | −18% | | | ok (server ≤ 100 ms) |
| MCP search_content (client / server) | 18.22 / 9 → 13.69 / 7 | 33.64 / 17 → 22.87 / 13 | 30/30 | −32% | | | ok (server ≤ 100 ms) |
| MCP get_post (client / server) | 15.98 / 8 → 19.96 / 11 | 33.45 / 15 → 35.58 / 17 | 30/30 | +6% | | | ok (server ≤ 100 ms) |
| MCP get_delivery_status (client / server) | 16.4 / 6 → 15.9 / 5 | 59.37 / 36 → 30.26 / 17 | 30/30 | −49% | | | ok (server ≤ 100 ms) |
| MCP list_calendar (client / server) | 18.3 / 10 → 18.85 / 10 | 31.83 / 21 → 28.44 / 15 | 30/30 | −11% | | | ok (server ≤ 100 ms) |
| MCP analytics_overview (client / server) | 14.72 / 5 → 14.61 / 5 | 20.92 / 9 → 29.08 / 16 | 30/30 | +39% | | | ok (server ≤ 100 ms) |

### Medium (462 MB → 478 MB; load avg at end 6.63 → 6.58)

| Scenario | p50 before → after (ms) | p95 before → after (ms) | n | Δ p95 | queries | payload | budget (after) |
|---|---|---|---|---|---|---|---|
| request.context (loadAccess) | 2.74 → 2.6 | 3.29 → 6.39 | 30/30 | +94% | 5 → 5 | 664 B → 664 B | ok (≤ 10 ms) |
| planner.week (all brands) | 80.87 → 72.53 | 103.39 → 107.26 | 30/30 | +4% | 5 → 5 | 681 KB → 680 KB | **over**: p95 107.26 ms > 100 ms; payload 695920 B > 300000 B |
| planner.month (all brands) | 81.2 → 60.08 | 101.9 → 83.39 | 30/30 | −18% | 5 → 5 | 762 KB → 763 KB | ok (≤ 150 ms) |
| planner.month (one brand) | 12.71 → 13.77 | 17.95 → 22.49 | 30/30 | +25% | 5 → 5 | 130 KB → 130 KB | ok (≤ 100 ms) |
| planner.month (brand-restricted editor) | 81.52 → 84.74 | 115.39 → 129.42 | 30/30 | +12% | 5 → 5 | 769 KB → 769 KB | ok (≤ 150 ms) |
| posts.list (first page) | 17.2 → 3.88 | 20.17 → 6.41 | 30/30 | −68% | 4 → 4 | 17 KB → 19 KB | ok (≤ 50 ms) |
| posts.list (page 5, cursor) | 13.42 → 3.91 | 21.12 → 10 | 30/30 | −53% | 4 → 4 | 18 KB → 18 KB | ok (≤ 50 ms) |
| posts.search (q=launch) | 20.34 → 8.92 | 35.98 → 14.28 | 30/30 | −60% | 4 → 4 | 19 KB → 19 KB | ok (≤ 100 ms) |
| post.detail | 6.65 → 6.24 | 10.2 → 12.1 | 30/30 | +19% | 10 → 10 | 6 KB → 7 KB | ok (≤ 50 ms) |
| dashboard | 131.75 → 27.28 | 197.51 → 34.36 | 30/30 | −83% | 15 → 11 | 237 KB → 198 KB | ok (≤ 100 ms) |
| history (first page) | 75.19 → 8.53 | 128.68 → 11.18 | 30/30 | −91% | 1 → 1 | 48 KB → 48 KB | ok (≤ 50 ms) |
| history (failed, one brand) | 5.99 → 5.55 | 12.77 → 7.23 | 30/30 | −43% | 1 → 1 | 49 KB → 49 KB | ok (≤ 50 ms) |
| history (page 21, cursor) | 77.48 → 8.43 | 111.98 → 17.57 | 30/30 | −84% | 1 → 1 | 48 KB → 48 KB | ok (≤ 50 ms) |
| history (brand-restricted editor) | 51.14 → 7.65 | 101.23 → 15.21 | 30/30 | −85% | 1 → 1 | 48 KB → 48 KB | ok (≤ 50 ms) |
| approvals (pending) | 564.94 → 47.13 | 744.65 → 110.76 | 30/30 | −85% | 1216 → 11 | 129 KB → 129 KB | **over**: p95 110.76 ms > 100 ms |
| approvals (decided) | 42.41 → 25.15 | 61.89 → 39 | 30/30 | −37% | 16 → 1 | 133 KB → 133 KB | ok (≤ 100 ms) |
| ops (operations) | 37.03 → 21.47 | 51.28 → 34.76 | 30/30 | −32% | 9 → 9 | 1013 B → 1013 B | ok (≤ 100 ms) |
| analytics.overview (28 d) | 196.62 → 181.5 | 287.27 → 231.27 | 30/30 | −19% | 15 → 15 | 120 KB → 120 KB | ok (≤ 400 ms) |
| analytics.overview (365 d) | 803.32 → 727.22 | 1287.88 → 839.42 | 30/30 | −35% | 15 → 15 | 638 KB → 637 KB | **over**: p95 839.42 ms > 800 ms |
| analytics.content (28 d, sort ER) | 49.6 → 55.39 | 88.43 → 96.89 | 30/30 | +10% | 11 → 11 | 85 KB → 86 KB | ok (≤ 200 ms) |
| worker: claim | 8.1 → 11.34 | 16.01 → 21.87 | 300/300 | +37% | | | ok (≤ 25 ms) |
| worker: idle_claim | 4.76 → 5 | 8.94 → 7.31 | 30/30 | −18% | | | ok (≤ 15 ms) |
| worker: process_app | 35.74 → 25.96 | 59.08 → 46.08 | 300/300 | −22% | | | ok (≤ 100 ms) |
| worker: process_provider | 1.49 → 1.61 | 6.03 → 6.55 | 300/300 | +9% | | |  |
| worker: outbox_batch50 | 18.3 → 22.77 | 27.9 → 32.7 | 6/6 | +17% | | |  |
| MCP list_workspaces (client / server) | 13.39 / 2 → 7.08 / 2 | 33.45 / 8 → 12.51 / 4 | 30/30 | −63% | | | ok (server ≤ 150 ms) |
| MCP list_brands (client / server) | 8.19 / 3 → 12.91 / 5 | 18.9 / 7 → 21.81 / 8 | 30/30 | +15% | | | ok (server ≤ 150 ms) |
| MCP search_content (client / server) | 38.68 / 29 → 22.47 / 13 | 82.13 / 61 → 32.19 / 22 | 30/30 | −61% | | | ok (server ≤ 150 ms) |
| MCP get_post (client / server) | 14.86 / 10 → 18.93 / 12 | 25.35 / 13 → 24.09 / 16 | 30/30 | −5% | | | ok (server ≤ 150 ms) |
| MCP get_delivery_status (client / server) | 10.3 / 5 → 14.25 / 6 | 20.26 / 10 → 20.42 / 12 | 30/30 | +1% | | | ok (server ≤ 150 ms) |
| MCP list_calendar (client / server) | 99.47 / 84 → 76.95 / 63 | 166.28 / 139 → 133.85 / 121 | 30/30 | −20% | | | ok (server ≤ 150 ms) |
| MCP analytics_overview (client / server) | 9.46 / 5 → 13.91 / 7 | 15.93 / 9 → 32.13 / 14 | 30/30 | +102% | | | ok (server ≤ 150 ms) |

### Large (1925 MB → 1997 MB; load avg at end 5.29 → 5.61)

| Scenario | p50 before → after (ms) | p95 before → after (ms) | n | Δ p95 | queries | payload | budget (after) |
|---|---|---|---|---|---|---|---|
| request.context (loadAccess) | 3.8 → 2.56 | 7.99 → 6.69 | 30/30 | −16% | 5 → 5 | 664 B → 664 B | ok (≤ 15 ms) |
| planner.week (all brands) | 161.31 → 65.41 | 270.28 → 82.85 | 30/30 | −69% | 5 → 5 | 775 KB → 775 KB | **over**: payload 793474 B > 300000 B |
| planner.month (all brands) | 171.33 → 93 | 281.78 → 139.16 | 30/30 | −51% | 5 → 5 | 776 KB → 776 KB | ok (≤ 300 ms) |
| planner.month (one brand) | 31.57 → 14.64 | 58.37 → 24.19 | 30/30 | −59% | 5 → 5 | 156 KB → 156 KB | ok (≤ 200 ms) |
| planner.month (brand-restricted editor) | 160.7 → 102.42 | 237.49 → 161.49 | 30/30 | −32% | 5 → 5 | 777 KB → 777 KB | ok (≤ 300 ms) |
| posts.list (first page) | 115.03 → 3.62 | 180.15 → 7.42 | 30/30 | −96% | 4 → 4 | 18 KB → 18 KB | ok (≤ 100 ms) |
| posts.list (page 5, cursor) | 102.55 → 3.31 | 180.1 → 5.97 | 30/30 | −97% | 4 → 4 | 18 KB → 18 KB | ok (≤ 100 ms) |
| posts.search (q=launch) | 136.84 → 4.1 | 359.12 → 7.65 | 30/30 | −98% | 4 → 4 | 18 KB → 18 KB | ok (≤ 150 ms) |
| post.detail | 41.43 → 5.48 | 83.8 → 6.81 | 30/30 | −92% | 10 → 10 | 6 KB → 6 KB | ok (≤ 100 ms) |
| dashboard | 827.87 → 25.14 | 1342.26 → 33 | 30/30 | −98% | 15 → 11 | 775 KB → 203 KB | ok (≤ 200 ms) |
| history (first page) | 527.82 → 8.52 | 638.52 → 11.09 | 30/30 | −98% | 1 → 1 | 48 KB → 48 KB | ok (≤ 100 ms) |
| history (failed, one brand) | 4.69 → 6.11 | 11.09 → 13.08 | 30/30 | +18% | 1 → 1 | 49 KB → 49 KB | ok (≤ 100 ms) |
| history (page 21, cursor) | 655.79 → 8.26 | 880.15 → 13.46 | 30/30 | −98% | 1 → 1 | 48 KB → 48 KB | ok (≤ 100 ms) |
| history (brand-restricted editor) | 593.97 → 8.14 | 1049.54 → 8.98 | 30/30 | −99% | 1 → 1 | 48 KB → 48 KB | ok (≤ 100 ms) |
| approvals (pending) | 683.23 → 48.24 | 1093.88 → 74.63 | 30/30 | −93% | 1276 → 11 | 130 KB → 130 KB | ok (≤ 200 ms) |
| approvals (decided) | 100.53 → 30.37 | 147.06 → 75.93 | 30/30 | −48% | 76 → 1 | 133 KB → 133 KB | ok (≤ 200 ms) |
| ops (operations) | 279.92 → 126.45 | 599.53 → 198.86 | 30/30 | −67% | 9 → 9 | 1019 B → 1019 B | ok (≤ 200 ms) |
| analytics.overview (28 d) | 555.26 → 370.64 | 784.66 → 449.75 | 30/30 | −43% | 15 → 15 | 137 KB → 137 KB | ok (≤ 800 ms) |
| analytics.overview (365 d) | 3998.97 → 1694.58 | 5475.5 → 2051.93 | 30/30 | −63% | 15 → 15 | 657 KB → 657 KB | **over**: p95 2051.93 ms > 1600 ms |
| analytics.content (28 d, sort ER) | 110.71 → 140.16 | 131.66 → 207.07 | 30/30 | +57% | 11 → 11 | 93 KB → 94 KB | ok (≤ 400 ms) |
| worker: claim | 9.72 → 9.98 | 18.28 → 17.08 | 500/500 | −7% | | | ok (≤ 40 ms) |
| worker: idle_claim | 4.97 → 4.89 | 9.25 → 12.25 | 30/30 | +32% | | | ok (≤ 20 ms) |
| worker: process_app | 96.89 → 23 | 155.51 → 34.13 | 500/500 | −78% | | | ok (≤ 200 ms) |
| worker: process_provider | 1.75 → 1.39 | 4.86 → 2.69 | 500/500 | −45% | | |  |
| worker: outbox_batch50 | 23.18 → 16.92 | 32.5 → 21.31 | 10/10 | −34% | | |  |
| MCP list_workspaces (client / server) | 8.14 / 2 → 6.12 / 1 | 11.61 / 3 → 12.03 / 4 | 30/30 | +4% | | | ok (server ≤ 250 ms) |
| MCP list_brands (client / server) | 10.81 / 5 → 11.93 / 5 | 13.13 / 7 → 14.96 / 8 | 30/30 | +14% | | | ok (server ≤ 250 ms) |
| MCP search_content (client / server) | 70.73 / 63 → 13.54 / 7 | 86.31 / 79 → 20.32 / 11 | 30/30 | −76% | | | ok (server ≤ 250 ms) |
| MCP get_post (client / server) | 29.66 / 23 → 14.1 / 9 | 36.39 / 29 → 19.68 / 13 | 30/30 | −46% | | | ok (server ≤ 250 ms) |
| MCP get_delivery_status (client / server) | 11.81 / 6 → 15.28 / 5 | 17.84 / 10 → 28.61 / 13 | 30/30 | +60% | | | ok (server ≤ 250 ms) |
| MCP list_calendar (client / server) | 93.93 / 80 → 50.97 / 36 | 112.26 / 96 → 68.68 / 52 | 30/30 | −39% | | | ok (server ≤ 250 ms) |
| MCP analytics_overview (client / server) | 12.67 / 7 → 11.84 / 6 | 20.83 / 8 → 22.39 / 15 | 30/30 | +7% | | | ok (server ≤ 250 ms) |

**Budget violations (after):**
- medium planner.week (all brands): p95 107.26 ms > 100 ms; payload 695920 B > 300000 B
- medium approvals (pending): p95 110.76 ms > 100 ms
- medium analytics.overview (365 d): p95 839.42 ms > 800 ms
- large planner.week (all brands): payload 793474 B > 300000 B
- large analytics.overview (365 d): p95 2051.93 ms > 1600 ms

## What got worse, or did not improve (honest list)

- **Claim latency, small datasets**: claim p50 +3 ms at Small/Medium (8 → 11 ms), within budget. Cause: the per-provider
  cap adds a savepoint, a provider advisory lock (merged into the workspace re-count) and one re-count statement per
  successful claim. An intermediate version that added a CTE to the candidate query cost 3–5 ms more (planning time) and
  was replaced (`evidence/perf/superseded/after1-*.json`: claim p50 13–15 ms, idle claim 7–8 ms). Idle polling is back to
  baseline (4.8–5.0 ms p50). At Large, claim p95 is unchanged (18 → 17 ms).
- **Small-profile noise**: several Small scenarios show higher p95 (e.g. posts list page 5: 5.9 → 16.5 ms; request
  context 3.3 → 5.4 ms) with unchanged code paths and statement counts; host load average at the end of the Small run was
  2.8 before vs 6.1 after (other agents running test suites). Treated as variance, not regressions; all within budget.
- **Analytics content table at Large**: 132 → 207 ms p95 (+57%) with no change to its SQL; registry memo only. Within
  budget (400 ms); re-measure before acting.
- **Analytics overview 28 d at Small** 143 → 180 ms p95 (load); Medium −19%, Large −43%.
- **Planner across all brands at Medium** did not improve (p95 103 → 107 ms): the seq-scan fix matters only at Large; the
  remaining cost is the 1,000-row join + decoration and the **~700–800 KB payload**, which violates the 300 KB budget.
- **Analytics overview 365 d** still violates its budget (Medium 839 ms p95 vs 800; Large 2.05 s vs 1.6 s).

## Open items (not hidden by loosening budgets)

1. **Planner payload** (all brands, Medium/Large): ~1 KB per item × up to 1,000 items. Options for the UI stream: default
   the calendar to one brand or a week at scale, or a compact field set (ids, time, status, provider list) with details
   fetched per visible item. The API now reports `truncated: true` instead of silently cutting at 1,000.
2. ~~Analytics overview over long ranges~~ — within budget after round 2 (Medium 415 ms, Large 1,538 ms p95). What is
   left on Large is the per-post state scan (≈ 400 ms for 14.5k posts) and per-day health in Node.
3. ~~Approval inbox p95 at Medium~~ — fixed in round 2 (57 ms p95).
4. **HTTP layer** (Next.js routing, session lookup, JSON over the network) and all browser metrics are not measured here
   (UI stream, on the redesigned screens).

## Round 2 (lead follow-up): analytics 365-day overview and approval inbox

Same harness, same generator, all three profiles, n = 30 per scenario. Before = `evidence/perf/after-*.json` (round 1),
after = `evidence/perf/after2-*.json` (adds migration `025_v31_perf_more.sql`). Full table: `pnpm bench:compare after after2`;
budget check: `pnpm bench:compare baseline after2 --check`. The only remaining budget violations are the planner payload and
Medium planner-week p95 (left alone: needs a UI decision).

| Scenario (p50 / p95 ms) | Medium round 1 → 2 | Large round 1 → 2 | Large V3 baseline |
|---|---|---|---|
| analytics overview, 365 days | 727 / 839 → **337 / 415** | 1,695 / 2,052 → **1,272 / 1,538** (budget 1,600) | 3,999 / 5,476 |
| analytics overview, 28 days | 182 / 231 → 141 / 191 | 371 / 450 → 290 / 435 | 555 / 785 |
| approval inbox, pending | 47 / 111 → **38 / 57** (budget 100) | 48 / 75 → 33 / 64 | 683 / 1,094 |
| approval inbox, decided | 25 / 39 → 21 / 37 | 30 / 76 → 12 / 14 | 101 / 147 |

What changed:
- **Precomputed per-local-day summary** (`metric_rollup_days`, migration 025): the same rows `aggregate()` computes from the
  15-minute rollups, keyed by (workspace, time zone, source, local date, connection, metric key, version, dimension).
  Maintained **incrementally by statement-level triggers on `metric_rollups`** (every writer: ingest's per-bucket recompute,
  bulk rebuilds, cascades), recomputing only the changed (zone, connection, source, day range) under an advisory lock per
  (workspace, zone, connection, source). Local days use the query's own expression (`(bucket_start AT TIME ZONE tz)::date`),
  so 23/25-hour DST days and :30/:45 offsets bucket identically. `source` is in the key → live / simulated / demo never
  mix. Zones = workspace + brand time zones (tracked by triggers on `workspaces`/`brands`); a zone is read only after the
  analytics worker has backfilled it (`status = 'ready'`); any other time zone reads the rollups as before.
- **Fewer rows for the overview**: KPIs/channels read one row per (connection, key) for the period; only the trend
  measure is read per day (one statement per period). Large 365 d: 95,817 → 6,689 rows returned.
- **Post scope**: index `deliveries (connection_id, published_at) WHERE state='published'` (Large 365 d read 191,822 rows
  to keep 14,568) and post families from one grouped scan instead of a correlated subquery per post.
- **Approval inbox**: the 150 rows are picked on a narrow approvals + schedule-due join, then display columns are joined
  for those rows only (planning ~20–34 ms → ~10 ms on Large; it dominated execution).
- Statement count for the overview went 15 → 16 (one readiness check per request; within budget).

Equality proofs (`tests/integration/v31-analytics-summary.test.ts`, real PostgreSQL):
- summary rows == rollup rows for six zones (London, New York, Kathmandu +5:45, St John's −3:30, Lord Howe with a
  30-minute DST shift, Santiago) over both 2026 DST transitions and a 260-day range, for zones added after the data
  existed (backfill);
- the whole overview response is identical (except `generated_at`) to the pre-V3.1 data path (`overview(…, { reference: true })`)
  for three measures and two zones;
- after the zones are ready, real `ingestPoints` (incl. a correction) keeps live and simulated summaries equal to the
  rollups, each containing only its own connection; a 00:30 UTC post lands on the 29th in London and the 28th in New York;
- a bulk rebuild keeps it equal; demo rows never appear in live queries; deleting a connection leaves no summary rows.

Got worse / variance in round 2: the host was busier (1-minute load average at the end of each run 6.3–7.7 vs 5.6–6.6 in round 1) and many
unchanged paths show higher p95 with identical statement counts (e.g. Large post detail 6.8 → 13.1 ms, worker claim p95
17 → 25 ms); all within budget and treated as variance. Analytics writes do slightly more work (each rollup statement
recomputes the affected summary days): the Large bench's synthetic analytics generation took 133 → 148 s (round 1 → 2) and the zone backfill
14 s; per-ingest overhead is one day per tracked zone.

## Caching decision

No application cache was introduced and no Redis: after the index/N+1 fixes every core page is within its server budget
straight from PostgreSQL on Medium (except the open items above, which a cache would only hide). Authority is re-read on
every request (`loadAccess`, reviewer facts in the approval inbox) — `tests/integration/v31-perf.test.ts` shows a revoked
approver losing `can_decide` immediately even with an old request context. The only memoisation added is the analytics
metric registry (`definitionsFor`, `fetchedPostDefinitions`, `providerSupports`), which is a pure function of
code-defined definitions with no tenant, user or authorization dimension. Round 2's `metric_rollup_days` is a precomputed aggregate maintained in the same transaction as each rollup
write (never stale, no authorization data; readers keep the same scope and permission checks).

## Verification

- Root `npx tsc -p tsconfig.json --noEmit`: clean. Web `tsc`: clean. Worker bundle builds.
- `pnpm test`: 490 passed (incl. `tests/unit/v31-perf.test.ts`, 11 tests).
- `npx vitest run --project integration`: 47 files, 369 tests passed (round 2: 49 files, 374 tests) (incl. `tests/integration/v31-perf.test.ts`: provider
  cap exact under 8 concurrent claimers with no duplicate sends; batched inbox + immediate revocation; planner/dashboard
  truncation flags; workload samples per workspace + `diagnostics.read` gate).

## Browser (V3.1 UI stream, lab) — `scripts/v31-browser-perf.mjs`

**Conditions.** Production build (`next build --webpack` + `next start`) on the shared dev host: 4 vCPU Intel Xeon
2.1 GHz, 16 GB, the same host also runs Postgres, the worker and Keycloak. Headless Chromium 153 (Playwright), 1440×900,
**localhost with no network or CPU throttling** — these are lab numbers and optimistic for real networks and phones;
field Web Vitals need a deployment. Cold cache per run (fresh browser context), server warmed once per route before
measuring. Dataset: Demo Workspace (3 brands, 19 connections, 907 posts, 896 schedules, 905 deliveries) — smaller than
the PERF Medium profile; larger workloads are server-side results above. **n = 10 cold loads per route** and 10 warm laps;
percentiles are nearest-rank, so p95 of 10 is the slowest run and only indicative. Evidence:
`evidence/v3-1/perf/browser-initial.json` (first measurement), `browser-after.json` (after the fixes below),
`browser-budget-check.json` (n = 3, budget check only).

| Route | LCP p75 / p95 (ms) | Useful content p50 / p95 (ms) | CLS p75 (max) | INP proxy p75 (max) ms, initial → after | JS KB p50, initial → after | Requests p50 |
|---|---|---|---|---|---|---|
| Overview | 384 / 400 | 519 / 607 | 0.032 (0.039) | 200 → 48 (56) | 291 → 292 | 64 |
| Planner (week) | 552 / 576 | 454 / 551 | 0.002 (0.002) | 192 → 56 (64) | 298 → 300 | 63 |
| Create | 348 / 416 | 363 / 439 | 0 (0) | 192 → 40 (48) | 284 → 286 | 68 |
| Composer | 472 / 512 | 480 / 523 | 0.005 (0.008) | 40 → 40 (48) | 349 → 352 | 73 |
| Analytics (28 d) | 556 / 656 | 500 / 639 | 0 (0) | 152 → 48 (56) | 288 → 289 | 76 |
| Content library | 348 / 376 | 369 / 398 | 0 (0) | 168 → 40 (48) | 314 → 311 | 59 |
| Approvals | 328 / 352 | 341 / 390 | 0 (0) | 152 → 40 (48) | 288 → 289 | 56 |
| Connections | 472 / 492 | 493 / 793 | **0.222 → 0** (0) | 160 → 48 (48) | 293 → 296 | 66 |
| History | 348 / 356 | 439 / 524 | 0 (0) | 192 → 64 (64) | 294 → 295 | 59 |
| Settings | 352 / 396 | 364 / 438 | 0 (0) | 152 → 40 (48) | 326 → 303 | 78 |
| Trash | 348 / 356 | 313 / 348 | 0 (0) | 176 → 32 (48) | 290 → 292 | 58 |

Warm navigation through the shell (click → route rendered, no skeleton), n = 10 per target, ms:

| Target | p50 | p95 | initial p95 |
|---|---|---|---|
| Planner | 120 | 191 | 147 |
| Content library | 75 | 96 | 96 |
| Approvals | 82 | 95 | 98 |
| Connections | 132 | 153 | 143 |
| Overview | 175 | 202 | 214 |

**Against the targets (lab):** LCP p75 ≤ 556 ms (target 2 s), CLS p75 ≤ 0.032 (0.1), INP proxy p75 ≤ 64 ms (200),
warm navigation p95 ≤ 202 ms (300) — all within, under the optimistic conditions above.

**What changed between the two measurements (measured, not assumed):**
- INP: every keystroke in the command menu cost 100–140 ms of *presentation delay* (handlers ≤ 14 ms) because the
  full-screen dialog overlay used `backdrop-filter: blur`, which repaints the page behind it each frame. The blur was
  removed from the command menu and the shared `Dialog` overlay: keystrokes now 16–24 ms.
- CLS on Connections (0.222 → 0): brand sections loaded independently and the first one pushed the others down; they
  now appear together after one skeleton, and Content sources renders after them. Trade-off: cold useful-content p95
  on Connections rose (439 → 793 ms) because it waits for the slowest brand.
- JS: Settings sections and the Content Hub panel load on demand (Settings 326 → 303 KB); the Picker module is a dynamic import.

**Not done / honest limits:**
- The ~230 KB shared baseline is unchanged. The biggest lever is the `@social-lite/core` barrel pulling zod (and all
  schemas) into the browser; narrowing client imports or marking core side-effect free is a shared-package change
  (raised with the lead).
- No throttled (slow 4G / 4× CPU) series yet; the harness supports `--cpu 4`.
- INP is a lab proxy for one scripted interaction per route, not field INP.
