# HC — Help Centre platform + delivery tooling (progress)

Status: **done** (2026-11-09). Web rebuilt and restarted on :3000 with all HC code. Owner: stream HC.
Brief: `docs/queue/04_DOCUMENTATION_PROMPT.md` §2, §9, §10; contract `docs/DOCS_WORKSTREAMS.md`.

## For content streams (UG / IG / DV) — the published format

The schema lives in code: `packages/services/src/help/schema.ts`, validated by **`node scripts/docs-check.mjs`**
(`pnpm docs:check`; `--strict` makes warnings fail; `--json` for tooling). It prints `file:line message`.

- File: `content/help/<section>/<slug>.md`. **Slug = file name**, kebab-case, **unique across all sections**.
  Glossary: `content/help/glossary.md` (section `getting-started`, URL `/help/getting-started/glossary`).
- Front matter keys (unknown keys fail): `title`, `summary`, `section`, `audience`, `roles`, `status`, `related`,
  `product_version`, `reviewed`, `sources`, plus optional `order` (integer, position in the section, default 100, then
  title A–Z) and `keywords` (extra search terms, e.g. `[2fa, two-factor, authenticator]`).
- `section` must equal the folder. `roles` from `ROLE_PRESETS` (`owner, admin, team_manager, brand_manager, editor,
  approver, publisher, analyst, viewer, exporter, guest, integration, care_agent`) or `platform_staff`.
- `sources`: block list or inline list of `{ title, url, verified }`; url `https://`; verified `YYYY-MM-DD`.
- Body: **no H1** (title comes from front matter); start at `##`; don't skip levels. Raw HTML is escaped, never rendered.
  GFM tables and fenced code work. Callouts: `> **Note:** …`, `> **Tip:**`, `> **Important:**`, `> **Warning:**`.
- Links: `/help/<section>/<slug>` (+ optional `#heading-id`: heading lower-cased, other characters → `-`); app paths that
  exist in `apps/web/app` (e.g. `/settings/publishing/approvals`); `https://…`; `mailto:`. Nothing else.
- Images: `![alt text](/help/img/<section>/<file>.png)`, file in `apps/web/public/help/img/<section>/`; alt required.
- Never: secrets/tokens, non-example emails (use `@example.com` / `*.test`), private IPs, internal hostnames, links to
  `docs/runbooks/`. Local-only dev values containing `local-only`/`example`/`<placeholder>` are allowed.
- Audiences: `public` (anyone) · `user` (signed-in members) · `admin` (workspace.manage on the active workspace, or any
  platform role) · `developer` (signed-in members). Guest-only users (review-link clients) get public only.

## Decisions
- **Renderer:** `markdown-it@15.0.3` (the one new dependency, in `@social-lite/services`). CommonMark + GFM tables built
  in; `html: false` escapes every raw HTML tag; link validation narrowed to `/…`, `#…`, `http(s)://`, `mailto:`
  (markdown-it's default already blocks `javascript:`/`vbscript:`/`file:`/most `data:`); bundled types. Small own deps
  (entities, mdurl, linkify-it, uc.micro, punycode.js, argparse). No YAML library: a strict YAML-subset parser.
- **One implementation** in `packages/services/src/help/*` used by the app (server components + API), both scripts (loaded
  through `tsx`'s `tsImport`) and tests.
- **Routes:** a new route group `app/(help)` owns `/help`, `/help/<section>`, `/help/<section>/<slug>`. Its layout resolves
  the session on the server: signed in → the normal app shell (`AppProviders`), signed out → a minimal public shell. V4's
  `/help/contact`, `/help/requests`, `/help/requests/<ref>` stay in `app/(app)/help` with their sub-nav (now with a
  "Help Centre" item). The old `(app)/help/page.tsx` redirect to `/help/requests` was removed (the Help home replaces it).
- **Audience filtering is server-side only:** `helpViewerFor()` (`packages/services/src/help/access.ts`) uses the session,
  `loadAccess` + `hasAnywhere(workspace.manage)` (MFA state doesn't hide docs) and `platform_operators`. Any failure reads
  as signed out (public only). Pages, `/api/help/search`, related lists, the section sidebar, `/admin/help` and the bundle
  all filter through it. Signed-out readers of a member/admin article see "Sign in to read this article" (no content);
  signed-in readers without the audience get a 404.
- **Search:** in-memory index of title, keywords, headings, summary and body text (light stemming, prefix matching, every
  term must match; title/keywords weigh most). Combobox suggestions (`/api/help/search`, ↑/↓/Enter/Esc, `/` to focus) on
  top of a plain GET form to `/help?q=` (server-rendered results; works without JS).
- **HelpLink:** `<HelpLink slug="…">` → `/help/article/<slug>` (opens in a new tab so forms keep their state); the article
  route resolves the section and redirects to the canonical URL. Settings pages get theirs from the settings registry
  (`help: helpArticleHref('…')`, rendered next to the page title by `settings-shell.tsx`). Literal slugs only — the check
  fails on missing or dynamic slugs.
- **Bundle:** `scripts/docs-bundle.mjs` → `dist/help/relay-help-2026-11.zip` (all four audiences; `--audience`,
  `--out`, `--dir`). In the app, `GET /api/help/bundle` (signed in) builds the same zip for the reader's audiences
  ("Download offline copy" on the Help home). App-path links become plain text offline; links to articles outside the
  bundle are unwrapped. Only `content/help` is read — `docs/runbooks` is never bundled or served.
- **Content in production:** read once from `content/help` (found by walking up from cwd; `HELP_CONTENT_DIR` overrides);
  re-read every 2 s outside production. `infra/docker/Dockerfile` now copies `content/help` and `apps/web/public` into
  the web image (the standalone output contains neither — `public/` was already missing from the image before HC).

## Done
- Library: `packages/services/src/help/{schema,markdown,library,access,check,bundle}.ts`.
- App: `app/(help)/layout.tsx`, `app/(help)/help/page.tsx`, `[section]/page.tsx`, `[section]/[slug]/page.tsx`,
  `app/api/help/search/route.ts`, `app/api/help/bundle/route.ts`, `components/help/*` (frame + breadcrumbs, search,
  HelpLink, icons, public shell, sign-in link, prose CSS), `lib/help-server.ts`, `lib/help-view.ts`, `/admin/help` lists
  admin articles (server component now).
- Entry points: main nav Help (existing) → Help Centre; account menu "Help Centre"; V4 support sub-nav "Help Centre";
  marketing footer "Help Centre" (public).
- Contextual links (44, all checked incl. anchors). Later additions: Analytics (analytics-metric-dictionary),
  Listening (read-listening-results), Inbox (work-in-the-inbox), Team → Invitations / Teams / Held, member page
  (effective-access-and-overlapping-roles), Tasks, Trash, emergency-pause dialog, "Not set up" network dialog
  (set-up-social-network-apps), Connections callback error → connect-social-accounts#common-errors-when-connecting,
  Connection health → connection-status-and-fixes#states-and-fixes; settings registry also: general/brands,
  plan and billing, service levels, saved replies, listening sources, brand voice, inbound sources, usage and limits,
  feature flags, data export. First batch (22): Team (roles-and-permissions), Connections (connect-social-accounts; callback
  error banner → connection-status-and-fixes), Connection health (connection-status-and-fixes), Business apps
  (business-apps-overview), Approvals (approve-or-request-changes), Planner time zone (time-zones-and-dst), Overview
  "Needs attention" (delivery-statuses), Security (set-up-two-step-verification); settings pages: notifications,
  time zone, draft recovery, workspace security, approval policies, posting slots, brand rules, campaign links,
  Google Drive and Docs, Notion, inbox channels, MCP (mcp-server), API and service accounts.
- Tooling: `scripts/docs-check.mjs`, `scripts/docs-bundle.mjs`, `pnpm docs:check` / `pnpm docs:bundle`, CI steps in
  `.github/workflows/ci.yml` after the secret scan: docs-check, DV's `docs-api-check.mjs`, UG's
  `docs-role-matrix.ts --check`, docs-bundle; `scripts/help-shots.mjs` (screenshots + `MOBILE_QA=1`).
- Content: `content/help/getting-started/{what-is-relay, create-your-workspace, find-your-way-around,
  publish-your-first-post, first-steps-for-workspace-admins, use-the-help-centre}.md`, `content/help/glossary.md`.
- Glossary: ~95 terms incl. UG's list (destination, revision, deadline, held/adopt, quorum, separation of duties,
  scope, effective access, restriction, recovery code, support access, listening terms, billing terms…).
- Tests: unit `tests/unit/help-centre.test.ts` (14), integration `tests/integration/help-centre.test.ts` (2),
  E2E `tests/e2e/help-centre.spec.ts` 6/6 (desktop 5 + mobile 1). Full unit suite 644/644. Mobile QA
  (`MOBILE_QA=1 node scripts/help-shots.mjs`): 98 checks at 320–1440, 0 horizontal scroll (`evidence/docs/hc/mobile-qa.json`).
  Screenshots: 56 in `evidence/docs/hc/` (14 screens × 1440/390 × light/dark). Also re-ran v4-support (pass) and
  v5-marketing (allow-list updated for the footer Help Centre link; pass).

## Next (optional)
- More of UG/IG's suggested placements inside dialogs (schedule/publish-now dialogs, composer readiness, review reset
  banner, analytics tooltips/footer) — each is one `<HelpLink slug=… anchor=…>`; the check validates slug + anchor.

## Files
New: `packages/services/src/help/*`, `apps/web/app/(help)/**`, `apps/web/app/api/help/**`, `apps/web/components/help/*`,
`apps/web/lib/help-server.ts`, `apps/web/lib/help-view.ts`, `scripts/docs-check.mjs`, `scripts/docs-bundle.mjs`,
`scripts/help-shots.mjs`, `content/help/getting-started/*` (6), `content/help/glossary.md`, `tests/unit/help-centre.test.ts`,
`tests/integration/help-centre.test.ts`, `tests/e2e/help-centre.spec.ts`.
Removed: `apps/web/app/(app)/help/page.tsx` (redirect to /help/requests; replaced by the Help home).
Edited (shared, small/additive): `tests/e2e/v5-marketing.spec.ts` (allow-list), `package.json` (docs scripts), `packages/services/package.json` + `pnpm-lock.yaml`
(markdown-it; pnpm also re-serialised two eslint snapshot keys), `.github/workflows/ci.yml`, `infra/docker/Dockerfile`,
`apps/web/components/support/customer.tsx` (Help Centre in the support sub-nav), `apps/web/components/shell/user-menu.tsx`,
`apps/web/components/marketing/site-footer.tsx`, `apps/web/components/settings-shell/{registry,settings-shell}.tsx`,
`apps/web/app/(admin)/admin/help/page.tsx`, HelpLink placements in `app/(app)/{team,accounts,accounts/health,approvals,
planner,overview,tasks,trash,team/invitations,team/teams,team/held,team/members/[userId]}/page.tsx`,
`components/{integrations-hub/hub-page,security/security-page,analytics/v3/analytics-shell,listening/overview,inbox/inbox-app,
accounts/connect-dialogs,shell/emergency-pause}.tsx`.

## Coverage rows (HC area)
| Item | Implementation | Article | Status |
|---|---|---|---|
| Help Centre home + search + sections | `app/(help)/help/page.tsx`, `components/help/help-search.tsx`, `/api/help/search` | getting-started/use-the-help-centre | verified (E2E) |
| Article page (sidebar, breadcrumbs, related, version, review date, sources) | `app/(help)/help/[section]/[slug]/page.tsx` | use-the-help-centre | verified (E2E) |
| Audience filtering (public/user/admin/developer, guests) | `packages/services/src/help/access.ts`, `library.ts` | use-the-help-centre | verified (integration + E2E) |
| Contextual help links | `components/help/help-link.tsx` + 44 placements | use-the-help-centre#help-next-to-settings | verified by docs check |
| Offline bundle | `packages/services/src/help/bundle.ts`, `/api/help/bundle`, `scripts/docs-bundle.mjs` | use-the-help-centre#offline-copy | verified (unit, integration) |
| Docs check in CI | `scripts/docs-check.mjs`, `.github/workflows/ci.yml` | — (repo) | verified locally |
| Admin articles in /admin/help | `app/(admin)/admin/help/page.tsx` | — | verified (E2E) |
| Sign-up / onboarding | `app/signup/**`, `app/onboarding/page.tsx` | getting-started/create-your-workspace | from code; not re-run in UI by HC |
| Main nav, top bar, phone bar, search (Ctrl/⌘K) | `components/shell/*` | getting-started/find-your-way-around | from code |

## Discrepancies / notes for the lead
- `infra/docker/Dockerfile` (before HC): the web image never copied `apps/web/public` (standalone output excludes it), so
  brand/marketing static files would 404 in the image. HC added the COPY (plus `content/help`); not built as an image here.
- Pre-existing lint errors (not HC): `react-hooks/set-state-in-effect` in `components/settings-shell/settings-shell.tsx:31`
  and `components/shell/user-menu.tsx:24`.
- Self-serve workspace creation in production needs `ALLOW_SELF_SERVE_WORKSPACES=true` (or an empty install); people who
  already belong to a workspace can't create another (`canCreateWorkspace`). Documented in create-your-workspace.
- Signed-in readers who open an article outside their audience get the "Article not available" page (no content), but
  with HTTP 200: the app shell's Suspense boundary streams before the page calls `notFound()`. Signed out it's a real 404.
- `tests/e2e/v5-marketing.spec.ts` (MKT) allow-list extended with `/help` for the new footer link.
- Overview says **Not confirmed** for the delivery state the badges call **Unknown — needs review** (same thing, two
  labels). Documented both.
