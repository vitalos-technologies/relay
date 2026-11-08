# Collaboration — test report

Date 2026-11-07. Production build (`next build --webpack` + `next start` on :3000) and the rebuilt worker on the shared dev
host (4 vCPU Xeon 2.1 GHz, 16 GB; Postgres, Keycloak, Mailpit, worker on the same host). Simulated destinations only; no
real email to real people (Mailpit); nothing published to live accounts.

## Summary

| Suite | Result |
|---|---|
| `pnpm typecheck` (root + web) | clean |
| `pnpm test` (unit + contracts) | **505 / 505** (incl. `tests/unit/collab.test.ts` 10) |
| Integration (disposable DB per run, real Postgres) | **413 / 413** in 52 files (incl. `collab-complete.test.ts` 11, `v2-collab.test.ts` 13) |
| New E2E `tests/e2e/collaboration.spec.ts` | 5 / 5 (+ 1 desktop skip of the phone-only test) |
| Full E2E on the production build (all specs, both projects) | **56 passed, 1 skipped, 0 failed** (24.3 min) |
| Mobile QA `scripts/collab-mobile-qa.mjs` | 10 routes × 6 widths: **0** page-level horizontal overflow, **0** console errors; **8 / 8** phone workflows |
| V3.1 browser budgets `scripts/v31-browser-perf.mjs --check` | **all routes within budget** (composer 364 KB ≤ 370 KB) |
| Secret scan (tracked + new untracked files) | clean |

## What the automated tests prove (brief §14)

| Requirement | Test |
|---|---|
| Two users commenting + receiving updates | I "two users comment and receive each other's updates…" (change feed, unread, participant notification once); E "two people discuss a post" (live update without reload, measured) |
| Mention creation / edits / dedupe | I "mentions" (one notification; edit adds only new people; remove + re-add doesn't re-notify; removed member skipped and shown as former; outsider gets nothing and still 404s) |
| Internal-thread isolation from clients | I "internal threads never reach a client" (review portal, thread API, replies, change feed, notifications, DB trigger, explicit confirmed visibility change, client-comment switch); E "server-side refusals" (guest 404 on thread + list; events don't contain the id; CSRF 403) |
| Assignment + reassignment | I "tasks + deadlines" (permissions, entitlement, concurrency, reassignment, completion doesn't approve, schedule untouched); I "revoked access…" (offboarding sweep + admin reassign); E tasks test; M workflow 4 |
| Time-zone-aware deadline reminders | I "bounded reminders" (window, once per deadline, ≤ N overdue ≥ 24 h apart, task time zone, new deadline resets); U `reminderDue` |
| Reviewer notifications | I "reviews" (eligible only, merged notification, overdue once, approved/invalidated notified) |
| Approval invalidation after edits | I "reviews" (autosave after submission → invalidated + notifications; history shows the approval as not applying to the current version) |
| Simultaneous autosaves → recoverable conflict | I "concurrent editing" (two parallel saves: one wins, one 409 with a conflict copy); E conflict test (apply selected keeps both people's changes); M workflow 8 |
| Revision restore → new draft version | I + E (version count +1, content restored, viewer refused) |
| Revoked access stops subscriptions + notifications | I "revoked access" (events `visible:false`, presence hides the person, mention skipped, offboarding flags the task); stream re-checks access every 15 s (route) |
| Offline reconnect + missed-event reconciliation | I "offline reconnect" (ordered events after the cursor, idempotent replay, reset when the cursor predates retention, other workspaces invisible) |
| Duplicate / out-of-order delivery | I (client keys return the same comment; insert-once dedupe keys; event ids ordered) |
| Mobile completion of essential workflows | M (8 workflows at 390 × 844) + E `@mobile` test (Pixel 7) |
| Multiple workspaces, roles, concurrent sessions | every integration test builds a workspace with owner / 2 editors / approver / viewer / other-brand editor / guest; cross-workspace test; two browser contexts in E2E |
| Email without SMTP never "sent"; access re-checked at send | I "notification centre + delivery" |

I = `tests/integration/collab-complete.test.ts`, E = `tests/e2e/collaboration.spec.ts`, M = `scripts/collab-mobile-qa.mjs`,
U = `tests/unit/collab.test.ts`. Mocked delivery (Mailpit in tests; `SMTP_URL` unset to prove `not_configured`) is
separate from verified external delivery, which was **not** tested (no real mail provider was used).

## Full E2E (production build) — `evidence/collaboration/e2e-results.json`

| Spec | desktop | mobile (Pixel 7) |
|---|---|---|
| admin.spec.ts | 5 / 5 | 1 / 1 |
| collaboration.spec.ts | 4 / 4 (+1 skipped: the phone-only test) | 1 / 1 |
| publishing.spec.ts | 17 / 17 | 9 / 9 |
| security.spec.ts | 8 / 8 | — |
| v2-product.spec.ts | 4 / 4 | 1 / 1 |
| v31-ui.spec.ts | 6 / 6 | — |
| **Total** | **44** | **12** → **56 passed** |

Measured in the run: a mention posted by one person appeared on the other person's open page **1,437 ms** later (no reload).

Changes made to keep other streams' specs truthful: `v31-ui.spec.ts` follows the new conflict dialog (title, explicit
two-step discard); `scripts/v31-browser-perf.mjs` finds the Approvals nav link when it carries a pending badge. Two earlier
full runs failed only on (a) the old conflict wording, (b) `security.spec` back-channel logout when the approver had other
live Keycloak sessions from `collaboration.spec`, and (c) a teammate whose team grant changed during the suite — the
collaboration spec now uses Eden (editor) and Vic (workspace viewer).

## Performance (lab) — `scripts/collab-perf.mjs`, `evidence/collaboration/perf-collab.json`

Dataset (synthetic, Demo Workspace): one post with **200 threads / 842 comments**, **204 tasks**, **~2,000 notifications**,
~3,200 change-feed events. API: warm, sequential, n = 30 per endpoint (p95 of 30 is indicative), including Next routing,
session + policy load and serialisation.

| Endpoint | p50 ms | p95 ms | payload |
|---|---|---|---|
| Threads page (volume post, 20 threads, ≤ 31 comments each) | 15.5 | 22.6 | 61 KB |
| Thread detail (all replies) | 10.0 | 14.1 | 22 KB |
| Mention search | 13.9 | 19.2 | 0.4 KB |
| Tasks — mine / team / post | 12.6 / 13.2 / 13.5 | 19.1 / 18.2 / 27.0 | 31 / 30 / 50 KB |
| Task workload | 7.9 | 11.1 | 0.5 KB |
| Notification feed / bell | 11.9 / 9.8 | 15.4 / 11.9 | 16 / 11 KB |
| History page / compare / activity | 8.8 / 6.9 / 11.9 | 12.1 / 9.5 / 21.6 | ≤ 4 KB |
| Change-feed poll / presence | 5.7 / 7.4 | 6.7 / 11.3 | ~0 |
| Planner week (with collaboration decorations) | 14.0 | 17.0 | 8 KB |
| Admin collaboration overview | 12.3 | 15.0 | 4 KB |
| Reply (write, returns the full thread), n = 20 | 19.0 | 26.7 | — |

All lists are bounded (threads 20/page, inline replies ≤ 30, thread ≤ 500, tasks 30/page, notifications 30/page, history
20/page, activity 30/page, mention candidates ≤ 8 from ≤ 40 scanned).

**Sync latency** (B holds the SSE stream, A posts a reply; request start → event received), n = 20: **p50 1.20 s, max 1.21 s**.
The stream polls every 1.5 s, so the expected range is ~0–1.6 s; the narrow spread is an artefact of the fixed loop timing.
Polling fallback: 10 s. E2E "live update without reload" passed within its 20 s limit.

**Notification pipeline**: a synthetic burst of ~800 reply events (volume seed) drained in about 2–3 minutes on one worker;
queue wait p95 68 s (workload class `notifications`, 2 at a time). Publishing was unaffected (separate `delivery-due` queue).

**Browser** (cold loads, n = 8, 1440 × 900, localhost):

| Route | LCP p75 | Useful content p95 | CLS p75 | INP proxy p75 | JS p50 |
|---|---|---|---|---|---|
| Composer + collaboration panel | 476 ms | 565 ms | 0 | 24 ms | 364 KB |
| Composer, volume post (200 threads) | 432 ms | 601 ms | 0 | — | 364 KB |
| Tasks | 356 ms | 379 ms | 0 | — | 292 KB |
| Notifications | 304 ms | 375 ms | 0 | — | 287 KB |
| Admin → Collaboration | 292 ms | 391 ms | 0 | — | 299 KB |

V3.1 budgets (`docs/PERFORMANCE_BUDGETS.md`): LCP ≤ 2 s p75, INP ≤ 200 ms, CLS ≤ 0.1, warm navigation ≤ 300 ms p95 — all met;
the composer's JS first measured 372.5 KB (over its 370 KB budget) and was brought to 364 KB by loading the non-default
collaboration tabs on demand. `evidence/collaboration/browser-budget-check.json`: every V3.1 route within its JS budget;
warm navigation p95 Planner 153, Library 87, Approvals 99, Connections 149, Overview 206 ms.

## Mobile — `evidence/collaboration/mobile-qa.json`, `evidence/collaboration/mobile/*.png`

Widths 320 / 360 / 390 / 430 / 768 (+1440) on composer (panel closed and open as a sheet), Tasks, Notifications, review,
four admin pages: 0 overflow, 0 console errors. Small-target report (bounding box < 44 px; many controls use the
`touch-target` hit-area extension, so this over-counts): present on 40 of 60 page checks, mainly compact icon buttons in the
composer and review page (pre-existing components) — listed per page in the JSON. Workflows at 390 × 844 (ms):
notification → focused thread 1,356 · reply 1,118 · mention 1,366 · task with deadline 1,514 · request changes 1,044 ·
approve 1,047 · revision comparison 1,086 · conflict recovery 32,729 (includes the autosave debounce and the server round
trips) — all passed.

## Security checks (summary)

Workspace isolation, brand restrictions, guest access, internal vs client threads, comment edit/delete rights, task
assignment rights, reviewer eligibility, revoked membership/grants, stale sessions (stream re-validates the session every
15 s), change-feed audience filtering, attachment access (media anchors only reference the post's own assets; previews go
through `assetsByIds`), CSRF on every mutation, sanitised user content, no comment text in notifications/emails/search/exports.
