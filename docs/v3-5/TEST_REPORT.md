# V3.5 test report (final verification, stream F)

Date 2026-11-08. Production build on the shared dev host (`next build --webpack` + `next start` on :3000; worker rebuilt
and restarted with all streams; migrations 028–032 applied). Everything below is **fixture/simulation based**: simulated
provider transports, locally signed webhook fixtures, real Postgres, real Keycloak sign-in. **No live-provider
verification** was possible (see `FINAL_ACTIVATION_CHECKLIST.md`).

## Summary

| Check | Result |
|---|---|
| Typecheck (repo + web) | clean |
| ESLint (all files changed by stream F) | clean (one pre-existing `react-hooks/set-state-in-effect` error in `app/(app)/activity/page.tsx:64`, not introduced here) |
| Unit + contracts (`pnpm test`) | **564 / 564** (38 files) |
| Integration (`pnpm test:integration`, disposable DBs) | **489 / 489** (59 files) |
| E2E full suite (production build) | see "E2E per file" |
| Mobile QA (23 V3.5 screens × 320/360/390/430/768/1024/1440) | **0** page-level horizontal scroll (`evidence/v3-5/final/mobile-qa.json`) |
| Performance (server read paths at 5,000 conversations / 20,000 messages) | all within budget (`evidence/v3-5/final/perf-server.json`) |
| Secret scan (tracked + untracked) | clean |

### V3.5 integration files

| File | Tests |
|---|---|
| `v35-connectors.test.ts` | 6 |
| `v35-inbox.test.ts` | 8 |
| `v35-inbox-more.test.ts` | 13 |
| `v35-integrations.test.ts` | 14 |
| `v35-listening.test.ts` | 10 |
| `v35-ai-automation.test.ts` | 15 |
| `v35-final.test.ts` (stream F) | 10 |
| `mcp.test.ts` (incl. V3.5 scopes) | 21 |

## E2E per file

Full suite on the production build, 1 worker (Playwright, desktop 1440 px + mobile Pixel 7 for `@mobile`):
**76 passed, 5 skipped, 0 failed** (81 tests, 34.3 min; skips = desktop project skipping the `@mobile` tests).
Log: `.data/logs/f-e2e-full.log` (copied to `evidence/v3-5/final/e2e-full.log`).

| File | Desktop passed | Mobile passed | Skipped |
|---|---|---|---|
| admin.spec.ts | 5 | 1 | 0 |
| ai-automation.spec.ts | 2 | 1 | 1 |
| collaboration.spec.ts | 4 | 1 | 1 |
| inbox.spec.ts | 2 | 1 | 1 |
| inbox-more.spec.ts | 4 | 1 | 1 |
| integrations.spec.ts | 5 | 1 | 0 |
| listening.spec.ts | 2 | 1 | 1 |
| publishing.spec.ts | 17 | 9 | 0 |
| security.spec.ts | 8 | 0 | 0 |
| v2-product.spec.ts | 4 | 1 | 0 |
| v31-ui.spec.ts | 6 | 0 | 0 |
| **Total** | **59** | **17** | **5** |

Stream F's own spec `v35-final.spec.ts` was added after that run and is reported below ("Post-rebuild runs").

## §22 acceptance tests → tests

| # | Acceptance test | Integration | E2E |
|---|---|---|---|
| 1 | Receive, assign, draft, send once, actual provider result | `v35-inbox` "AT1: receive → assign → draft → send once…"; `v35-inbox-more` "DMs, comments, private reply once… (AT1, AT13)" | `inbox.spec` "receive, assign, internal note, reply sent once with the provider result" |
| 2 | Concurrent replies never silently duplicate | `v35-inbox` "AT2: two agents replying concurrently…" | `inbox.spec` "two agents reply at the same time…" |
| 3 | Internal note never reaches the customer | `v35-inbox` "AT3…"; `v35-final` (MCP reads exclude notes); `v35-ai-automation` (notes never sent to the model) | `inbox.spec` (note in the receive flow) |
| 4 | Google review → inbox item; authorized reply to the correct location | `v35-inbox-more` "a review becomes an inbox item and an authorized owner reply reaches the correct location only"; `v35-final` "GBP Pub/Sub review notification polls the matching channel" | `inbox-more.spec` "Google review → inbox item…" |
| 5 | One HubSpot ticket despite repeated delivery | `v35-integrations` "repeat requests + lost response + reconciliation ⇒ exactly one ticket"; `v35-connectors` "sync jobs: one external record per logical request…" | `integrations.spec` "external task from a case…" (preview) |
| 6 | Asana + monday.com sync without loops | `v35-integrations` "Asana: … the echo is dropped…", "monday.com: …"; `v35-connectors` echo test (Relay-written fields + real job only) | `integrations.spec` "hub honesty… sync contract" |
| 7 | Slack rejects unauthorized/revoked actors | `v35-integrations` "routes, dedupe, …, revoked member refused, unsigned refused" | `integrations.spec` "Slack link page refuses an invalid token" |
| 8 | Mailchimp draft without sending/subscribing | `v35-integrations` "approved content only; one draft per post; … no send/members calls exist" | — |
| 9 | Translation keeps the original, never auto-sends | `v35-integrations` "off until an admin enables it…" | `integrations.spec` "translation: … original kept; nothing sent"; `v35-final.spec` @mobile translate |
| 10 | Listening alert links to real observations, states coverage | `v35-listening` "AT10…"; `v35-final` (alert → automation trigger, notification link) | `listening.spec` "AT10…" |
| 11 | AI uses authorized sources, resists embedded instructions | `v35-ai-automation` "retrieves only sources the requester may read…", "treats instructions inside customer content as data…" | `ai-automation.spec` "assistant reports its provider state honestly…" |
| 12 | Membership revocation immediately blocks inbox and AI retrieval | `v35-inbox-more` "AT12…"; `v35-ai-automation` "AT12…" ×2; `v35-listening` "AT12 + isolation"; `v35-final` (MCP + queued sync job) | — |
| 13 | Provider outages → recoverable states, no invented success | `v35-inbox` "AT13…"; `v35-inbox-more` "AT13…" ×2; `v35-ai-automation` "AT13…"; `v35-integrations` "outage ⇒ waiting_retry; rate limit…; revoked ⇒ reconnect…" | `v35-final.spec` @mobile (revoked ⇒ Reconnect state) |
| 14 | Main app, admin and MCP show consistent persisted state | `v35-final` "admin summary reuses each stream's service…", MCP "…AT14: the app sees the same persisted state" | `v35-final.spec` "admin … counts that match the app" |
| 15 | Essential mobile workflows usable | — | `inbox.spec` @mobile (reply, note, assign + resolve case), `inbox-more.spec` @mobile, `listening.spec` @mobile (inspect alert, create task), `ai-automation.spec` @mobile, `integrations.spec` @mobile, `v35-final.spec` @mobile (translate, reconnect state, admin); mobile QA 0 overflow |

Phone workflows (brief §21): reply ✔, internal note ✔, assign + resolve a case ✔, review an AI reply — screens verified
(no AI key ⇒ honest "AI is not set up"; a real AI reply cannot be reviewed without a provider), translate ✔, inspect a
listening alert ✔, create an external task ✔ (from a listening insight; from a case on desktop), reconnect an integration —
the Reconnect state is shown; the OAuth round trip needs live credentials.

Also covered (brief §22 "Test …"): tenant isolation (every V3.5 integration file has cross-workspace/brand refusals),
webhook verification (`v35-connectors`, `v35-integrations`, `v35-inbox-more` WhatsApp/Telegram), message ordering and
reply-window expiry (`v35-inbox`, `v35-inbox-more` WhatsApp 24 h), unknown send outcomes (AT13 rows), retention
(`v35-listening` deletion propagation, `v35-ai-automation` run-output purge, `v35-final` Telegram secret cleared),
accessibility (role/label-based E2E selectors; dialogs and drawers with focus management), representative load (below).

## Mobile

`MOBILE_QA=1 node scripts/v35-final-shots.mjs` — 23 screens (inbox thread/list/assistant drawer, inbox channels and
service levels, integrations hub + Asana + Slack, listening home/search/alert/mention, assistant, automation + rule test,
a published post's deliveries, Admin overview/inbox/integrations/listening/AI/audit, Platform pipeline) × 7 widths:
**0** page-level horizontal scroll. Fixed in this pass: the 320/360 px overflow on a published post's deliveries panel
(absolutely positioned screen-reader text escaped the truncated line). Screens: `evidence/v3-5/final/*-{1440,390}-{light,dark}.png`.

## Performance

Server read paths through the real services (`scripts/v35-perf.ts`), synthetic workspace with **5,000 conversations /
20,000 messages**, 30 samples each, nearest-rank p95, against `docs/PERFORMANCE_BUDGETS.md` (page read model ≤ 100 ms p95):

Run 2026-11-08 06:56 UTC; workload 5,000 conversations / 20,000 messages / 7,500 listening observations (the 7,500 public inbound comments, ingested through the real `observeMessage` path; an earlier run had bulk-inserted messages without ingesting them, so its listening rows measured an empty search; fixed in the script). Evidence: `evidence/v3-5/final/perf-server.json`.

| Read path | p50 ms | p95 ms | max ms | payload KB | Budget p95 | Within |
|---|---|---|---|---|---|---|
| inbox list (first page, all) | 8.9 | 15.2 | 16.2 | 17.9 | 100 | yes |
| inbox list (cursor page) | 8.7 | 9.9 | 10.3 | 17.9 | 100 | yes |
| inbox list (unassigned queue) | 2.7 | 3.8 | 3.8 | 17.9 | 100 | yes |
| inbox search (q) | 7.8 | 10.5 | 16.1 | 0.6 | 100 | yes |
| inbox thread | 5.2 | 9.5 | 12.5 | 3.1 | 100 | yes |
| listening mentions (30 days, page) | 55.8 | 78.8 | 80.6 | 22 | 100 | yes |
| listening timeline (30 days) | 49.6 | 61.3 | 67.3 | 4.5 | 100 | yes |
| integrations hub | 3.9 | 8 | 8.6 | 5.9 | 100 | yes |
| assistant status (drawer open) | 1.3 | 1.8 | 2.8 | 0.2 | 100 | yes |
| admin summary (care) | 14.9 | 27.4 | 28.9 | 3.3 | 100 | yes |

Listening at scale was measured by stream D on 20,000 mentions in one search: timeline 73–294 ms (first call), sentiment
42 ms, topics 71 ms, mentions page 51 ms, text search 55 ms (`evidence/v3-5/listening/verification.json`); the
`v35-listening` "representative load: 20k mentions" integration test enforces bounded reads (< 3 s worst case under CI load).

Browser (production build, 1440 px, cold + warm, `PERF=1 node scripts/v35-final-shots.mjs`):

| Run (23 screens) | DOMContentLoaded min / median / max | First data API | Settled (network idle + no skeleton) |
|---|---|---|---|
| Cold | 61 / 71 / 122 ms | 323 / 370 / 547 ms | 974 / 1,075 / 1,445 ms |
| Warm | 55 / 72 / 109 ms | 271 / 307 / 376 ms | 872 / 1,010 / 1,294 ms |

These are **full document loads** (`page.goto`), not in-shell navigations, and "settled" includes Playwright's 500 ms
network-idle window, so they are not comparable with the 300 ms warm-navigation budget. The slowest request on most
screens is the shell's shared `/api/approvals?status=pending` or `/api/feature-flags` call, not a V3.5 endpoint. 0
horizontal-scroll issues at 1440 px in this run. Evidence: `evidence/v3-5/final/perf.json`.

Pages never wait for providers or AI: every V3.5 page renders from stored rows; AI runs are queued and polled, provider
work runs in the worker.
