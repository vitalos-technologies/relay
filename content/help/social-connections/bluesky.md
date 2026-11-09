---
title: Publish to Bluesky
summary: Connect a Bluesky account with an app password, publish text and up to four images with rich-text links and mentions, read engagement counts, and answer replies, mentions and DMs.
section: social-connections
audience: user
roles: [owner, admin, publisher]
status: not-live-verified
related: [connect-social-accounts, connection-status-and-fixes, network-limits-at-a-glance, metrics-by-network, inbox-channels-by-network]
product_version: "2026-11"
reviewed: 2026-11-09
order: 49
keywords: [bluesky, bsky, atproto, app password, graphemes, pds, self-hosted]
sources:
  - title: "Bluesky lexicons in the official @atproto/api package (post 300 graphemes / 3,000 bytes; 4 images; 2,000,000-byte images; video 300 MB)"
    url: https://unpkg.com/@atproto/api/dist/client/lexicons.js
    verified: 2026-11-09
---

## At a glance

| | |
|---|---|
| Status in Relay | Built and tested on a simulated Bluesky server; **not verified with a live account**. No network approval is needed. |
| Destination | The account whose handle and app password you enter (bsky.social or a self-hosted server) |
| Formats | Text · 1–4 images |
| Video | **Not supported in Relay** (Bluesky supports it; Relay's video flow is not built) |
| Scheduling | Relay publishes at the scheduled time |
| Edit / delete after publishing | Not possible from Relay |
| Analytics | Likes, reposts, replies, quotes, bookmarks (public counts) |
| Inbox | Replies, mentions and DMs |

## Before you start

Create an **app password** in Bluesky: **Settings → Privacy and security → App passwords**. To answer DMs from Relay,
allow direct messages when creating it. Relay does not support Bluesky's OAuth sign-in yet, and never asks for your
main password.

## Connect

1. **Connections** ([/accounts](/accounts)) → brand → **Connect** → **Bluesky**.
2. Enter your **Handle** (for example `name.bsky.social`) and the **App password** (stored encrypted, never shown
   again). Only if your account is not on bsky.social, fill in **Self-hosted server** (an `https://` address).
3. Select **Connect**.

## Limits

| Rule | Bluesky (verified 2026-11-09) | Relay |
|---|---|---|
| Text | 300 graphemes **and** 3,000 bytes | Same; a link is appended and made clickable |
| Images | Up to 4; each up to 2,000,000 bytes | 1–4, JPEG/PNG/WebP, ≤ 2,000,000 bytes |
| Languages | — | Optional, up to 3 language codes in the Bluesky variant |
| Video | MP4 up to 300 MB | Not supported |

Mentions (`@handle`) and links become rich-text facets automatically.

## Scheduling and publishing

Relay uploads the images and fixes the post's record key before the due time, then creates the post. Each image
carries its library alt text. Because the key
is fixed, a repeated attempt cannot create a second post, and a lost answer is resolved by looking the record up —
Relay always knows for certain whether it was published.

## Analytics

`likeCount`, `repostCount`, `replyCount`, `quoteCount`, `bookmarkCount` from Bluesky's public view of the post
(lifetime counts, available immediately). Bluesky has no view or impression counts, so engagement rate is not
available for Bluesky posts. See [Metrics by network](/help/analytics/metrics-by-network).

## Inbox

Replies and mentions (checked about every minute) and DMs in existing conversations. You can delete your own replies;
you cannot delete other people's. See [Inbox channels by network](/help/inbox-and-care/inbox-channels-by-network).

## Reconnect, revoke, disconnect

- **Reconnect** with a new app password if you revoked the old one (card shows *Reconnect required*).
- **Disconnect** deletes the stored session and blocks scheduled posts; posts stay on Bluesky.
- To revoke, delete the app password in Bluesky's settings.

## Common problems

| Message | Fix |
|---|---|
| Bluesky: text is … of 3000 bytes. | Shorten the text (emoji and accented letters use several bytes). |
| Bluesky video posts are not supported yet. Remove the video. | Post images instead. |
| Bluesky: at most 3 languages. | Remove language codes. |
| Invalid handle or password | Check the handle and create a new app password. |
