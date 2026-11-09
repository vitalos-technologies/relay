# IG — Integration guides + analytics dictionary (progress)

Status: **complete** (41 articles, 7 screenshots; docs check passes). Owner: stream IG.
Brief: `docs/queue/04_DOCUMENTATION_PROMPT.md` §5–§6; contract `docs/DOCS_WORKSTREAMS.md` (row IG).
Format: HC's schema (`packages/services/src/help/schema.ts`); `node scripts/docs-check.mjs` reports **no errors or
warnings in IG files** (remaining errors on 2026-11-09 belong to other streams' missing slugs, e.g. `publishing-failed`,
`upload-failed-or-media-rejected`, `cant-sign-in`, `feature-flags`).

No product code was changed. No git state changes. Screenshot script (scratchpad, not in repo) writes synthetic-data
PNGs to `apps/web/public/help/img/<section>/`.

## Articles (41)

| Section | Slugs |
|---|---|
| social-connections (14) | `connect-social-accounts`, `connection-status-and-fixes`, `network-limits-at-a-glance`, `set-up-social-network-apps`, `instagram`, `facebook`, `telegram`, `x-twitter`, `tiktok`, `youtube`, `linkedin`, `threads`, `pinterest`, `bluesky` |
| content-sources (6) | `content-sources-overview`, `google-drive-and-docs`, `notion`, `refresh-imported-content`, `export-to-google-docs-drive-and-notion`, `notion-writeback` |
| business-apps (8) | `business-apps-overview`, `asana`, `monday-com`, `hubspot`, `slack`, `mailchimp`, `google-business-profile`, `cloud-translation` |
| analytics (12) | `use-analytics`, `analytics-metric-dictionary`, `metrics-by-network`, `lifetime-totals-and-reach`, `data-status-and-freshness`, `engagement-rate-and-comparisons`, `content-and-channel-rankings`, `video-and-audience-analytics`, `workflow-reporting`, `analytics-exports-and-reports`, `calculated-insights-and-ai`, `other-metrics-in-relay` |
| inbox-and-care (3) | `inbox-channels-by-network`, `whatsapp-in-the-inbox`, `google-reviews-in-the-inbox` |

All audience `user` (`set-up-social-network-apps` was admin; changed to user so user articles can link to it — it
contains no secrets, only callback patterns and approvals).

## Coverage rows (integration / metric → implementation → slug → verification)

Verification legend: **LV** = not live-verified (simulated transport + contract tests only); **PA** = needs provider
approval; **SU** = needs setup (operator app registration); **AV** = available and verified locally (app-owned logic).

| Item | Implementation | Slug | Status |
|---|---|---|---|
| Connect / select destinations / reconnect / pause / disconnect | `packages/services/src/connections/{manage,oauth}.ts`, `apps/web/app/(app)/accounts/{page,select/page}.tsx` | `connect-social-accounts` | LV |
| Connection states + fixes | `apps/web/lib/client/{capability-state,connection-fix}.ts` | `connection-status-and-fixes` | AV |
| Network app setup (Setup page) | `packages/services/src/settings.ts`, `connections/manage.ts` PROVIDER_KEYS | `set-up-social-network-apps` | PA |
| Limits per network | `packages/providers/src/*/adapter.ts`, `meta/common.ts` constraints | `network-limits-at-a-glance` | LV |
| Instagram (image, carousel ≤20, Reel; insights; DMs/comments) | `providers/src/meta/{instagram,carousel,metrics,inbox-instagram}.ts` | `instagram` | PA, LV |
| Facebook Page (text/link, photo, multi-photo ≤10, video; insights; Messenger/comments) | `providers/src/meta/{facebook,facebook-media,metrics,inbox}.ts` | `facebook` | PA, LV |
| Telegram (text+buttons, photo, album, video; no metrics; manual reconcile; bot inbox ownership) | `providers/src/telegram/*` | `telegram`, `inbox-channels-by-network` | LV |
| X (text, ≤4 images, video; billed reads; x.write/x.read budgets; token revoke on disconnect) | `providers/src/x/*`, `services/src/engine/budget.ts` | `x-twitter` | SU (credits), LV |
| TikTok (direct / inbox draft handoff / manual; required options; unaudited limits) | `providers/src/tiktok/*`, `apps/web/components/composer/provider-options.tsx` | `tiktok` | PA, LV |
| YouTube (video; required options; app vs provider-held release; analytics; comments) | `providers/src/youtube/*`, `services/src/engine/provider-scheduling.ts` | `youtube` | PA, LV |
| LinkedIn (member + organization; manual reconcile for members) | `providers/src/linkedin/*` | `linkedin` | PA (orgs), LV |
| Threads (text/image/video/carousel; emoji rule; replies) | `providers/src/threads/*` | `threads` | PA, LV |
| Pinterest (boards; trial vs standard; 90-day window analytics) | `providers/src/pinterest/*` | `pinterest` | PA, LV |
| Bluesky (app password; text + ≤4 images; no video; inbox) | `providers/src/bluesky/*` | `bluesky` | LV |
| Content sources: authorisation, selection, snapshots, ACL boundary, access loss, retention | `services/src/content-hub/{connections,items,imports,refresh,store}.ts`, `components/content-hub/*` | `content-sources-overview`, `google-drive-and-docs`, `notion`, `refresh-imported-content` | SU, LV (test transport) |
| Content exports (Doc / Drive file / Notion page) | `services/src/content-hub/exports.ts`, `content-hub-panel.tsx` ExportPlanDialog | `export-to-google-docs-drive-and-notion` | SU, LV |
| Notion writeback | `services/src/content-hub/writeback.ts` | `notion-writeback` | SU, LV |
| Business apps hub (connect, resources, sync rules, history, disconnect) | `services/src/integrations-v35/core/*`, `components/integrations-hub/*` | `business-apps-overview` | SU, LV |
| Asana / monday.com / HubSpot / Slack / Mailchimp / GBP / Translation | `services/src/integrations-v35/<app>/*`, `providers/src/<app>/*` | `asana`, `monday-com`, `hubspot`, `slack`, `mailchimp`, `google-business-profile`, `cloud-translation` | SU (GBP: PA), LV |
| Inbox capabilities per network | `services/src/inbox/capabilities.ts`, inbox adapters | `inbox-channels-by-network` | PA, LV |
| WhatsApp channel + charges | `providers/src/whatsapp/inbox.ts`, `services/src/inbox/channels-whatsapp.ts` | `whatsapp-in-the-inbox` | PA, LV |
| Google reviews | `providers/src/google-business/inbox.ts` | `google-reviews-in-the-inbox` | PA, LV |
| Analytics views + filters + compare + dataset | `apps/web/app/(app)/analytics/**`, `components/analytics/v3/shared.tsx`, `services/src/analytics/{query,filters}.ts` | `use-analytics` | AV (synthetic) |
| Measures (17) + combination rules + states | `services/src/analytics/{registry,semantics}.ts` (`docs/V3_ANALYTICS_DICTIONARY.md` is current: `--check` passes) | `analytics-metric-dictionary` | AV |
| Native metrics per network (55 definitions; fetched ones listed) | `services/src/analytics/registry.ts`, `providers/src/*/metrics.ts` | `metrics-by-network` | LV |
| Lifetime-by-publish-date basis, reach ≠ unique, labelled cross-network sums | `semantics.ts` sumCompatible, `query.ts` LIFETIME_LABEL/trendFor | `lifetime-totals-and-reach` | AV |
| Refresh cadence, delays, coverage, stale (48 h), retention | `analytics/{cadence,retention,index}.ts`, `query.ts` | `data-status-and-freshness` | AV |
| Engagement rate (ratio of sums), comparisons (new/flat/insufficient <50 %), best time (API) | `semantics.ts` compare/ratioOfSums, `query.ts` bestTime | `engagement-rate-and-comparisons` | AV |
| Content table / drawer / channels comparison groups | `analytics/content/page.tsx`, `channels/page.tsx`, `query.ts` channelComparison | `content-and-channel-rankings` | AV |
| Video + audience views | `analytics/{video,audience}/page.tsx`, `query.ts` video/audience | `video-and-audience-analytics` | AV (audience: demo only) |
| Workflow reporting | `query.ts` workflow, `analytics/workflow/page.tsx` | `workflow-reporting` | AV |
| Exports (CSV/PDF→HTML fallback, 5,000 rows, 20 MB, 7 days, 10/h) + saved reports (API) | `analytics/{reports,render,pdf}.ts` | `analytics-exports-and-reports` | AV |
| Calculated insights vs AI explain_analytics | `query.ts` insights, `services/src/assistant/{prompt,retrieval}.ts` | `calculated-insights-and-ai` | AV (AI needs key) |
| Other displayed metrics (Overview tiles, listening, SLA, CSAT, GBP metrics, Mailchimp report) | `overview/page.tsx`, `core/contracts/{v35-listening,v35-sla}.ts`, `providers/src/{google-business,mailchimp}/client.ts` | `other-metrics-in-relay` | AV / LV |

## Slugs for HC's contextual `<HelpLink>`s

Already placed by HC and existing: `connect-social-accounts`, `connection-status-and-fixes`, `analytics-metric-dictionary`,
`business-apps-overview`. Suggested additional placements (anchor ids are `slugifyHeading` output):

| Where in the app | Slug (+ anchor) |
|---|---|
| Connection card error/state note, Connection health rows | `connection-status-and-fixes#states-and-fixes` |
| OAuth callback error banner on /accounts | `connect-social-accounts#common-errors-when-connecting` |
| Disconnect confirm dialog | `connect-social-accounts#disconnect-what-happens` |
| "Not set up" dialog (NotConfiguredDialog) | `set-up-social-network-apps` |
| Composer validation issue for a network / provider options panel | `network-limits-at-a-glance` or the network slug (`tiktok#required-fields-in-the-composer`, `youtube#required-fields-in-the-composer`) |
| YouTube "Release" radio | `youtube#scheduling-two-ways` |
| TikTok limited/handoff banners | `tiktok#scheduling-and-publishing` |
| Unknown delivery "Not confirmed" | `connection-status-and-fixes#errors-you-may-see-on-a-delivery` |
| KPI / trend ⓘ tooltips | `analytics-metric-dictionary#measures` |
| "Lifetime of posts in period" basis label | `lifetime-totals-and-reach` |
| Analytics HealthFooter (coverage, complete through) | `data-status-and-freshness#what-each-state-means` |
| Engagement rate KPI / Compare switch | `engagement-rate-and-comparisons` |
| Channels "Not comparable" line | `content-and-channel-rankings#comparison-groups` |
| Workflow page note | `workflow-reporting` |
| Export menu | `analytics-exports-and-reports` |
| "Calculated from this data" heading | `calculated-insights-and-ai` |
| Content sources sharing banner / import preview | `content-sources-overview#imported-copies-do-not-follow-the-source-s-sharing` |
| Source item "No access / Removed / Changed" | `refresh-imported-content#when-refresh-can-t-read-the-source` |
| Notion writeback switch | `notion-writeback` |
| Settings → Inbox → Channels | `inbox-channels-by-network` |
| WhatsApp template/charge dialog | `whatsapp-in-the-inbox` |
| Translation settings (billing acknowledgement) | `cloud-translation` |
| GBP location metrics card | `google-business-profile#location-metrics-28-days` |

## Discrepancies found (report only — product code not changed)

1. **Connection card says "Analytics: Not available" for Facebook, Instagram and X** although metric fetchers exist and
   analytics sync reads them: `canReadMetrics: false` in `packages/providers/src/meta/common.ts` (capabilitiesFor) and
   `packages/providers/src/x/adapter.ts` (capabilities). Also propagates to MCP (`services/src/mcp/tools.ts:299`
   `can_read_metrics`) and diagnostics (`services/src/gov/diagnostics.ts:118`). Documented as a known display issue.
2. **TikTok Comments toggle inverted default (bug):** `components/composer/provider-options.tsx:61` shows the switch ON
   when `allowComment` is unset (`!== false`), but `providers/src/tiktok/adapter.ts:159,252` sends
   `disable_comment: o.allowComment !== true` → comments are **disabled** unless the user toggles. TikTok's guidelines
   also require greying out interactions disabled in creator_info (`comment_disabled`/`duet_disabled`/`stitch_disabled`
   are fetched but unused) and showing only Comment for photo posts.
3. **WhatsApp utility templates inside the window treated as free** (`providers/src/whatsapp/inbox.ts:139`); Meta resumed
   charging on 2026-10-01 → no charge acknowledgement for a charged message. Also Meta's 1,000 free service
   messages/month (from 2026-10-01) not modelled. `docs/v3-5/INBOX_NETWORKS.md` "WhatsApp charges" is outdated.
4. **Threads 5-link limit** (enforced by Threads since 2025-12-22, `THREADS_API__LINK_LIMIT_EXCEEDED`) not validated in
   `providers/src/threads/adapter.ts` → fails at publish instead of in the composer.
5. **TikTok photo max 1080p** (media transfer guide) not validated (`TIKTOK_CONSTRAINTS` has no max image dimension).
6. **Instagram insights:** Meta now marks `views` and `total_interactions` "in development" and says data can be delayed
   up to 48 h; registry (`services/src/analytics/registry.ts`) has them `available` with 24 h delay.
7. **Mailchimp report shows 0 for missing values** (`components/integrations-hub/post-integrations.tsx:109` uses `?? 0`),
   contrary to the "missing is never 0" rule.
8. **Content hub UI copy points to a non-existent "Settings → Sources"** (`components/content-hub/content-hub-panel.tsx:104`
   ExportPlanDialog banner; code comments in `content-hub/index.ts`, `source-connections.tsx` too) — actual location: Settings → Connections →
   Google Drive and Docs / Notion (or Connections → Content sources). `docs/V3_CONTENT_INTEGRATIONS.md` "Library →
   Sources tab, Settings → Sources tab" is outdated after the copy cleanup.
9. **API-only analytics features** (no UI): best-time (`/api/analytics/best-time`), saved reports
   (`/api/analytics/reports`), report export to Google Doc/Drive/Notion, campaign/team filters. Documented as API-only.
10. **Followers and audience breakdowns are never fetched** (all account-scope definitions `not_fetched`): live Channels
    "Followers"/"Change" always "—", Overview Followers KPI and Audience breakdowns only appear with demo data.
11. **Provider-side revocation on disconnect** only for X (social) and Slack (business apps); content sources revoke for
    Google and Notion. Other networks keep Relay in the user's connected-apps list (documented).
12. **Meta `ads_management`/`ads_read`** required by Meta when the Page role comes from Business Manager (content
    publishing + insights docs) — not requested. Known FLfB `config_id` gap still open.
13. `docs/v3-5/CAPABILITY_MATRIX.md` lists Slack `users:read`, `users:read.email`; code requests only `chat:write`,
    `channels:read`, `groups:read` (connectors/registry.ts). Matrix outdated.
14. YouTube `notifySubscribers` / `categoryId` options exist in the adapter (`YouTubeOptions`) but have no UI.
16. **Channels table "Engagements" column always "—"** (`apps/web/app/(app)/analytics/channels/page.tsx` KEY_METRICS looks
    up `family === 'engagements'`, but engagements is a measure, not a metric family) while the comparison card below
    shows engagement totals (visible in `help/img/analytics/analytics-channels.png`).
17. **Facebook reactions by type shown as several unlabelled "Reactions" values** in the content detail drawer
    (`analytics/content/page.tsx` renders `m.name` without `m.dimension`).
15. Notion rate limit in `docs/V3_CONTENT_INTEGRATIONS.md` (~3 rps) is outdated: Notion now documents 180/min
    (600/min on Business/Enterprise) plus ~3 rps for data source queries (informational; Relay honours Retry-After).

## Provider sources checked 2026-11-09 (WebFetch/WebSearch)

Verified on official pages (32): Meta IG User Media; IG content publishing; IG media insights; FB Page photos; FB
insights; Graph API versions; Meta permissions; Messenger policy; Threads overview, posts, get-started, insights;
WhatsApp pricing; Telegram Bot API; X pricing; X media best practices; TikTok content sharing guidelines, direct post
reference, photo post reference, media transfer guide, content posting get started, video object; YouTube videos.insert,
videos resource, quota costs, Help 71673, Analytics metrics; LinkedIn Community Management overview, MultiImage API,
Videos API, refresh tokens, Share on LinkedIn; Pinterest access tiers; Bluesky lexicons via the official `@atproto/api`
package; Google Drive scopes; Notion versioning, request limits, file object; GBP prerequisites, localPosts, reviews;
Asana OAuth scopes + webhooks; Slack request verification; HubSpot webhook validation; monday.com webhooks; Mailchimp
webhooks; Cloud Translation pricing (official page via search-result text; the page itself didn't render).

**Not verified** (stated as such in the articles): X 280/23-weighting (not re-fetched); Facebook text/video limits
(undocumented); LinkedIn 3,000-character commentary limit (not in the Posts API reference); Pinterest title 100,
link 2,048, image/video specs, multi-image 2–5 and Pin analytics (docs didn't render); GBP 1,500-character local post
(not in Google's reference); TikTok/X/Threads/LinkedIn/Pinterest "revoke access" menu paths in their apps; Mailchimp
OAuth scope granularity (not on the fetched page); Google OAuth verification requirements for YouTube scopes.

## Screenshots (1440 px, light, synthetic data; taken under the lock 2026-11-09)

`apps/web/public/help/img/social-connections/{connections,connect-a-network}.png` (Demo Workspace, simulated
destinations) · `apps/web/public/help/img/analytics/{analytics-overview,analytics-content-detail,analytics-channels,analytics-workflow}.png`
(Relay Showcase, demo dataset) · `apps/web/public/help/img/business-apps/business-apps-hub.png` (E2E Workspace,
simulated installations). A Google Drive settings shot was dropped because it shows Setup key names.
