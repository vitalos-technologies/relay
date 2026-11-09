---
title: Set up the social network apps
summary: What each network needs before anyone can connect an account through Relay — developer app, callback address, permissions to request and the approvals the network must grant.
section: social-connections
audience: user
roles: [owner]
status: needs-provider-approval
related: [connect-social-accounts, connection-status-and-fixes, instagram, facebook, x-twitter, tiktok, youtube, linkedin, threads, pinterest]
product_version: "2026-11"
reviewed: 2026-11-09
order: 90
keywords: [setup, app review, developer app, client id, callback, redirect uri, approval, business verification, audit, advanced access]
sources:
  - title: "Meta permissions reference (App Review, Business Verification for Advanced Access)"
    url: https://developers.facebook.com/docs/permissions
    verified: 2026-11-09
  - title: "Threads API — get started (App Review for non-role users)"
    url: https://developers.facebook.com/docs/threads/get-started
    verified: 2026-11-09
  - title: "TikTok Content Sharing Guidelines (audit, unaudited limits)"
    url: https://developers.tiktok.com/doc/content-sharing-guidelines
    verified: 2026-11-09
  - title: "YouTube Data API — videos.insert"
    url: https://developers.google.com/youtube/v3/docs/videos/insert
    verified: 2026-11-09
  - title: "LinkedIn Community Management API overview"
    url: https://learn.microsoft.com/en-us/linkedin/marketing/community-management/community-management-overview
    verified: 2026-11-09
  - title: "Pinterest access tiers"
    url: https://developers.pinterest.com/docs/key-concepts/access-tiers/
    verified: 2026-11-09
  - title: "X API pricing"
    url: https://docs.x.com/x-api/getting-started/pricing
    verified: 2026-11-09
---

Networks only let an app post on someone's behalf after the app is registered with them, and most only let **other
people's** accounts connect after the network has reviewed the app. This page is for the workspace **owner**, who
enters app details in **Setup** ([/setup](/setup)). Until a network is set up, the **Connect** picker shows it as
**Not set up**.

> **Important:** None of the approvals below have been obtained for this Relay installation yet, and no live account
> has been connected. Until a network approves the app, only the people listed as testers/roles in that network's
> developer console can connect, and some networks restrict what those posts can do.

## The callback address

Every OAuth network needs Relay's callback (redirect) address registered exactly:

`https://<your Relay address>/api/oauth/<network>/callback`

with `<network>` one of `facebook`, `instagram`, `x`, `tiktok`, `youtube`, `linkedin`, `threads`, `pinterest`.
**Setup** shows the exact value for your installation next to each network. Telegram and Bluesky need no app.

## What each network needs

| Network | Developer app | Permissions Relay requests | Approval needed before other people can connect | Notes |
|---|---|---|---|---|
| Facebook Pages | Meta app with Facebook Login | `pages_show_list`, `pages_read_engagement`, `pages_manage_posts`; analytics adds `read_insights` (only when the insights option is enabled in Setup); inbox adds `pages_messaging`, `pages_manage_engagement`, `pages_read_user_content` (only when enabled) | Meta **App Review** per permission (screencast + use case) and **Business Verification** for Advanced Access | One Meta app serves Facebook and Instagram. |
| Instagram | Same Meta app | `pages_show_list`, `pages_read_engagement`, `instagram_basic`, `instagram_content_publish`; analytics adds `instagram_manage_insights` | Same as Facebook | Accounts must be professional and linked to a Page. |
| Threads | Meta app with the Threads use case (its own app id/secret) | `threads_basic`, `threads_content_publish`, `threads_manage_insights` | Meta **App Review** of each permission, and the app must be published | Testers can connect before review. |
| X | X developer app, OAuth 2.0 (Web App, Read and write) | `tweet.read`, `tweet.write`, `users.read`, `media.write`, `offline.access` | No review, but **prepaid pay-per-use credits**: every post, upload and read is billed by X | Set a budget in **Settings → Operations → Usage and limits**. |
| TikTok | TikTok developer app with Login Kit + Content Posting API (Direct Post enabled) | `user.info.basic`, `video.publish`, `video.upload`, `video.list` | TikTok **audit** of the app. Before the audit: up to 5 creators per 24 h, accounts must be private, posts are *Only me* | Without `video.publish` the connection becomes inbox-draft (manual handoff) only. |
| YouTube | Google Cloud OAuth client with YouTube Data API v3 and YouTube Analytics API | `youtube.upload`, `youtube.readonly`, `yt-analytics.readonly`, `youtube.force-ssl` | Google **OAuth app verification** for these scopes (not verified in this build); upload quota: 100 `videos.insert` calls per day per project by default | `youtube.force-ssl` is optional; without it YouTube-held scheduling is off. |
| LinkedIn | LinkedIn app with *Share on LinkedIn* (member posting) | `openid`, `profile`, `w_member_social`; organizations add `w_organization_social`, `r_organization_social`, `rw_organization_admin`, `r_member_postAnalytics` | Member posting is self-serve. Company Page posting needs the **Community Management API**, a vetted product requested from a separate, new developer app (Development tier, then Standard tier with a screencast) | Organization scopes are requested only after you switch them on in Setup; requesting them earlier makes LinkedIn refuse the sign-in. |
| Pinterest | Pinterest developer app | `boards:read`, `pins:read`, `pins:write`, `user_accounts:read` | **Standard access** (video of the OAuth flow + review). On Trial access, Pins are sandbox entities visible only to you | Relay shows Trial connections as *Limited access*. |
| Telegram | None (each brand uses its own bot from @BotFather) | Bot must be a channel admin with *Post messages* | None | Relay never changes an existing bot webhook when publishing. |
| Bluesky | None (each person creates an app password) | — | None | AT Protocol OAuth is not supported yet. |

## After setup

1. Ask someone with a tester/role account on the network to connect first ([Connect a social account](/help/social-connections/connect-social-accounts)).
2. Publish a test post to a test destination and confirm it on the network.
3. Apply for the network's review with screen recordings of that flow.
4. Re-check each network guide's "Before you start" section when the network changes its rules: they change often.

## Limitations

- Relay does not support Facebook Login for Business configurations (`config_id`); it uses the classic permission
  dialog. If your Meta app only offers a Login for Business configuration, connecting will need a product change.
- Relay pins Meta Graph API **v26.0** (the newest version in Meta's version table on 2026-11-09).
