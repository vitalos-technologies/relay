# V3.1 architecture changes

What V3.1 changed in Relay's architecture. It is still a modular monolith: PostgreSQL plus pg-boss, with no new infrastructure (no Redis, no new services). Migrations are covered in [V3_1_MIGRATION_AND_ROLLBACK.md](V3_1_MIGRATION_AND_ROLLBACK.md), measurements in [PERFORMANCE_RESULTS.md](PERFORMANCE_RESULTS.md), and the data API contract in [V3_1_DATA_API.md](V3_1_DATA_API.md).

## 1. Worker workload isolation (PERF; `packages/services/src/workload/*`, migration 020)

| Piece | Implementation |
|---|---|
| Workload classes | `workload/policy.ts`: publishing, connection_health, notifications (main pool, never deferred); interactive_import, analytics_refresh, historical_backfill, video, report_export (bulk pool). Overrides: `WORKLOAD_<CLASS>_CONCURRENCY` / `_PER_WORKSPACE` |
| Separate bulk pool | Bulk classes run inside `runWithPool(bulkPool)`, so every `getPool()` they call uses a second pool (`WORKER_BULK_POOL_MAX`, default 6). They can never take the main pool's connections, which the claim loops use |
| Backpressure | Analytics, backfill, video and exports wait (max 60 s, then run anyway) while every publishing slot is busy or claimable due work is older than `PUBLISHING_PRESSURE_DUE_AGE_SECONDS` (10 s). Slot waits are capped below pg-boss expiry, so jobs are never re-delivered while waiting |
| Per-workspace caps | In-process FIFO gate per class with no head-of-line blocking across workspaces; on top of pg-boss group concurrency |
| Per-provider dispatch cap | `DISPATCH_PROVIDER_CONCURRENCY` (default 8, per-provider overrides) across all workers. Enforced with a provider advisory lock, a re-count and a savepoint per claim attempt; exact under 8 concurrent claimers (`v31-perf`) |
| Video queue | Video gets its own `media-transcode` queue instead of sharing `events` with notifications |
| `workload_samples` | One row per item: queue age, dispatch delay, processing time, with provider time separate from app time. Pruned after 7 days. Served per workspace at `GET /api/ops/workload` (`diagnostics.read`) |
| Connection budget per worker | main `DATABASE_POOL_MAX` 10 + bulk 6 + pg-boss 4 = **20** |

Result (3 runs each): publishing dispatch delay p95 under a bulk burst went from 3.37 s to 1.14 s, with 0 duplicate sends and bulk work not starved (`evidence/perf/isolation.json`).

## 2. Read-path performance (PERF; migrations 020, 025)

- **Migration 020 indexes:**
  - `deliveries (workspace_id, due_at DESC, id DESC)`, plus an attention partial index;
  - `schedules (workspace_id, due_at)`;
  - `approvals (schedule_id …)` and decided-approvals indexes;
  - `delivery_attempts (workspace, started)`.
- **N+1 removed:** approval inbox batching (1,276 → 11 statements); a single dashboard attention query; planner Map grouping.
- **Bounded reads:** planner capped at 1,000 items (`truncated`); dashboard `today` capped at 200 (`today_truncated`); the posts summaries query carries the tenant predicate.
- **Per-day analytics summary (025):** `metric_rollup_days` holds what `aggregate()` computes from `metric_rollups`, per (workspace, time zone, source, local date, connection, metric key, version, dimension).
  - **Upkeep:** statement-level triggers on `metric_rollups` keep it current inside the same transaction, under an advisory lock per (workspace, zone, connection, source).
  - **Zones:** `metric_summary_zones` (workspace and brand zones, tracked by triggers) start `pending`. The analytics worker backfills a zone and marks it `ready`.
  - **Reads:** only from `ready` zones, otherwise from rollups. `summary.ts` also falls back when the table is absent.
  - **Isolation:** `source` is part of the key, so live, simulated and demo data never mix.
  - **Tests:** `v31-analytics-summary` proves equality with the rollups across DST transitions and :30/:45 offsets.
- **Approval inbox:** two-stage query. Rows are picked on a narrow join first, display columns joined afterwards.
- **No application cache.** Authority is re-read on every request. The analytics registry memo holds no tenant data.

## 3. Trash and soft delete (DATA; `services/data/trash.ts`, migration 021)

- **Soft delete:** `posts`/`assets` get `deleted_at`, `deleted_by` and `purge_after` (30 days, `TRASH_RETENTION_DAYS`), with CHECK constraints for consistency. Trashed rows are hidden from `loadPost`/`listPosts`, assets, campaigns and search.
- **Refusals:** trashing is refused while a schedule is live, publishing is in flight, or the post reached a network. Assets are refused while a live schedule or unfinished delivery uses them.
- **Purge:** the `trash-purge` worker timer runs hourly. Before deleting, it re-checks references (schedules, deliveries, non-trashed drafts, Content Hub snapshots); a blocked asset gets `purge_blocked_reason`. Storage objects are deleted after the row commits.
- **Undo:** replays a server token with `expected_deleted_at` / `expected_version`. Every action is audited.

## 4. Bulk jobs (DATA; `services/data/bulk.ts`, migration 021)

- `POST /api/bulk/preview` returns a per-item verdict and a `preview_hash`. Starting a job needs that hash; a stale preview gets 409.
- **Start:** the `bulk_jobs` row, its `bulk_job_items` and an outbox event (`bulk.requested`) are written in one transaction, then go to the `bulk-ops` queue. A `bulk-jobs` sweep runs every 30 s, with a lease, to resume lost runs.
- **Runtime checks:** the job runs with the creator's **current** grants. Each item goes through the UI's services, with per-item idempotency keys. Succeeded items never re-run.
- **Retry, cancel, undo:** retry re-runs failed items only; cancel skips the remaining items; undo starts a new job.
- Bulk work is in the `interactive_import` class (bulk pool).

## 5. Search (DATA; `services/data/search.ts`, migration 021)

- PostgreSQL full-text search (`'simple'`, prefix terms) over expression GIN indexes on posts, campaigns and assets (helper `relay_tags_text()`).
- **Authorization:** each kind is searched only on brands where the caller has read permission now. Settings destinations are filtered by permission. Snippets are plain text with highlight ranges, taken only from readable fields.
- **Bounds:** 6 terms, 20 results per kind, a 2 s statement timeout (`partial: true` when hit). An aborted request triggers `pg_cancel_backend` (HTTP 499).
- **Recent items:** `recent_items`, re-authorized on every read.
- **Client:** the Cmd+K cache is keyed by workspace + `policy_version` + query and dropped on change.

## 6. Brand rules, engine hold, reschedule enforcement (GOV; `services/gov/*`, migration 022)

- **Rule engine** (`rules-engine.ts`): findings are `mandatory` (blocks) or `advisory` (warns).
  - It is enforced in `posts/scheduling.ts` (`enforceBrandRules` in `createScheduleTx`), in `validatePost` and in the readiness checks.
  - A mandatory finding returns `validation_failed` with `details.reason='brand_rules'`.
- **Rule changes** bump `brand_profiles.rules_version` and re-evaluate up to 500 drafts and 500 live schedules. They open one `brand_rule_reviews` row per affected post and never modify content, revisions, schedules or deliveries.
- **Engine hold** (`engine/process.ts`):
  - The engine holds a delivery (state `blocked`, code `brand_rule_review`) while a mandatory review for its schedule is open, or was decided `will_edit`.
  - A `keep` decision releases it (`releaseBrandRuleHold`).
  - Reconnects never release it (`engine/hooks.ts` excludes the code). Nothing is sent while held (`v31-brand-rule-hold`).
- **Reschedule enforcement** (89286a7): `reschedule()` (single and bulk) checks mandatory rules and asset expiry against the revision being moved at the new time. Bulk preview reports specific skip reasons (published, cancelled, finished, never scheduled).
- **Related services:**
  - TipSignal fact preservation and promise-language checks (`ai/fidelity.ts`);
  - asset governance;
  - reuse with provenance;
  - content queues (consumed once);
  - UTM defaults and tracked links (code-only redirect, no open redirect);
  - read-only integration diagnostics.

## 7. Dispatch-version guard (GOV; `engine/claim.ts`)

- `dispatchEnabled(db, version)` reads `system_flags.dispatch_version`. When it is set, only workers whose `APP_VERSION` equals it claim, dispatch or reconcile (three call sites in `apps/worker/src/main.ts`). When it is absent, any version may dispatch.
- Claims stay atomic and fenced regardless. The guard prevents two builds from dispatching side by side during a rolling deploy.
- Procedure: [V3_1_MIGRATION_AND_ROLLBACK.md](V3_1_MIGRATION_AND_ROLLBACK.md) §4.

## 8. Feature flags (GOV; `services/gov/release.ts`, migration 022)

- **Registry:** a code registry (`FEATURE_FLAGS`, six `v31.*` keys, all default off) plus installation rows (`feature_flags`: rollout %, kill switch; operators via SQL, no API).
- **Workspace overrides:** `workspace_feature_flags`, changed by `workspace.manage`, audited.
- **Precedence:** kill switch > workspace override > rollout bucket (stable hash of flag and workspace) > default. Unknown keys are off.
- **Client:** `lib/client/flags.tsx` (`useFlag`) gates screens.
- **The flags gate the UI only.** The server function `isFeatureEnabled` has no caller, so the APIs behind a flag stay reachable.

## 9. Draft resilience (DATA + UI)

- **Autosave:** `PUT /api/posts/:id/autosave` with `base_version`, a per-tab `client_id` and a monotonic `client_revision` (table `draft_save_clients`). Conflicts return 409 with the server copy and keep a conflict copy. A new `recovered` version kind exists.
- **Local recovery:**
  - `lib/client/draft-recovery.ts` stores browser copies, namespaced by user + workspace;
  - `workspace_data_policies` sets the mode (`persistent` / `session` / `off`), max age and clear-on-logout;
  - recovery never overwrites a newer server version and never schedules.

## 10. E2E workspace isolation

- `scripts/seed-e2e.ts` (also run from `scripts/seed.ts` and Playwright `tests/e2e/global-setup.ts`) seeds a synthetic **"E2E Workspace"**, plus an empty **"E2E Onboarding"** workspace for the onboarding test.
- `helpers.signIn` switches to it via `POST /api/session/workspace`.
- Playwright fixtures therefore never land in the Demo Workspace, and the E2E workspace persists between runs (specs pin seeded destinations).

## 11. Strict-CSP fix (Zod jitless)

- Zod v4 probes `Function('')` when it builds object schemas. Under the nonce-based CSP without `unsafe-eval`, every page logged an eval violation.
- `packages/core/src/schemas.ts` calls `z.config({ jitless: true })` when `document` exists (browser only). Validation results are the same; the server is unchanged.
- The `security.spec` CSP test passes with zero violations on a production build.

## 12. MCP additions

V3.1 adds six read-only tools (33 in total, `MCP_TOOLS`):
- `search`, `get_draft_recovery_status`, `preview_bulk_action`, `get_bulk_job_status` (`mcp/tools-data.ts`);
- `get_brand_rules`, `get_integration_diagnostics` (`mcp/tools-gov.ts`).

They use the same services and permissions as the app. Bulk jobs start and undo only in Relay; no tool takes a confirmation flag.
