# Admin test report (V3.1 Admin §18–19)

Date: 2026-11-07. Environment: local dev stack (PostgreSQL 16, Keycloak 26.4, SeaweedFS, Mailpit, worker), production
web build for E2E/perf/screens. Simulated destinations only; nothing was published to live networks; invitation email
went to local capture only.

## Results
| Suite | Result |
|---|---|
| Root `tsc` + web `tsc` | clean |
| `pnpm test` (unit + contracts) | **495 / 495** (490 existing + 5 new in `tests/unit/v31-admin.test.ts`) |
| Integration (real PostgreSQL, disposable DB) | **401 / 401** — full run 400/401 under heavy CPU load (concurrent production build): `v31-analytics-summary` "overview output is identical" (pre-existing, timing-sensitive, 54 s under load); re-run alone: 3/3 pass in 10 s. New: `v31-admin.test.ts` 24 (incl. simulated-rename regression), `v31-admin-mcp.test.ts` 3 |
| Full E2E (Playwright, production build, all specs) | **51 / 51** in 23.7 min (`.data/e2e-admin-final.log`): admin 6 (5 desktop + 1 mobile), publishing 26, security 8, v2-product 5, v31-ui 6. The run before it was 50/51: `publishing.spec` failed because the 6-hourly health check had renamed the seeded simulated X destinations — fixed at the root (see IMPLEMENTATION_GAPS) and re-run green. |
| Mobile QA (30 routes × 8 sizes, 10 phone workflows) | 0 horizontal scroll, 10/10 workflows |
| Lab performance | all admin routes within budgets (PERFORMANCE_REPORT.md) |

## §18 synchronization — what each test proves
| Requirement | Test |
|---|---|
| Admin role change affects main-app access | IT "an admin role change affects main-app access on the next request" |
| Membership revocation affects an open session | IT "suspending a membership locks out an already-open session" |
| Main-app scheduled post appears in admin | IT "a post scheduled in the main app appears in admin…" + E2E two-tab test |
| Admin cancellation appears in main app | same IT (post detail shows cancelled) + E2E (`/api/posts/:id` status cancelled) |
| Worker completion updates both | same IT (engine publishes → admin list + main detail) |
| Connection revocation updates diagnostics + affected jobs | IT "revoking a connection updates admin connection health and the affected deliveries" |
| Import appears in content hub + admin history | IT-MCP "a Content hub import appears…" (queued → completed in `adminJobs`, content + jobs markers) |
| MCP-created drafts appear in main + admin | IT-MCP "an MCP-created draft appears in the main app, the admin change feed and the audit log" |
| Analytics sync updates freshness + reports | IT-MCP "an analytics sync updates admin freshness (stale → fresh)…" |
| Two admins editing the same record | IT "two admins rescheduling the same schedule: exactly one wins" |
| Reconnection after missed events / duplicate delivery | IT "missed events reconcile from state; a duplicate poll is a no-op" |
| Stale cache after permission change | IT "stale cache after a permission change…" + session refresh on policy version (client) |
| Normal-operation target + fallback bound | Target ≤ 10 s poll (+ fetch); fallback ≤ 60 s backoff / 60 s safety refetch. Observed in E2E (two tabs, production build): **9.8 s** from the other tab's schedule call to the row appearing; the cancellation disappeared within the same bound |

## §19 security + workflow
| Requirement | Test |
|---|---|
| Cross-workspace id manipulation | IT (detail, cancel, retry, dead-letter requeue, support decision → 404) + E2E (other workspace owner → 404) |
| Unauthorized direct API calls | IT (editor → forbidden on change feed / dead letters; brand-scoped user sees only own brand) + E2E (editor: platform 404, admin overview 403, "Workspace admins only") |
| Private search leakage / platform metadata only | IT "platform views expose metadata only" (secret title/body/brand names absent from every platform response) |
| Export authorization | existing activity export tests (audit.read + exports.create); unchanged |
| Signed media access | existing V2/V3 tests; admin lists never return signed URLs |
| Role escalation | IT (support can't suspend or grant; operator can't change own role) + existing delegation tests |
| Last-owner protection | IT "last-owner protection and offboarding effects…" |
| Offboarding effects on scheduled work | same IT (held publication → admin offers Adopt) |
| Approval invalidation | existing V2 approval tests; admin decisions use the same service |
| Retry after ambiguous outcomes | IT "retry after an ambiguous outcome needs explicit duplicate-risk acceptance" |
| Idempotency under repeated clicks | IT (concurrent requeue → one requeue, one audit row; repeated support approval → invalid_state) |
| CSRF | E2E (POST without token → 403) |
| Secret redaction | IT + UT (`safeError`, platform audit diff redaction) |
| Audit completeness + append-only | IT (support access 3 events in both audits; suspension in both audits; platform audit UPDATE/DELETE → 42501 for app + worker roles) |
| Mobile keyboard/focus | E2E (drawer Escape → focus back on menu) + mobile QA |
| Empty/error/loading/large-data states | every admin page renders skeleton → ErrorState (with reference + retry) → EmptyState; lists are keyset-paged |

## External verification kept separate
Live provider behaviour (real tokens, review status, insights scopes) is not covered here; see activation checklist.
