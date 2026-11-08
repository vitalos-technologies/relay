# V3.1 Admin — progress (resume point)

Brief: `docs/queue/03c_V3_1_ADMIN_PROMPT.md`. Migration: `packages/db/migrations/026_v31_admin.sql` (additive). No git.
Checkpoints → `evidence/v3-1/admin/checkpoints/<n>-<area>-<theme>.png` (1440, DSF 2).

## Design (decided)
- Admin app at `/admin/**` (route group `app/(admin)`), own shell: left sidebar with collapsible groups, scope switch
  Workspace ↔ Platform, breadcrumbs, nav filter, mobile drawer. Reuses `components/ui`, settings registry sections,
  existing APIs/services (no second authorization layer).
- Workspace scope = V2 `authorize()` via `route()`; nav hides what the session can't use; server enforces.
- Platform scope = `platform_operators` (026) checked from the DB on every request by `platformRoute()`.
  Operators see aggregates/metadata only (no post text, media, documents, credentials). Bootstrap by CLI
  (`scripts/platform-operator.ts`); dev/E2E seed grants owner@demo.
- Support access = request (operator, reason, duration) → workspace owner/admin approves (step-up) → time-boxed
  `viewer` grant through the normal grants table (expires_at) + membership; ended by either side or expiry; audited in
  both audits; banner in the main app while active.
- Sync = `/api/admin/changes` state markers (policy version, deliveries, posts, approvals, connections, audit, jobs);
  UI polls 10 s while visible, backoff to 60 s on errors, refetches only changed topics; every view also refetches on
  focus and after its own mutations.

## Status
- 2026-11-07: started; inventory done.
- Migration 026 APPLIED to dev (frozen; further schema → 027). db:roles re-applied. owner@demo seeded as platform operator (seed-e2e).
- Backend done: services/admin/{platform,support-access,overview,publishing,changes,reads}.ts; routes /api/admin/**, /api/platform/**;
  platformRoute() in apps/web/lib/api.ts; engine gate holds suspended workspaces (engine/process.ts) — WORKER NEEDS REBUILD.
- UI done (dev server): admin shell + all pages listed under Files. Next: review shots, tests, docs, perf, prod E2E.
- Fixed pre-existing: /api/ops/workload 500 under least-privilege web role (pgboss not readable) → guarded.

## Done
- Shell/nav/scope + Overview: `evidence/v3-1/admin/checkpoints/1-overview-light.png`, `1-nav-drawer-light.png`, `1-jump-light.png`
- People (Team pages mounted in admin, links stay in admin): `2-people-light.png`, `2-member-light.png`
- Publishing ops (deliveries list + drawer + recovery) + approvals: `3-publishing-light.png`, `3-publishing-attention-light.png`, `3-approvals-light.png`
- Connections (inventory + health + fix + diagnostics): `4-connections-light.png`, `4-connection-drawer-light.png`
- Content jobs/storage + analytics ingestion: `5-content-light.png`, `5-analytics-light.png`
- Developer (webhooks, MCP): `6-developer-webhooks-light.png`, `6-mcp-light.png`
- Security (audit, support access): `7-audit-light.png`, `7-support-light.png`
- Operations, usage, settings: `8-operations-light.png`, `8-usage-light.png`, `8-settings-light.png`
- Platform: `9-platform-light.png`, `9-platform-workspaces-light.png` (dark set + rest retaken on the production build)
- Tests: tests/integration/v31-admin.test.ts (23), v31-admin-mcp.test.ts (3), tests/unit/v31-admin.test.ts (5), tests/e2e/admin.spec.ts (5) — all pass on dev.
- Docs: docs/admin/{INTEGRATION_MATRIX,PERMISSIONS_MATRIX,SYNC_AND_EVENT_MODEL,ADMIN_USER_GUIDE,WORKSPACE_ADMIN_GUIDE,PLATFORM_OPERATOR_GUIDE,OPERATIONS_RUNBOOK,IMPLEMENTATION_GAPS,FINAL_ACTIVATION_CHECKLIST}.md

- Production build (final, 2026-11-07 ~18:45): checkpoints 1–11 light+dark retaken (`evidence/v3-1/admin/checkpoints/*`), full set
  `evidence/v3-1/admin/<screen>-{1440,390}-{light,dark}.png` (108), mobile QA 0 overflow / 10 of 10 workflows (`evidence/v3-1/admin/mobile-qa.json`),
  perf `evidence/v3-1/perf/admin-after.json` (all within budget). Integration 400/401 under load (analytics-summary timing; passes alone).
- Docs: all 12 docs/admin/*.md written.

- FINAL (2026-11-07 ~19:20, production build, worker rebuilt): root + web tsc clean; pnpm test 495/495; integration 401/401 (one
  timing-sensitive analytics-summary test failed once under heavy load, passes alone); full E2E 51/51 (admin 6, publishing 26, security 8,
  v2-product 5, v31-ui 6). Fixed pre-existing: simulated destinations renamed by the 6-hourly health check (broke publishing.spec after 6 h).

## Status: done (report sent to lead)

## Next
- Production build → checkpoints dark + 390 set (scripts/admin-shots.mjs), mobile QA (scripts/admin-mobile-qa.mjs), perf (scripts/admin-perf.mjs),
  full E2E (all specs, per-file results for the lead), then MOBILE_QA_REPORT / PERFORMANCE_REPORT / TEST_REPORT.
- Worker already rebuilt + restarted (17:42) with the worker DB role.

## Files
- new: packages/db/migrations/026_v31_admin.sql, packages/core/src/contracts/v31-admin.ts, packages/services/src/admin/*,
  apps/web/app/api/admin/**, apps/web/app/api/platform/**, apps/web/app/(admin)/admin/** (layout + pages), apps/web/components/admin/*,
  scripts/platform-operator.ts, scripts/admin-shots.mjs
- edited: infra/postgres/roles.sql (append-only platform audit), apps/web/lib/api.ts (platformRoute, queryOf), apps/web/lib/client/{types,hooks}.ts,
  services/workspaces.ts (session platform_role + support_access), services/engine/process.ts (suspension gate), services/product/activity.ts (categories),
  services/workload/stats.ts (pgboss guard), team pages + components/team/shared.tsx (useTeamHref), approvals pages + diagnostics page (useAreaHref),
  scripts/seed-e2e.ts, package.json (platform:operator)
