# Relay V3.1 — server-side performance budgets

Stream: PERF. Scope: the server share of each interaction (service + SQL + serialisation), the worker hot path,
workload isolation and MCP. Browser budgets (LCP ≤ 2 s p75, INP ≤ 200 ms p75, CLS ≤ 0.1, route JS/image/request-count
budgets) are set by the UI stream after measuring the redesigned screens; they are not claimed here.

Machine-checked: `scripts/bench/budgets.ts`. Every harness run can be checked with
`pnpm bench:compare baseline after --check` (exit 1 on any violation; all violations are listed). Results against these
budgets: `docs/PERFORMANCE_RESULTS.md`.

## How the numbers were chosen

- **Derived from the brief's end-to-end targets (§3)**, leaving room for network, Next.js, session lookup and rendering:
  warm navigation useful content ≤ 300 ms p95 → page read model **≤ 100 ms p95** server-side on the representative
  workload; search ≤ 400 ms p95 after debounce → **≤ 100 ms** server; analytics filter change ≤ 800 ms p95 →
  **≤ 400 ms** server for the standard 28-day view; job acknowledgement ≤ 500 ms → enqueue paths are a single
  transaction (no budget row needed; nothing heavy runs in the request).
- **Representative workload = Medium** (20 brands, 100 connections, 50k posts in the measured workspace, three
  neighbour workspaces). Small must be comfortably inside; **Large is reported separately** with about 2× the time
  budget. Payload and statement-count budgets do **not** loosen with size: a page must not grow with the library.
- **Set after measuring, not to excuse it**: several baseline numbers violate these budgets (approvals 1,216 statements,
  history 0.5 s at Large, planner 775 KB). Budgets that are still violated after the fixes are listed as open items in
  the results, not relaxed.
- **p95 from 30 samples is indicative** (nearest-rank 29th of 30) on a shared 4-vCPU host; a single violation in one
  run is re-measured before it is treated as a regression.

## Page read models (server p95, ms; payload; SQL statements per request)

| Scenario (harness name) | Small | Medium | Large | Max payload | Max statements | Rationale |
|---|---|---|---|---|---|---|
| request context (`loadAccess`, every request) | 10 | 10 | 15 | – | 6 | Paid on every API call; authority is re-read per request (never cached) |
| planner week / one brand month | 50 | 100 | 200 | 300 KB | 6 | Calendar is the primary navigation surface |
| planner month, all brands | 50 | 150 | 300 | 1 MB | 6 | Bounded at 1,000 items with `truncated: true`; UI should prefer brand/week scope at scale |
| posts list (first / cursor page) | 30 | 50 | 100 | 50 KB | 5 | Cursor pagination (30/page); cost independent of library size |
| posts search (`q`) | 50 | 100 | 150 | 50 KB | 5 | §3 search ≤ 400 ms end-to-end |
| post detail | 30 | 50 | 100 | 50 KB | 12 | Composer/detail open |
| dashboard (home) | 50 | 100 | 200 | 300 KB | 12 | `today` bounded to 200 items (`today_truncated`) |
| history (first / deep cursor / filtered / restricted) | 30 | 50 | 100 | 100 KB | 2 | Keyset pagination, 50/page, one statement |
| approvals (pending / decided) | 50 | 100 | 200 | 200 KB | 15 | Bounded to 150 rows; statements must not scale with rows |
| operations (`ops`) | 30 | 100 | 200 | 20 KB | 10 | Counts and percentiles only |
| analytics overview, 28 days | 400 | 400 | 800 | 200 KB | 16 | §3 analytics filter ≤ 800 ms end-to-end |
| analytics overview, 365 days | 800 | 800 | 1,600 | 800 KB | 16 | Long range reported separately (brief: "report larger workloads separately") |
| analytics content table, 28 days | 200 | 200 | 400 | 150 KB | 12 | Paginated table |

Rules that are not numbers:
- **No page request waits on a provider, Google, Notion or AI.** Pages read stored observations/summaries with explicit
  freshness; refreshes are worker jobs. (Verified: every measured page scenario is DB + CPU only.)
- **Every list is bounded**: keyset cursors for posts and history; hard caps with explicit truncation flags for planner
  (1,000), dashboard today (200), approvals (150), history CSV (20,000 rows).
- **Statement counts must not depend on row counts** (no N+1). The harness records statements per call.

## Worker and publishing

| Measure | Small | Medium | Large | Rationale |
|---|---|---|---|---|
| claim (one due delivery), p95 | 25 ms | 25 ms | 40 ms | 4 slots × ~25 claims/s/slot ceiling; claims must stay cheap as history grows |
| idle claim poll (nothing due), p95 | 15 ms | 15 ms | 20 ms | Runs every second per slot per worker |
| processing, app time (excl. provider), p95 | 60 ms | 100 ms | 200 ms | Provider time is reported separately and never counted as app latency |
| dispatch delay (due → claimed), p95, normal load | ≤ 60 s (V1 target) | | | Unchanged contract |
| dispatch delay under a bulk burst (isolation load test), p95 | ≤ 2 s | | | Publishing must not queue behind imports/exports/backfills/video |
| publishing queue age (oldest claimable due item), p95 under bulk burst | ≤ 2 s | | | Pressure threshold for bulk deferral is 10 s in production (2 s in the test) |
| duplicate sends | 0 | 0 | 0 | Never traded for throughput |

## Workload classes (defaults; `WORKLOAD_<CLASS>_CONCURRENCY` / `_PER_WORKSPACE`)

| Class | Per worker | Per workspace | Pool | Defers under publishing pressure |
|---|---|---|---|---|
| publishing (due + reconciliation) | `WORKER_CONCURRENCY` (4) claim slots | `DISPATCH_WORKSPACE_CONCURRENCY` (4) live leases | main (reserved) | never |
| connection_health | 1 | 1 | main | no |
| notifications | 2 | 2 | main | no |
| interactive_import (source imports, writeback, bulk ops) | 2 | 1 | bulk | no |
| analytics_refresh | 2 | 1 (+ pg-boss group concurrency) | bulk | yes |
| historical_backfill | 1 | 1 | bulk | yes |
| video | 1 | 1 | bulk | yes |
| report_export (report, Content Hub, MCP exports) | 2 | 1 | bulk | yes |

Per-provider live leases across all workers: `DISPATCH_PROVIDER_CONCURRENCY` (default 8), per provider
`DISPATCH_PROVIDER_CONCURRENCY_<PROVIDER>`. Pools per worker: main `DATABASE_POOL_MAX` (10) + bulk
`WORKER_BULK_POOL_MAX` (6) + pg-boss (4) = 20 connections. Deferral is bounded (60 s), slot waits are bounded (10 min,
below pg-boss expiry) — bulk work is slowed, never starved or re-delivered.

## MCP (§17)

| Measure | Small | Medium | Large |
|---|---|---|---|
| read tools, server latency (`mcp_audit.latency_ms`) p95 | 100 ms | 150 ms | 250 ms |
| client-observed overhead over server (JSON-RPC, auth, rate limit, audit) | reported, not budgeted (≈ 5–10 ms in-process) | | |

Heavy MCP work (exports) returns a job reference; its processing is a `report_export` workload item, not tool latency.

## Caching policy

No application cache was added: measurements did not justify one (every fixed page is now within budget from the
database). Rules for any future cache: keys include workspace, user/principal, brand scope and policy version plus
every query dimension; permission-sensitive results are never served stale (revocation must not survive a cache);
approval, publishing authority and security state are never cached as authorization; SWR only where staleness is
acceptable and labelled. The analytics registry memo (`providerSupports`, `definitionsFor`) is a pure function of
code-defined data and contains no tenant or authorization state.

Round 2 adds a **precomputed aggregate, not a cache**: `metric_rollup_days` (migration 025) is maintained in the same
transaction as every rollup write (statement-level triggers), so it is never stale; it holds no authorization state, and
readers apply exactly the same workspace/brand/connection scope, dataset (source) and permission checks as before.
