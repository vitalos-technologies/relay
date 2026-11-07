# V3 implementation gaps

What is partial, simulated or not done, as of 2026-11-07 after the UX redesign landed (`main` @ c6a8c0a, tag `v3.0.0`). Matrix IDs refer to [V3_REQUIREMENTS_MATRIX.md](V3_REQUIREMENTS_MATRIX.md). External setup: [V3_FINAL_ACTIVATION_CHECKLIST.md](V3_FINAL_ACTIVATION_CHECKLIST.md) (§ references below). Open V2 gaps: [V2_IMPLEMENTATION_GAPS.md](V2_IMPLEMENTATION_GAPS.md).

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

## 1. Closed since the first V3 docs (lead fixes)

| Was | Fix | Commit | Evidence |
|---|---|---|---|
| UX redesign §2–5 in progress | Landed: design system, new nav, left Settings, Overview, Planner, Composer, Connections, Library, Campaigns, Analytics views | 3e5e3f2, 95f8e34 (`v3.0.0`) | `evidence/v3/ux/` (104 shots); E2E 39/39 on a production build |
| P1: Meta insights scopes never requested | `read_insights` / `instagram_manage_insights` requested when `META_REQUEST_INSIGHTS=true` (after Meta review); optional for publishing | 9dc2ad7 | `contracts/meta.test.ts` |
| `/api/providers` reported `META_APP_ID` for every network | Each provider reports its own setting keys; Bluesky needs no app setup | 8e774ba | `integration/api-fixes-v3.test.ts` |
| `?status=draft` posts filter | Returns never-scheduled posts; unsupported values refused | 8e774ba | same |
| Bluesky connect only as a service | Connect/reconnect routes, operator allow-list `BLUESKY_SELF_HOSTED_HOSTS`, connect form in Connections | b8abe47, b0fcc70, 3e5e3f2 | `v3-connections`; `connections-bluesky-*.png` |
| Content Hub OAuth returned to the old Settings tab | Returns to `/settings/connections/<google|notion>`; Google and Notion are separate Settings pages | 11e215f, 8e774ba | `content-hub` |
| Mandatory brand rule added after scheduling did not stop the post | Delivery is held while the review is open | 46d6313 | `v31-brand-rule-hold` |
| MCP had no Content Hub or V3 analytics access | `list_sources`, `preview_source`, `import_source_to_draft`, `get_import_status`; `analytics_overview` on the V3 query service | 18b5c53, ed9aa1f | `mcp` |
| P9: composer provider fields | `provider-options.tsx` (TikTok, YouTube, Pinterest, LinkedIn, Bluesky) | 3e5e3f2 | `composer-youtube-*.png` |
| A1: Analytics UI was the V1.1 list | Overview, Content (+ drawer), Channels, Video, Audience, Workflow; URL filters; CSV/PDF export | 3e5e3f2 | `analytics-*.png` |
| C6, M4: Settings placement | `/settings/connections/{google,notion}`, `/settings/developer/mcp` | 3e5e3f2 | `settings-sources-*`, `settings-mcp-*` |
| Earlier 5 E2E failures | That run used the dev server (production server hit `EADDRINUSE`); now 39/39 on `next build --webpack` + `next start` | 95f8e34 | `evidence/e2e/results.json` |
| Strict-CSP eval violation in browsers | Browser Zod runs `jitless` | 95f8e34 | `security.spec` CSP test |

**Lead decisions** (kept as is, not gaps):
- **Picker CSP default on.** The CSP is built in the proxy before database settings are readable. It only adds Google Picker origins. Disable with `CONTENT_HUB_GOOGLE_PICKER=false`.
- **MCP `query_analytics` stays on the per-post reader.** The V3 pipeline also maintains those values; `analytics_overview` uses the V3 query service.
- **Setup readiness.** On/off and tier switches no longer count as missing settings.

## 2. Security-relevant (open)

| # | Gap | Where | What is missing | Matrix |
|---|---|---|---|---|
| S2 | Connectors not behind workspace flags | `services/connections/runtime.ts` | V3.1 GOV added workspace-scoped flags (`feature_flags`, `workspace_feature_flags`), but TikTok audit, LinkedIn organisations, Pinterest tier, Meta insights and the Picker are still global settings | 14.7 |
| S3 | MCP sessions are in-process | `services/mcp/server.ts` | Several web replicas need sticky routing, or clients re-initialise. Authorization is re-checked per request | 13.1 |
| S4 | Notion webhook handshake | `services/content-hub/webhooks.ts` | Stores the latest unauthenticated verification POST until an owner adopts it | 11.10 |

## 3. Platforms and media (open)

| # | Gap | What is missing | Matrix |
|---|---|---|---|
| P2 | LinkedIn analytics tied to the organisations flag | `r_member_postAnalytics` and `rw_organization_admin` are only requested with `LINKEDIN_ORGANIZATIONS=true` | 8.4 |
| P3 | No account-level fetchers | No adapter fetches followers or audience (`not_fetched`); Channels/Audience show explanatory states | 8.4–8.6 |
| P4 | TikTok manual handoff action | The composer shows a "Manual handoff" banner, but `tiktokManualHandoff()` (caption + media download, open the app) still has no caller | 6.14 |
| P5 | Capability model incomplete | No `comments` capability. Meta and X still report `canReadMetrics:false`, so MCP `get_capabilities` shows `can_read_metrics:false` for them | 6.13 |
| P6 | Bluesky limits | App password only (no atproto OAuth); no video; no link cards | 6.7, 6.8 |
| P7 | Browser upload not resumable | Single presigned POST ≤ 300 MB; no processing-time budget | 7.1, 7.6 |
| P8 | Unmapped native posts | Only Relay-published posts are synced | 9.8 |

## 4. UX (open)

| # | Gap | What is missing | Matrix |
|---|---|---|---|
| U1 | Settings pages waiting on backend | Retention, Guests, Webhooks, Recovery, AI provider/usage are not in the Settings registry | 4.4 |
| U2 | Approvals | List/detail polish still open (stream note) | – |
| U3 | Accessibility | Keyboard/screen-reader pass on composer and planner still open. Only the E2E "skip to content and visible focus" check exists | 15.2 |
| U4 | Composer extras | No reusable snippets | 5.6 |
| U5 | Saved views and global shortcuts | Saved-views API exists, but no UI; no global keyboard shortcuts | 3.6, 8.8 |
| U6 | Analytics export destinations | The UI exports CSV/PDF downloads only; Drive/Notion report export exists in the API but has no control in Analytics | 8.8 |
| U7 | Width coverage | Captures at 1440 and 390 only (the design doc states 1280/1024/768 were checked) | 15.1 |
| U8 | Readiness vs delivery vs health | No written assessment of disagreements (spec §2.8) | 2.8 |

## 5. Analytics and Content Hub (open)

| # | Gap | What is missing | Matrix |
|---|---|---|---|
| A2 | Workflow view untested | `query.ts` `workflow()`: no automated test | 8.7 |
| A3 | PDF needs Chromium | Without Chromium in the image, PDF exports arrive as HTML with a note | 8.8 |
| C1 | Browser Picker untested | No E2E for Google Identity + Picker iframe | 10.2 |
| C2 | Notion export parent | Parent page only; not a data source | 11.6 |
| C3 | Optional, not built | Drive folder sync, Sheets/Slides import, AI repurposing | 10.3, 10.6 |
| C4 | Notion `status` writeback | Relay status options must exist in Notion (checklist §3) | 11.5 |
| C5 | Drive watch renewal | Untested | 10.10 |

## 6. MCP (open)

| # | Gap | What is missing | Matrix |
|---|---|---|---|
| M2 | Export targets | `create_report_export` is `relay_download` only | 13.15 |
| M3 | Real clients | Only the SDK protocol client is tested (needs public HTTPS) | 13.17 |
| M5 | Guide drift | `V3_MCP_GUIDE.md` setup section still names the temporary `/mcp/settings` route (it redirects) | 16.7 |

## 7. Verification and documentation

| # | Gap | Detail |
|---|---|---|
| V1 | E2E coverage | 39/39 passing, but there is no E2E for MCP consent/confirm, Content Hub, Analytics views or new-provider composer fields. The redesigned screens have render smoke tests only |
| V2 | V3 migration/rollback runbook | Rehearsal 001–019 passes; no V3 runbook (V2 covers 009–013) |
| V3 | Performance | Server side measured (V3.1 PERF); no browser metrics |
| V4 | Lint | Errors open (V2 G18) |
| V6 | Flaky integration test | `engine-handoff` "processing → handoff…" failed once under full-suite load (`unknown` ≠ `handoff`) and passed 3/3 alone |
