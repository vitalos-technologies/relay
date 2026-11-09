---
title: Publish to Instagram
summary: Connect an Instagram professional account through its Facebook Page, publish images, carousels and Reels, read insights and answer DMs and comments within Instagram's limits.
section: social-connections
audience: user
roles: [owner, admin, publisher]
status: needs-provider-approval
related: [connect-social-accounts, facebook, connection-status-and-fixes, network-limits-at-a-glance, metrics-by-network, inbox-channels-by-network, set-up-social-network-apps]
product_version: "2026-11"
reviewed: 2026-11-09
order: 40
keywords: [instagram, ig, reels, carousel, professional account, business account, creator account, meta, page publishing authorization]
sources:
  - title: "Instagram — IG User Media reference (image, caption, carousel and Reel limits)"
    url: https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/media
    verified: 2026-11-09
  - title: "Instagram — Content publishing guide (permissions, PPA, publishing limit, 24 h containers)"
    url: https://developers.facebook.com/docs/instagram-platform/content-publishing
    verified: 2026-11-09
  - title: "Instagram — Media insights"
    url: https://developers.facebook.com/docs/instagram-platform/reference/instagram-media/insights
    verified: 2026-11-09
  - title: "Meta — Permissions reference (App Review, Business Verification)"
    url: https://developers.facebook.com/docs/permissions
    verified: 2026-11-09
  - title: "Meta — Graph API versions"
    url: https://developers.facebook.com/docs/graph-api/changelog/versions
    verified: 2026-11-09
---

## At a glance

| | |
|---|---|
| Status in Relay | Built and tested on simulated Instagram; **not verified with a live account**. Other people's accounts can connect only after Meta App Review. |
| Destination | One Instagram **professional** (Business or Creator) account linked to a Facebook Page |
| Formats | Single image · Carousel (2–20 images/videos) · Reel (one video) |
| Text-only posts | Not possible (Instagram requires media) |
| Scheduling | Relay publishes at the scheduled time (Instagram's own scheduler is not used) |
| Edit / delete after publishing | Not possible from Relay |
| Analytics | Post insights (views, reach, likes, comments, saves, shares, total interactions) — needs the insights permission |
| Inbox | DMs and comments (needs a separate Meta approval) |

## Before you start

**Network rules (Meta, verified 2026-11-09):**

- The account must be an Instagram **professional account connected to a Facebook Page**.
- The person connecting needs a role on that Page that lets them create content.
- If the Page requires **Page Publishing Authorization (PPA)**, publishing is blocked until PPA is completed; Meta
  recommends completing it in advance because a Page can start requiring it later.
- Permissions: `instagram_basic`, `instagram_content_publish`, `pages_read_engagement` (plus `pages_show_list` to list
  your Pages). Insights need `instagram_manage_insights`. If your Page role comes from a Business Manager, Meta may
  also require `ads_management`/`ads_read`, which Relay does **not** request today.
- For accounts that are not app testers, Meta must approve each permission through **App Review**, and Meta requires
  **Business Verification** for Advanced Access.

**Relay setup:** the workspace owner configures the Meta app once ([Set up the social network apps](/help/social-connections/set-up-social-network-apps)).

## Connect

1. **Connections** ([/accounts](/accounts)) → brand → **Connect** → **Instagram**.
2. Sign in with the Facebook account that manages the Page linked to your Instagram account and approve all permissions.
3. On **Choose destinations**, tick the Instagram account(s). Accounts on Pages where you cannot create content are
   greyed out with the reason.
4. Select **Add**. The card should show **Connected** and *Image · Album · Reel*.

## What you can publish

| Format | How to create it in Relay | Notes |
|---|---|---|
| Single image | One image | JPEG publish copy is produced by Relay's media pipeline |
| Carousel | 2–20 images and/or videos | Captions apply to the whole carousel; Instagram crops items to the first item's aspect ratio. A carousel counts as one post towards the daily limit. |
| Reel | One video | Relay uses its poster frame as the cover and shares the Reel to the feed |

## Limits

| Rule | Instagram (verified 2026-11-09) | Relay |
|---|---|---|
| Caption | 2,200 characters, 30 hashtags, 20 @tags | Checks all three (counts code points) |
| Image | JPEG only, ≤ 8 MB, aspect 4:5 to 1.91:1, width 320–1440 px (scaled) | Same; rejects narrower than 320 px |
| Carousel | Up to 20 items, images and videos mixed | 2–20 |
| Reel video | MOV/MP4, H.264 or HEVC, AAC ≤ 48 kHz, 23–60 fps, ≤ 1920 px wide, aspect 0.01:1–10:1 (9:16 recommended), 3 s–15 min, ≤ 300 MB | Same |
| Links | Not clickable in captions | Link field not offered |
| Publishing limit | The guide states both 100 and 50 API-published posts per 24 hours | Relay reads the account's actual quota from Instagram before publishing |
| Not supported by the API | Shopping tags, filters | — |

## Scheduling and publishing

Relay keeps the schedule and starts publishing at the due time. Instagram publishing has two steps: Relay first
creates an invisible "container" with your media (Instagram downloads it from a temporary, signed Relay link), waits
until Instagram has processed it, then publishes. Videos can take several minutes. Containers expire after 24 hours,
so Relay recreates them if publishing is delayed. If a publish answer is lost, Relay checks the container status and
the account's recent posts before doing anything else, so a post is never published twice.

## Analytics

Post insights: **Views, Reach, Likes, Comments, Saves, Shares, Total interactions** (lifetime values per post). Meta
says insight data can be delayed up to 48 hours, are stored for up to 2 years, and come back empty (not 0) when not
available. Insights are not available for items inside a carousel. Reading insights needs `instagram_manage_insights`;
without it Analytics shows *missing permission*, never 0. See [Metrics by network](/help/analytics/metrics-by-network).

## Inbox

DMs and comments can be answered in **Inbox** once Meta has approved the messaging and comment permissions. Rules:
DMs within 24 hours of the customer's last message (7 days with Meta's Human Agent approval); one private reply to a
comment within 7 days. See [Inbox channels by network](/help/inbox-and-care/inbox-channels-by-network).

## Limitations

- No Stories, no editing or deleting published posts, no shopping tags, no collaborator invites, no first comment.
- Alt text and user tags are not sent to Instagram.
- Facebook Login for Business configurations are not supported (classic Facebook Login only).

## Reconnect, revoke, disconnect

- **Reconnect** when the card shows *Reconnect required* or *Missing permission*. The Page access Relay stores has no
  fixed expiry, but it stops working when the person who connected loses their Page role, changes their Facebook
  password, or removes the app.
- **Disconnect** deletes the stored sign-in and blocks scheduled posts; published posts stay on Instagram.
- To remove Relay's access on Meta's side as well, remove the app in Facebook **Settings → Business integrations**
  (Relay cannot do this for you). The menu names are the network's and may change (not verified in a live account).

## Common problems

| Message or symptom | Cause | Fix |
|---|---|---|
| No pages or profiles to publish to | The Facebook account has no Page with a linked Instagram professional account, or no content role on it | Link the Instagram account to a Page in Instagram's settings, check your Page role, reconnect |
| Image aspect ratio / width message | Image outside 4:5–1.91:1 or narrower than 320 px | Crop in Relay's media editor and reschedule |
| Publishing blocked: Page Publishing Authorization | The Page needs PPA | Complete PPA in Facebook, then retry |
| Rate limited until … | Daily publishing quota or Meta API limits reached | Relay retries automatically after the time shown |
| Not confirmed — check before retrying | The answer from Instagram was lost | Relay checks automatically; if it stays *Unknown*, look on Instagram and resolve it in Relay |
