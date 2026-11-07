# V3 AN — Analytics stream progress (resumable)

Owner: AN. Read this first after a container restart. Migration: `packages/db/migrations/015_v3_analytics.sql` ONLY.

## Plan / milestones
| # | Milestone | Status |
|---|---|---|
| 1 | Migration 015 (definitions, sync_runs/cursors, observations, cumulative + daily facts, resource latest + 15-min rollups, data_coverage, report_definitions/exports) | done (applies on scratch; NOT on dev yet) |
| 2 | Registry + dictionary | done: 70 definitions; `npx tsx scripts/analytics-dictionary.ts [--check]` → docs/V3_ANALYTICS_DICTIONARY.md |
| 3 | Pipeline: ingest, sync, backfill, worker | done; worker wired in apps/worker/src/main.ts ('analytics' tick replaces V1.1 'metrics' loop; queues analytics-sync + analytics-report-export — CH owns 'report-export'); disabled if 015 missing |
| 4 | Query API (`services/analytics/query.ts`, filters.ts) + routes `apps/web/app/api/analytics/**` | done; routes done (overview, content, content/[id], channels, video, audience, workflow, best-time, metrics, sync, reports, reports/[id], exports, exports/[id], exports/[id]/download) |
| 5 | Reports (saved views, exports CSV/HTML/PDF, ReportExporter stub) | done; tests/integration/v3-analytics-pipeline.test.ts 8/8 pass (PDF via Chromium verified) |
| 6 | Contracts `packages/core/src/contracts/analytics.ts` (exports.ts owned by CH — ReportExporter consumed) | done (extend as needed) |
| 7 | Synthetic demo dataset + large generator | done: demo.ts + scripts/analytics-demo.ts (NOT run on dev: needs 015) |
| 8 | Tests, EXPLAIN, docs | done: unit 12, integration 21 (v3-analytics 13 + pipeline 8); scripts/analytics-bench.ts (disposable DB): 14.6k posts/484k points → overview 28 d ≈0.6 s, 365 d ≈2.8 s; content 28 d ≈0.2 s |
| 9 | Verify | DONE 2026-11-07: tsc root ✓ web ✓; pnpm test 455/455; test:integration 319/319; routes compile (401 smoke); worker bundles. Migration 015 NOT applied to dev (lead applies 015–017) |

## Design decisions (keep consistent)
- TS registry is canonical; `syncMetricRegistry()` upserts rows into `metric_definitions` (immutable per id+version).
- Fact key: (workspace, connection, resource_type, resource_id, metric_id, period_key, dimension, definition_version). Lifetime
  counters: period_key = `asof:<UTC date>` (one row per as-of day; retries/upserts never duplicate; value change ⇒ revision+1 = correction).
- Stores: raw `metric_observations` → `metric_cumulative_facts` (lifetime/snapshot as-of series) SEPARATE from
  `metric_daily_facts` (time buckets: provider-reported daily or `observed_change` deltas, labelled) → `metric_resource_latest`
  (per post latest) → `metric_rollups` (15-minute publish buckets; exact local-day bucketing for every real tz offset).
- Datasets: `live` (source=provider, real connections), `simulated` (mock_ destinations), `demo` (synthetic fixtures, demo
  workspaces only). Live queries never include simulated/synthetic rows.
- Permissions: `analytics.read` per brand (V2 policy), exports need `exports.create` too; jobs re-check at run time.

- semantics.ts = pure rules (periods/DST, compare, sumCompatible, ratioOfSums, deriveStatus, csvCell). Rollups carry derived keys `_family.<f>`, `_derived.*`.

- Coordinator (after restart): do NOT apply 015 to dev; lead applies 015–017 together. Not a git repo anymore.

## Open items / for the lead
- Apply 015 before restarting web/worker on dev: the V1.1 on-demand refresh route now dual-writes to 015 tables (worker analytics disables itself if 015 is missing).
- Register CH's exporter in the worker: `registerReportExporter(contentHubExporter)` (services/analytics/exporters.ts); until then external destinations fail honestly with destination_not_connected.
- Account-level fetchers (followers, audience) don't exist in adapters → live shows not_fetched; demo data shows the UI path.
- V3.1: overview over 365 d ≈2.8 s (JS-side health over ~95k agg rows); demo/bench generator inserts posts row-by-row (≈130 s for 14.6k posts).
