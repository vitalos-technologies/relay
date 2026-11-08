# Stream D — Product & fairness (progress)

Owner files: `packages/db/migrations/013_v2_product.sql`, `packages/services/src/product/**`, web `app/(app)/{health,activity}`, `components/product/**`, API under `/api/product/**`-ish routes, tests `tests/integration/v2-product*.test.ts`.

## Milestones
- [x] 0. Read contracts/spec (done 2026-11-07)
- [x] 1. Migration 013 (written; NOT yet applied to dev DB — checksum: apply only when final)
- [x] 2. Budgets/reservations service `product/budgets.ts` (+ engine/budget.ts, ai/usage.ts, integrations limits → product/usage-admin.ts)
- [x] 3. Fair claim `engine/fairness.ts` (claim.ts: candidate query → selectFairCandidate)
- [x] 4. Account health centre `product/health.ts`
- [x] 5. Readiness `product/readiness.ts` + `product/duplicates.ts`
- [x] 6. Activity centre + export `product/activity.ts`
- [x] 7. Client handover export `product/handover.ts` (+ zip.ts)
- [x] 8. API routes: /api/accounts/health, /api/posts/[id]/readiness, /api/brands/[id]/duplicate-window, /api/activity, /api/activity/export, /api/brands/[id]/handover-export, /api/workspace/limits/teams/[teamId]
- [x] 9. UI: app/(app)/accounts/health, app/(app)/activity, components/product/{readiness-panel,brand-product-settings,download}, budgets-settings teams; composer action-dialogs gate; shell ADMIN_NAV Activity; accounts header Health link; settings BrandTab
- [x] 10. tsc root+web clean; pnpm test 418/418; test:integration 237/239 (2 failures in setup.test.ts = OIDC issuer still /dex — stream A, not D); v2-product 17/17; unit v2-product 19/19
- [x] 11. Load test fairness → evidence/v2/fairness.json (scripts/load-test.ts --fairness → scripts/load-test-fairness.ts; B p95 6.5 s → 0.9 s)
- [x] 12. Screenshots evidence/v2/product-{health,readiness,activity,budgets,handover,health-viewer-mobile}.png via tests/e2e/v2-product.spec.ts (5/5 green on private prod build :3100, DB socialite_stream_d, copy in .data/webd)

## Notes
- Shared-file edits so far: engine/claim.ts (candidate query), engine/process.ts (budget attribution arg), ai/service.ts (reserveTokens userId), readmodels.ts (ops usage team_id IS NULL), integrations/index.ts (limits section re-exported from product/usage-admin.ts).
- Tests: `tests/integration/v2-product.test.ts` (17) green 2026-11-07. Storage hooks in media/assets.ts + media/video-worker.ts (reserve at intent, settle/release on ready/reject).
- Screenshot env: private copy `.data/webd` (prod build, next.config copy has ignoreBuildErrors) on :3100 against `socialite_stream_d` (all migrations + seed + scratch seed-d). Never touch :3000/:3001 or socialite_dev.
- DONE 2026-11-07. Private :3100 server stopped (restart: build .data/webd with next build --webpack, then next start --port 3100 with DATABASE_URL=.../socialite_stream_d APP_BASE_URL=http://localhost:3100).
