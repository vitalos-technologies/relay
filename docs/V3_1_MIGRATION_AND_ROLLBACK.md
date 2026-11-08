# V3.1 migration and rollback

Upgrade from V3 (`v3.0.0`, migrations up to 019) to V3.1. The general V2 procedure (backup, least-privilege roles, `db:migrate` with the migrator role) is unchanged: [V2_MIGRATION_RUNBOOK.md](V2_MIGRATION_RUNBOOK.md).

## 1. What the migrations do

The migrator (`packages/db/src/migrate.ts`) runs each file in its own transaction and records a checksum. An applied file must never be edited.

| File | Contents | Additive? | Old code on the new schema |
|---|---|---|---|
| `019_v3_engine.sql` (V3) | `ALTER TYPE delivery_state ADD VALUE 'handoff'` | Yes, but **irreversible** (PostgreSQL cannot drop an enum value) | Pre-V3 code does not know `handoff` |
| `020_v31_perf.sql` | Table `workload_samples`. Indexes on `deliveries` (workspace, due, id; attention partial), `schedules` (workspace, due), `approvals` (schedule; decided), `delivery_attempts` (workspace, started) | Yes | Compatible (unused) |
| `021_v31_data.sql` | Nullable `deleted_at` / `deleted_by` / `purge_after` (+ `purge_blocked_reason` on assets) with consistency CHECKs on `posts` and `assets`. **Drops and re-adds** `post_versions_kind_check`, widened to allow `recovered`. Tables `draft_save_clients`, `workspace_data_policies`, `bulk_jobs`, `bulk_job_items`, `recent_items`. Three FTS GIN indexes and the immutable function `relay_tags_text()` | Schema-additive. The CHECK swap only widens; there is no data rewrite | Compatible, but **trashed posts/assets reappear as ordinary rows** for V3 code |
| `022_v31_gov.sql` | 16 tables (brand profiles/rules/reviews, asset governance, provenance, reuse policy, queues, UTM defaults, tracked links + daily clicks, `feature_flags` with 6 seed rows (all off), `workspace_feature_flags`, support reports, release-note reads, onboarding progress) | Yes | Compatible (unused). Brand-rule **holds** are not applied by V3 code |
| `025_v31_perf_more.sql` | Tables `metric_summary_zones`, `metric_rollup_days`. Functions + **statement-level triggers on `metric_rollups`**, row triggers on `workspaces`/`brands` (timezone). Seeds zones. Partial index `deliveries (connection_id, published_at) WHERE state='published'` | Schema-additive, but **adds write-path triggers** | Compatible: V3 writers still fire the triggers, so the summary stays correct (slightly more write work) |

Not created: 018, 023, 024 (planned slots, not needed).

**Verdict:** every V3.1 migration is additive at the schema level: no dropped columns or tables, no data rewrite. Two things are not plain additions:
- the 021 CHECK replacement (it only widens);
- the 025 triggers (they change write behaviour).

**Locks:** no index uses `CONCURRENTLY`, because each file runs inside a transaction. Building indexes on large `deliveries`, `schedules`, `approvals` and `posts` tables blocks writes to those tables while it runs. Apply in a maintenance window with dispatch paused (§3 step 2).

## 2. Verification status

| Check | Status |
|---|---|
| 001–025 apply to an empty database | Every integration run (`tests/integration/global-setup.ts`), 375/375 on 2026-11-07 |
| Rehearsal from a V1 backup (`scripts/migration-rehearsal.sh`) | **Last run 07:53, before 020–025 existed.** Re-run before production (it writes `evidence/v2/migration-rehearsal.txt`) |
| Equality of the 025 summary with rollups (DST, offsets, backfill, rebuild) | `tests/integration/v31-analytics-summary.test.ts` |
| Application rollback rehearsal | Not done |

## 3. Upgrade steps

1. **Back up** the database (and confirm KMS/KEK access for restore, V2 checklist §4). Record row counts for `posts`, `deliveries`, `schedules`.
2. **Pause dispatch:**
   ```sql
   UPDATE system_flags SET value='false' WHERE key='dispatch_enabled';
   ```
   Or use the ops pause. Wait for in-flight claims to finish.
3. **Pin the dispatching version** to a value no V3.1 worker has yet (for example the V3 build's version, §4), so that new workers start without dispatching. **V3 workers predate the guard and ignore the pin.** For this upgrade, stop all V3 workers before step 7.
4. **Migrate** with the migrator role: `pnpm db:migrate` (`MIGRATOR_DATABASE_URL`).
5. **Deploy V3.1 web and workers.** Set `APP_VERSION` per build.
6. **Check:**
   - `/api/ready` returns 200;
   - workers log the analytics summary backfill;
   - `SELECT status, count(*) FROM metric_summary_zones GROUP BY 1` moves to `ready`; analytics reads rollups until then.
7. **Make sure no V3 worker is still running**, switch the dispatch pin to the V3.1 version, then re-enable dispatch (`dispatch_enabled` = `true`).
8. **Watch** `GET /api/ops/workload`: dispatch delay p95 and queue age.

## 4. Rolling deploys: one dispatching version

Claims are atomic and fenced, so no delivery is ever sent twice. Even so, two worker builds must not dispatch side by side. Workers compare `APP_VERSION` (default `dev`) with `system_flags.dispatch_version` before claiming, dispatching or reconciling (`engine/claim.ts`).

1. Before starting build N+1, pin N:
   ```sql
   INSERT INTO system_flags(key, value, updated_by) VALUES ('dispatch_version', '"<N>"', 'ops')
   ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
   ```
2. Start N+1 workers. They run but never claim.
3. When N+1 is healthy, set the pin to `"<N+1>"` in one statement. N workers stop claiming on their next loop (within seconds); in-flight claims finish under their lease and fence.
4. Stop the N workers, then `DELETE FROM system_flags WHERE key='dispatch_version'` (absent = any version).

**Rollback:** set the pin back to `"<N>"`.

Notes:
- Every build must set a distinct `APP_VERSION`. With the default `dev` on both builds, the guard cannot tell them apart.
- The pin may also be a JSON array of versions. Any other malformed value means no version dispatches.
- The guard exists from V3.1 on. Workers from V3 or earlier ignore it.

## 5. Worker database connection budget

Per worker process:

| Pool | Default | Setting |
|---|---|---|
| Main (claims, publishing, essential work) | 10 | `DATABASE_POOL_MAX` |
| Bulk (imports, analytics, backfill, video, exports, bulk ops) | 6 | `WORKER_BULK_POOL_MAX` |
| pg-boss | 4 | fixed in `engine/outbox-dispatcher.ts` |
| **Total** | **20** | |

Each web process adds `DATABASE_POOL_MAX` (10). Size PostgreSQL `max_connections` (or the pooler) for the sum below, plus headroom:

`workers × 20 + web replicas × 10 + migrator + admin/monitoring`

PostgreSQL's default of 100 covers about 3 workers and 3 web replicas.

## 6. Rollback

**Primary rollback: restore the pre-upgrade backup** and redeploy the V3 images. There are no down-migrations.

If you must keep the data and only roll back the application:
- **Allowed:** V3 code runs on the V3.1 schema (§1).
- **Before rolling back, restore or purge trashed items.** Otherwise:
  - trashed posts/assets reappear;
  - brand-rule holds stop applying;
  - bulk jobs in progress stop.
- **Stop all V3.1 workers before starting V3 workers.** V3 workers ignore `dispatch_version`, so the pin cannot stop them; delete it once the V3.1 workers are gone.
- **Optional removal of 025:** follow the comment at the top of `025_v31_perf_more.sql` (drop the triggers, functions and two tables). `summary.ts` falls back to rollups when the table is absent.
- **Never** re-run or edit an applied migration file (checksums).
- 019's enum value stays.
