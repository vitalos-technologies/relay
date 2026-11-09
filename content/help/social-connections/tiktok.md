---
title: Publish to TikTok
summary: Connect a TikTok account, post videos and photo posts directly or as drafts in the creator's inbox, fill in TikTok's required choices, and understand the limits that apply until TikTok audits the app.
section: social-connections
audience: user
roles: [owner, admin, publisher]
status: needs-provider-approval
related: [connect-social-accounts, connection-status-and-fixes, network-limits-at-a-glance, metrics-by-network, set-up-social-network-apps]
product_version: "2026-11"
reviewed: 2026-11-09
order: 44
keywords: [tiktok, direct post, inbox, draft, manual handoff, privacy level, music usage confirmation, branded content, audit, self only]
sources:
  - title: "TikTok — Content Sharing Guidelines (required UX, unaudited limits, posting caps)"
    url: https://developers.tiktok.com/doc/content-sharing-guidelines
    verified: 2026-11-09
  - title: "TikTok — Direct Post API reference (fields, privacy levels, rate limit)"
    url: https://developers.tiktok.com/doc/content-posting-api-reference-direct-post
    verified: 2026-11-09
  - title: "TikTok — Photo post API reference"
    url: https://developers.tiktok.com/doc/content-posting-api-reference-photo-post
    verified: 2026-11-09
  - title: "TikTok — Media transfer guide (video and image restrictions)"
    url: https://developers.tiktok.com/doc/content-posting-api-media-transfer-guide
    verified: 2026-11-09
  - title: "TikTok — Content Posting API get started (unaudited clients private)"
    url: https://developers.tiktok.com/doc/content-posting-api-get-started
    verified: 2026-11-09
  - title: "TikTok — Video object (view, like, comment, share counts)"
    url: https://developers.tiktok.com/doc/tiktok-api-v2-video-object
    verified: 2026-11-09
---

## At a glance

| | |
|---|---|
| Status in Relay | Built and tested on a simulated TikTok API; **not verified with a live account**. Public posting needs TikTok's audit of Relay's app. |
| Destination | The TikTok account (creator) that signs in |
| Formats | Video · Photo post (1–35 images) |
| Publish modes | **Direct post** · **Draft to the creator's TikTok inbox** (manual handoff) · **Manual only** (no posting permission) |
| Scheduling | Relay sends at the scheduled time |
| Edit / delete after publishing | Not possible from Relay |
| Analytics | Views, likes, comments, shares of **public** videos (needs `video.list`) |
| Inbox | Not available (TikTok has no DM API; comments need a different TikTok API) |

## Before you start

**Network rules (TikTok, verified 2026-11-09):**

- Until TikTok **audits** the app: at most **5 users** can post in a 24-hour window, their accounts must be
  **private** when posting, and posts are limited to **Only me** (SELF_ONLY). To make such a post public later, the
  creator first makes the account public, then changes the post's privacy in TikTok.
- After the audit, each creator still has a posting cap across all apps (typically about 15 posts a day) and each app
  has a daily active-creator cap.
- Each user token is limited to 6 publishing requests per minute.
- TikTok requires apps to show the creator's privacy options with **no default**, interaction toggles, commercial
  content disclosure and the **Music Usage Confirmation** consent before sending anything. Relay's composer does this.
- Photo posts are fetched by TikTok from a URL on a domain the app owner has verified with TikTok (setup task for the
  workspace owner).

**Relay labels:** an unaudited connection shows **Limited access** with the explanation; a connection with only the
draft permission shows **Manual handoff**; one with neither posting permission shows **Unsupported for this account**.

## Connect

1. **Connections** ([/accounts](/accounts)) → brand → **Connect** → **TikTok**.
2. Sign in to TikTok and approve. Relay asks for `user.info.basic`, `video.publish` (direct post), `video.upload`
   (drafts) and `video.list` (analytics).
3. The account appears on **Connections**. If you declined `video.publish` but allowed `video.upload`, posts go to the
   creator's inbox as drafts.

## Required fields in the composer

Open the TikTok variant of the post:

| Field | Rules |
|---|---|
| **Who can view** | Required for direct posts; options come from the creator's own TikTok settings; there is no default |
| Comments / Duet / Stitch | Duet and Stitch start off. **Comments:** the switch starts in the *on* position, but Relay only allows comments when you have actually switched it (known issue) — toggle it off and on again if you want comments. Relay does not yet grey out interactions the creator has disabled in TikTok; TikTok then disables them itself. |
| Disclose commercial content → **Your brand** | Labelled "Promotional content" by TikTok |
| Disclose commercial content → **Branded content** | Labelled "Paid partnership"; cannot be *Only me* |
| AI-generated | Adds TikTok's "Creator labeled as AI-generated" tag |
| Photo title | Photo posts only, up to 90 characters (the post text becomes the description) |
| **I agree to TikTok's Music Usage Confirmation** (+ Branded Content Policy) | Required before anything is sent |

## Limits

| Rule | TikTok (verified 2026-11-09) | Relay |
|---|---|---|
| Video caption | 2,200 UTF-16 units | 2,200 |
| Photo description / title | 4,000 / 90 UTF-16 units | 2,200 / 90 |
| Photo post | Up to 35 images; JPEG or WebP; ≤ 20 MB each; max 1080p | 1–35, JPEG/WebP, ≤ 20 MB (1080p not checked by Relay) |
| Video | MP4 (recommended), WebM, MOV; H.264/H.265/VP8/VP9; 23–60 fps; 360–4096 px per side; up to 10 min via the API (some accounts 3 or 5 min); ≤ 4 GB | Same, plus the creator's own maximum duration from TikTok |
| Links | Not clickable | No link field |

## Scheduling and publishing

At the due time Relay asks TikTok for the creator's current settings, uploads the video in chunks (the last chunk
completes the post) or asks TikTok to fetch the photos, and then follows TikTok's processing status. TikTok says
processing can take a few minutes before the post appears.

**Manual handoff (draft mode):** the video lands in the creator's TikTok inbox as a draft. The delivery shows
**Manual handoff — Post it in the app** and appears in **Overview → Needs attention**. Open TikTok, finish and post
it. Relay checks TikTok about once an hour and marks the delivery published when TikTok reports it; you can also
resolve it manually. Nothing is published automatically in this mode.

## Analytics

`view_count`, `like_count`, `comment_count`, `share_count` (lifetime totals per video). Private (*Only me*) and draft
posts report nothing — shown as *not provided*, never 0. Needs `video.list`. See [Metrics by network](/help/analytics/metrics-by-network).

## Reconnect, revoke, disconnect

- **Reconnect** to add posting permission or after TikTok expires the sign-in.
- **Disconnect** deletes the stored sign-in and blocks scheduled posts. Revoke Relay in TikTok under **Settings and
  privacy → Security → Manage app permissions**. The menu names are the network's and may change (not verified in a live account).

## Common problems

| Message | Fix |
|---|---|
| TikTok: choose who can view this post (there is no default). | Pick an option under **Who can view**. |
| TikTok: confirm that you agree to TikTok's Music Usage Confirmation … | Tick the agreement. |
| TikTok: privacy "…" is not available for this creator | The creator's settings changed; pick one of the listed options. |
| TikTok: branded content visibility cannot be set to private. | Choose a public option or untick *Branded content*. |
| TikTok: video is …; TikTok needs at least 360 px on each side. | Use a larger video. |
| This account has no posting permission | Reconnect and approve posting, or post manually in TikTok. |
| Post visible only to you | The app is not audited yet (Limited access). |
