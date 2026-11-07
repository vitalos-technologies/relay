# V3.1 PERF — performance & workload isolation (resumable)

Owner: PERF. Migrations: `020_v31_perf.sql` (APPLIED to dev by the lead 09:0x — FROZEN), further schema → `025_v31_perf_more.sql`.
Backend only (no `apps/web/app/(app)/**`, no `apps/web/components/**`).

## Status
| # | Milestone | Status |
|---|---|---|
| 1 | Bench harness `scripts/bench/*` (`pnpm bench`, `pnpm bench:compare`) | done |
| 2 | Baseline runs → `evidence/perf/baseline-{small,medium,large}.json`, docs/PERFORMANCE_BASELINE.md | done |
| 3 | Fixes: 020 indexes, approval inbox batching, dashboard single attention query, planner Map grouping + `truncated`, dashboard `today` ≤ 200 + `today_truncated`, post summaries tenant predicate, ops lateness predicate, analytics registry/providerSupports memo + per-connection grouping | done; final after-run `evidence/perf/after-*.json` (+ dashboard partial-index literal, batched policies, claim without extra CTE) |
| 4 | Workload isolation: `services/workload/{policy,runner,worker,stats}.ts`, `db.runWithPool`, fairness per-provider cap (savepoint per attempt), `media-transcode` queue, worker wiring, `/api/ops/workload`, contract `core/contracts/v31-perf.ts`; load test `pnpm load:isolation` → `evidence/perf/isolation.json` (3 runs) | done |
| 5 | Docs: PERFORMANCE_BASELINE, PERFORMANCE_BUDGETS (+ `scripts/bench/budgets.ts`, `pnpm bench:compare … --check`), PERFORMANCE_RESULTS | done |
| 6 | Verify: root tsc clean, web tsc clean, worker builds, pnpm test 490, integration 369 (47 files) | done |

## Next (open items, see PERFORMANCE_RESULTS.md)
- Planner payload at scale (UI: brand/week default or compact fields).
- Analytics overview 365 d: precomputed per-day summary in the analytics worker.
- Approval inbox listing query p95 at Medium (111 ms vs 100).

## Notes
- Bench DBs are `relay_bench_*`, dropped at the end unless `--keep`. Disk is tight (~4 GB free): Large needs ~2 GB.
- tsx runs scripts as CJS while services are ESM when imported dynamically → keep one profile per process (run.ts does).
