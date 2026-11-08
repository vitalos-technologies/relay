# V3.1 final activation checklist

Only things a human operator must do outside the code. Earlier checklists still apply:
- [FINAL_ACTIVATION_CHECKLIST.md](FINAL_ACTIVATION_CHECKLIST.md) (V1)
- [V2_FINAL_ACTIVATION_CHECKLIST.md](V2_FINAL_ACTIVATION_CHECKLIST.md)
- [V3_FINAL_ACTIVATION_CHECKLIST.md](V3_FINAL_ACTIVATION_CHECKLIST.md)

Engineering gaps: [V3_1_IMPLEMENTATION_GAPS.md](V3_1_IMPLEMENTATION_GAPS.md). Upgrade procedure: [V3_1_MIGRATION_AND_ROLLBACK.md](V3_1_MIGRATION_AND_ROLLBACK.md).

Keep secrets in the secret manager; never put them in chat or this repo.

## 1. Database capacity

| What | Where | How to verify | Unlocks |
|---|---|---|---|
| Size `max_connections`, or put a **session-mode** pooler in front, for `workers × 20` (main 10 + bulk 6 + pg-boss 4) + `web replicas × 10` + migrator + admin/monitoring + headroom. The PostgreSQL default of 100 covers about 3 workers + 3 web replicas. Transaction-mode pooling is unsafe: credential refresh and Content Hub use session-level advisory locks (`pg_advisory_lock`) | Managed PostgreSQL / pooler settings; env `DATABASE_POOL_MAX`, `WORKER_BULK_POOL_MAX` | `SELECT count(*) FROM pg_stat_activity;` at peak stays below `max_connections`; no `too many clients` errors in worker logs | Workload isolation without connection exhaustion |
| Memory/IO for the larger indexes (020, 021 GIN, 025 summary). The Large bench ran at 0.835 buffer hit ratio with default `shared_buffers` (128 MB) | DB instance class / parameters | Buffer hit ratio and p95 on `/api/ops/workload` after a week | Server budgets at scale |
| Maintenance window for migrations 020–025 (indexes are built without `CONCURRENTLY`, which blocks writes on large tables) | Change calendar | Migration finishes; `schema_migrations` lists 020, 021, 022, 025 | Upgrade |
| Re-run the V1-backup migration rehearsal on a disposable copy with 001–025 (`./scripts/migration-rehearsal.sh`) | Ops host with a recent backup | All checks PASS | Confidence in the upgrade |

## 2. Rolling deploys

| What | Where | How to verify | Unlocks |
|---|---|---|---|
| Give every web/worker image a distinct `APP_VERSION` (build tag) | Build pipeline → env | `SELECT worker_id, version FROM worker_heartbeats` shows the tag, not `dev` | Dispatch-version guard |
| Adopt the pin procedure (`system_flags.dispatch_version`) in the deploy runbook. For the V3 → V3.1 step, stop all V3 workers first, because they ignore the pin | Deploy runbook | During a test deploy, only the pinned version's workers write `delivery_attempts` | No two schedulers dispatching |

## 3. Real-user performance and monitoring

| What | Where | How to verify | Unlocks |
|---|---|---|---|
| Choose a real-user Web Vitals collector (LCP, INP, CLS per route, p75) and its endpoint/retention. The app has **no collection code yet** (gap G2); engineering adds it once the endpoint is chosen. Must not send content or identifiers beyond the route | Monitoring/analytics vendor or self-hosted endpoint; CSP `connect-src` | Field p75 per route after a week of traffic | §3 field targets (lab results are provisional) |
| Error reporting / APM sink for web and worker structured logs | Logging platform | A forced test error appears with its correlation id and no secrets | §16 structured error reporting |
| Optional: a throttled lab series (`node scripts/v31-browser-perf.mjs --cpu 4`) on a representative machine | Ops | JSON in `evidence/v3-1/perf/` | Realistic lab numbers |

## 4. Feature-flag rollout plan

Six V3.1 features ship **off**:

| Flag | Feature |
|---|---|
| `v31.onboarding_checklist` | Onboarding checklist |
| `v31.content_queue` | Content queue |
| `v31.tracked_links` | Tracked links |
| `v31.brand_rules` | Brand rules editor |
| `v31.integration_diagnostics` | Integration diagnostics |
| `v31.release_notes` | Release notes |

The flags hide screens only; the APIs work regardless (gap G6).

| What | Where | How to verify | Unlocks |
|---|---|---|---|
| Decide the order and audience: for example internal workspace → named pilot workspaces → percentage rollout → all | Product owner | Decision recorded | Controlled release |
| Per workspace: **Settings → Operations → Feature flags** (needs `workspace.manage`, audited). Installation-wide: `UPDATE feature_flags SET rollout_percent=<n>` / `killed=true` (SQL only, gap G13) | App / migrator role | `GET /api/feature-flags` in a pilot workspace shows `source: workspace_override` or `rollout` | Feature visibility |
| Kill switch drill: set `killed=true` on one flag in staging | Staging DB | The screen disappears for every workspace on the next load | Fast rollback |
| Tracked links: confirm the public short-link host (`<APP_BASE_URL>/api/l/<code>`) is reachable and on the brand's approved link domains | Domain/proxy; brand rules | A short link redirects (302) to its stored destination; an unknown code returns 404 | Campaign links |

## 5. Content and policy decisions

| What | Where | How to verify | Unlocks |
|---|---|---|---|
| Draft local-recovery policy per workspace (`persistent` / `session` / `off`, max age, clear on sign-out), especially for shared devices | **Settings → Workspace → Draft recovery** | `GET /api/session` → `draft_recovery` shows the choice | Data-protection posture |
| Trash retention (30 days, `TRASH_RETENTION_DAYS`) accepted by the data owner | Policy decision | Recorded | Purge job behaviour |
| Brand rules and approved link domains for real brands (mandatory vs advisory) | **Settings → Publishing → Brand rules** (after enabling the flag) | `POST /api/posts/:id/brand-check` on a sample draft shows the expected findings | Brand safeguards |
| Website-analytics integration and conversion model: currently "Not connected" / "Unavailable" by design | Product decision | – | Website events / conversions (not built) |
| Help Centre content for Cmd+K help search | Docs + Help Centre task | – | Help-article search |

## 6. Carried over

Provider apps, Google/Notion, MCP over public HTTPS, Keycloak, the production domain and TLS are unchanged: see the V3 checklist. Also still needed: the designer's master SVG logo.
