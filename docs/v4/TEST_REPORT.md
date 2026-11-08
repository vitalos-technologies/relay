# V4 test report

Date 2026-11-08. Production build (`next build --webpack` + `next start`) on the dev host, worker rebuilt, migrations
034–036 applied, fresh E2E seeds. **Test mode only:** billing runs on the labelled test double with locally signed webhook
fixtures (Stripe v1 HMAC scheme); no live provider, no real charges, no real customer email.

## Summary

| Check | Result |
|---|---|
| Typecheck (repo + web) | clean |
| Unit + contracts | **600 / 600** (42 files) |
| Integration (disposable DBs) | **551 / 552** (64 files); the 1 failure is the pre-existing flaky `v31-analytics-summary` test (also flaked before V4; passes 2/2 alone) |
| E2E full suite (all V1–V4 specs, 1 worker, 46.3 min) | **93 passed, 0 failed, 7 skipped** (skips = desktop project skipping `@mobile` tests) |
| Mobile QA (14 V4 screens × 7 widths) | **0** page-level horizontal scroll (`MOBILE_QA.md`) |
| Secret scan (tracked + untracked; also checked for Stripe key/secret patterns) | clean |

### V4 test files

| File | Tests |
|---|---|
| `tests/unit/v4-plans.test.ts` (catalogue: exactly two plans, £10/£25 GBP monthly, 3 seats = £30 / £75, ≥1 seat) | 3 |
| `tests/unit/v4-billing-stripe.test.ts` (signature incl. rotation/tolerance, fixtures, normalisers, request encoding) | 17 |
| `tests/integration/v4-support.test.ts` | 17 |
| `tests/integration/v4-billing.test.ts` | 25 |
| `tests/integration/v4-entitlements.test.ts` / `-workers` / `-billing` | 16 / 5 / 1 |
| `tests/e2e/v4-support.spec.ts` | 3 desktop + 1 mobile |
| `tests/e2e/v4-billing.spec.ts` | 5 desktop + 1 mobile |
| `tests/e2e/v4-entitlements.spec.ts` | 3 desktop + 1 mobile |

## Brief §18 → tests

| # | Acceptance item | Integration | E2E |
|---|---|---|---|
| 1 | Customer request appears in Platform → Support | `v4-support` | `v4-support` "customer request → Platform → Support → reply…" |
| 2 | Staff replies appear in the correct customer account | `v4-support` | same |
| 3 | Another tenant can't read the ticket or attachments | `v4-support` (404 for ticket + attachment) | same |
| 4 | Internal staff notes never reach customers (APIs, notifications, email, transcript, search, feed) | `v4-support` | same |
| 5 | Duplicate submissions don't duplicate notifications | `v4-support` (idempotency + notification dedupe) | — |
| 6 | Problem report shared only through the explicit flow | `v4-support` | `v4-support` "problem report is shared only through the explicit review flow" |
| 7 | Support access requires owner approval and expires | `v4-support` (+ existing `v31-admin`) | existing `admin.spec` support-access flow |
| 8 | Trial becomes active after verified test checkout | `v4-billing` | `v4-billing` "§18.9 … §18.8 verified test checkout" |
| 9 | Forged checkout redirect doesn't activate a plan | `v4-billing` (forged redirect, unsigned/wrong-secret/stale events, signed event for a non-existent object) | same |
| 10 | Duplicate / out-of-order webhooks → consistent state | `v4-billing` (duplicate, reversed, stale ⇒ same state, one activation) | — |
| 11 | Failed payment and recovery follow the policy | `v4-billing` (7-day grace → restricted → recovery; SCA) + `v4-entitlements-billing` (held work) | — |
| 12 | Upgrade, downgrade, cancellation, reactivation | `v4-billing` + `v4-entitlements` (enforcement) | `v4-billing` "update payment details, change plan with a provider preview, cancel and resume" |
| 13 | Entitlements enforced through UI, API, workers, MCP | `v4-entitlements`, `v4-entitlements-workers` (MCP over the protocol) | `v4-entitlements` "operator overrides → … upgrade prompt; server refuses" |
| 14 | Concurrent usage can't bypass limits | `v4-entitlements` (12 concurrent consumers for 3 units; 6 concurrent connects for 1 slot) | — |
| 15 | Billing and support reachable while restricted | `v4-billing`, `v4-support`, `v4-entitlements` | — |
| 16 | Publishing reliability preserved | `v4-entitlements` (held → released exactly once, no duplicates, Unknown untouched) + the full existing suite | full E2E (`publishing.spec` 17 + 9 mobile) |
| 17 | Essential mobile workflows | — | `@mobile` specs (see `MOBILE_QA.md`); approving/revoking support access on a phone is not E2E-tested |

## Performance

Browser timings, production build, 1440 px, 14 V4 screens, cold + warm full document loads
(`PERF=1 node scripts/v4-final-shots.mjs`, `evidence/v4/final/perf.json`):

| Run | DOMContentLoaded min / median / max | First data API | Settled (network idle + no skeleton) |
|---|---|---|---|
| Cold | 57 / 69 / 135 ms | 292 / 341 / 443 ms | 713 / 987 / 1,214 ms |
| Warm | 50 / 73 / 83 ms | 250 / 301 / 388 ms | 718 / 963 / 1,133 ms |

"Settled" includes Playwright's 500 ms network-idle window, so it is not comparable with the 300 ms warm-navigation budget.
Billing, usage and support pages read stored rows only: `GET /api/billing` makes no provider call (provider work happens in
checkout/portal/change actions, webhooks and the worker sweep), and staff AI runs only on request.

## Not verified here
Live Stripe (account, real Checkout/Portal, live webhooks), real SMTP delivery, real AI output, malware scanning, sign-up by
a brand-new visitor (Keycloak registration is off). See `FINAL_ACTIVATION_CHECKLIST.md`.
