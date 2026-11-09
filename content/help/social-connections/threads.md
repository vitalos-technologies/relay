---
title: Publish to Threads
summary: Connect a Threads profile, publish text, images, videos and carousels within Threads' 500-character and emoji rules, read post insights and answer replies.
section: social-connections
audience: user
roles: [owner, admin, publisher]
status: needs-provider-approval
related: [connect-social-accounts, connection-status-and-fixes, network-limits-at-a-glance, metrics-by-network, inbox-channels-by-network, set-up-social-network-apps]
product_version: "2026-11"
reviewed: 2026-11-09
order: 47
keywords: [threads, meta, carousel, emoji, 500 characters, replies, link limit]
sources:
  - title: "Threads — overview (media specifications, carousel, 250 posts per 24 h)"
    url: https://developers.facebook.com/docs/threads/overview
    verified: 2026-11-09
  - title: "Threads — posts (500 characters, emoji bytes, 5 links, link attachment)"
    url: https://developers.facebook.com/docs/threads/posts
    verified: 2026-11-09
  - title: "Threads — get started (permissions, App Review, token lifetimes)"
    url: https://developers.facebook.com/docs/threads/get-started
    verified: 2026-11-09
  - title: "Threads — insights"
    url: https://developers.facebook.com/docs/threads/insights
    verified: 2026-11-09
---

## At a glance

| | |
|---|---|
| Status in Relay | Built and tested on a simulated Threads API; **not verified with a live profile**. Profiles without a role on Relay's Meta app can connect only after Meta App Review. |
| Destination | The Threads profile that signs in |
| Formats | Text · Image · Video · Carousel (2–20 images/videos) |
| Scheduling | Relay publishes at the scheduled time |
| Edit / delete after publishing | Not possible from Relay |
| Analytics | Views, likes, replies, reposts, quotes, shares (needs `threads_manage_insights`) |
| Inbox | Replies to your posts (hide/unhide, reply). No DMs (Threads has no DM API). |

## Before you start

**Network rules (Meta, verified 2026-11-09):** `threads_basic` is needed for everything and `threads_content_publish`
for publishing; insights need `threads_manage_insights`, replies `threads_read_replies` and `threads_manage_replies`.
For people without a role on the app, each permission must be approved in **App Review** and the app published.
Long-lived tokens last **60 days** and can be refreshed; permission grants from **private** profiles cannot be
extended and must be granted again. Each profile can publish **250** posts through the API in a rolling 24 hours
(a carousel counts as one).

## Connect

1. **Connections** ([/accounts](/accounts)) → brand → **Connect** → **Threads**.
2. Sign in to Threads and approve.
3. The profile appears on **Connections**. Threads does not tell Relay which permissions were granted, so a missing
   permission only shows up when publishing or reading insights.

## Limits

| Rule | Threads (verified 2026-11-09) | Relay |
|---|---|---|
| Text | 500 characters; **each emoji counts as its UTF-8 bytes** (often 4) | Same rule: "text is 512 of 500 allowed (emojis count as their UTF-8 bytes)" |
| Links | At most **5** links per post (link attachment counts unless it repeats a URL in the text) | **Not checked** — Threads rejects the post |
| Image | JPEG/PNG, ≤ 8 MB, aspect up to 10:1, width 320–1440 (scaled) | JPEG/PNG ≤ 8 MB, aspect 1:10–10:1 |
| Video | MOV/MP4, H.264/HEVC, AAC, 23–60 fps, ≤ 1920 px wide, aspect 0.01:1–10:1, up to 5 min, ≤ 1 GB | Same |
| Carousel | 2–20 images/videos | Same |

On text-only posts the link is sent as a link attachment (preview); with media it is appended to the text. Images and
videos carry their library alt text (up to 1,000 characters).

## Scheduling and publishing

Relay creates the media containers ahead of the publish step (Threads recommends waiting about 30 seconds), checks
they are finished, then publishes at the due time. Containers expire after about a day, so Relay recreates them if
needed. A lost answer is resolved from the container's status, which tells Relay definitively whether it was published.

## Analytics

`views`, `likes`, `replies`, `reposts`, `quotes`, `shares` per post (lifetime). Meta marks **views** and **shares** as
"in development"; Relay labels them that way. Replies on a root post count all replies in the conversation. See
[Metrics by network](/help/analytics/metrics-by-network).

## Reconnect, revoke, disconnect

- **Reconnect** when the 60-day sign-in lapses or after granting missing permissions.
- **Disconnect** deletes the stored sign-in and blocks scheduled posts; posts stay on Threads.
- Revoke Relay in Threads under **Settings → Account → Website permissions**. The menu names are the network's and may change (not verified in a live account).

## Common problems

| Message | Fix |
|---|---|
| Threads: text is … of 500 allowed (emojis count as their UTF-8 bytes). | Remove characters or emoji. |
| Link limit exceeded | Use 5 links or fewer. |
| Threads: alt text of the image is … of 1000 characters. | Shorten the image's alt text in **Content library**. |
| Container expired | Relay rebuilds it automatically; if it keeps failing, re-upload the media. |
| Rate limited | 250 posts per 24 h reached; Relay retries later. |
