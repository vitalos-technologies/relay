# V3 implementation gaps

What is partial, simulated or not done, as of 2026-11-07 (`main` @ e3d0e17 + uncommitted UX work). Matrix IDs refer to [V3_REQUIREMENTS_MATRIX.md](V3_REQUIREMENTS_MATRIX.md). External setup is in [V3_FINAL_ACTIVATION_CHECKLIST.md](V3_FINAL_ACTIVATION_CHECKLIST.md) (§ references below). Open V2 gaps: [V2_IMPLEMENTATION_GAPS.md](V2_IMPLEMENTATION_GAPS.md).

## 0. Simulated: everything external

Every provider, Google, Notion and MCP-client path runs against labelled fakes or recorded-request transports. **None has been verified live.** "Done (tested)" in the matrix means tested that way.

| Area | Simulated by | Blocked by (checklist) |
|---|---|---|
| 6 new social adapters | `packages/providers/src/<p>/fake.ts`, contract tests | §1 provider apps and reviews |
| Meta, X, Telegram (V1) | simulators, contract tests | V1 checklist §2–5 |
| Google Drive/Docs/Picker | `services/content-hub/fakes.ts` (mode `test`) | §2 Google content client + Picker |
| Notion | same fakes | §3 Notion public integration |
| MCP clients | SDK `Client` 1.32.2 in `tests/integration/mcp.test.ts` | §4 public HTTPS, §5 Keycloak |
| Analytics numbers | fake fetchers; demo fixtures in demo workspaces only | §6 analytics permissions |

## 1. Security-relevant

| # | Gap | Where | What is missing | Matrix |
|---|---|---|---|---|
| S1 | Google Picker CSP origins are on by default | `apps/web/proxy.ts` (`CONTENT_HUB_GOOGLE_PICKER !== 'false'`) | `frame-src` allows `docs.google.com`, `accounts.google.com` and `content.googleapis.com` even when no Picker keys are configured. Safer: enable only when `GOOGLE_PICKER_API_KEY` is set, or when the flag is explicitly `true` | 10.2 |
| S2 | No workspace-scoped feature flags for connectors | `services/connections/runtime.ts`, settings | TikTok audit, LinkedIn organisations, Pinterest tier and the Picker are global settings. The spec wants flags per workspace (planned for V3.1 GOV §16) | 14.7 |
| S3 | MCP sessions are in-process | `services/mcp/server.ts` | Several web replicas need sticky routing, or clients re-initialise. Authorization is unaffected (re-checked per request) | 13.1 |
| S4 | Notion webhook handshake | `services/content-hub/webhooks.ts` | Stores the most recent unauthenticated verification POST until an owner adopts it (a wrong token only fails at Notion) | 11.10 |

## 2. Platforms and media

| # | Gap | What is missing | Matrix |
|---|---|---|---|
| P1 | Meta connect doesn't request insights scopes | `FACEBOOK_SCOPES`/`INSTAGRAM_SCOPES` (`providers/src/meta/common.ts`) lack `read_insights` / `instagram_manage_insights`, which the metrics fetchers need. Live FB/IG analytics would show "permission missing" | 8.4 |
| P2 | LinkedIn analytics scopes are tied to the organisations flag | `r_member_postAnalytics` and `rw_organization_admin` are only in `LI_ORG_SCOPES` (sent when `LINKEDIN_ORGANIZATIONS=true`). Member-only installs get no analytics | 8.4 |
| P3 | No account-level fetchers | No adapter fetches followers or audience (all `not_fetched`). Channels/Audience views show explanatory states only | 8.4, 8.6 |
| P4 | TikTok manual handoff action | `tiktokManualHandoff()` (caption + media download, open the app) has no UI or API caller. The `handoff` delivery state exists | 6.14 |
| P5 | Capability model incomplete | No `comments` capability. Meta and X report `canReadMetrics:false` although fetchers exist, so MCP `get_capabilities` shows `can_read_metrics:false` for them | 6.13 |
| P6 | Bluesky limits | App password only (atproto OAuth needs PAR + DPoP + public client metadata); no video; no link cards | 6.7, 6.8 |
| P7 | Browser upload not resumable | Single presigned POST ≤ 300 MB; no resumable/multipart client upload; no processing-time budget | 7.1, 7.6 |
| P8 | Unmapped native posts | Only Relay-published posts are synced; network-native posts are never imported | 9.8 |
| P9 | Composer provider fields and Bluesky connect form | Server validation done; UI is in the UX stream (`provider-options.tsx`, uncommitted) | 5.8 |

## 3. Analytics

| # | Gap | What is missing | Matrix |
|---|---|---|---|
| A1 | Analytics UI | `/analytics` is still the V1.1 per-post list. Overview, Content, Channels, Video, Audience, Workflow, Reports screens are waiting for the UX stream (API done) | 8.1–8.10 |
| A2 | Workflow view untested | `query.ts` `workflow()` and its route have no test | 8.7 |
| A3 | PDF needs Chromium | Without Playwright Chromium in the image, PDF exports are delivered as HTML with a note | 8.8 |
| A4 | Long ranges are slow | Overview over 365 days ≈ 2.8 s on the large bench (14.6k posts); V3.1 PERF | 3.7 |

## 4. Content Hub

| # | Gap | What is missing | Matrix |
|---|---|---|---|
| C1 | Browser Picker untested | No E2E for Google Identity token client + Picker iframe | 10.2 |
| C2 | Notion export parent | New page under a selected parent **page** only; a data source as parent is not supported | 11.6 |
| C3 | Not built (optional in the spec) | Drive folder sync (`drive.readonly`, restricted scope), Sheets/Slides import, AI repurposing of imports | 10.3, 10.6 |
| C4 | Writeback to Notion `status` properties | Fails unless the Relay status options exist in Notion (operator setup, checklist §3) | 11.5 |
| C5 | Drive watch renewal | Renewal timer (1 day before expiry) untested | 10.10 |
| C6 | Settings placement | Sources live in a Settings tab; moving to the left Settings tree is UX work | 12.2 |

## 5. MCP

| # | Gap | What is missing | Matrix |
|---|---|---|---|
| M1 | `query_analytics` on old data | Reads V1.1 per-post snapshots (`services/analytics/index.ts`). `analytics_overview` already uses the V3 query service | 13.16 |
| M2 | Export targets | `create_report_export` supports `relay_download` only; Drive/Notion targets not exposed through MCP | 13.15 |
| M3 | Real clients | Only the SDK protocol client is tested. Inspector, Claude Code, Claude, ChatGPT are not tested (need public HTTPS) | 13.17 |
| M4 | Settings location | Still served at `/mcp/settings`. Placement under Settings → Developer → MCP is in the uncommitted UX work | 13.14 |
| M5 | Guide drift | `V3_MCP_GUIDE.md` still says `query_analytics` "switches when the analytics stream lands" and points at the temporary route | 16.7 |

## 6. UX redesign (in progress)

Spec §2–5: 34 matrix rows are "Partial: UX stream in progress". Done per [v3-progress/ux.md](v3-progress/ux.md) (uncommitted):
- tokens + shell/nav;
- Overview;
- Settings left nav with deep links and a mobile drawer.

Remaining:
- design-system doc (`V3_DESIGN_SYSTEM.md`);
- Planner, Composer, Connections (capability states), Library, Analytics, Team;
- both themes at 4 widths;
- accessibility checks.

## 7. Verification and documentation

| # | Gap | Detail |
|---|---|---|
| V1 | Browser E2E | Not re-run since the redesign started (last full run 33/38). No E2E for MCP consent/confirm, Content Hub or new providers |
| V2 | V3 migration/rollback runbook | Rehearsal 001–019 passes, but no V3 runbook (the V2 runbook covers 009–013). Rollback safety of 014–019 is not documented |
| V3 | Performance | Server-side analytics bench only. No browser metrics and no MCP latency figures (V3.1 PERF) |
| V4 | Lint / production build | Not run in the V3 report; lint errors open (V2 G18) |
| V5 | Type check | Not re-run here (streams reported clean at hand-off) |


## Lead follow-ups (2026-11-07)
- **Meta insights permissions:** fixed. `read_insights` / `instagram_manage_insights` are requested when the operator sets `META_REQUEST_INSIGHTS=true` (only after Meta app review, since unapproved permissions break login). They stay optional: publishing never requires them, and analytics shows "permission missing" without them.
- **Google Picker CSP default:** kept on by design. CSP is built in the proxy, before database settings (where Picker keys live) are readable. The allowance only adds Google Picker origins to `frame-src`/`connect-src`/`img-src`. Operators can turn it off with `CONTENT_HUB_GOOGLE_PICKER=false`.
- **MCP analytics:** `analytics_overview` uses the V3 analytics query service. `query_analytics` (per post) stays as is; it reads values the V3 pipeline also maintains.
- **Setup readiness:** on/off and tier settings (Meta insights, LinkedIn organizations, Pinterest tier, TikTok audit) no longer count as missing for a provider's readiness.
