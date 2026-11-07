# V3 requirements matrix

One row per requirement in the V3 spec ([docs/specs/V3_UPGRADE_PROMPT.md](specs/V3_UPGRADE_PROMPT.md); § numbers match). As of 2026-11-07, `main` @ e3d0e17 plus the uncommitted UX redesign.

Status: **Done (tested)** · **Done (untested)** · **Partial** · **Not started** · **Blocked (external)** · **Unsupported by provider**. "Tested" means an automated test in this repo covers it. Provider, Google, Notion and MCP-client behaviour is tested against **labelled fakes and recorded-request transports only**. Nothing has been verified live. Results: [V3_SECURITY_AND_TEST_REPORT.md](V3_SECURITY_AND_TEST_REPORT.md). Gaps: [V3_IMPLEMENTATION_GAPS.md](V3_IMPLEMENTATION_GAPS.md).

**UX note:** §2–5 rows are owned by the UX redesign stream, which is still running. Its progress note ([v3-progress/ux.md](v3-progress/ux.md)) lists these as done: (1) tokens, shell and nav; (2) Overview; (3) the Settings left nav. That work is uncommitted. These rows will be updated when it lands.

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
| 1.1 | Baseline build and regression results | Done (tested) | `docs/V2_TEST_REPORT.md`; this run: unit 104, contracts 351, integration 321 | All passed |
| 1.2 | V2 isolation/permissions apply to new integrations, analytics, exports and MCP | Done (tested) | CH "…another tenant", "a queued import fails when the requester lost access…"; AN "cross-tenant ids are not found…"; MCP "cross-workspace tools, results and resources never leak…" | Search is V3.1 DATA |
| 1.3 | Durable jobs, outbox, idempotency, Unknown + reconcile; no blind retries for new providers | Done (tested) | each C:‹p› "timeout_after_send ⇒ unknown ⇒ reconciled"; EN | |
| 1.4 | Live publication only to designated test destinations | Blocked (external) | — | No credentials or test destinations supplied |

## §2 Screenshot problems (UX stream)

| ID | Requirement | Status | Evidence | Notes |
|---|---|---|---|---|
| 2.1 | Every page has a clear purpose and primary action | Partial: UX stream in progress | `evidence/v3/ux/checkpoints/1-shell-*.png` | Shell done |
| 2.2 | Meaningful info above the fold (trends, attention, upcoming, health) | Partial: UX stream in progress | `evidence/v3/ux/checkpoints/2-overview-*.png` | Overview done |
| 2.3 | Charts, compact tables and thumbnails instead of oversized rows | Partial: UX stream in progress | `web/components/ui/data-viz.tsx` (WIP) | Analytics page is still the V1.1 per-post list |
| 2.4 | Progressive disclosure (logs/diagnostics in drawers) | Partial: UX stream in progress | `web/components/planner/post-drawer.tsx` (WIP) | |
| 2.5 | Demo status shown once; live and demo never mixed | Partial: UX stream in progress | Backend: AN "synthetic demo data never appears in live queries…" | UI banner pending |
| 2.6 | Unavailable metrics shown as coverage, not repeated empty cards | Partial: UX stream in progress | API states: ANu "keeps zero, partial coverage…distinct" | UI pending |
| 2.7 | Realistic synthetic demo content; E2E fixtures out of user data | Partial: UX stream in progress | `svc/analytics/demo.ts`, `scripts/analytics-demo.ts` | Fixture move not verified |
| 2.8 | Check readiness vs delivery errors vs connection health | Partial: UX stream in progress | — | |

## §3 Design system (UX stream)

| ID | Requirement | Status | Evidence | Notes |
|---|---|---|---|---|
| 3.1 | Tokens, dark and light themes | Partial: UX stream in progress | `web/app/globals.css` (WIP); checkpoint 1 | Relay palette replaces lime (D19) |
| 3.2 | Type scale, 4/8 spacing, radius, 240/72 px nav | Partial: UX stream in progress | ux.md "rail 72 / 240 expanded" | |
| 3.3 | Motion 120–220 ms; reduced motion | Partial: UX stream in progress | — | |
| 3.4 | Shared components (PageHeader … SettingsShell) | Partial: UX stream in progress | `web/components/ui/{card,layout,data-viz,feedback}.tsx`, `settings-shell/` (WIP) | No `DataTable` found yet |
| 3.5 | Accessible charts: line styles, keyboard summaries, table alternative | Partial: UX stream in progress | — | |
| 3.6 | Dynamic: persistent filters, saved views, shortcuts, drawers | Partial: UX stream in progress | Saved views API: ANP "saved views serialise filters…" | |
| 3.7 | Fast first loads, measured | Partial: UX stream in progress | `scripts/analytics-bench.ts` (server side only) | Browser metrics: V3.1 PERF |

## §4 Navigation and left-sidebar Settings (UX stream)

| ID | Requirement | Status | Evidence | Notes |
|---|---|---|---|---|
| 4.1 | Primary nav items; Operations/Setup in a separate admin area | Partial: UX stream in progress | ux.md item 1 "Admin group, new labels" | |
| 4.2 | Settings in a grouped left nav; no horizontal tabs; deep links | Partial: UX stream in progress | `web/app/(app)/settings/[group]/`, `settings/layout.tsx` (WIP); checkpoint 3 | `/settings/<group>/<item>` |
| 4.3 | Keep scope, active route, expanded group and back/forward | Partial: UX stream in progress | ux.md "?tab= server redirects keep other params" | |
| 4.4 | Eight groups and their sub-settings | Partial: UX stream in progress | `web/components/settings-shell/` (WIP) | |
| 4.5 | Groups permission-aware and authorized on the server | Partial: UX stream in progress | — | |
| 4.6 | Settings search that doesn't leak inaccessible pages | Partial: UX stream in progress | ux.md "search" | |
| 4.7 | Mobile: left drawer with breadcrumb/back | Partial: UX stream in progress | ux.md "mobile drawer" | |

## §5 Overview, Planner, Composer (UX stream)

| ID | Requirement | Status | Evidence | Notes |
|---|---|---|---|---|
| 5.1 | Overview: ≤4 tiles, upcoming with thumbnails, attention queue, channel health, performance | Partial: UX stream in progress | checkpoint 2; `web/app/(app)/page.tsx` (WIP) | Uses the analytics contract |
| 5.2 | Marketing vs operational kept apart; severity-ranked actionable items | Partial: UX stream in progress | ux.md "attention w/ Manual handoff" | |
| 5.3 | Planner: week/month/list, thumbnails, filters, side drawer | Partial: UX stream in progress | `web/components/planner/post-drawer.tsx` (WIP) | |
| 5.4 | Drag to reschedule through revision/approval; conflicts, timezones; mobile agenda | Partial: UX stream in progress | — | |
| 5.5 | Composer: three regions with a generous live preview | Partial: UX stream in progress | `web/components/composer/*` (WIP) | |
| 5.6 | Composer tools: chips, snippets, link/CTA, voice, alt text, crops, poster, progress, autosave; no silent truncation | Partial: UX stream in progress | V1.1 crops/AI exist | Autosave server side: V3.1 DATA |
| 5.7 | Destination picker for 10 networks; feed/vertical/video/Pin previews labelled approximate | Partial: UX stream in progress | `web/components/composer/destination-rail.tsx` (WIP) | |
| 5.8 | Provider-required fields; Save/Submit/Schedule/Publish by role; published = read-only history | Partial: UX stream in progress | `web/components/composer/provider-options.tsx` (WIP); server validation: C:tiktok "validation: privacy (no default), express consent…", C:youtube "title, explicit privacy and made-for-kids are required…" | Server side is done (tested) |

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
| 6.12 | Connection states (available, connected, missing permission, awaiting approval, unsupported, reconnect, manual handoff) | Partial | `core/types.ts` connection statuses + `eligibility.status`; `mig/019` `handoff` delivery state; EH | Connections UI is in the UX stream |
| 6.13 | Capabilities modelled independently (formats, analytics, edit/delete, comments, media prep, native scheduling) | Partial | `core/types.ts` `ChannelCapabilities` (`publishMode`, `nativeScheduling`, `eligibility`, `requiredOptions`) | No `comments` field. Meta and X report `canReadMetrics:false` even though metrics fetchers exist |
| 6.14 | TikTok: eligibility honest, no promise of public autopublish, labelled manual handoff | Partial | C:tiktok "capabilities per mode…", "manual handoff package is labelled manual…"; EH | The download / open-app action is not wired in the UI (`tiktokManualHandoff()` unused) |
| 6.15 | YouTube: explicit privacy; not "published" until state allows; no hard-coded unaudited rule | Done (tested) | C:youtube "init (exact URL, headers, explicit privacy)…" | |
| 6.16 | Versioned provider register (source, date, scopes, version, limits, review, formats, live evidence) | Done (untested) | `docs/PROVIDER_CAPABILITIES.md`, `docs/providers/*.md`, `docs/V3_PLATFORM_CAPABILITIES.md` | Live evidence column: none |

## §7 Video and asynchronous publishing

| ID | Requirement | Status | Evidence | Notes |
|---|---|---|---|---|
| 7.1 | Resumable uploads | Partial | Provider side: C:youtube "resume after a failed chunk…", C:tiktok "70 MB video…resumes", C:linkedin "video…resumes" | Browser → storage is a single presigned POST (≤ 300 MB), not resumable |
| 7.2 | Real MIME/codec/dimension/duration validation | Done (tested) | `svc/media/video.ts` (ffprobe); MV | V1.1 |
| 7.3 | Thumbnails; optional bounded transcoding | Done (tested) | MV "transcodes an incompatible MOV…" | One publish derivative ≤ 1280×1024 |
| 7.4 | Progress, cancellation, processing polling, checkpoints | Partial | Polling and checkpoints: C:‹p› "processing ⇒ polls…" | Upload progress/cancel UX not verified |
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
| 8.1 | Default view is an overview, not a raw post list | Partial | API: `svc/analytics/query.ts` `overview`; MCP "analytics_overview uses the analytics query service…" | `web/app/(app)/analytics/page.tsx` is still the V1.1 list (UX stream) |
| 8.2 | Persistent filters, timezone, previous period, freshness, coverage; URL state without private data; access rechecked | Partial | `svc/analytics/filters.ts`; ANu "serialises canonically (ids/dates only)…"; ANP "saved views…re-check access" | API done (tested); UI pending |
| 8.3 | Content view: sortable, paginated table with drilldown | Partial | `query.ts` `contentTable`/`contentDetail`; routes `api/analytics/content/**` | API done; UI pending |
| 8.4 | Channels view: native metrics, follower snapshots | Partial | AN "serves native channel metrics…" | No adapter fetches followers (`not_fetched`) |
| 8.5 | Video view: views, watch time, retention | Partial | AN "…video ratio-of-sums…" | Retention metrics not fetched |
| 8.6 | Audience: provider aggregates only, otherwise an honest state | Partial | AN "…honest audience/best-time states" | No audience fetchers; always an explanatory state |
| 8.7 | Team and workflow view (no employee score) | Done (untested) | `query.ts` `workflow`; `api/analytics/workflow` | No test names it; UI pending |
| 8.8 | Reports: saved views, CSV/PDF, export to Drive/Docs/Notion | Done (tested) | ANP "CSV export reproduces…", "exports re-check authority…external destinations go through ReportExporter"; `apps/worker/src/main.ts` registers `contentHubExporter` | PDF needs Chromium, otherwise HTML with a note |
| 8.9 | Charts: tooltips, intervals, toggles, drilldown, table alternative; detail drawer | Partial: UX stream in progress | — | |
| 8.10 | Chart type by question; best time hidden when evidence is thin | Partial | `query.ts` `bestTime`; AN best-time states | API done; UI pending |
| 8.11 | Comparison: zero/missing baseline ⇒ New/insufficient | Done (tested) | ANu "baseline zero ⇒ new, missing ⇒ insufficient…"; AN | |
| 8.12 | Reports reproduce scope, filters, tz, metrics, observed time and coverage | Done (tested) | ANP CSV manifest test | |

## §9 Analytics semantics and pipeline

| ID | Requirement | Status | Evidence | Notes |
|---|---|---|---|---|
| 9.1 | Metric registry (id, name, unit, scope, aggregation, basis, paid, availability, retention, version) | Done (tested) | `svc/analytics/registry.ts` (70 definitions); ANu "registry…"; AN "maps every metric the 10 provider fetchers request…" | `docs/V3_ANALYTICS_DICTIONARY.md` generated |
| 9.2 | Native metrics separate from app operational facts | Done (untested) | Measures table: `posts_published` from app records | |
| 9.3 | No summed unique reach, unlabelled totals or summed snapshots; ratio-of-sums rates | Done (tested) | AN "never combines views + impressions…", "is Σ engagements ÷ Σ views…"; ANu | |
| 9.4 | Cumulative snapshots separate from time buckets; labelled deltas; no fabricated history | Done (tested) | AN "stores lifetime counters as as-of snapshots…"; `mig/015` | |
| 9.5 | Distinct states (zero, unsupported, permission, not fetched, stale, delayed, partial, failed); coverage and through-date | Done (tested) | AN "keeps observed 0, not-reported and unsupported…distinct", "counts only the selected accounts and reports the through-date" | Gap rendering in charts: UI pending |
| 9.6 | Deletion and lost-access retention | Done (tested) | `svc/analytics/retention.ts`; ANP "revoked access stops sync…" (purge) | |
| 9.7 | Pipeline: cursors, checkpoints, bounded backfill, quota-aware, retry, late corrections | Done (tested) | ANP "checkpoints, never duplicates…", "rate limits stop the run…"; AN "upserts on the fact key…" | |
| 9.8 | Unmapped native posts (when allowed), labelled as imported | Not started | — | Only Relay-published posts are synced |
| 9.9 | Schema: definitions, observations, facts, sync runs/cursors, reports, coverage | Done (tested) | `mig/015_v3_analytics.sql` | Plus cumulative facts, rollups |
| 9.10 | Unique fact keys; dedupe on retry | Done (tested) | AN "upserts on the fact key: retries do not duplicate…" | |
| 9.11 | No paid data; YouTube revenue excluded; no ROI claims | Done (untested) | registry `youtube.video.estimatedRevenue` = excluded | |
| 9.12 | Insights cite data; calculated vs AI interpretation | Done (untested) | `query.ts` insights `kind:'calculated'` + `basis` | No AI insights exist |
| 9.13 | Demo fixtures isolated; live empty state never shows seeded numbers | Done (tested) | AN "synthetic demo data never appears in live queries…"; `mig/015` `is_synthetic` | Empty-state UI pending |

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
| 12.2 | Connections in the Settings tree; selection from Composer and Library | Partial | Composer "From Drive or Notion" (`source-import-button.tsx`); Settings Sources tab | Left-tree placement: UX stream |
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
| 13.14 | Settings → Developer → MCP: endpoint, guide, clients, scopes, revoke, audit, tested-client list | Done (untested) | `web/components/mcp/*`; `evidence/v3/mcp/*` | Moving into the left Settings nav (UX) |
| 13.15 | Report exports to configured targets | Partial | MCP "report exports run asynchronously…" | MCP target is `relay_download` only (no Drive/Notion) |
| 13.16 | Analytics tools on structured, caveated data | Partial | MCP "analytics_overview uses the analytics query service…" | `query_analytics` still reads V1.1 snapshots |
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
| 14.7 | Connector changes behind workspace-scoped feature flags | Not started | Global settings only (`TIKTOK_DIRECT_POST_AUDITED`, `LINKEDIN_ORGANIZATIONS`, `CONTENT_HUB_GOOGLE_PICKER`) | V3.1 GOV §16 |

## §15 Acceptance gates (not already covered above)

| ID | Requirement | Status | Evidence | Notes |
|---|---|---|---|---|
| 15.1 | Screens at 1440/1024/768/390 in both themes | Partial: UX stream in progress | `evidence/v3/ux/checkpoints/*` | |
| 15.2 | Keyboard, focus, chart alternatives, contrast, reduced motion | Partial: UX stream in progress | — | |
| 15.3 | Small vs large datasets; before/after screenshots | Partial | `scripts/analytics-bench.ts` (14.6k posts / 484k points) | Screenshots: UX |
| 15.4 | One failing destination never republishes the others | Done (tested) | EN (V1 partial success) | |
| 15.5 | Type checks, lint, build, all suites, E2E, performance | Partial | Unit/contract/integration green this run | E2E not re-run since the redesign started; lint errors open (V2 G18); no production build in this report |

## §16 Deliverables

| ID | Requirement | Status | Evidence | Notes |
|---|---|---|---|---|
| 16.1 | Source, migrations, tests, startup/deploy config | Done (tested) | `mig/014`–`017`, `019`; `scripts/dev.sh`; `infra/` | |
| 16.2 | `V3_REQUIREMENTS_MATRIX.md` | Done (untested) | this file | |
| 16.3 | `V3_DESIGN_SYSTEM.md` and before/after captures | Partial: UX stream in progress | checkpoints only | Doc not written yet |
| 16.4 | `V3_PLATFORM_CAPABILITIES.md` | Done (untested) | [V3_PLATFORM_CAPABILITIES.md](V3_PLATFORM_CAPABILITIES.md) | |
| 16.5 | `V3_ANALYTICS_DICTIONARY.md` with examples | Done (untested) | generated by `scripts/analytics-dictionary.ts --check` | |
| 16.6 | `V3_CONTENT_INTEGRATIONS.md` | Done (untested) | [V3_CONTENT_INTEGRATIONS.md](V3_CONTENT_INTEGRATIONS.md) | |
| 16.7 | `V3_MCP_GUIDE.md` | Done (untested) | [V3_MCP_GUIDE.md](V3_MCP_GUIDE.md) | Its `query_analytics` note and Settings path are out of date |
| 16.8 | Security and test report; migration/rollback runbook; measured performance | Partial | [V3_SECURITY_AND_TEST_REPORT.md](V3_SECURITY_AND_TEST_REPORT.md) | No V3 runbook (V2 runbook covers 009–013); performance is the server-side analytics bench only |
| 16.9 | `V3_IMPLEMENTATION_GAPS.md` | Done (untested) | [V3_IMPLEMENTATION_GAPS.md](V3_IMPLEMENTATION_GAPS.md) | |
| 16.10 | `V3_FINAL_ACTIVATION_CHECKLIST.md` | Done (untested) | [V3_FINAL_ACTIVATION_CHECKLIST.md](V3_FINAL_ACTIVATION_CHECKLIST.md) | |
| 16.11 | Resumable build checkpoint | Done (untested) | `HANDOFF.md`, `docs/PROGRESS.md`, [V3_BUILD_STATUS.md](V3_BUILD_STATUS.md) | |

## Totals

| Status | Rows |
|---|---|
| Done (tested) | 73 |
| Done (untested) | 18 |
| Partial: UX stream in progress | 34 |
| Partial (other) | 21 |
| Not started | 3 |
| Blocked (external) | 5 |
| Unsupported by provider | 0 |
| **Total** | **154** |

"Done (tested)" means tested against fakes and real PostgreSQL. It does not mean verified live.
