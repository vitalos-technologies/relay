# Documentation + Help Centre — verification report

Date 2026-11-09 · branch `claude/dazzling-pasteur-8yny50` · production build on the dev host (fresh worker build, fresh
E2E seeds). Brief: `docs/queue/04_DOCUMENTATION_PROMPT.md`. Streams: HC (Help Centre platform), UG (user + admin guide),
IG (integrations + analytics), DV (developer, API, MCP, runbooks). Progress notes: `docs/docs-progress/*.md`.

## What exists

| Deliverable | Where |
|---|---|
| In-app Help Centre (search, sections, breadcrumbs, related articles, audience filtering, public view, 44 contextual help links + 27 settings pages) | `/help`, `/help/<section>/<slug>`, `/admin/help`; code `packages/services/src/help/*`, `apps/web/app/(help)/*` |
| Version-controlled article source (single source for app + bundle) | `content/help/**` — 164 articles: public 12 · user 121 · admin 14 · developer 17; glossary ~95 terms |
| User and workspace-admin guide | `content/help/{publishing,calendar-and-scheduling,teams-and-approvals,account-security,inbox-and-care,listening,ai-and-mcp,billing-and-plans,support,troubleshooting,administration}` |
| Integration guides (10 networks, Drive/Docs, Notion, 7 business apps, inbox channels) | `content/help/{social-connections,content-sources,business-apps,inbox-and-care}` — provider rules sourced from official docs, verified 2026-11-09; unverifiable rules marked "not verified" |
| Analytics dictionary | `content/help/analytics/*` + `docs/V3_ANALYTICS_DICTIONARY.md` (matches the code registry) |
| Developer, API and MCP reference | `content/help/developers/*` (generated API route + MCP tool references); repo-only `docs/api/openapi.json` (OpenAPI 3.1, 671 handlers), `docs/api/routes.md`, `docs/api/mcp.json` |
| Operational runbooks (repo only, never served) | `docs/runbooks/` — index + 19 |
| Downloadable bundle | `node scripts/docs-bundle.mjs` → `dist/help/relay-help-2026-11.zip`; in-app "Download offline copy" (filtered to the reader's audience) |
| Coverage matrix | `docs/help/COVERAGE_MATRIX.md` (185 rows) |
| Discrepancies and bugs found while documenting | `docs/help/DISCREPANCIES.md` (45: 7 High, 24 Medium, 14 Low) |
| Consolidated activation checklist | `docs/FINAL_ACTIVATION_CHECKLIST.md` (116 rows, 63 launch-blocking; the user's four reminders first) |

## Checks (final tree)

| Check | Result |
|---|---|
| Typecheck (repo + web) | clean |
| Unit + contracts | **644 / 644** (47 files) |
| Integration (disposable DBs) | **594 / 594** (68 files) — incl. Help Centre audience filtering (a member never gets an admin article via page, search or bundle) |
| Full E2E (all V1–V5 + Help Centre specs, 54.3 min) | **119 passed, 0 failed, 9 skipped** (skips = desktop project skipping `@mobile` tests) |
| `node scripts/docs-check.mjs` | 164 articles, 44 in-app help links, 656 app routes checked, **0 errors** (front matter, links, anchors, images + alt text, related slugs, help-link slugs/anchors, unsafe links, secrets, real emails, private IPs, internal hosts, runbook links) |
| `node scripts/docs-api-check.mjs` | up to date (API routes, MCP tools, env reference) |
| `npx tsx scripts/docs-role-matrix.ts --check` | role matrix matches `authz.ts` |
| Help Centre mobile QA (14 screens × 7 widths) | 98 checks, 0 horizontal scroll |
| Secret scans (tracked + untracked) | clean |
| Documented local setup on a clean copy with its own database (DV) | passed: install, migrate (34), seed, worker, web, Keycloak sign-in, API guards, MCP over HTTP with an API key; torn down afterwards |

CI (`.github/workflows/ci.yml`) now runs the docs check, the API/MCP/env reference check, the role-matrix check and the
bundle build.

## Uncertain / not verified
- No integration was exercised against a live account (no credentials or approvals here); provider rules are dated and
  sourced, and several are marked "not verified" in the articles (IG note).
- Workflows were checked against code, rendered pages (67 pages as the Demo Workspace owner) and the existing E2E suites —
  not re-performed by hand for every role; views for editor, care agent, guest portal and team manager were not
  rendered for the guide.
- The sign-up/onboarding article (`create-your-workspace`) was written from the code, not clicked through for the guide
  (the V5 E2E covers that flow).
- Production build of the Docker image, real email delivery, real AI output, Stripe live, MCP OAuth with a real external
  client.
- A signed-in member who opens an admin article sees "Article not available" with HTTP 200 (signed out: 404).

## Where each audience starts
- **New user:** `/help` → Getting started.
- **Workspace owner/admin:** `/help` → Teams and approvals → role matrix; Administration → map of every Setting;
  `/admin/help`.
- **Developer / AI client:** `/help/developers` → local development setup, API conventions, MCP server.
- **Operator / Relay staff:** `docs/runbooks/README.md` (repo) and `docs/FINAL_ACTIVATION_CHECKLIST.md`.
