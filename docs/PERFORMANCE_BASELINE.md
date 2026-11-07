# Relay V3.1 — performance baseline (server side)

Stream: PERF. Measured 2026-11-07 on the V3 code **before** any V3.1 PERF change (harness label `baseline`).
Raw data: `evidence/perf/baseline-{small,medium,large}.json`. Browser metrics (LCP/INP/CLS, bundles, hydration) are
measured later by the UI stream on the redesigned screens; nothing here is a browser number.

## How to reproduce (one command)

```bash
pnpm bench                                   # small + medium (each in its own process + throwaway DB)
pnpm bench --profile large                   # or: small | medium | large | all
pnpm bench --profile all --samples 30 --label after
pnpm bench:compare baseline after            # markdown before/after table
```

Each profile: `CREATE DATABASE relay_bench_<profile>_<ts>` → all migrations → synthetic dataset → `VACUUM ANALYZE` →
3 warm-up calls + N timed calls per scenario (sequential, one caller) → JSON → `DROP DATABASE` (unless `--keep`).
The harness refuses any database name without the `relay_bench_` prefix; it never touches `socialite_dev`.
Files: `scripts/bench/{run,profiles,generate,scenarios,mcp,stats,compare}.ts`.

## Datasets (fixtures for measurement, not promised capacity)

Generator: `scripts/bench/generate.ts` (set-based SQL, deterministic shapes via `bench_rand(seed‖row)`) plus the
analytics stream's history generator (`services/analytics/demo.ts` `generateLargeHistory`). Per post: 70% published
(last 720 days), 3% failed, 1% unknown/blocked (last 10 days), 8% scheduled (next 60 days), 4% pending approval
(approval brands), 2% cancelled, 12% drafts; 1–3 destinations on the post's brand; one attempt row per finished
delivery; approvals for pending and for published posts on approval brands (25% of brands). Users: owner, approver,
and a brand-restricted editor (half the brands) to exercise the `brandIds` scoping path.

| Profile | Measured workspace (brief §2) | Neighbour workspaces | Analytics history (measured ws) | Totals in DB | DB size |
|---|---|---|---|---|---|
| Small | 2 brands, 10 connections, 1,000 posts | 2 × 50% | 90 days, 1 post/day/connection, 10 synthetic connections → 891 posts, 27,465 observations | 2,891 posts, 4,261 deliveries | 68 MB |
| Medium | 20 brands, 100 connections, 50,000 posts | 3 × 10% | 365 days, 1/day, 10 connections → 3,643 posts, 122,143 observations | 68,643 posts, 116,772 deliveries | 462 MB |
| Large | 100 brands, 500 connections, 250,000 posts | 4 × 5% | 365 days, 2/day, 20 connections → 14,570 posts, 482,580 observations | 314,570 posts, 536,602 deliveries, 444,771 attempts | 1,925 MB |

(The measured workspace also holds the analytics brand, so it has brands+1 and connections+10/20; counts are in each JSON.)

## Conditions

| | |
|---|---|
| Host | shared 4-vCPU VM, Intel Xeon @ 2.10 GHz, 16.9 GB RAM (6–9 GB free at start), Node 22.23.4 |
| PostgreSQL | 16.15 in Docker on the same host; `shared_buffers` 128 MB, `work_mem` 4 MB, `effective_cache_size` 4 GB (defaults) |
| Migrations | 001–019 + other V3.1 streams' 021/022 (no 020) — listed per run in the JSON |
| Cache state | warm: 3 warm-up calls per scenario; buffer hit ratio during page samples 0.99999 (Small), 0.982 (Medium), **0.835 (Large — 1.9 GB DB vs 128 MB shared_buffers, OS cache only)** |
| Concurrency | one sequential caller (latency, not throughput); pool max 8 |
| Host load | other agents ran tests concurrently: 1-min load average at end 2.8 (Small), 6.6 (Medium), 5.3 (Large) on 4 vCPUs — variance is reported (cv) and is material on Large |
| Layer measured | the service functions the API routes call (`loadAccess` + authorization + SQL + serialisation); excludes Next.js routing, session cookie lookup and network |
| Providers | simulated destinations, 0 ms simulated latency (provider time reported separately) |

Sample counts: 30 timed calls per page scenario (p95 = 29th of 30 sorted; nearest rank — treat as indicative),
dispatch = every delivery of the backlog (100 / 300 / 500), MCP = 30 calls per tool.

## Results (ms, p50 / p95)

| Scenario | Small p50 / p95 | Medium p50 / p95 | Large p50 / p95 | Large queries | Large payload |
|---|---|---|---|---|---|
| request.context (loadAccess) | 2.51 / 3.3 | 2.74 / 3.29 | 3.8 / 7.99 | 5 | 1 KB |
| planner.week (all brands) | 6.01 / 8.38 | 80.87 / 103.39 | 161.31 / 270.28 | 5 | 775 KB |
| planner.month (all brands) | 9.54 / 13.16 | 81.2 / 101.9 | 171.33 / 281.78 | 5 | 776 KB |
| planner.month (one brand) | 6.37 / 7.97 | 12.71 / 17.95 | 31.57 / 58.37 | 5 | 156 KB |
| planner.month (brand-restricted editor) | 6.17 / 8.75 | 81.52 / 115.39 | 160.7 / 237.49 | 5 | 777 KB |
| posts.list (first page) | 3.74 / 6.37 | 17.2 / 20.17 | 115.03 / 180.15 | 4 | 18 KB |
| posts.list (page 5, cursor) | 3.78 / 5.88 | 13.42 / 21.12 | 102.55 / 180.1 | 4 | 18 KB |
| posts.search (q=launch) | 4.68 / 5.34 | 20.34 / 35.98 | 136.84 / 359.12 | 4 | 18 KB |
| post.detail | 6.04 / 11.39 | 6.65 / 10.2 | 41.43 / 83.8 | 10 | 6 KB |
| dashboard | 25.73 / 39.85 | 131.75 / 197.51 | 827.87 / 1342.26 | 15 | 775 KB |
| history (first page) | 9.51 / 13.52 | 75.19 / 128.68 | 527.82 / 638.52 | 1 | 48 KB |
| history (failed, one brand) | 3.1 / 6.57 | 5.99 / 12.77 | 4.69 / 11.09 | 1 | 49 KB |
| history (page 21, cursor) | 9.19 / 11.9 | 77.48 / 111.98 | 655.79 / 880.15 | 1 | 48 KB |
| history (brand-restricted editor) | 7.91 / 15.1 | 51.14 / 101.23 | 593.97 / 1049.54 | 1 | 48 KB |
| approvals (pending) | 67.13 / 94.1 | 564.94 / 744.65 | 683.23 / 1093.88 | 1276 | 130 KB |
| approvals (decided) | 19.19 / 37.19 | 42.41 / 61.89 | 100.53 / 147.06 | 76 | 133 KB |
| ops (operations) | 5.32 / 7.89 | 37.03 / 51.28 | 279.92 / 599.53 | 9 | 1 KB |
| analytics.overview (28 d) | 114.88 / 142.9 | 196.62 / 287.27 | 555.26 / 784.66 | 15 | 137 KB |
| analytics.overview (365 d) | 189.23 / 224.96 | 803.32 / 1287.88 | 3998.97 / 5475.5 | 15 | 657 KB |
| analytics.content (28 d, sort ER) | 49.93 / 64.73 | 49.6 / 88.43 | 110.71 / 131.66 | 11 | 93 KB |
| worker: claim | 7.96 / 14.09 (n=100) | 8.1 / 16.01 (n=300) | 9.72 / 18.28 (n=500) | | |
| worker: idle_claim | 3.73 / 8.21 (n=30) | 4.76 / 8.94 (n=30) | 4.97 / 9.25 (n=30) | | |
| worker: process_app | 21.92 / 36.15 (n=100) | 35.74 / 59.08 (n=300) | 96.89 / 155.51 (n=500) | | |
| worker: process_provider | 1.23 / 6.29 (n=100) | 1.49 / 6.03 (n=300) | 1.75 / 4.86 (n=500) | | |
| worker: outbox_batch50 | 11.03 / 14.85 (n=2) | 18.3 / 27.9 (n=6) | 23.18 / 32.5 (n=10) | | |
| MCP list_workspaces client (server) | 9.78 (2) / 22.35 (5) | 13.39 (2) / 33.45 (8) | 8.14 (2) / 11.61 (3) | | |
| MCP list_brands client (server) | 8.05 (3) / 18.28 (7) | 8.19 (3) / 18.9 (7) | 10.81 (5) / 13.13 (7) | | |
| MCP search_content client (server) | 18.22 (9) / 33.64 (17) | 38.68 (29) / 82.13 (61) | 70.73 (63) / 86.31 (79) | | |
| MCP get_post client (server) | 15.98 (8) / 33.45 (15) | 14.86 (10) / 25.35 (13) | 29.66 (23) / 36.39 (29) | | |
| MCP get_delivery_status client (server) | 16.4 (6) / 59.37 (36) | 10.3 (5) / 20.26 (10) | 11.81 (6) / 17.84 (10) | | |
| MCP list_calendar client (server) | 18.3 (10) / 31.83 (21) | 99.47 (84) / 166.28 (139) | 93.93 (80) / 112.26 (96) | | |
| MCP analytics_overview client (server) | 14.72 (5) / 20.92 (9) | 9.46 (5) / 15.93 (9) | 12.67 (7) / 20.83 (8) | | |

MCP: client = what an MCP client waits for through the real `/mcp` Streamable HTTP handler in-process (JWT verify,
consent/scope, rate limit, tool, audit write); server = the tool's own latency from `mcp_audit.latency_ms` (integer
ms). No measured tool calls a provider in-request, so provider time is 0 by construction. `analytics_overview` over MCP
reads the *live* dataset (MCP cannot select demo data), so it is not comparable to the page scenario.

## Findings (what the baseline shows)

1. **Approval inbox is an N+1**: 148 / 1,216 / 1,276 SQL statements per request (≈8 per pending row: policy, decisions,
   reviewer authority, teams, shares, own decision). 565–683 ms p50 at Medium/Large.
2. **Missing tenant-leading orderings**: history (all brands) sorts the workspace's deliveries on every page (Large
   528 ms first page, 656 ms deep page, external merge sort on disk); dashboard attention lists (5 sequential queries)
   seq-scan deliveries (≈190 ms each at Large); planner across brands seq-scans schedules.
3. **Tenant predicate missing in post summaries**: `deliveries WHERE post_id = ANY(…)` cannot use
   `(workspace_id, post_id)` → full index scan of deliveries for every posts-list page and post detail (Large 76 ms of
   the 115 ms list).
4. **Unbounded-looking payloads**: planner returns up to 1,000 items silently (no truncation flag) — ~775 KB for one
   week across 100 brands; the dashboard embeds that planner window (775 KB at Large).
5. **Analytics overview over 365 days** is CPU-bound in Node (registry scans per post per day, per-provider re-filtering):
   0.8 s Medium, 4.0 s Large p50.
6. **Worker hot path is fine at the claim** (8–10 ms p50, idle poll 4–5 ms) but per-delivery app time grows with data
   (22 → 97 ms p50 Small → Large).
7. **No page request waits on providers**: every measured page scenario is DB + CPU only (providers are only called by
   the worker; analytics/connection summaries read stored observations).
