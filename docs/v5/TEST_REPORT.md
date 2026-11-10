# V5 test report

Date 2026-11-08. Production build (`next build --webpack` + `next start`), worker rebuilt, migrations 037–038 applied
(34 applied in total), fresh E2E seeds. Billing in V4 test mode (labelled test double, locally signed webhooks); no AI
provider key (model steps tested with a fake provider injected in integration tests only); local Keycloak realm with
self-registration + email verification; Mailpit for email. No real campaigns, no real charges, no live provider calls.

## Summary

| Check | Result |
|---|---|
| Typecheck (repo + web) | clean |
| Unit + contracts | **624 / 624** (45 files) |
| Integration (disposable DBs) | **592 / 592** (67 files) |
| E2E full suite (all V1–V5 specs, 1 worker, 53.7 min) | **113 passed, 0 failed, 9 skipped** (skips = desktop project skipping `@mobile` tests) |
| Mobile QA (8 V5 screens × 7 widths) | **0** page-level horizontal scroll (`MOBILE_QA.md`) |
| Secret scans (tracked + untracked; Stripe key/secret patterns) | clean |

### V5 test files

| File | Tests |
|---|---|
| `tests/unit/v5-widget.test.ts` / `v5-ai.test.ts` / marketing units | 6 / 10 / 8 |
| `tests/integration/v5-marketing.test.ts` | 8 |
| `tests/integration/v5-widget.test.ts` | 17 |
| `tests/integration/v5-ai-workflows.test.ts` | 15 |
| `tests/e2e/v5-marketing.spec.ts` | 6 desktop + 1 mobile |
| `tests/e2e/v5-widget.spec.ts` | 4 desktop + 1 mobile |
| `tests/e2e/v5-ai.spec.ts` | 7 desktop + 1 mobile |

## Brief §18 → tests

| # | Acceptance item | Evidence |
|---|---|---|
| 1 | Marketing section links stay on the same page | E2E `v5-marketing` "§18.1 section navigation stays on the page" |
| 2 | Signup, login, dashboard links reach the correct routes | same + "a signed-in visitor sees Open dashboard on / (no redirect) and reaches /overview"; integration `auth` (return paths) |
| 3 | Relay branding and the supplied visual direction | E2E "§18.3–4 Relay branding and visual direction"; screenshots `evidence/v5/mkt/` |
| 4 | No fabricated endorsements or outcomes | same E2E (no testimonials, ratings, customer logos or growth claims; hero captioned as illustrative) |
| 5 | Exactly two public plans at £10 and £25 per user per month *(superseded by D33: three plans £0 / £5 / £15; marketing E2E now asserts those)* | E2E "§18.5–6"; unit `v4-plans` |
| 6 | Genuine 14-day trial on both plans | E2E "new visitor: pricing → register → verify email → workspace → 14-day Professional trial → Billing"; V4 integration `v4-billing` |
| 7 | Seat totals match across marketing handoff, checkout, billing and admin | integration `v5-marketing` (3 Standard = £30, 3 Professional = £75 across marketing, Billing, checkout, provider state, Platform admin) + the E2E above |
| 8 | Trial expiry and plan changes don't reset trial eligibility | integration `v4-billing` (once per workspace; plan change/replay never extends) |
| 9 | Visitor messages reach Platform support | integration `v5-widget`; E2E "visitor message reaches Platform → Support" |
| 10 | Staff replies return to the correct widget conversation | same (incl. after reconnect via cursor) |
| 11 | Another visitor can't access that conversation | integration `v5-widget` (404 for read, reply, files — even with the same email) |
| 12 | Internal notes never appear publicly | integration (reads, polling, list, reply responses, emails, files) + E2E |
| 13 | AI suggestions relevant and actionable | unit `v5-ai` (never unconnected accounts, respects permissions/plan/data); E2E "4–6 actionable suggestions from real data" |
| 14 | AI workflows create real records with working links | integration `v5-ai-workflows`; E2E weekly planning + campaign from an attached brief |
| 15 | Runs survive refresh; cancellation and partial failure | integration (refresh, stop before/during, partial failure + retry without duplicates, interrupted worker, timeout); E2E "refresh-safe", "stop" |
| 16 | Publishing and replies respect permissions | integration `v5-ai-workflows` (stale review refused, revoked permission refused at dispatch, no-schedule-right gets no scheduling action, approvals kept) + V4/V3.5 publishing suites |
| 17 | Mobile workflows usable with the on-screen keyboard | `@mobile` E2E: marketing seat entry, widget sheet (reply box + Send stay visible with a shrunken viewport), AI composer. A real device keyboard can't be emulated — manual device check listed in gaps |
| 18 | Performance and accessibility recorded honestly | `PERFORMANCE_REPORT.md`, `MOBILE_QA.md`; keyboard, names, focus, reduced motion and 200 % zoom covered in the V5 E2E specs |

## Not verified here
Live Stripe, real SMTP delivery, real AI output, production self-registration, a real phone keyboard, Lighthouse scores on
a deployed build. See `FINAL_ACTIVATION_CHECKLIST.md` and `IMPLEMENTATION_GAPS.md`.
