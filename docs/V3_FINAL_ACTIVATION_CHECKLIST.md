# V3 final activation checklist

Only things a human operator must do outside the code. Engineering gaps: [V3_IMPLEMENTATION_GAPS.md](V3_IMPLEMENTATION_GAPS.md). Earlier items still apply:
- [FINAL_ACTIVATION_CHECKLIST.md](FINAL_ACTIVATION_CHECKLIST.md): V1 hosting, Meta, Telegram, X;
- [V2_FINAL_ACTIVATION_CHECKLIST.md](V2_FINAL_ACTIVATION_CHECKLIST.md): Keycloak, DB roles, KMS, email, domain/TLS.

**Rules:**
- Store every secret in the secret manager or **Relay Setup** (admin, protected). Never put one in chat, tickets or this repo.
- `<APP_BASE_URL>` = the final public https origin. It has not been chosen yet, and most items below depend on it.
- Live tests use **designated test accounts and destinations only**. Never use live business channels.

## 0. Prerequisites

| What | Where | How to verify | Unlocks |
|---|---|---|---|
| Public HTTPS domain + TLS; `APP_BASE_URL=https://…` | DNS, reverse proxy, env (V2 checklist §6) | `curl -sI https://<domain>/login` shows CSP + HSTS; `/api/ready` → 200 | Every OAuth redirect, webhooks, MCP |
| Production migrations 014–017 and 019 applied (no 018 exists) | Release job with the migrator role | `/api/ready` → ready; worker logs show the analytics, content-hub and mcp-jobs loops starting | All V3 features |
| One designated test account/destination per network (private where possible) | Each network | Recorded in the provider register with the owner's name | Live canaries |
| Master SVG logo from the brand designer | Design hand-off → `apps/web/components/brand/relay-mark.tsx` / `public/` | Mark renders crisply at 16–512 px | Replaces the redrawn mark (D19) |

## 1. Social provider apps and reviews (new in V3)

Callback for every OAuth provider: `<APP_BASE_URL>/api/oauth/<provider>/callback`. Configure keys in **Relay Setup → ‹provider›** or the secret manager.

| Network | What | Where | How to verify | Unlocks |
|---|---|---|---|---|
| TikTok | Developer app with Login Kit + Content Posting API; scopes `user.info.basic video.publish video.upload video.list`; redirect URI; `TIKTOK_CLIENT_KEY`/`TIKTOK_CLIENT_SECRET` | developers.tiktok.com → app | Connect a test creator; **Connections** shows the publish mode (direct / inbox / manual) | Inbox (draft handoff) and unaudited Direct Post (`SELF_ONLY`, private accounts, ≤ 5 creators/day) |
| TikTok | **Direct Post audit and intended-use review.** Describe Relay truthfully; TikTok rejects internal "utility tool" uses. If refused, Relay stays on inbox/manual handoff | TikTok app → audit | Audit approval email; then set `TIKTOK_DIRECT_POST_AUDITED=true`; eligibility changes to "Direct Post (audited client)" | Public Direct Post |
| TikTok | Verify the media domain/URL prefix (the public storage origin) | TikTok app → URL properties | A photo test post no longer fails with `url_ownership_unverified` | Photo posts (PULL_FROM_URL) |
| YouTube | Google Cloud project; enable **YouTube Data API v3** and **YouTube Analytics API**; OAuth web client with the redirect URI; `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` | console.cloud.google.com | Connect a test channel; upload a **private** test video; Relay shows processing → published only when YouTube reports it | Video upload |
| YouTube | OAuth consent screen + **verification** for `youtube.upload`, `youtube.readonly`, `yt-analytics.readonly`, `youtube.force-ssl` | Cloud console → OAuth consent | No "unverified app" screen for a non-test user | Non-test users; native scheduling + cancellation (force-ssl) |
| YouTube | Optional: quota audit if more than 100 uploads/day are needed | YouTube API Services audit form | Quota page shows the new limit | Higher volume |
| LinkedIn | App with **Share on LinkedIn** + **Sign In with LinkedIn (OpenID)**; redirect URI; `LINKEDIN_CLIENT_ID`/`LINKEDIN_CLIENT_SECRET`; app verified against a LinkedIn Page | linkedin.com/developers | Connect a test member; a text post publishes to that member | Member posting |
| LinkedIn | **Community Management API** application. After approval, set `LINKEDIN_ORGANIZATIONS=true`. The test member needs an approved Content admin/Administrator role on the test Page | LinkedIn app → Products | Organisation appears as selectable; post appears on the Page; analytics shows data, not "permission missing" | Organisation posting, all LinkedIn analytics (member analytics scope is only requested with this flag) |
| Threads | Meta app with the **Threads** use case (separate from Facebook Login); redirect URI; `THREADS_APP_ID`/`THREADS_APP_SECRET`; add test users as Threads testers | developers.facebook.com → app → Threads | Tester connects; text post publishes | Tester-only use |
| Threads | **App Review** for advanced access to `threads_basic`, `threads_content_publish`, `threads_manage_insights` | Meta App Review | A non-tester account connects | General use and insights |
| Pinterest | App; redirect URI; `PINTEREST_APP_ID`/`PINTEREST_APP_SECRET`; a test board | developers.pinterest.com | Connect; pick a board; Pin created (Trial: visible only to you) | Trial (sandbox) |
| Pinterest | **Upgrade to Standard access** (video of the OAuth flow + live integration). After approval, set `PINTEREST_ACCESS_TIER=standard` | Pinterest app → access tier | Eligibility shows "Standard access"; Pin is publicly visible | Public Pins |
| Bluesky | No app. The test-account owner creates an **app password** (Bluesky → Settings → Privacy and security → App passwords) and enters it in **Connections → Bluesky** (handle + app password) | Bluesky account | Connect; text + image post appears; reconnect with a new app password keeps the same connection | Bluesky posting |
| Bluesky | Self-hosted servers only: add exact hostnames to `BLUESKY_SELF_HOSTED_HOSTS` | Server env (operator) | Connecting with that server's handle succeeds; others are refused | Self-hosted PDS accounts |

Instagram, Facebook, Telegram and X apps/reviews: unchanged, see V1 checklist §2–4.

## 2. Google content (Drive, Docs, Picker)

| What | Where | How to verify | Unlocks |
|---|---|---|---|
| Enable **Google Drive API**, **Google Docs API** and **Google Picker API** in a Cloud project (can be the YouTube project) | Cloud console → APIs | APIs listed as enabled | Content Hub (Google) |
| OAuth web client for content (separate from YouTube recommended). Scope `drive.file` (plus `openid email`). Redirect `<APP_BASE_URL>/api/content-hub/oauth/google/callback`. Set `GOOGLE_CONTENT_CLIENT_ID`/`GOOGLE_CONTENT_CLIENT_SECRET` | Cloud console → Credentials; Relay Setup → Google Drive & Docs | **Settings → Connections → Google Drive and Docs → Connect**; Google consent lists only "see and edit specific files you use with this app" | Google connection |
| OAuth consent screen published (brand verification as Google requires; `drive.file` is non-sensitive) | Cloud console → OAuth consent | Non-test user can connect without an unverified warning | Use beyond test users |
| **Picker API key** restricted to the Picker API and HTTP referrer `<APP_BASE_URL>/*` → `GOOGLE_PICKER_API_KEY`. Project **number** → `GOOGLE_PICKER_APP_ID` | Cloud console → Credentials | Library → Sources: choosing from Drive opens the Picker; browser console shows no CSP violations | File selection |
| Decide the Picker CSP: keep the default (Google frame/connect origins allowed) or set `CONTENT_HUB_GOOGLE_PICKER=false` when Google content is not used | Web env | `curl -sI https://<domain>/login` shows `frame-src 'none'` when disabled | Smaller CSP (gap S1) |
| Optional Drive change notifications: `<APP_BASE_URL>/api/webhooks/google-drive` must be public HTTPS (domain verification may be required by Google) | Network / Search Console | After a picked file changes, its card shows "changed" without manual refresh | Change signals (manual refresh works without it) |

## 3. Notion public integration

| What | Where | How to verify | Unlocks |
|---|---|---|---|
| Create a **public** integration. Redirect `<APP_BASE_URL>/api/content-hub/oauth/notion/callback`. Capabilities: read content. Add update + insert content only if writeback and exports will be used. Set `NOTION_CLIENT_ID`/`NOTION_CLIENT_SECRET` | notion.so/profile/integrations; Relay Setup → Notion | Connect; Notion's page picker shows only the pages the user shares; Relay lists only those | Notion import/export |
| Never set `NOTION_INTERNAL_TOKEN` in production (test installs only; production refuses it) | Env | Production boot / Setup shows it unset | – |
| Optional webhooks: subscribe `<APP_BASE_URL>/api/webhooks/notion`. An owner adopts the verification token in Relay (`POST /api/content-hub/settings`) and pastes it into Notion. This sets `NOTION_WEBHOOK_VERIFICATION_TOKEN` | Notion integration → Webhooks | Notion shows the subscription verified; editing a selected page marks its card "changed" | Change signals |
| Writeback to a `status` property: create Relay's options in that property (`Draft in Relay`, `In review`, `Scheduled`, `Published`, `Failed`) | Notion database | A scheduled post's row shows "Scheduled" | Status writeback |

## 4. MCP: public HTTPS and clients

| What | Where | How to verify | Unlocks |
|---|---|---|---|
| Serve `/mcp` over public HTTPS. Set `MCP_RESOURCE_URL=https://<domain>/mcp`. Set `MCP_ALLOWED_HOSTS` / `MCP_ALLOWED_ORIGINS` if a proxy changes Host/Origin. Use sticky routing with several web replicas | Web env, proxy | `curl -s https://<domain>/.well-known/oauth-protected-resource/mcp` returns the resource and issuer; unauthenticated POST → 401 with `resource_metadata` | Remote MCP clients |
| Register each real client's redirect URI on Keycloak client **`relay-mcp`**: MCP Inspector, Claude Code, Claude, ChatGPT. Use the URIs each vendor documents; only Inspector's local URIs are pre-loaded | Keycloak admin → Clients → relay-mcp → Valid redirect URIs | The client completes sign-in + consent; **Settings → Developer → MCP** lists it | Each client |
| Decide on dynamic client registration (off by default, `MCP_DCR_ENABLED=false`). Enabling it means changing Keycloak's client-registration policies and allowing the MCP scopes | Keycloak → Clients → Client registration policies | A DCR-only client registers, or is refused as intended | DCR-only clients |
| Test each client and update the tested-clients table in `docs/V3_MCP_GUIDE.md` / `services/mcp/setup.ts` | Real client | `list_workspaces` returns the consented workspace; a read-only consent cannot `create_draft`; the client appears in **Settings → Developer → MCP** | Honest client list |
| Each MCP user signs in to Relay once with the same Keycloak account before connecting | Relay | Otherwise the token maps to no Relay user and `/mcp` answers 401 | MCP access |

## 5. Keycloak: relay-mcp client

| What | Where | How to verify | Unlocks |
|---|---|---|---|
| Any environment built from the local realm import before the MCP client was added: recreate Keycloak with `docker compose -f infra/compose.yaml up -d --force-recreate oidc` (dev: already done per `HANDOFF.md`) | Host running compose | Keycloak admin shows client `relay-mcp` and the seven scopes `social.read` … `reports.export` | MCP sign-in |
| Production Keycloak (do **not** import the dev realm): create public client `relay-mcp` (standard flow, PKCE S256, consent on, `default.acr.values=mfa`). Create the seven client scopes, each with an audience mapper whose included custom audience = `https://<domain>/mcp` | Keycloak admin | Token for `relay-mcp` has `aud` = the public MCP URL and `azp=relay-mcp`; Relay accepts it, and the web-login token is refused at `/mcp` | MCP auth |

## 6. Analytics provider permissions

| Network | What | How to verify | Unlocks |
|---|---|---|---|
| Instagram / Facebook | Meta App Review for `instagram_manage_insights` and `read_insights` (+ `pages_read_engagement`). then set `META_REQUEST_INSIGHTS=true` in Setup → Meta and reconnect the accounts | Analytics → data health shows "ok", not "permission missing" | FB/IG post metrics |
| X | Prepaid credits; set the workspace read budget (`limits.x_monthly_reads`) | Metrics appear; budget usage moves | X metrics (billable) |
| TikTok | `video.list` approved; Direct Post (public posts only have metrics) | Public test video shows views | TikTok metrics |
| YouTube | `yt-analytics.readonly` included in the verified consent screen | Video shows views/watch time after YouTube's delay | YouTube metrics |
| LinkedIn | Community Management API (`rw_organization_admin`) and/or `r_member_postAnalytics`, then `LINKEDIN_ORGANIZATIONS=true` | Post shows impressions | LinkedIn metrics |
| Threads | `threads_manage_insights` advanced access | Likes/replies appear | Threads metrics |
| Pinterest | Standard access (`pins:read`, `boards:read`) | Pin shows impressions (≤ 90 days) | Pinterest metrics |
| Bluesky | Nothing (public counts) | – | – |
| Reports | PDF exports need Chromium in the worker image; otherwise they arrive as HTML with a note (`ANALYTICS_PDF=off` forces HTML) | Export a PDF; file starts with `%PDF` | PDF reports |
| Demo data | Never run `scripts/analytics-demo.ts` against production | No demo workspace in production | Clean live data |

## 7. After activation

1. Canary per network on its designated test destination: publish, reconcile, metrics, disconnect/revoke. Record the evidence in `docs/providers/<p>.md` ("Live verification").
2. Google and Notion:
   - import one file, one Doc and one page;
   - export one report;
   - revoke access at the provider and confirm previews disappear.
3. MCP: one real client. Do prepare → confirm in Relay → commit on a test brand, then revoke the client.
4. Update [V3_PLATFORM_CAPABILITIES.md](V3_PLATFORM_CAPABILITIES.md) "Verified live" and the matrix rows marked "Blocked (external)".
