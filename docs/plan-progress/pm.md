# Stream PM — Free plan: marketing page, signup screens, upgrade copy, help (D33)

Status: done (pricing + lead's marketing requests). Rebuilt; E2E, unit, integration, docs-check green; evidence in `evidence/plans/`.

## Ownership (to avoid collisions with PL)
- PM edits: `apps/web/components/marketing/**`, `apps/web/app/(marketing)/page.tsx`, `apps/web/app/signup/**` (UI only),
  upgrade-prompt copy (`apps/web/components/entitlements/use-entitlements.ts`, AI workspace banner),
  `content/help/**` plan/trial wording, `docs/v5/{MARKETING_PAGE_GUIDE,PLAN_AND_SEAT_DEFINITIONS}.md` (+ superseded notes in
  `IMPLEMENTATION_MATRIX.md`, `TEST_REPORT.md`), tests `tests/{unit,integration}/v5-marketing.test.ts`, `tests/e2e/v5-marketing.spec.ts`.
- Left to PL (billing record / enforcement; still assert £10/£25 or two plans): `tests/unit/v4-plans.test.ts`,
  `tests/unit/v4-billing-stripe.test.ts`, `tests/unit/v4-entitlements.test.ts`, `tests/integration/v4-billing.test.ts`,
  `tests/e2e/v4-billing.spec.ts` (line ~167 `signup-plan-standard` → now '£5'), `packages/core/src/contracts/v4-entitlements.ts`,
  `packages/services/src/{billing,entitlements}/**`.

## For PL — shared upgrade copy (new, PM-owned)
`packages/core/src/contracts/plan-copy.ts`: `cheapestPlanWithFeature`, `cheapestPlanWithMore(allowance, currentPlan)`,
`planPrice`, `upgradeSentence`, `featureUpgradeMessage(label, planName, to)` → "Standard analytics isn’t included in Free.
Upgrade to Standard (£5 per user / month).", `limitUpgradeMessage(limitText, planName, to)` → "Free includes 10 scheduled
posts a month. Upgrade to Standard (£5 per user / month)." The client prompt already uses it. Suggest the server messages use
the same helpers so 402 errors read the same: `services/entitlements/resolve.ts` checkFeature (currently "It’s part of X.")
and `services/entitlements/gauges.ts` assertGaugeCapacity (currently "… Upgrade in Billing, or remove one first.") and the
scheduled-posts check. Not edited by PM (PL files).

## Assumptions about PL's API
- `POST /api/billing/signup` accepts `plan: 'free'` → Free workspace (`status: 'free'`, no trial); `GET` returns
  `catalogue = publicCatalogue()` (3 plans). Integration test `v5-marketing` "D33 Free handoff" asserts this.
- After creating a Free workspace the signup page goes to `/overview` (paid → `/settings/workspace/billing?welcome=1` as before).
- Trial ended / cancellation took effect → Free (per v4-billing.ts comment). Failed payment past grace still → restricted
  (help articles say so). Tell PM if that changes.
- Free's support = Help Centre (D33): comparison shows "Help Centre" for Free, ✓ for paid. No contact restriction is claimed
  beyond that.

## Done
- Marketing: 3 cards from the catalogue (Free £0 "for 1 user", "Start free", no trial copy, "1 user · £0 / month · no
  teammates"; Standard £5 / Professional £15 "14 days free", "Start free trial"; Professional highlighted); stepper labelled
  "paid plans"; comparison has Free column, Free limits first (users, brands, accounts, scheduled posts, storage, AI),
  "Report exports" row, "Data export always works", trial group "–"/"No trial" for Free; 500 MB formatting; hero price line,
  pricing lead, footnote, final CTA (+ "Start free"), metadata, product demo plan lines (inbox/analytics not on Free),
  integrations (WhatsApp/Drive/Notion badge "Paid plans"); FAQ rewritten (trial → Free, new "What’s included in Free?",
  per-user, teammates, cancel → Free, AI limits incl. Free).
- Signup: `/signup?plan=free` → "Start on Free", no seats/total/trial copy, "Continue with Free"; picker shows 3 plans;
  workspace step supports Free (3-way radio, "Create workspace").
- Upgrade prompts: name the cheapest plan + catalogue price; AI workspace banner from the catalogue.
- Help: plans-and-features (3 columns, limits table), start-a-free-trial, create-your-workspace, change-plan-or-cancel,
  when-paid-actions-are-paused, invoices-and-payment-details, manage-seats, glossary, approval-policies, use-the-ai-workspace,
  cases-and-service-levels, switch-workspaces. `node scripts/docs-check.mjs` passes.
- Evidence script: `scripts/plans-shots.mjs` → `evidence/plans/`.

## Activation / follow-ups
- `apps/web/public/help/img/billing-and-plans/plan-and-billing.png` still shows the old £10 billing page; re-capture after PL's
  billing UI lands (alt text no longer quotes a price).

## 2026-11-10 — lead's marketing requests (done)
- Light only: `components/marketing/force-light.tsx` (+ `restore-app-theme.tsx`) in `app/(marketing)/layout.tsx` and the
  signed-out `components/help/public-help-shell.tsx`; dark blocks removed from `marketing.css`; hero uses only
  `overview-light.webp` (`overview-dark.webp` deleted, unreferenced).
- Integrations: legend, status badges, notes, plan badges and the "Names and logos…" line removed; tiles = icon, name, one
  line; intro "The networks and apps Relay connects to. Some go live as each network approves Relay’s access."; statuses kept
  as `data-status`. FAQ channels answer no longer points at the removed labels.
- Hero price line under the CTAs removed.
- Explore modals: real screenshots (`apps/web/public/marketing/explore-{publishing,inbox,analytics,assistant}.webp`, 80–124 KB
  sources, served by next/image), lazy, 2560×1600 reserved, alt in `components/marketing/explore-shots.ts`, caption "Example
  workspace"; image top / left ≥ 1024 px (`explore-panel.tsx` `media` slot). Seed (`scripts/seed-marketing-showcase.ts`) now adds
  6 synthetic inbox conversations (FB + IG) and one completed AI workspace task (performance analysis — data-only steps;
  weekly planning needs an AI provider, which dev doesn't have). `scripts/marketing-capture.mjs` captures overview + the four
  Explore screens, light only (Planner filtered to Scheduled so no simulated-conflict badges show).
- Motion: `Reveal` gained `effect` (rise/scale/left/right/fade), used per section; hero depth layers + pointer tilt and the
  sticky product-card stack in `components/marketing/marketing-motion.tsx` (Motion `scroll()` + `motion/mini` WAAPI) and
  `marketing.css`; hover lift `.mkt-lift`. All inside `prefers-reduced-motion: no-preference`.
- Perf (`PERF=1 RUNS=3 node scripts/v5-mkt-shots.mjs`, medians; before = pricing build, after = this build):
  desktop LCP 464 → 632 ms, mobile (4× CPU, slow 4G) LCP 1944 → 1948 ms, CLS 0 → 0; JS on `/` reported 364.3 KB transfer /
  1130.2 KB decoded both times (the script's resource-timing total didn't move); direct check: marketing page chunk 11.4 KB
  gzip incl. the motion code, all JS on `/` 340 KB gzip. Raw: `evidence/plans/perf-{before,after}/perf.json`.
- Overflow QA (`MOBILE_QA=1`): 0 px at 320/360/390/430/768/1024/1440 and 1440 @ 200 % (`evidence/plans/mobile-qa.json`).

## Verification (final)
- `pnpm -s typecheck` clean · `pnpm test` 685/685 · integration `v5-marketing` 9/9 · `node scripts/docs-check.mjs` ok ·
  E2E `v5-marketing` 8 passed, 1 skipped (mobile-only test in the desktop project).
