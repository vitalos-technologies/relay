# Documentation + Help Centre workstreams (queue item 9)

Brief: `docs/queue/04_DOCUMENTATION_PROMPT.md` (the user's full brief; read all of it). It was written when the product was
"Social Lite" before V3; the product is now **Relay** (D18) and includes everything through V5 + copy cleanup — document
what exists today. Working code and verified behaviour are the source of truth; existing `docs/**` build notes are inputs,
not truth. Never document planned functionality as available. Rules in `HANDOFF.md`; shared-host conventions in
`docs/v5-progress/STREAM_BRIEFING.md` (lock for rebuilds/Playwright, kill only your own server, no git state changes).
Progress notes `docs/docs-progress/<stream>.md`; screenshots `evidence/docs/<stream>/` and, for articles,
`apps/web/public/help/img/<section>/…` (synthetic data only — use the "Relay Showcase" workspace from
`scripts/seed-marketing-showcase.ts` and the demo/E2E seeds; redact nothing real because nothing real exists).

## Single source for help content (lead decision)
All Help Centre and downloadable documentation comes from **one Markdown source**: `content/help/<section>/<slug>.md`.
The app renders it (HC), the bundle script exports it (HC), the docs check validates it (HC). Front matter (YAML):

```yaml
---
title: Schedule a post            # task-oriented, sentence case
summary: Pick a time, check the time zone, and schedule one or more channels.   # one sentence, used in search + cards
section: calendar-and-scheduling  # one of the sections below
audience: user                    # public | user | admin | developer
roles: [editor, publisher]        # optional: who can do it (role presets from core/authz.ts)
status: available                 # available | needs-setup | needs-provider-approval | not-live-verified | unsupported
related: [publish-now, time-zones-and-dst]   # slugs
product_version: "2026-11"        # Relay release the page describes
reviewed: 2026-11-09              # last review date
sources: []                       # provider rules: [{ title, url, verified: 2026-11-09 }]
---
```

Sections (folder names): `getting-started`, `publishing`, `calendar-and-scheduling`, `analytics`, `teams-and-approvals`,
`social-connections`, `content-sources` (Google Drive, Docs, Notion), `business-apps` (Asana, monday.com, HubSpot, Slack,
Mailchimp, Google Business Profile, Translation), `inbox-and-care`, `listening`, `ai-and-mcp`, `billing-and-plans`,
`account-security`, `support`, `troubleshooting`, `developers`, `administration`. Glossary = `content/help/glossary.md`
(section `getting-started`).

Audience rules (enforced server-side by HC): `public` = anyone (also linkable from the marketing page); `user` = signed-in
members; `admin` = workspace owners/admins (`workspace.manage`) and platform staff; `developer` = signed-in members
(API/MCP reference, no secrets). **Operational runbooks and platform-staff procedures are NOT Help Centre content**: they
live in `docs/runbooks/*.md` (repo only, never served). Never include secrets, internal hostnames, real credentials or
customer data in any page.

Article style: audience + numbered steps + expected outcome + common errors + limitations; plain English; tables for
mappings; consequences spelled out (cancel schedule vs delete published post). Distinguish Relay limits from provider rules
(link the provider's official page with a "last verified" date in `sources`). Screenshots: `![alt](/help/img/...)` with
real alt text, 1440 or 390 px, light theme unless the dark theme is the point.

## Streams

| Stream | Owns |
|---|---|
| **HC** Help Centre platform + delivery | The in-app Help Centre at `/help` (home with search + section cards; keep V4's Contact support and My requests as tabs/links), `/help/<section>/<slug>` article pages (left section sidebar, breadcrumbs, related articles, "Was this useful?" not required), server-side audience filtering, search (title/summary/headings/body of articles the viewer may read; works with keyboard; mobile usable), Markdown rendering with a small, sanitising renderer (justify the dependency), public article access for `audience: public` without sign-in, sidebar entry (Workspace → Help already exists — make it the Help Centre), admin articles visible in `/admin/help`, a reusable `<HelpLink slug=…>` contextual link component and deep links placed beside complex settings, metrics, permissions and integration errors (coordinate slugs with the content streams via progress notes; links to missing slugs fail the docs check). Delivery tooling: `scripts/docs-check.mjs` (front matter schema, sections, audiences, broken internal links/images/related slugs, every `<HelpLink>` slug exists, no secret patterns) wired into `.github/workflows/ci.yml`; `scripts/docs-bundle.mjs` → downloadable static HTML bundle (zip) of public+user+admin+developer articles, linked from the Help Centre for signed-in users. Getting-started articles + glossary. E2E `tests/e2e/help-centre.spec.ts`. |
| **UG** User + admin guide | Brief §3 and §4 (user and workspace-admin side) for everything in the app today: onboarding, workspaces/brands/teams/context, Overview, drafts, shared copy vs channel variants, media (upload, import, albums, video, thumbnails, crops, alt text), templates/campaigns/tags/assignments, previews/limits/validation, publish now, scheduling/time zones/DST, reschedule/pause/cancel, approvals + invalidation, deliveries (partial, retries, unknown outcomes), notifications + preferences + accessibility, every Settings group, collaboration (comments, mentions, tasks, review links, guests), Inbox and care (cases, SLAs, notes vs replies), Listening, Assistant/AI workspace + automation, Billing/plans/trial/seats/usage, Relay support (Help → Contact support, widget), account security (MFA, recovery, sessions, service accounts/API keys), role/permission matrix verified against `packages/core/src/authz.ts`, suspend/remove/ownership transfer/last-owner protection, audit. Troubleshooting catalogue (user-facing) in `troubleshooting/`. |
| **IG** Integrations + analytics dictionary | Brief §5 and §6: one guide per social network present in code (Instagram, Facebook, Telegram, X, TikTok, YouTube, LinkedIn, Threads, Pinterest, Bluesky, WhatsApp/Google reviews for the inbox where present) with eligibility, permissions/approvals, connection, formats, required fields + media constraints, scheduling, analytics, limits, reconnect/revoke/disconnect, failures/remedies, manual handoff — each provider rule checked against current official docs with source links + verified date, Relay limits separated. Content sources (Drive, Docs, Notion: authorisation, selection, imports, snapshots, refresh, permissions, writeback, exports, source deletion, disconnection — never imply copies mirror source sharing). Business apps (Asana, monday.com, HubSpot, Slack, Mailchimp, Google Business Profile, Cloud Translation). Analytics dictionary for every displayed metric (meaning, source, formula/denominator, unit/time basis, scope, daily vs lifetime, refresh delay, platforms, aggregation limits, zero/missing/stale/unsupported), filters/comparisons/charts/exports, worked synthetic examples, why cross-platform reach ≠ unique people, AI insights vs calculated facts. Start from `docs/V3_ANALYTICS_DICTIONARY.md`, `docs/PROVIDER_CAPABILITIES.md`, `docs/v3-5/CAPABILITY_MATRIX.md` but verify in code. |
| **DV** Developer, API, MCP, runbooks | Brief §7 and §8: `developers/` articles (architecture/modules, local setup verified in a clean clone + fresh database, environment reference with placeholders, data model + migrations, authn/authz, API routes/schemas/pagination/errors/idempotency — generate an OpenAPI document from the route handlers if practical, else a generated route reference; provider adapter contracts, media + jobs, delivery state machine, webhooks, analytics ingestion, source import/export, testing/contribution) and MCP (endpoint, protocol/SDK versions, auth, scopes, every tool/resource with arguments/outputs/errors, client setup, tested compatibility, worked examples). Runbooks in `docs/runbooks/` (repo only): deployment/config, health, worker/queue failures, expired provider auth, rate limits/budgets, failed/ambiguous publications, media failures, source-sync failures, MCP failures, emergency pause, migration/rollback, backup restore + publication reconciliation (never blind replay), key rotation + incidents, data export/deletion, billing webhooks/reconciliation, support-widget abuse, AI budget exhaustion — each with symptoms, diagnostics, actions, verification, escalation; destructive commands flagged. A CI check that fails when API routes or MCP tools change without the reference being regenerated (or the generated reference is stale). |

**Lead (final):** documentation coverage matrix (`docs/help/COVERAGE_MATRIX.md`: every page/subpage, significant action,
role/permission, integration, configuration field, API/MCP operation, background process → implementation location, article
slug, verification status), verification report, implementation discrepancies found while documenting, the consolidated
activation checklist + user reminder. Streams record coverage rows for their areas in their progress notes as they go
(same columns) so the lead can assemble the matrix; report bugs/discrepancies there too — do not fix product code beyond
help links (HC) unless trivial and clearly a bug, and say so.

Order: all four start together. HC publishes the front-matter schema in code (`content/help/_schema` or the check script)
early; content streams write to the format above from the start. Content streams don't edit app code except where HC asks
for a `<HelpLink>` placement in their areas (HC places them).
