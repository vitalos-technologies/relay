# V3 requirements matrix

One row per requirement in the V3 spec ([docs/specs/V3_UPGRADE_PROMPT.md](specs/V3_UPGRADE_PROMPT.md); § numbers match). Updated 2026-11-07 after the UX redesign landed (`main` @ c6a8c0a, tag `v3.0.0`).

Status: **Done (tested)** · **Done (untested)** · **Partial** · **Not started** · **Blocked (external)** · **Unsupported by provider**. "Tested" means an automated test in this repo covers it. Provider, Google, Notion and MCP-client behaviour is tested against **labelled fakes and recorded-request transports only**. Nothing has been verified live. Results: [V3_SECURITY_AND_TEST_REPORT.md](V3_SECURITY_AND_TEST_REPORT.md). Gaps: [V3_IMPLEMENTATION_GAPS.md](V3_IMPLEMENTATION_GAPS.md).

**UX:** the redesign landed in 3e5e3f2 and 95f8e34. Rows are classified from [v3-progress/ux.md](v3-progress/ux.md), [V3_DESIGN_SYSTEM.md](V3_DESIGN_SYSTEM.md), `apps/web` and `evidence/v3/ux/`. The stream's own open items are:
- Approvals detail polish;
- Settings pages that need backend first (Retention, Guests, Webhooks, Recovery, AI usage);
- a keyboard / screen-reader pass.

Test keys (under `tests/`):

| Key | File | Key | File |
|---|---|---|---|
| **MCP** | `integration/mcp.test.ts` | **MCPu** | `unit/mcp.test.ts` |
| **CH** | `integration/content-hub.test.ts` | **CHu** | `unit/content-hub.test.ts` |
| **AN** | `integration/v3-analytics.test.ts` | **ANP** | `integration/v3-analytics-pipeline.test.ts` |
| **ANu** | `unit/v3-analytics-semantics.test.ts` | **VC** | `integration/v3-connections.test.ts` |
| **RS** | `integration/v3-remote-schedule.test.ts` | **YE** | `integration/v3-youtube-early-upload.test.ts` |
| **EH** | `integration/engine-handoff.test.ts` | **DB** | `integration/db-roles.test.ts` |
| **UH** | `unit/security-headers.test.ts` | **C:‹p›** | `contracts/v3-‹p›.test.ts` |
| **TA** | `contracts/transport-allowlist.test.ts` | **MV** | `integration/media-video*.test.ts` |
| **EN** | `integration/engine.test.ts` | | |

Code roots: `core/` = `packages/core/src`, `svc/` = `packages/services/src`, `prov/` = `packages/providers/src`, `web/` = `apps/web`, `mig/` = `packages/db/migrations`.

## §1 Preserve and verify the foundation

| ID | Requirement | Status | Evidence | Notes |
|---|---|---|---|---|
| 1.1 | Baseline build and regression results | Done (tested) | `docs/V2_TEST_REPORT.md`; [V3_SECURITY_AND_TEST_REPORT.md](V3_SECURITY_AND_TEST_REPORT.md) | All passed |
| 1.2 | V2 isolation/permissions apply to new integrations, analytics, exports and MCP | Done (tested) | CH "…another tenant", "a queued import fails when the requester lost access…"; AN "cross-tenant ids are not found…"; MCP "cross-workspace tools, results and resources never leak…" | Search is V3.1 DATA |
| 1.3 | Durable jobs, outbox, idempotency, Unknown + reconcile; no blind retries for new providers | Done (tested) | each C:‹p› "timeout_after_send ⇒ unknown ⇒ reconciled"; EN | |
| 1.4 | Live publication only to designated test destinations | Blocked (external) | — | No credentials or test destinations supplied |

## §2 Screenshot problems

UI evidence for this and the next three sections is `evidence/v3/ux/<screen>-<1440|390>-<light|dark>.png` (104 shots) plus `evidence/v3/ux/checkpoints/*`. **E2E** = `tests/e2e/*.spec.ts`, 39/39 passing on a production build. Of those, `publishing.spec` "‹path› renders without errors" is a smoke test covering `/`, `/planner`, `/compose`, `/approvals`, `/library`, `/history`, `/accounts`, `/settings` and `/operations` on desktop and mobile.

| ID | Requirement | Status | Evidence | Notes |
|---|---|---|---|---|
| 2.1 | Every page has a clear purpose and primary action | Done (untested) | `docs/V3_DESIGN_SYSTEM.md` "Principles"; `web/components/ui/card.tsx` `PageHeader` | E2E smoke only |
| 2.2 | Meaningful info above the fold (trends, attention, upcoming, health) | Done (untested) | `web/app/(app)/page.tsx`; `overview-*.png` | |
| 2.3 | Charts, compact tables and thumbnails instead of oversized rows | Done (untested) | `web/components/ui/data-viz.tsx`; `web/app/(app)/analytics/**`; `analytics-*.png` | |
| 2.4 | Progressive disclosure (logs/diagnostics in drawers) | Done (untested) | `DetailDrawer` (`ui/layout.tsx`); `planner/post-drawer.tsx`; analytics content drawer | |
| 2.5 | Demo status shown once; live and demo never mixed | Done (tested) | AN "synthetic demo data never appears in live queries…"; `components/analytics/v3/shared.tsx` `DatasetNotice`; shell demo strip | The banner itself is untested |
| 2.6 | Unavailable metrics shown as coverage, not repeated empty cards | Done (untested) | Coverage footer (`CoverageMeter`, `shared.tsx` health labels); API states ANu | |
| 2.7 | Realistic synthetic demo content; E2E fixtures out of user data | Done (tested) | `scripts/seed-e2e.ts` ("E2E Workspace"), `tests/e2e/global-setup.ts`, `helpers.useE2EWorkspace`; E2E 39/39 runs there | Demo workspace stays clean |
| 2.8 | Check readiness vs delivery errors vs connection health | Partial | Readiness is grouped in the composer (`composer.tsx` "Readiness"); health centre (`/accounts/health`) | No written assessment of disagreements found |

## §3 Design system

| ID | Requirement | Status | Evidence | Notes |
|---|---|---|---|---|
| 3.1 | Tokens, dark and light themes | Done (untested) | `web/app/globals.css`; `docs/V3_DESIGN_SYSTEM.md` "Tokens" | Relay palette replaces lime (D19) |
| 3.2 | Type scale, 4/8 spacing, radius, 240/72 px nav | Done (untested) | `--nav-w` 240 / `--rail-w` 72, `--radius-card` 14px, Inter 14px body / 28px titles | |
| 3.3 | Motion 120–220 ms; reduced motion | Done (untested) | 140–180 ms `anim-*`; `prefers-reduced-motion` disables them (design doc) | |
| 3.4 | Shared components (PageHeader … SettingsShell) | Done (untested) | `web/components/ui/{card,layout,data-viz,feedback,badge,table}.tsx`, `settings-shell/*` | DataTable = `Table` + `SortTh` |
| 3.5 | Accessible charts: line styles, keyboard summaries, table alternative | Done (untested) | `data-viz.tsx` `ChartPanel` (chart ↔ table, sr-only summary), `LineChart` (←/→/Home/End, dashed previous period) | No automated a11y check |
| 3.6 | Dynamic: persistent filters, saved views, shortcuts, drawers | Partial | URL filters (`FILTER_QUERY_KEYS`), drawers, chart keyboard nav | No saved-views UI (API exists); no global keyboard shortcuts |
| 3.7 | Fast first loads, measured | Partial | Server side: `docs/PERFORMANCE_RESULTS.md` (V3.1 PERF) | Browser metrics not measured |

## §4 Navigation and left-sidebar Settings

| ID | Requirement | Status | Evidence | Notes |
|---|---|---|---|---|
| 4.1 | Primary nav items; Operations/Setup in a separate admin area | Done (untested) | `web/components/shell/app-shell.tsx`; design doc "Navigation" | Admin group = Setup, Operations, Activity |
| 4.2 | Settings in a grouped left nav; no horizontal tabs; deep links | Done (tested) | `web/app/(app)/settings/[group]/`, `components/settings-shell/registry.tsx`; E2E `v2-product.spec` opens `/settings/operations/export` | |
| 4.3 | Keep scope, active route, expanded group and back/forward | Done (tested) | Legacy `?tab=` server redirects keep other params; E2E `security.spec` (`/settings?tab=security`) and `v2-product.spec` (`?tab=budgets`) | Back/forward not asserted |
| 4.4 | Eight groups and their sub-settings | Partial | `registry.tsx`: 8 groups | Missing: Retention, Guests, Webhooks, Recovery, AI provider/usage (need backend first). Sessions are inside Security |
| 4.5 | Groups permission-aware and authorized on the server | Done (untested) | `visible: (p) => p.canV2(…)` per item; routes keep `requireAction` | |
| 4.6 | Settings search that doesn't leak inaccessible pages | Done (untested) | Settings shell search over visible items only | |
| 4.7 | Mobile: left drawer with breadcrumb/back | Done (untested) | Drawer + breadcrumb under 1024 px; `settings-390-*` evidence | |

## §5 Overview, Planner, Composer

| ID | Requirement | Status | Evidence | Notes |
|---|---|---|---|---|
| 5.1 | Overview: ≤4 tiles, upcoming with thumbnails, attention queue, channel health, performance | Done (untested) | `web/app/(app)/page.tsx`; `overview-*.png` | Performance from the analytics contract |
| 5.2 | Marketing vs operational kept apart; severity-ranked actionable items | Done (untested) | Attention queue incl. Manual handoff (ux.md item 2) | |
| 5.3 | Planner: week/month/list, thumbnails, filters, side drawer | Done (untested) | `web/app/(app)/planner/page.tsx`, `planner/post-drawer.tsx`; `planner-{week,month,list,drawer}-*.png` | `readmodels.ts` adds `thumb_url` |
| 5.4 | Drag to reschedule through revision/approval; conflicts, timezones; mobile agenda | Done (untested) | `planner/page.tsx` `onDropDay` → reschedule dialog; conflict/expired/other-zone markers; List default on phones | No calendar subscriptions exist; content-plan exports are permission-checked (CH) |
| 5.5 | Composer: three regions with a generous live preview | Done (untested) | `web/components/composer/*`; three regions ≥ 1280, steps on phones; `composer-*.png` | |
| 5.6 | Composer tools: chips, snippets, link/CTA, voice, alt text, crops, poster, progress, autosave; no silent truncation | Partial | Destination search, AI assist, crops, `ordered-media-strip.tsx` reorder, autosave status (`composer.tsx`) | No reusable snippets |
| 5.7 | Destination picker for 10 networks; feed/vertical/video/Pin previews labelled approximate | Done (untested) | `composer/destination-rail.tsx`, `composer/preview.tsx` | |
| 5.8 | Provider-required fields; Save/Submit/Schedule/Publish by role; published = read-only history | Done (tested) | `composer/provider-options.tsx`; server: C:tiktok, C:youtube validation; E2E `publishing.spec` compose → publish, `v2-product.spec` readiness preflight | Read-only published view: `composer-published-*.png` |

## §6 Platform coverage and capability states

| ID | Requirement | Status | Evidence | Notes |
|---|---|---|---|---|
| 6.1 | Instagram, Facebook, Telegram, X regression-protected | Done (tested) | `tests/contracts/{meta,meta-media,telegram,telegram-media,x,x-media,x-revoke}.test.ts` | Fakes only |
| 6.2 | TikTok: video/photo via Content Posting API; inbox and manual modes | Done (tested) | `prov/tiktok/*`; C:tiktok (35) | Fakes only |
| 6.3 | YouTube: resumable upload, metadata, explicit privacy, native scheduling | Done (tested) | `prov/youtube/*`; C:youtube (29); RS; YE | Fakes only |
| 6.4 | LinkedIn: member posts; organisation posts only with an approved role | Done (tested) | `prov/linkedin/*`; C:linkedin (29) "destinations: … posting roles selectable, others not" | Org scopes behind `LINKEDIN_ORGANIZATIONS` |
| 6.5 | Threads: own OAuth; text/image/video/carousel | Done (tested) | `prov/threads/*`; C:threads (24) | No Facebook permission reuse |
| 6.6 | Pinterest: Pins on an explicitly chosen board | Done (tested) | `prov/pinterest/*`; C:pinterest (22) "destinations are boards (explicit choice)…" | |
| 6.7 | Bluesky: text/images with rich-text facets | Done (tested) | `prov/bluesky/*`; C:bluesky (25); VC | App password, not atproto OAuth |
| 6.8 | Bluesky video and other formats | Not started | `prov/bluesky/adapter.ts` refuses video | Spec: "only when verified" |
| 6.9 | Live validation for each new provider | Blocked (external) | `docs/PROVIDER_CAPABILITIES.md` "Live-test status for all six: not tested" | Needs developer apps and reviews |
| 6.10 | Official APIs only; no scraping or browser publishing | Done (tested) | TA; `prov/transport/http.ts` allow-list | |
| 6.11 | WhatsApp/Snapchat/Reddit are not presented as feed adapters | Done (untested) | `core/types.ts` `PROVIDERS` (10 only) | WhatsApp is queued as V3.5 inbox, not publishing |
| 6.12 | Connection states (available, connected, missing permission, awaiting approval, unsupported, reconnect, manual handoff) | Done (untested) | `web/lib/client/capability-state.ts`, `components/accounts/capability-badge.tsx`; backend: `core/types.ts` `eligibility.status`, `mig/019` `handoff` state, EH; `connections-*.png` | Publishing and analytics listed separately per card |
| 6.13 | Capabilities modelled independently (formats, analytics, edit/delete, comments, media prep, native scheduling) | Partial | `core/types.ts` `ChannelCapabilities` (`publishMode`, `nativeScheduling`, `eligibility`, `requiredOptions`) | No `comments` field. Meta and X still report `canReadMetrics:false` even though metrics fetchers exist |
| 6.14 | TikTok: eligibility honest, no promise of public autopublish, labelled manual handoff | Partial | C:tiktok "capabilities per mode…", "manual handoff package is labelled manual…"; EH; composer banners (`provider-options.tsx`) | The download / open-app action is still not wired (`tiktokManualHandoff()` has no caller) |
| 6.15 | YouTube: explicit privacy; not "published" until state allows; no hard-coded unaudited rule | Done (tested) | C:youtube "init (exact URL, headers, explicit privacy)…" | |
| 6.16 | Versioned provider register (source, date, scopes, version, limits, review, formats, live evidence) | Done (untested) | `docs/PROVIDER_CAPABILITIES.md`, `docs/providers/*.md`, `docs/V3_PLATFORM_CAPABILITIES.md` | Live evidence column: none |

## §7 Video and asynchronous publishing

| ID | Requirement | Status | Evidence | Notes |
|---|---|---|---|---|
| 7.1 | Resumable uploads | Partial | Provider side: C:youtube "resume after a failed chunk…", C:tiktok "70 MB video…resumes", C:linkedin "video…resumes" | Browser → storage is a single presigned POST (≤ 300 MB), not resumable |
| 7.2 | Real MIME/codec/dimension/duration validation | Done (tested) | `svc/media/video.ts` (ffprobe); MV | V1.1 |
| 7.3 | Thumbnails; optional bounded transcoding | Done (tested) | MV "transcodes an incompatible MOV…" | One publish derivative ≤ 1280×1024 |
| 7.4 | Progress, cancellation, processing polling, checkpoints | Partial | Polling and checkpoints: C:‹p› "processing ⇒ polls…"; video upload progress (`web/components/media/video-upload.tsx`, XHR) | No user-facing upload cancel |
| 7.5 | No huge uploads buffered in web memory | Done (untested) | `svc/storage.ts` presigned POST; Drive bytes fetched in the worker (`svc/content-hub/google.ts`) | |
| 7.6 | Workspace storage, upload size and processing budgets | Partial | `svc/product/budgets.ts` `storage.bytes`; V2 `v2-product` "storage reserve-before-presign" | No processing-time budget |
| 7.7 | No watermark removal or unlicensed music reuse | Done (untested) | No such feature; TikTok music consent required (C:tiktok validation) | |
| 7.8 | Separate upload/prepare/accept/process/visible; remote ids persisted; retries resume | Done (tested) | C:‹p› checkpoint tests ("a lost final chunk is resolved from the checkpoint…") | |
| 7.9 | Worker restarts keep progress; dedicated heavy-media jobs | Done (tested) | `svc/media/video-worker.ts`; MV; checkpoints in `deliveries` | |
| 7.10 | One scheduling owner per delivery; YouTube native schedule state stored | Done (tested) | `svc/engine/{remote-schedule,provider-scheduling}.ts`; RS; YE | |
| 7.11 | Pause surfaces native schedules, tries to cancel, reports residual risk | Done (tested) | RS "an unconfirmed cancellation keeps the delivery visible with the residual risk…" | |
| 7.12 | Reconcile provider state after restart before resending | Done (tested) | EN; C:‹p› "timeout_after_send ⇒ unknown ⇒ reconciled" | |

## §8 Analytics as a product

| ID | Requirement | Status | Evidence | Notes |
|---|---|---|---|---|
| 8.1 | Default view is an overview, not a raw post list | Done (tested) | API: `svc/analytics/query.ts` `overview` (AN, MCP "analytics_overview…"); UI `web/app/(app)/analytics/page.tsx` (KPIs, trend + previous period, channels, top content, insights); `analytics-*.png` | UI itself untested |
| 8.2 | Persistent filters, timezone, previous period, freshness, coverage; URL state without private data; access rechecked | Done (tested) | `svc/analytics/filters.ts`; ANu "serialises canonically (ids/dates only)…"; ANP "saved views…re-check access"; UI URL filters (`components/analytics/v3/shared.tsx`) | |
| 8.3 | Content view: sortable, paginated table with drilldown | Done (untested) | `query.ts` `contentTable`/`contentDetail`; `web/app/(app)/analytics/content/page.tsx` (table + `DetailDrawer`); `analytics-content-*.png` | |
| 8.4 | Channels view: native metrics, follower snapshots | Partial | AN "serves native channel metrics…"; `analytics/channels/page.tsx` | No adapter fetches followers (`not_fetched`) |
| 8.5 | Video view: views, watch time, retention | Partial | AN "…video ratio-of-sums…"; `analytics/video/page.tsx` | Retention metrics not fetched |
| 8.6 | Audience: provider aggregates only, otherwise an honest state | Partial | AN "…honest audience/best-time states"; `analytics/audience/page.tsx` | No audience fetchers; always an explanatory state |
| 8.7 | Team and workflow view (no employee score) | Done (untested) | `query.ts` `workflow`; `analytics/workflow/page.tsx`; `analytics-workflow-*.png` | No test names it |
| 8.8 | Reports: saved views, CSV/PDF, export to Drive/Docs/Notion | Partial | Backend: ANP "CSV export reproduces…", "exports re-check authority…external destinations go through ReportExporter"; worker registers `contentHubExporter`. UI: Export CSV/PDF menu (`analytics-shell.tsx`) | UI has no saved views and no Drive/Notion destination (download only). PDF needs Chromium |
| 8.9 | Charts: tooltips, intervals, toggles, drilldown, table alternative; detail drawer | Done (untested) | `ui/data-viz.tsx` (crosshair tooltip, legend, chart ↔ table), content drawer | |
| 8.10 | Chart type by question; best time hidden when evidence is thin | Done (tested) | Lines for trends, `BarList` for channels, ranked table for content; `query.ts` `bestTime` + AN best-time states | Best time has no UI (hidden by default) |
| 8.11 | Comparison: zero/missing baseline ⇒ New/insufficient | Done (tested) | ANu "baseline zero ⇒ new, missing ⇒ insufficient…"; AN | |
| 8.12 | Reports reproduce scope, filters, tz, metrics, observed time and coverage | Done (tested) | ANP CSV manifest test | |

## §9 Analytics semantics and pipeline

| ID | Requirement | Status | Evidence | Notes |
|---|---|---|---|---|
| 9.1 | Metric registry (id, name, unit, scope, aggregation, basis, paid, availability, retention, version) | Done (tested) | `svc/analytics/registry.ts` (70 definitions); ANu "registry…"; AN "maps every metric the 10 provider fetchers request…" | `docs/V3_ANALYTICS_DICTIONARY.md` generated |
| 9.2 | Native metrics separate from app operational facts | Done (untested) | Measures table: `posts_published` from app records | |
| 9.3 | No summed unique reach, unlabelled totals or summed snapshots; ratio-of-sums rates | Done (tested) | AN "never combines views + impressions…", "is Σ engagements ÷ Σ views…"; ANu | |
| 9.4 | Cumulative snapshots separate from time buckets; labelled deltas; no fabricated history | Done (tested) | AN "stores lifetime counters as as-of snapshots…"; `mig/015` | |
| 9.5 | Distinct states (zero, unsupported, permission, not fetched, stale, delayed, partial, failed); coverage and through-date | Done (tested) | AN "keeps observed 0, not-reported and unsupported…distinct", "counts only the selected accounts and reports the through-date" | Charts break lines at `null` (`LineChart`) |
| 9.6 | Deletion and lost-access retention | Done (tested) | `svc/analytics/retention.ts`; ANP "revoked access stops sync…" (purge) | |
| 9.7 | Pipeline: cursors, checkpoints, bounded backfill, quota-aware, retry, late corrections | Done (tested) | ANP "checkpoints, never duplicates…", "rate limits stop the run…"; AN "upserts on the fact key…" | |
| 9.8 | Unmapped native posts (when allowed), labelled as imported | Not started | — | Only Relay-published posts are synced |
| 9.9 | Schema: definitions, observations, facts, sync runs/cursors, reports, coverage | Done (tested) | `mig/015_v3_analytics.sql` | Plus cumulative facts, rollups |
| 9.10 | Unique fact keys; dedupe on retry | Done (tested) | AN "upserts on the fact key: retries do not duplicate…" | |
| 9.11 | No paid data; YouTube revenue excluded; no ROI claims | Done (untested) | registry `youtube.video.estimatedRevenue` = excluded | |
| 9.12 | Insights cite data; calculated vs AI interpretation | Done (untested) | `query.ts` insights `kind:'calculated'` + `basis` | No AI insights exist |
| 9.13 | Demo fixtures isolated; live empty state never shows seeded numbers | Done (tested) | AN "synthetic demo data never appears in live queries…"; `mig/015` `is_synthetic`; `DatasetNotice` | |

## §10 Google Drive and Docs

| ID | Requirement | Status | Evidence | Notes |
|---|---|---|---|---|
| 10.1 | Content connection separate from sign-in and YouTube; workspace/brand scoped | Done (tested) | CH "Google content OAuth: drive.file only, PKCE, separate grant…" | |
| 10.2 | Selection via Google Picker | Partial | `web/components/content-hub/google-picker.ts`; server checks: CH "Picker-selected file imports…arbitrary/private ids are rejected" | Browser Picker untested end to end |
| 10.3 | `drive.file` only; no whole-Drive; folders not recursive | Done (tested) | CH OAuth tests | Folder sync (`drive.readonly`) not built (optional) |
| 10.4 | Drive media import: preview, server verify, bounded fetch, validate, immutable snapshot, provenance | Done (tested) | CH "Picker-selected file imports…", "shortcuts resolve…denied downloads and trashed files are explicit" | |
| 10.5 | Docs import: tabs/sections, structure, explicit suggestions mode, no comments, warnings | Done (tested) | CH "tabs/sections, headings, lists, links…"; CHu | |
| 10.6 | Choose sections, brands, destinations; drafts or campaign; works without AI | Done (tested) | CH import tests | AI repurposing not built (optional) |
| 10.7 | Snapshot vs linked source; revocation hides previews; retention, hold, delete | Done (tested) | CH "access loss stops refresh, hides linked previews, keeps snapshots…" | |
| 10.8 | Refresh ⇒ diff + new revision; approved/scheduled never mutated; dispatch uses app assets | Done (tested) | CH "source change ⇒ new snapshot + diff…", "source changed after preview ⇒ import refused" | |
| 10.9 | Export: new Doc in a chosen folder, sharing warning, no ACL changes | Done (tested) | CH "new Doc in a selected folder…ACLs never touched" | |
| 10.10 | Manual refresh; optional watch notifications (authenticated, deduped, renewed, bounded) | Done (tested) | CH "Drive watch: token-authenticated, deduped…" | Renewal timer untested |
| 10.11 | Live Google verification | Blocked (external) | — | Needs a Google Cloud project and OAuth client |

## §11 Notion

| ID | Requirement | Status | Evidence | Notes |
|---|---|---|---|---|
| 11.1 | Public OAuth; internal token only for test installs; pinned API version | Done (tested) | CH "Notion public OAuth: Basic auth…pinned Notion-Version…" | `2026-03-11` |
| 11.2 | Page import with preview | Done (tested) | CH "recursive bounded blocks…" | |
| 11.3 | Data source selection and property mapping | Done (tested) | CH "mapping validation…"; CHu "rejects malformed mappings…" | |
| 11.4 | Row import: row-level errors, idempotent | Done (tested) | CH "…idempotent row import…" | |
| 11.5 | Opt-in writeback to mapped properties | Done (tested) | CH "writeback: opt-in, single mapped property only…" | |
| 11.6 | Export to a chosen parent page or data source | Partial | CH "content plan to a new Notion page under a selected parent" | Parent page only |
| 11.7 | Recursive bounded blocks; unsupported disclosed; fingerprints; hosted files copied; database vs data source | Done (tested) | CH "recursive bounded blocks…expired URLs never stored", "very long pages are flagged incomplete…" | |
| 11.8 | Notion "Approved" is not Relay approval; properties never become roles | Done (tested) | CHu "statuses are labels only"; CH row import | |
| 11.9 | Field-scoped writeback; no loops; conflicts reviewed; disconnect stops it | Done (tested) | CH writeback test; CHu "writeback payload touches one property…" | |
| 11.10 | Webhooks verified, deduped, signals only | Done (tested) | CH "Notion webhooks: signature verified…"; CHu "sha256= HMAC" | |
| 11.11 | Live Notion verification | Blocked (external) | — | Needs a public Notion integration |

## §12 Content Hub

| ID | Requirement | Status | Evidence | Notes |
|---|---|---|---|---|
| 12.1 | Library hub: uploads, Drive, Docs, Notion, Templates; source cards | Done (untested) | `web/app/(app)/library/page.tsx` (Media / Templates / Sources); `evidence/v3/content-hub/*` | No E2E |
| 12.2 | Connections in the Settings tree; selection from Composer and Library | Done (untested) | `/settings/connections/google` and `/settings/connections/notion` (`registry.tsx`); OAuth returns there (11e215f); Composer "From Drive or Notion"; `settings-sources-*.png` | |
| 12.3 | Scoped tables with authorizing identity; jobs recheck authority | Done (tested) | `mig/016`; CH "a queued import fails when the requester lost access…" | |
| 12.4 | Import pipeline and idempotency keys; deliberate duplicates allowed | Done (tested) | CH "…retries dedupe"; `copy_nonce` | |
| 12.5 | App-owned code, shared schema and workers | Done (tested) | `svc/content-hub/jobs.ts`; queues `source-import`, `report-export`, `writeback` | |

## §13 First-party MCP server

| ID | Requirement | Status | Evidence | Notes |
|---|---|---|---|---|
| 13.1 | Official SDK, pinned revision, Streamable HTTP `/mcp`, lifecycle, cancellation | Done (tested) | `web/app/mcp/route.ts`, `svc/mcp/server.ts`; MCP "negotiates the pinned revision…", "honours cancellation…" | SDK 1.32.2, protocol 2025-11-25 |
| 13.2 | Initial tool surface (8 groups) | Done (tested) | `svc/mcp/tools.ts` (27 tools); MCP "lists every tool with schemas and accurate annotations" | |
| 13.3 | Explicit ids, bounded ranges, expected versions, idempotency keys; typed results; safe errors | Done (tested) | MCP "creates, reads, updates and validates drafts…", "paginates with bounded page sizes…"; MCPu catalogue | |
| 13.4 | Safe resources; prompts grant nothing; no SQL/shell/fetch/token/role tools | Done (tested) | `svc/mcp/resources.ts`; MCP "…resources never leak" | |
| 13.5 | Authentication required; OAuth resource server with protected-resource metadata; reuse an existing AS | Done (tested) | MCP "serves RFC 9728 protected-resource metadata…"; Keycloak `relay-mcp` | |
| 13.6 | Validate iss/aud/exp/scopes; revocation; membership checks | Done (tested) | MCP "rejects expired, wrong-audience…", "a revoked client is rejected…" | |
| 13.7 | No token passthrough | Done (tested) | `svc/mcp/auth.ts`; MCP "prompt injection…leaks no secrets" | |
| 13.8 | Effective permission = intersection; no cross-tenant or confused-deputy actions | Done (tested) | MCP "403 insufficient_scope…", "a read-only client…cannot mutate…", "…brand consent narrows access" | |
| 13.9 | Scope set; default read/draft; service-account limits; Origin/Host; rate/size limits; sessions ≠ authority | Done (tested) | MCP "validates Origin/Host…", "service-account API keys work as scripted principals…" | |
| 13.10 | prepare/commit intents; changes invalidate; repeats return the original | Done (tested) | MCP "prepare → fabricated confirmation rejected → … commit once", "any change after prepare invalidates the intent…" | |
| 13.11 | Trusted confirmation or policy grant; model `confirmed:true` ignored | Done (tested) | MCP "an automation policy grant covers commits…" | |
| 13.12 | Revoke client/policy; pause any time; ambiguity returns choices | Done (tested) | MCP "publishing pause is identical to the UI…"; `needs_choice` asserted in the stale-intent test | |
| 13.13 | Untrusted content; audit without private text | Done (tested) | MCP "prompt injection inside post content authorizes nothing…"; `mcp_audit` | |
| 13.14 | Settings → Developer → MCP: endpoint, guide, clients, scopes, revoke, audit, tested-client list | Done (untested) | `/settings/developer/mcp` (`registry.tsx`, `/mcp/settings` redirects); `web/components/mcp/*`; `settings-mcp-*.png` | |
| 13.15 | Report exports to configured targets | Partial | MCP "report exports run asynchronously…" | MCP target is `relay_download` only (no Drive/Notion) |
| 13.16 | Analytics tools on structured, caveated data | Done (tested) | MCP "analytics_overview uses the analytics query service…" | `query_analytics` (per post) is kept on the V1.1 snapshot reader by lead decision; the pipeline maintains those values too |
| 13.17 | Tested with a protocol client and a real client | Blocked (external) | SDK client tested (MCP); real clients not tested (`docs/V3_MCP_GUIDE.md`) | Needs public HTTPS |

## §14 Architecture and authorization

| ID | Requirement | Status | Evidence | Notes |
|---|---|---|---|---|
| 14.1 | Modular monolith; UI/API/MCP share services; MCP never calls providers | Done (tested) | MCP "editorial policy is identical to the UI…" | |
| 14.2 | Tenant/brand context on storage keys, caches, reports, indexes | Done (tested) | AN, CH, MCP cross-tenant tests | No realtime or search index in V3 |
| 14.3 | Revocation reaches delayed jobs; no tenant ids trusted from queues | Done (tested) | CH "a queued import fails…"; ANP "exports re-check authority at request, run and download time…" | |
| 14.4 | App/worker/migration DB-role separation | Done (tested) | `packages/db/src/runtime-role.ts`; DB "runtime role guard…" | G14 |
| 14.5 | Backfill four-network analytics without turning unsupported into zero | Done (tested) | ANP "moves V1.1 snapshots into the pipeline idempotently…" | |
| 14.6 | Rehearse migrations on a disposable copy | Done (tested) | `scripts/migration-rehearsal.sh`; `evidence/v2/migration-rehearsal.txt` (001–019 PASS) | |
| 14.7 | Connector changes behind workspace-scoped feature flags | Partial | V3.1 GOV flag framework (`svc/gov/release.ts`, `feature_flags` + `workspace_feature_flags`) | Connectors still use global settings (`TIKTOK_DIRECT_POST_AUDITED`, `LINKEDIN_ORGANIZATIONS`, `META_REQUEST_INSIGHTS`, `CONTENT_HUB_GOOGLE_PICKER`) |

## §15 Acceptance gates (not already covered above)

| ID | Requirement | Status | Evidence | Notes |
|---|---|---|---|---|
| 15.1 | Screens at 1440/1024/768/390 in both themes | Partial | 104 captures at 1440 and 390, both themes; design doc says 1280/1024/768 were checked | No captures at 1024/768 |
| 15.2 | Keyboard, focus, chart alternatives, contrast, reduced motion | Partial | E2E "keyboard: skip to content and visible focus"; chart table alternative; token contrast ratios in the design doc | Keyboard/screen-reader pass on composer and planner still open (ux.md) |
| 15.3 | Small vs large datasets; before/after screenshots | Done (untested) | `scripts/analytics-bench.ts`, V3.1 PERF benchmark harness; before: `evidence/ui-v2/`, after: `evidence/v3/ux/` | |
| 15.4 | One failing destination never republishes the others | Done (tested) | EN (V1 partial success) | |
| 15.5 | Type checks, lint, build, all suites, E2E, performance | Partial | Unit + contracts 490/490 and integration green (this run); E2E 39/39 on a production build (`next build --webpack` + `next start`, `evidence/e2e/results.json`); tsc clean per ux.md | Lint errors open (V2 G18); browser performance not measured |

## §16 Deliverables

| ID | Requirement | Status | Evidence | Notes |
|---|---|---|---|---|
| 16.1 | Source, migrations, tests, startup/deploy config | Done (tested) | `mig/014`–`017`, `019`; `scripts/dev.sh`; `infra/` | |
| 16.2 | `V3_REQUIREMENTS_MATRIX.md` | Done (untested) | this file | |
| 16.3 | `V3_DESIGN_SYSTEM.md` and before/after captures | Done (untested) | [V3_DESIGN_SYSTEM.md](V3_DESIGN_SYSTEM.md); `evidence/v3/ux/` | |
| 16.4 | `V3_PLATFORM_CAPABILITIES.md` | Done (untested) | [V3_PLATFORM_CAPABILITIES.md](V3_PLATFORM_CAPABILITIES.md) | |
| 16.5 | `V3_ANALYTICS_DICTIONARY.md` with examples | Done (untested) | generated by `scripts/analytics-dictionary.ts --check` | |
| 16.6 | `V3_CONTENT_INTEGRATIONS.md` | Done (untested) | [V3_CONTENT_INTEGRATIONS.md](V3_CONTENT_INTEGRATIONS.md) | |
| 16.7 | `V3_MCP_GUIDE.md` | Done (untested) | [V3_MCP_GUIDE.md](V3_MCP_GUIDE.md) | The setup section still names the temporary `/mcp/settings` route (it redirects) |
| 16.8 | Security and test report; migration/rollback runbook; measured performance | Partial | [V3_SECURITY_AND_TEST_REPORT.md](V3_SECURITY_AND_TEST_REPORT.md) | No V3 runbook (V2 runbook covers 009–013); performance is the server-side analytics bench only |
| 16.9 | `V3_IMPLEMENTATION_GAPS.md` | Done (untested) | [V3_IMPLEMENTATION_GAPS.md](V3_IMPLEMENTATION_GAPS.md) | |
| 16.10 | `V3_FINAL_ACTIVATION_CHECKLIST.md` | Done (untested) | [V3_FINAL_ACTIVATION_CHECKLIST.md](V3_FINAL_ACTIVATION_CHECKLIST.md) | |
| 16.11 | Resumable build checkpoint | Done (untested) | `HANDOFF.md`, `docs/PROGRESS.md`, [V3_BUILD_STATUS.md](V3_BUILD_STATUS.md) | |

## Totals

| Status | Rows |
|---|---|
| Done (tested) | 81 |
| Done (untested) | 44 |
| Partial | 22 |
| Not started | 2 |
| Blocked (external) | 5 |
| Unsupported by provider | 0 |
| **Total** | **154** |

Before the redesign landed: 73 / 18 / 55 Partial (34 of them UX) / 3 / 5.

"Done (tested)" means tested against fakes, real PostgreSQL and (for UI journeys) Playwright on a production build. It does not mean verified live. Most UX rows are "Done (untested)": screenshots and render smoke tests are evidence, not behavioural tests.
