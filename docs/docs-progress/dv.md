# DV — Developer, API, MCP reference and runbooks (progress)

Status: **done, ready for lead review** (resume point). Stream DV, queue item 9. Brief §7, §8 and the §10 setup
verification. Last update 2026-11-09.

## Delivered

| Deliverable | Files | Kind |
|---|---|---|
| API/MCP reference generator + staleness check | `scripts/docs-api-check.mjs` | new script |
| Generated route reference (member-facing; platform routes excluded) | `content/help/developers/api-route-reference.md` | **generated** |
| Generated MCP reference (tools, scopes, resources, prompts, errors) | `content/help/developers/mcp-tool-reference.md` | **generated** |
| OpenAPI 3.1 (all 671 handlers incl. platform; zod schemas quoted as source excerpts) | `docs/api/openapi.json` | **generated**, repo only |
| Full route table with body/query schema excerpts, incl. platform routes | `docs/api/routes.md` | **generated**, repo only |
| MCP snapshot (tools with JSON Schemas, annotations, scopes) | `docs/api/mcp.json` | **generated**, repo only |
| Developer articles (written from code) | `content/help/developers/`: `architecture-and-modules`, `local-development-setup`, `environment-variables`, `data-model-and-migrations`, `authentication-and-authorization`, `api-conventions`, `mcp-server`, `mcp-worked-examples`, `provider-adapters`, `publishing-engine-and-delivery-states`, `background-jobs-and-media`, `webhooks`, `analytics-ingestion`, `content-source-imports-and-exports`, `testing-and-contributing` | 15 written |
| Runbooks (repo only, never served) | `docs/runbooks/README.md` + 19 runbooks | written |

Counts: **541 route files / 671 handlers** (610 member-visible incl. 26 public, 2 API-key, 10 widget, 4 MCP bearer; 61
platform-operator handlers kept out of the Help Centre), **47 MCP tools, 3 resource templates, 1 static resource,
2 prompts**, **124 environment variables** read by code (92 not in `.env.example`), **17 developer articles**,
**19 runbooks + index**. Route counts move while HC adds routes — rerun `--write` before committing (see CI below).

No product code or shared files were edited. No git state changes. The shared servers on :3000/:3001 were not touched
(no lock needed: my clean instance ran on :3100/:3101 with its own database and bucket, now removed).

## How the generator works (for the lead / HC)

- Routes: static scan of every `apps/web/app/**/route.ts` — path from folders, methods from exported handlers, access
  model from the wrapper (`route` / `route(…, { workspace: false })` / `platformRoute` / `publicRoute` / `widgetRoute`
  / `machineRoute` / custom), header comment, zod schema passed to `parseJson`/`.parse(queryOf(req))` (local source
  quoted, imported ones by module path), `Idempotency-Key` reads.
- MCP: instantiates the real server (`createMcpServer()`) via `tsx`'s `tsImport`, connects the official SDK client over
  an in-memory transport and records `tools/list`, `resources/templates/list`, `prompts/list` (exactly what clients
  see), plus scopes/annotations from `packages/core/src/contracts/mcp.ts`. Fails if `MCP_TOOLS` lists an unregistered tool.
- Environment: every `process.env.X` / `env.X` / `env['X']` read (plus helper-argument reads in files with dynamic
  access, config.ts schema keys and setup-page keys) in `apps/web`, `apps/worker/src`, `packages/*/src` must be
  mentioned in `content/help/developers/environment-variables.md`.
- Generated articles keep their `reviewed:` date while content is unchanged; the check ignores that line. No network,
  database or env vars needed; runs in ~2 s.

### CI wiring (please add — HC owns `.github/workflows/ci.yml`)

Add to the `verify` job after `pnpm install --frozen-lockfile` (next to the docs check):

```yaml
      - name: API/MCP reference and environment docs are current
        run: node scripts/docs-api-check.mjs
```

On failure the message names the stale file and says to run `node scripts/docs-api-check.mjs --write`. **Lead: run
`--write` once more right before committing**, because HC/UG/IG streams were still adding routes during this run.

## Clean-environment setup verification (2026-11-09, 10:27–10:37 UTC)

Copy of the working tree (tracked + untracked, no `node_modules`, no `.env`) into the DV scratch directory; separate
database `relay_docs_dv` on the running Postgres and bucket `relay-docs-dv`; fresh `SESSION_SECRET` and KEK generated
as documented; role passwords reused from the shared `.env` so `db:roles` did not change anything shared.

| Step | Result |
|---|---|
| `pnpm install --frozen-lockfile` | 606 packages, 4 s (warm local store); ignored build script `core-js` |
| `CREATE DATABASE` (admin URL) → `pnpm db:roles` → `pnpm db:migrate` → `pnpm db:roles` | 34 migrations applied in 2.7 s (001–038; 018/023/024/033 unused) |
| `pnpm db:seed`, `pnpm db:seed:e2e` | OK (4.4 s, 1.4 s); bucket created |
| `node build.mjs` + worker on :3101 | `/health` ok, `/ready` ok, 16 simulated deliveries processed, 0 warnings/errors |
| `next dev --webpack --port 3100` | `/api/ready` → ready, 34 applied |
| HTTP OIDC sign-in (editor@demo, Keycloak code+PKCE) | landed on `/overview`; `/api/session` OK with CSRF token |
| API probes | 422 validation envelope with `fieldErrors`, 422 invalid JSON, 403 `csrf_failed` (no token / foreign Origin), 409 `workspace_changed`, 401 signed out, 401 API key missing, 404 not_found, keyset page `{items, next_cursor}` — all with `x-correlation-id` |
| MCP (official SDK 1.32.2 client, Streamable HTTP, service-account key) | initialize at 2025-11-25, 47 tools, resources/list, create_draft idempotent replay + `idempotency_conflict`, scope/role denials, `unsupported_principal` for publishing via API key, revocation → next call 401 with `WWW-Authenticate` |
| Worker SIGTERM | drained cleanly |
| `pnpm test` (clean copy) | 46 files / 630 tests passed, 15 s |
| MCP integration suites (clean copy, disposable DBs) | `mcp.test.ts` 21/21; `v31-data-mcp`, `v31-admin-mcp`, `v31-gov`, `v35-final` 36/36 |
| Teardown | web + worker stopped, bucket (16 objects) removed, `relay_docs_dv` dropped; `socialite_dev` untouched |

Not verified: `next build`/production start, Docker images, real provider connections, OAuth MCP sign-in through
Keycloak with a real client (only the SDK/API-key path and the repository's JWT-override protocol tests), MCP Inspector
/ Claude Code / other clients, any production deployment step in the runbooks (Relay is not deployed).

## Coverage rows (lead: merge into `docs/help/COVERAGE_MATRIX.md`)

Columns: item → implementation → documentation → verification status.

### API routes by area (per-route rows: `docs/api/routes.md`, generated)

| Area (`/api/<area>`) | Route files | Handlers | Access models |
|---|---|---|---|
| .well-known | 2 | 2 | public |
| accounts | 1 | 1 | session |
| activity | 2 | 2 | session |
| admin | 21 | 22 | session |
| ai | 1 | 1 | session |
| analytics | 17 | 22 | session |
| approvals | 7 | 8 | session |
| assets | 5 | 7 | session |
| assistant | 21 | 26 | session |
| audit | 1 | 1 | session |
| auth | 5 | 5 | public, session_no_ws |
| automation | 11 | 17 | session |
| billing | 16 | 20 | session, public, session_no_ws |
| brand-rules | 1 | 2 | session |
| brands | 26 | 39 | session |
| bulk | 6 | 7 | session |
| campaigns | 2 | 2 | session |
| collab | 2 | 2 | session |
| collaboration | 1 | 2 | session |
| comments | 2 | 3 | session |
| connection-flows | 2 | 2 | session |
| connections | 5 | 5 | session |
| connectors | 51 | 64 | session, public |
| content-hub | 28 | 30 | session, public |
| content-queue | 1 | 1 | session |
| dashboard | 1 | 1 | session |
| deliveries | 2 | 2 | session |
| diagnostics | 1 | 1 | session |
| entitlements | 2 | 3 | session |
| feature-flags | 2 | 2 | session |
| grants | 1 | 1 | session |
| health | 1 | 1 | public |
| help | 2 | 2 | session_no_ws, public |
| history | 2 | 2 | session |
| inbox | 42 | 54 | session, public |
| integrations | 3 | 5 | session, public |
| invitations | 6 | 7 | session, session_no_ws, public |
| l | 1 | 1 | public |
| links | 3 | 4 | session |
| listening | 21 | 30 | session |
| mcp | 12 | 16 | session, mcp |
| members | 11 | 15 | session |
| meta | 3 | 3 | public |
| notification-preferences | 1 | 2 | session |
| notifications | 5 | 5 | session |
| oauth | 1 | 1 | public |
| onboarding | 1 | 2 | session |
| ops | 2 | 2 | session |
| planner | 1 | 1 | session |
| platform | 53 | 62 | platform, session_no_ws |
| posts | 31 | 38 | session |
| providers | 1 | 1 | session |
| publication-holds | 1 | 1 | session |
| queue | 1 | 2 | session |
| ready | 1 | 1 | public |
| release-notes | 1 | 2 | session |
| restrictions | 1 | 1 | session |
| review | 6 | 6 | session |
| rule-reviews | 1 | 1 | session |
| schedules | 3 | 3 | session |
| search | 2 | 3 | session |
| security | 4 | 4 | session_no_ws |
| service-accounts | 5 | 6 | session |
| session | 2 | 2 | session_no_ws |
| setup | 2 | 2 | session |
| slots | 1 | 2 | session |
| support | 15 | 18 | session |
| tasks | 5 | 8 | session |
| teams | 8 | 11 | session |
| templates | 1 | 2 | session |
| threads | 2 | 3 | session |
| trash | 4 | 4 | session |
| v1 | 2 | 2 | api_key |
| webhooks | 4 | 5 | public |
| widget | 10 | 10 | widget |
| workspace | 9 | 14 | session |
| workspaces | 1 | 1 | session_no_ws |

All rows: implementation `apps/web/app/api/<area>/**/route.ts` → doc `content/help/developers/api-route-reference.md`
(platform rows: `docs/api/routes.md` only) + `api-conventions` → status **generated from code, check passes**;
live-verified on the clean instance: auth (login/callback/session), CSRF/origin/workspace guards, error envelope,
`/api/brands`, `/api/notifications` pagination, `/api/v1/me` (401 path), `/mcp`, `/.well-known/oauth-protected-resource/mcp`,
`/api/health`, `/api/ready`.

### MCP tools

| Item | Implementation | Doc | Verification |
|---|---|---|---|
| MCP tool `list_workspaces` | `packages/services/src/mcp/tools.ts` | mcp-tool-reference (generated), mcp-server, mcp-worked-examples | integration-tested (mcp, v31-admin-mcp, v31-data-mcp, v31-gov, v35-final, v4-entitlements-workers); live 2026-11-09: ok |
| MCP tool `list_brands` | `packages/services/src/mcp/tools.ts` | mcp-tool-reference (generated), mcp-server, mcp-worked-examples | integration-tested (mcp); live 2026-11-09: ok |
| MCP tool `list_connections` | `packages/services/src/mcp/tools.ts` | mcp-tool-reference (generated), mcp-server | integration-tested (mcp); live 2026-11-09: ok (editor key) |
| MCP tool `get_capabilities` | `packages/services/src/mcp/tools.ts` | mcp-tool-reference (generated), mcp-server | integration-tested (mcp) |
| MCP tool `search_content` | `packages/services/src/mcp/tools.ts` | mcp-tool-reference (generated), mcp-server, mcp-worked-examples | integration-tested (mcp); live 2026-11-09: ok (editor key) / forbidden (integration key) |
| MCP tool `get_post` | `packages/services/src/mcp/tools.ts` | mcp-tool-reference (generated), mcp-server, mcp-worked-examples | integration-tested (mcp); live 2026-11-09: forbidden (integration key) — authz path |
| MCP tool `list_calendar` | `packages/services/src/mcp/tools.ts` | mcp-tool-reference (generated), mcp-server | integration-tested (mcp) |
| MCP tool `create_draft` | `packages/services/src/mcp/tools.ts` | mcp-tool-reference (generated), mcp-server | integration-tested (mcp, v31-admin-mcp, v31-gov, v4-entitlements); live 2026-11-09: ok + idempotent replay + idempotency_conflict (integration key); unsupported_principal with connection_ids (API key rule) |
| MCP tool `update_draft` | `packages/services/src/mcp/tools.ts` | mcp-tool-reference (generated), mcp-server | integration-tested (mcp) |
| MCP tool `list_sources` | `packages/services/src/mcp/tools.ts` | mcp-tool-reference (generated), mcp-server | integration-tested (mcp) |
| MCP tool `preview_source` | `packages/services/src/mcp/tools.ts` | mcp-tool-reference (generated), mcp-server | integration-tested (mcp) |
| MCP tool `import_source_to_draft` | `packages/services/src/mcp/tools.ts` | mcp-tool-reference (generated), mcp-server | integration-tested (mcp) |
| MCP tool `get_import_status` | `packages/services/src/mcp/tools.ts` | mcp-tool-reference (generated), mcp-server | integration-tested (mcp) |
| MCP tool `validate_post` | `packages/services/src/mcp/tools.ts` | mcp-tool-reference (generated), mcp-server, mcp-worked-examples | integration-tested (mcp); live 2026-11-09: forbidden (integration key) — authz path |
| MCP tool `submit_for_review` | `packages/services/src/mcp/tools.ts` | mcp-tool-reference (generated), mcp-server, mcp-worked-examples | integration-tested (mcp) |
| MCP tool `get_review_status` | `packages/services/src/mcp/tools.ts` | mcp-tool-reference (generated), mcp-server, mcp-worked-examples | integration-tested (mcp) |
| MCP tool `prepare_publication` | `packages/services/src/mcp/tools.ts` | mcp-tool-reference (generated), mcp-server, mcp-worked-examples | integration-tested (mcp); live 2026-11-09: unsupported_principal (API key) — authz path |
| MCP tool `commit_publication` | `packages/services/src/mcp/tools.ts` | mcp-tool-reference (generated), mcp-server, mcp-worked-examples | integration-tested (mcp) |
| MCP tool `get_delivery_status` | `packages/services/src/mcp/tools.ts` | mcp-tool-reference (generated), mcp-server, mcp-worked-examples | integration-tested (mcp) |
| MCP tool `cancel_schedule` | `packages/services/src/mcp/tools.ts` | mcp-tool-reference (generated), mcp-server, mcp-worked-examples | integration-tested (mcp) |
| MCP tool `pause_brand` | `packages/services/src/mcp/tools.ts` | mcp-tool-reference (generated), mcp-server | integration-tested (mcp) |
| MCP tool `analytics_overview` | `packages/services/src/mcp/tools.ts` | mcp-tool-reference (generated), mcp-server, mcp-worked-examples | integration-tested (mcp); live 2026-11-09: forbidden (editor key) — authz path |
| MCP tool `query_analytics` | `packages/services/src/mcp/tools.ts` | mcp-tool-reference (generated), mcp-server, mcp-worked-examples | no test reference found; live 2026-11-09: forbidden (editor key has no analytics.read) — authz path |
| MCP tool `get_metric_definitions` | `packages/services/src/mcp/tools.ts` | mcp-tool-reference (generated), mcp-server, mcp-worked-examples | no test reference found; live 2026-11-09: ok |
| MCP tool `get_data_coverage` | `packages/services/src/mcp/tools.ts` | mcp-tool-reference (generated), mcp-server, mcp-worked-examples | no test reference found; live 2026-11-09: ok (no live destinations) |
| MCP tool `create_report_export` | `packages/services/src/mcp/tools.ts` | mcp-tool-reference (generated), mcp-server | integration-tested (mcp) |
| MCP tool `get_job_status` | `packages/services/src/mcp/tools.ts` | mcp-tool-reference (generated), mcp-server | integration-tested (mcp) |
| MCP tool `search` | `packages/services/src/mcp/tools-data.ts` | mcp-tool-reference (generated), mcp-server | integration-tested (v31-data-mcp) |
| MCP tool `get_draft_recovery_status` | `packages/services/src/mcp/tools-data.ts` | mcp-tool-reference (generated), mcp-server | integration-tested (v31-data-mcp) |
| MCP tool `preview_bulk_action` | `packages/services/src/mcp/tools-data.ts` | mcp-tool-reference (generated), mcp-server | integration-tested (v31-data-mcp) |
| MCP tool `get_bulk_job_status` | `packages/services/src/mcp/tools-data.ts` | mcp-tool-reference (generated), mcp-server | integration-tested (v31-data-mcp) |
| MCP tool `get_brand_rules` | `packages/services/src/mcp/tools-gov.ts` | mcp-tool-reference (generated), mcp-server | integration-tested (v31-gov) |
| MCP tool `get_integration_diagnostics` | `packages/services/src/mcp/tools-gov.ts` | mcp-tool-reference (generated), mcp-server | integration-tested (v31-gov) |
| MCP tool `list_conversations` | `packages/services/src/mcp/tools-v35.ts` | mcp-tool-reference (generated), mcp-server | integration-tested (v35-final); live 2026-11-09: forbidden (no inbox.read) — authz path |
| MCP tool `get_conversation` | `packages/services/src/mcp/tools-v35.ts` | mcp-tool-reference (generated), mcp-server | integration-tested (v35-final) |
| MCP tool `draft_reply` | `packages/services/src/mcp/tools-v35.ts` | mcp-tool-reference (generated), mcp-server | integration-tested (v35-final, v4-support) |
| MCP tool `assign_conversation` | `packages/services/src/mcp/tools-v35.ts` | mcp-tool-reference (generated), mcp-server | integration-tested (v35-final) |
| MCP tool `list_cases` | `packages/services/src/mcp/tools-v35.ts` | mcp-tool-reference (generated), mcp-server | no test reference found |
| MCP tool `get_case` | `packages/services/src/mcp/tools-v35.ts` | mcp-tool-reference (generated), mcp-server | no test reference found |
| MCP tool `create_case` | `packages/services/src/mcp/tools-v35.ts` | mcp-tool-reference (generated), mcp-server | integration-tested (v35-final, v35-ai-automation) |
| MCP tool `update_case` | `packages/services/src/mcp/tools-v35.ts` | mcp-tool-reference (generated), mcp-server | integration-tested (v35-final) |
| MCP tool `list_listening_searches` | `packages/services/src/mcp/tools-v35.ts` | mcp-tool-reference (generated), mcp-server | integration-tested (v35-final) |
| MCP tool `query_listening` | `packages/services/src/mcp/tools-v35.ts` | mcp-tool-reference (generated), mcp-server | integration-tested (v35-final) |
| MCP tool `list_listening_alerts` | `packages/services/src/mcp/tools-v35.ts` | mcp-tool-reference (generated), mcp-server | integration-tested (v35-final) |
| MCP tool `get_listening_alert` | `packages/services/src/mcp/tools-v35.ts` | mcp-tool-reference (generated), mcp-server | no test reference found |
| MCP tool `prepare_with_ai` | `packages/services/src/mcp/tools-v35.ts` | mcp-tool-reference (generated), mcp-server | integration-tested (v35-final) |
| MCP tool `get_ai_result` | `packages/services/src/mcp/tools-v35.ts` | mcp-tool-reference (generated), mcp-server | no test reference found |
| MCP resources (`relay://mcp/scopes`, guidelines, capabilities, report) | `packages/services/src/mcp/resources.ts` | mcp-tool-reference, mcp-server | integration-tested (mcp); live: list + read guidelines (editor key) |
| MCP prompts (`plan_week`, `summarise_performance`) | `resources.ts` | mcp-tool-reference | listed (generator); integration-tested (mcp) |
| MCP auth: OAuth bearer, API keys, consent, revocation, PRM | `mcp/auth.ts`, `mcp/server.ts`, `mcp/registry.ts` | mcp-server | OAuth: integration-tested with JWT overrides only; API key + revocation + PRM + 401 challenge: live |

### Background processes

| Item | Implementation | Doc | Verification |
|---|---|---|---|
| Outbox → pg-boss dispatcher, dead letters | `services/src/engine/outbox-dispatcher.ts`, `apps/worker/src/main.ts` | background-jobs-and-media; runbook worker-and-queue-failures | code-read; worker ran clean on fresh DB |
| Claim loops, leases, fencing, sweeps, reconcile | `engine/claim.ts`, `engine/process.ts`, `engine/reconcile.ts` | publishing-engine-and-delivery-states; runbooks failed-and-ambiguous, container-restart | code-read; 16 simulated deliveries processed live (published + simulated failure) |
| Delivery state machine | `packages/core/src/state-machine.ts` | publishing-engine-and-delivery-states | transitions copied from code |
| Workload classes + pools | `services/src/workload/policy.ts` | background-jobs-and-media | code-read |
| Periodic loops (heartbeat … retention) | `apps/worker/src/main.ts` | background-jobs-and-media | code-read; `/ready` lastRun observed live |
| Media image/video pipeline | `services/src/media/*` | background-jobs-and-media; runbook media-processing-failures | code-read (seed upload passed live) |
| Analytics sync/ingest/rollups/retention | `services/src/analytics/*` | analytics-ingestion; runbook source-sync-failures | code-read; `analytics_sync_run succeeded` observed live |
| Content Hub import/refresh/writeback/export | `services/src/content-hub/*` | content-source-imports-and-exports; runbook source-sync-failures | code-read; integration-tested (mcp import flow) |
| Webhooks (provider, connectors, Stripe, Notion, Drive, TipSignal, Meta callbacks) | `services/src/webhooks.ts`, `connectors/*`, `billing/webhooks.ts`, `content-hub/webhooks.ts` | webhooks; runbook billing-webhooks-and-reconciliation | code-read |
| Billing sweeps / reconciliation | `services/src/billing/reconcile.ts` | webhooks; runbook billing | code-read |
| Widget abuse controls | `services/src/support/widget*.ts` | webhooks (widget section); runbook support-widget-abuse | code-read |

### Configuration

| Item | Implementation | Doc | Verification |
|---|---|---|---|
| 124 env vars (core, DB, OIDC, storage/email, MCP, billing, tuning, provider apps) | `services/src/config.ts`, `settings.ts`, `mcp/config.ts`, `billing/provider.ts`, worker/engine/analytics modules | environment-variables (enforced by docs-api-check) | check passes; core set exercised by the clean setup |
| Production fail-closed rules | `config.ts assertProductionSafe` | environment-variables; runbook deployment | code-read (unit test `config.test.ts` exists) |
| Setup page (installation-wide, bootstrap owner or platform operator in production) | `services/src/setup.ts` | environment-variables; runbook deployment | code-read |

### Runbooks (all repo only)

deployment-and-configuration, health-and-monitoring, worker-and-queue-failures, expired-provider-auth,
rate-limits-and-budgets, failed-and-ambiguous-publications, media-processing-failures, source-sync-failures,
mcp-connection-and-auth-failures, emergency-pause, migration-and-rollback, backup-restore-and-reconciliation,
key-rotation-and-security-incidents, data-export-and-deletion, billing-webhooks-and-reconciliation,
support-widget-abuse, ai-budget-exhaustion, keycloak-and-self-registration, container-restart-recovery — each with
symptoms, diagnostics, corrective actions, verification, escalation; READ-ONLY / CHANGES DATA / DESTRUCTIVE flags;
placeholders only. Status: **written from code; not exercised against a production deployment** (none exists).

## Discrepancies and findings (not fixed — report only)

1. **17 route files have no header comment** (they show "(no description in code)" in the reference):
   `/api/approvals/{id}/approve`, `/api/approvals/{id}/reject`, `/api/dashboard`, `/api/deliveries/{id}/resolve`,
   `/api/deliveries/{id}/retry`, `/api/health`, `/api/history`, `/api/history/export.csv`,
   `/api/meta/data-deletion/status`, `/api/ops`, `/api/planner`, `/api/posts/{id}/archive`,
   `/api/posts/{id}/deliveries`, `/api/posts/{id}/duplicate`, `/api/posts/{id}/validate`,
   `/api/schedules/{id}/cancel`, `/api/schedules/{id}/reschedule`. Trivial to add; then rerun `--write`.
2. **92 env vars read by code are not in `.env.example`** (many by design: tuning, setup-page provider keys). Ones a
   production deployment is likely to need: `META_WEBHOOK_VERIFY_TOKEN`, `RELAY_STRIPE_SECRET_KEY`,
   `RELAY_STRIPE_WEBHOOK_SECRET(_PREVIOUS)`, `BILLING_LIVE_MODE`, `KMS_KEY_NAME`, `KMS_WRAPPED_KEKS`, `MCP_*`,
   `ALLOW_SELF_SERVE_WORKSPACES`, `S3_PUBLIC_ENDPOINT`, `APP_VERSION`, `WORKER_CONCURRENCY`, `WORKER_HEALTH_PORT`,
   `ANALYTICS_*_RETENTION_DAYS`. `.env.example` header still says "Social Lite configuration".
3. **`AI_MODEL` default in `packages/services/src/config.ts` is a model id** — conflicts with the "no model names in
   code" rule. Docs say "the model id pinned in config.ts" without naming it.
4. **MCP error contract incomplete:** `toToolError` can return `entitlement_required`, which is not in
   `MCP_ERROR_CODES` (`packages/core/src/contracts/mcp.ts`), so the generated error list omits it.
5. **MCP `resources/list` advertises the brand-guidelines resource to principals that cannot read it** (an
   `integration` API key gets it listed, then `resources/read` → -32002). Observed live.
6. **MCP `list_workspaces` for API keys reports all 13 scopes**, although effective power is limited by the service
   account's role (e.g. `integration` = drafts only). Misleading to clients; documented.
7. **Local Keycloak `relay-mcp` client only offers the 7 V3 scopes** — `inbox.*`, `cases.manage`, `listening.read`,
   `ai.prepare` cannot be requested by OAuth clients against the reference realm. Production IdP must define them
   (activation item).
8. **MCP protocol sessions are in-process memory** → more than one web replica needs sticky routing on
   `Mcp-Session-Id` (documented as a deployment requirement).
9. **No KEK re-wrap tool**: `crypto.ts` says "rewrap lazily"; old key ids must stay configured until every blob is
   rewritten. Runbook gives the read-only query to see which key ids are in use.
10. **No self-service account deletion, workspace deletion or personal-data export; no configurable inbox message
    retention** (the last is a known gap in `docs/v3-5/IMPLEMENTATION_GAPS.md`). Runbook documents the gap and requires
    an engineering-supported procedure.
11. **No installation-wide AI kill switch**; feature-flag kill switches cover only the six V3.1 flags. Removing the AI
    key is the only global off switch (documented).
12. **`/api/v1/drafts` has no idempotency** — a retried request can create a duplicate draft (documented in
    api-conventions; MCP `create_draft` is idempotent).
13. `security-policy.ts`: `LIMITS.step_up_seconds` is `[60, 3600]` but normalisation clamps to `[30, 3600]` — minor
    inconsistency.
14. `packages/core/src/authz.ts` header lists precedence restriction → assurance → grants, but `evaluate()` checks
    grants before assurance: same allow/deny outcome, but a user with neither grant nor MFA gets `no_grant` rather than
    `mfa_required`.
15. Stale older docs (inputs, not truth): `docs/ARCHITECTURE.md` says sessions idle out after 2 h (code: 30 min);
    `docs/DEPLOYMENT.md`/`OPERATIONS.md` predate V3–V5 (no MCP, billing, widget, workload classes). The new developer
    articles and runbooks supersede them; lead may want to point those files at the new docs.
16. Migration `034_v4_support.sql` comment says "No visitor flow exists yet" — stale since V5 widget (037).
17. E2E tests are not part of CI (documented in testing-and-contributing).
18. Contributor-level articles (local setup, data model, env reference) are `audience: developer`, i.e. visible to every
    signed-in member per the lead's schema. They contain no secrets or hostnames, but lead may prefer `admin` for
    `local-development-setup`, `environment-variables` and `data-model-and-migrations`.

## Activation items found

- Production IdP: MCP public client with the Relay MCP resource as audience and **all 13 MCP scopes**; redirect URIs
  for the MCP clients the customer wants (none are tested yet).
- Secret manager entries not in `.env.example` (item 2), notably `META_WEBHOOK_VERIFY_TOKEN`, Stripe, KMS, MCP overrides.
- Monitoring/alerting wiring (recommended alerts in `docs/runbooks/health-and-monitoring.md`); on-call contacts.
- Sticky routing for `/mcp` if more than one web replica.
- Data-protection procedures for erasure/export (item 10).

## Where each audience should start

- Integrators: `content/help/developers/api-conventions.md` → `mcp-server.md` → `mcp-worked-examples.md`.
- Contributors: `architecture-and-modules.md` → `local-development-setup.md` → `testing-and-contributing.md`.
- Operators: `docs/runbooks/README.md`.
