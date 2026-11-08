# Admin performance report (V3.1 Admin §17)

**Lab measurements, not field data.** Production build (`next build --webpack` + `next start`), localhost, no network
throttling, 4 vCPU Xeon 2.1 GHz / 16 GB, headless Chromium 153, 1440×900, Demo Workspace (synthetic data). Cold load =
fresh browser context per run, server warmed once per route; n = 10 per route (p95 of 10 = the max, indicative only).
Real-user (RUM) numbers need a deployment. Harness: `scripts/admin-perf.mjs` → `evidence/v3-1/perf/admin-after.json`.

## Browser (budgets carried from V3.1: LCP ≤ 2 s p75, INP ≤ 200 ms p75, CLS ≤ 0.1, warm nav ≤ 300 ms p95)

| Route | LCP p75 (ms) | Useful content p95 (ms) | CLS p75 | INP proxy p75 (ms) | Route JS p50 (KB) / budget | Requests p50 |
|---|---|---|---|---|---|---|
| `/admin` | 324 | 395 | 0 | 48 | 299 / 300 | 66 |
| `/admin/publishing?state=attention` | 380 | 549 | 0.002 | 48 | 304 / 310 | 56 |
| `/admin/people` | 384 | 490 | 0.001 | 48 | 298 / 310 | 71 |
| `/admin/connections` | 324 | 390 | 0.033 | 48 | 302 / 310 | 56 |
| `/admin/operations` | 332 | 462 | 0.004 | 40 | 301 / 310 | 57 |
| `/admin/analytics` | 296 | 362 | 0 | 56 | 300 / 300 | 50 |
| `/admin/security/audit` | 372 | 394 | 0 | 48 | 298 / 305 | 48 |
| `/admin/platform` | 328 | 350 | 0.001 | 48 | 299 / 300 | 38 |
| `/admin/platform/workspaces` | 296 | 325 | 0 | 48 | 298 / 300 | 47 |

INP proxy = max Event Timing duration while opening the jump palette, typing, closing it and filtering the nav.

Warm navigation through the admin sidebar (click → heading rendered, no skeleton left), n = 10: Deliveries p95 135 ms,
Members 100 ms, Social accounts 132 ms, Queues and workers 128 ms, Overview 111 ms — all ≤ 300 ms.

## Server (API, warm, sequential, n = 30; includes routing, session + policy load, serialisation)

| Endpoint | p50 (ms) | p95 (ms) |
|---|---|---|
| `/api/admin/overview` (≈ 12 statements) | 18.5 | 22.0 |
| `/api/admin/changes` (1 statement, polled every 10 s) | 8.4 | 20.6 |
| `/api/admin/deliveries` | 10.7 | 18.3 |
| `/api/admin/deliveries?state=attention` | 10.7 | 14.0 |
| `/api/admin/connections` | 8.3 | 10.7 |
| `/api/admin/analytics` (stored data only) | 9.1 | 11.3 |
| `/api/admin/jobs` | 10.5 | 12.9 |
| `/api/platform/overview` | 10.1 | 15.8 |
| `/api/platform/workspaces` | 4.9 | 9.4 |

Stored-data analytics budget (≤ 800 ms p95) and warm-nav budget are met with a wide margin on this dataset. Long-running
operation acknowledgement (≤ 500 ms p95): admin actions are single transactions that enqueue work (requeue, resync,
suspend); they were not separately benchmarked — E2E action round trips completed well under a second.

## What keeps it fast
- Every list is bounded: keyset pages (deliveries 50, workspaces 25, platform audit 50), hard caps elsewhere; counts are
  limited to operational groups (no whole-history counts).
- New indexes (026): `deliveries(workspace_id, updated_at)`, `posts(workspace_id, updated_at)`,
  `connections(workspace_id, updated_at)`, partial `outbox(workspace_id, id) WHERE dead` → the change feed is index probes.
- Platform 24 h delivery counts go through a per-workspace lateral index range, never a whole-table scan.
- Settings sections, the budgets editor and diagnostics drawer are lazy-loaded; no chart library.
- The change feed is one small JSON object per 10 s per visible admin tab; nothing streams record data; hidden tabs stop.

## Not measured / caveats
- Large dataset (Medium/Large harness from V3.1 PERF) was not re-run for the admin queries; the queries are bounded and
  index-backed, but platform overview's per-workspace counts grow with the number of workspaces.
- Field data (RUM), slow networks and CPU throttling were not measured.
