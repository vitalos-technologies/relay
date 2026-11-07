# V3.1 implementation gaps

Unfinished engineering and verification, as of 2026-11-07 (`main` @ b7bf474). Matrix rows: [V3_1_REQUIREMENTS_MATRIX.md](V3_1_REQUIREMENTS_MATRIX.md). External items: [V3_1_FINAL_ACTIVATION_CHECKLIST.md](V3_1_FINAL_ACTIVATION_CHECKLIST.md). Open V3 gaps still apply: [V3_IMPLEMENTATION_GAPS.md](V3_IMPLEMENTATION_GAPS.md).

## Closed during V3.1 integration (lead)

| Was | Fix |
|---|---|
| `reschedule()` (single + bulk) skipped mandatory brand rules | Checks rules and asset expiry against the moved revision at the new time (89286a7; `v31-brand-rule-hold`) |
| Bulk reschedule preview said only `not_scheduled` | Specific reasons: published, cancelled, finished, never scheduled (89286a7) |
| Onboarding linked to `/posts` and legacy `?tab=` URLs | Links to the redesigned Settings pages (89286a7) |
| A mandatory rule added after scheduling did not stop dispatch | Engine hold `brand_rule_review` (46d6313) |
| Flaky V3 `engine-handoff` test | Claims and reconciles only its own delivery (b97a9d2) |

## 1. Performance

| # | Gap | Detail | Matrix |
|---|---|---|---|
| G1 | Shared browser baseline ~230 KB per route | The `@social-lite/core` barrel brings zod and every schema into client bundles. Fix options: `"sideEffects": false` in `packages/core/package.json` (not set), or client-only subpath exports | 4.2 |
| G2 | No throttled runs and no real-user Web Vitals | Browser numbers are lab-only: localhost, no CPU/network throttling, n = 10. The harness supports `--cpu 4`, but no series was run. There is no Web Vitals collection code (`useReportWebVitals` is unused) and no endpoint | 3.1–3.4, 3.11 |
| G7 | Planner payload over budget | All brands at Medium/Large: ~700–800 KB vs the 300 KB budget; Medium planner-week p95 also over. Needs compact fields or a default brand/week scope at scale | 3.10, 5.4 |
| G10 | End-to-end browser timings missing | Draft save ack, search results, analytics filter change and bulk job ack are timed server-side only. No composer typing test under slow requests | 2.4, 3.6–3.9, 18.2 |
| G11 | Frontend items not built | No list virtualization (pagination and caps only); default Next.js prefetch with no Save-Data / slow-connection check; no general request dedupe (only stale-response dropping and Cmd+K abort) | 4.3–4.5 |
| G12 | Analytics 365 days at Large | p95 1,538 ms vs a 1,600 ms budget. The remaining cost is the per-post state scan and per-day health in Node | 5.3 |

## 2. Data, trash, search

| # | Gap | Detail | Matrix |
|---|---|---|---|
| G4 | Purged asset objects can be orphaned | Storage objects are deleted after the row commits. A failed delete is only logged (`trash_purge_object_delete_failed`), with no retry table | 10.2 |
| G5 | Help-article search | Cmd+K has no help articles: there is no help content yet (Docs + Help Centre task) | 8.2 |
| G8 | Trashed drafts still counted in places | Analytics workflow counts (`analytics/query.ts` has no `deleted_at` filter) and the client handover export include trashed drafts. Read-only, low impact | – |
| G9 | Bulk duplicate after crash + edit | If the source post changes between a crash and the re-run, that item fails with `idempotency_conflict` on every retry. Workaround: start a new duplicate job | 11.3 |

## 3. Governance, release and support

| # | Gap | Detail | Matrix |
|---|---|---|---|
| G3 | Support redaction rules duplicated | `services/gov/release.ts` `REDACTIONS` / `redactText` / `safeRoute` are copied into the client preview (`components/support/support.tsx`) instead of shared from `packages/core`. The server redaction is authoritative, but the preview can drift | 16.6 |
| G6 | Flags gate the UI only | `isFeatureEnabled()` has no server caller. The APIs behind the six `v31.*` flags (queue, links, brand-rules editor, diagnostics, onboarding, release notes) work with the flag off. A flag is not a server-side kill switch | 16.1 |
| G13 | Rollout % has no operator UI or API | Installation rows (`feature_flags.rollout_percent`, `killed`) are changed by SQL only. Workspace overrides have UI | 16.1 |
| G14 | Migration and app-rollback rehearsal | `scripts/migration-rehearsal.sh` (V1 backup → all migrations) last ran before 020–025. No application-rollback or mixed-version rehearsal | 16.2, 18.13 |
| G15 | `APP_VERSION` defaults to `dev` | The dispatch-version guard only separates builds that set distinct versions. Images do not set one automatically | 16.3 |
| G16 | No external error/APM sink | Structured logs, `/api/ops/workload` and the health centre only | 16.5 |

## 4. Verification and polish

| # | Gap | Detail |
|---|---|---|
| G17 | E2E not re-run after 89286a7 | 45/45 ran at 16:46. The reschedule/bulk/onboarding service changes are covered by unit + integration only |
| G18 | Browser-untested behaviours | Offline mode blocking Schedule/Publish; Cmd+K cache dropped on workspace switch; draft recovery cleared on sign-out |
| G19 | Lint | react-hooks compiler rule errors in old and new files; lint is not in the gate (V2 G18) |
| G20 | Branding leftover | Demo seed image text "Social Lite sample asset" (`scripts/seed-agency.ts`) |
| G21 | User/help docs | Not updated for V3.1 (queued as the final Docs + Help Centre task) |
| G22 | Live verification | None; all provider/Google/Notion paths are simulated (V3 gaps §0) |
