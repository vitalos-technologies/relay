# V5 stream AIW — AI workspace + agent-like execution (progress / resume point)

Owner: stream AIW. Migration: `038_v5_ai_runs.sql` (applied to dev under the lock — frozen). Contract: `packages/core/src/contracts/v5-ai.ts`.

## Status
- [x] Migration 038 (threads, workflow runs on `ai_runs`, steps, events, results, attachments, external action previews)
- [x] Contract v5-ai.ts (+ `EXTERNAL_ACTION_KINDS` added to v35-ai.ts)
- [x] Services `packages/services/src/ai-workflows/**`: engine, model (reuses V3.5 client/guard/budget), sources, runs/threads,
      context + suggestions, attachments, external actions (preview/confirm), admin; workflows: campaign, adaptation, inbox,
      performance, weekly planning, ask
- [x] Worker wiring: reuses `ai-assist` queue — `assistant/runs.ts executeRun` delegates workflow rows; `sweepRuns` includes
      workflow sweep (lost wake-ups, expired leases, timeouts); `purgeRunOutputs` purges workflow text after 30 days
- [x] API routes (`/api/assistant/{workspace,threads,workflows,attachments,actions/:id/preview,admin}`, `/api/platform/ai`)
- [x] Unit tests `tests/unit/v5-ai.test.ts` (9) · Integration `tests/integration/v5-ai-workflows.test.ts` (15) — passing
- [x] UI `/assistant` workspace (`apps/web/components/ai-workspace/**`): history sidebar (sheet on < lg), composer, suggestions,
      run cards (steps, events, needs-input, stop/retry), result cards, action review dialog, inline edit, compare
- [x] Admin pages (workspace `/admin/ai` AI workflows section + platform `/admin/platform/ai`, nav item)
- [x] 038 applied to dev; web + worker rebuilt (`NODE_OPTIONS=--max-old-space-size=6144` needed for `next build`)
- [x] E2E `tests/e2e/v5-ai.spec.ts` 8/8 (7 desktop + 1 @mobile) + `ai-automation.spec.ts` 3/3; screenshots in `evidence/v5/aiw/` (13)
- [x] Docs `docs/v5/AI_TOOLS_AND_EXECUTION_MODEL.md`
- [x] Updated V3.5 spec `tests/e2e/ai-automation.spec.ts` for the new /assistant (Start task / Knowledge sources)

## Decisions
- One run system: workflow run = `ai_runs` row `kind='workflow'`, same queue/outbox event (`ai.run_requested`), same model
  client + structured schema + fake injection (`setAssistantModelClient`), same budget meter/ledger, same output checks.
- Lifecycle statuses added to `ai_runs.status`: preparing, working, needs_input, needs_review, completed,
  partially_completed (+ failed/cancelled). `outcome_code` says why (not_configured, budget_exhausted, blocked, timeout,
  entitlement, step_failed, cancelled, interrupted).
- Steps persisted at creation (plan visible immediately). Retry/resume: read/validate steps re-run (re-check access);
  model/write steps with a persisted result are reused; writes use deterministic idempotency keys (`ai-<run>-<step>-<item>`).
- External actions only prepared (`schedule_post`, `submit_for_approval`, `send_reply`) → preview with hash → confirm with
  reviewed hash → normal service (scheduling / requestReply) with idempotency key `ai-action-<id>`. Permission is checked
  grant-wise when preparing (runs have no session → MFA is enforced by the service at confirm).
- No AI key: deterministic steps run (read, validate destinations, create campaign, analytics report, calendar checks,
  schedule proposals, triage + missing-info flags); model steps are `not_configured`; run = partially_completed/failed
  with "AI is not set up". `ask` (single model step) is refused up front with provider_not_configured.
- Suggestions: pure function of the server-built context (brand, ready accounts, documents, permissions, plan features,
  unanswered count, analytics data); multi-step need `ai_workflows`; `ask` suggestions only when AI is configured.
- Free text in the composer → deterministic `guessWorkflow()` chip the person can change (no model routing).
- Attachments: text/Markdown/CSV/JSON ≤ 256 KB, private, untrusted, purged after 30 days.

## Files
New: `packages/db/migrations/038_v5_ai_runs.sql`, `packages/core/src/contracts/v5-ai.ts`, `packages/services/src/ai-workflows/**`,
`apps/web/app/api/assistant/{workspace,threads,workflows,attachments,admin}/**`, `apps/web/app/api/assistant/actions/[id]/preview`,
`apps/web/app/api/platform/ai`, `tests/unit/v5-ai.test.ts`, `tests/integration/v5-ai-workflows.test.ts`.
Edited (AIW-owned/adjacent, small): `packages/services/src/assistant/runs.ts` (kind filters, delegation, sweep, purge,
permissions for new kinds), `packages/services/src/assistant/actions.ts` (external kinds → confirm; settle review),
`packages/core/src/contracts/v35-ai.ts` (EXTERNAL_ACTION_KINDS), `apps/web/app/api/assistant/actions/[id]/apply/route.ts`.
Edited shared: `apps/web/components/admin/nav.tsx` (one Platform item + keywords), `apps/web/app/(admin)/admin/ai/page.tsx` (AI workflows section, V5 status labels),
`apps/web/components/assistant/assistant-app.tsx` (export Knowledge, RunHistory), `tests/e2e/ai-automation.spec.ts`.
New UI: `apps/web/components/ai-workspace/*`, `apps/web/app/(app)/assistant/page.tsx` (rewritten), `apps/web/app/(admin)/admin/platform/ai/page.tsx`, `tests/e2e/v5-ai.spec.ts`.

## Next (if resumed)
- Lead: full-suite run; optional server push for progress; listening workflow only when listening data + a workflow exist.

## Activation items
- AI provider key (Setup → protected settings) — without it model steps report "AI is not set up".
