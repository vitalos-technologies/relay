---
title: Publish to X
summary: Connect an X account, publish text, up to four images or a video, understand X's pay-per-use API charges and the budget Relay applies, and read public post metrics.
section: social-connections
audience: user
roles: [owner, admin, publisher]
status: needs-setup
related: [connect-social-accounts, connection-status-and-fixes, network-limits-at-a-glance, metrics-by-network, set-up-social-network-apps]
product_version: "2026-11"
reviewed: 2026-11-09
order: 43
keywords: [x, twitter, tweet, post, credits, pay-per-use, billing, budget, impressions]
sources:
  - title: "X API pricing (pay-per-usage, per-request prices, read cap)"
    url: https://docs.x.com/x-api/getting-started/pricing
    verified: 2026-11-09
  - title: "X media best practices (image, GIF and video limits)"
    url: https://docs.x.com/x-api/media/quickstart/best-practices
    verified: 2026-11-09
---

## At a glance

| | |
|---|---|
| Status in Relay | Built and tested on a simulated X API; **not verified with a live account**. Needs an X developer app with prepaid credits. |
| Destination | The X account that signs in |
| Formats | Text/link · 1–4 images · one video |
| Scheduling | Relay publishes at the scheduled time |
| Edit / delete after publishing | Not possible from Relay |
| Analytics | Public metrics (impressions, likes, reposts, replies, quotes, bookmarks) — each read is billed by X |
| Inbox | Not available in Relay (DMs and mentions need paid access; no adapter) |

## Before you start: X charges per request

X's API is **pay-per-usage**: credits are bought in advance in the X Developer Console and each request draws them
down. Prices on 2026-11-09 (X says they can change; the console is authoritative):

| Request | X price |
|---|---|
| Create a post | $0.015 |
| Create a post **containing a URL** | $0.200 |
| Read a post (per post returned) | $0.005 (reads of the same post within a UTC day are not charged again) |
| Read your own data with your own app | $0.001 per resource |

Pay-per-usage is capped at 3 million post reads per monthly billing cycle. Because Relay appends a post's link to the
text, **every X post with a link is billed at the URL rate**.

**Relay's controls:** the workspace can set monthly caps for **X posts** and **X reads** (**Settings → Operations →
Usage and limits**; no cap means unmetered). Relay counts each post before sending it and each read before making it;
when a cap is reached, posts to X wait as *budget exhausted* and analytics reads and checks of lost results pause until
the next month or until the cap is raised. Relay sends budget notifications at 50 %, 80 % and 100 %. Relay also refreshes X metrics
less often than other networks to save reads.

## Connect

1. **Connections** ([/accounts](/accounts)) → brand → **Connect** → **X**.
2. Sign in to X and authorise Relay. Relay asks for `tweet.read`, `tweet.write`, `users.read`, `media.write` and
   `offline.access` (to stay signed in).
3. You come back to **Connections**; the account you signed in with is the destination.

## What you can publish

| Format | In Relay |
|---|---|
| Text / link | Text, the link appended |
| Images | 1–4 images |
| Video | One video (cannot be combined with images) |

## Limits

| Rule | X (verified 2026-11-09 unless noted) | Relay |
|---|---|---|
| Text | 280 characters, links count as 23 — **not re-verified** on 2026-11-09 | 280 weighted characters |
| Images | Up to 4 per post; ≤ 5 MB; JPG, PNG, GIF, WEBP (animated GIF ≤ 15 MB) | 1–4, JPEG/PNG, ≤ 5 MB (GIF/WEBP not accepted by Relay) |
| Video | 0.5 s–20 min (up to 125 min for Premium), up to 8 GB, 32×32–1280×1024, aspect 1:3–3:1, ≤ 60 fps, H.264 High + AAC-LC, progressive, YUV 4:2:0 | 0.5 s–15 min, ≤ 300 MB, same dimension, aspect, frame-rate and codec checks |

## Scheduling and publishing

Images and videos are uploaded first (videos in chunks, then X processes them); the post is created at the due time.
If X's answer is lost, Relay looks at the account's recent posts around the send time (a billed read) before
deciding; it never posts again blindly.

## Analytics

`impression_count`, `like_count`, `repost_count`, `reply_count`, `quote_count`, `bookmark_count` from X's public
metrics, lifetime values per post. Impressions include promoted delivery if a post was promoted. Relay reads X metrics
for 30 days after publication (other networks: 90) and consumes the X read budget. See
[Metrics by network](/help/analytics/metrics-by-network).

## Reconnect, revoke, disconnect

- **Reconnect** when the card shows *Reconnect required* (for example after you revoke Relay in X's settings).
- **Disconnect** deletes the stored sign-in, **asks X to revoke Relay's token**, and blocks scheduled posts.
  Published posts stay on X.

## Common problems

| Symptom | Cause | Fix |
|---|---|---|
| Budget exhausted | The workspace X budget, or the app's X credits, ran out | Raise the budget or add credits; reads resume automatically |
| Duplicate content rejected | X refuses identical text posted recently | Change the text |
| Media processing failed | X could not process the image or video | Replace it with a JPEG/PNG ≤ 5 MB or an H.264/AAC MP4 |
| Missing permission | A scope was not granted | Reconnect and approve all |
