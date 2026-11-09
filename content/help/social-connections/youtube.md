---
title: Publish to YouTube
summary: Connect a YouTube channel, upload videos with the title, privacy and made-for-kids choices YouTube requires, optionally let YouTube hold the release, and read YouTube Analytics and comments.
section: social-connections
audience: user
roles: [owner, admin, publisher]
status: needs-provider-approval
related: [connect-social-accounts, connection-status-and-fixes, network-limits-at-a-glance, metrics-by-network, video-and-audience-analytics, inbox-channels-by-network, set-up-social-network-apps]
product_version: "2026-11"
reviewed: 2026-11-09
order: 45
keywords: [youtube, video, upload, shorts, publishAt, scheduled release, made for kids, privacy, unlisted, quota, watch time]
sources:
  - title: "YouTube Data API — videos.insert (quota bucket, 256 GB, scopes)"
    url: https://developers.google.com/youtube/v3/docs/videos/insert
    verified: 2026-11-09
  - title: "YouTube Data API — videos resource (title, description, tags, publishAt, made for kids)"
    url: https://developers.google.com/youtube/v3/docs/videos
    verified: 2026-11-09
  - title: "YouTube Data API — quota costs"
    url: https://developers.google.com/youtube/v3/determine_quota_cost
    verified: 2026-11-09
  - title: "YouTube Help — upload videos longer than 15 minutes"
    url: https://support.google.com/youtube/answer/71673
    verified: 2026-11-09
  - title: "YouTube Analytics — metrics"
    url: https://developers.google.com/youtube/analytics/metrics
    verified: 2026-11-09
---

## At a glance

| | |
|---|---|
| Status in Relay | Built and tested on a simulated YouTube API; **not verified with a live channel**. Google must verify the app for these permissions before the general public can connect. |
| Destination | One YouTube channel per connection |
| Formats | Video only (one per post). YouTube decides whether a video is a Short. |
| Scheduling | Relay uploads at the scheduled time, **or** Relay uploads early as private and YouTube releases it at the scheduled time |
| Edit / delete after publishing | Not possible from Relay |
| Analytics | Views, watch time, average view duration, likes, comments, shares, subscribers gained (YouTube Analytics) |
| Inbox | Comments: read, reply, hold for review, delete your own replies |

## Before you start

**Network rules (Google, verified 2026-11-09):**

- Uploads use a separate quota bucket: **100 `videos.insert` calls per day** for the whole Relay app by default
  (shared by all workspaces using the same Google project). Other calls share a 10,000-unit daily pool; replying to a
  comment costs 50 units, changing a video (cancelling a YouTube-held release) 50 units.
- Unverified YouTube accounts can upload videos up to **15 minutes**; verified accounts up to 12 hours. Files up to
  256 GB.
- YouTube's videos.insert page currently states that videos uploaded from unverified API projects are **not**
  restricted to private viewing. Google still requires OAuth app verification before people outside the test list can
  grant these permissions.

**Permissions Relay asks for:** `youtube.upload` and `youtube.readonly` (required), `yt-analytics.readonly`
(analytics) and `youtube.force-ssl` (needed to cancel a YouTube-held release and to answer comments). Google lets you
untick individual permissions; Relay adapts and tells you what is missing.

## Connect

1. **Connections** ([/accounts](/accounts)) → brand → **Connect** → **YouTube**.
2. Sign in with the Google account that owns or manages the channel; approve all permissions.
3. On **Choose destinations**, tick the channel and select **Add**.

## Required fields in the composer

| Field | Rule |
|---|---|
| **Title** | Required, up to 100 characters, no `<` or `>` |
| **Privacy** | Required: Public, Unlisted or Private (Relay never relies on YouTube's default) |
| **Made for kids** | Required: Yes or No (YouTube policy) |
| Description | The post text plus the link: up to 5,000 **bytes**, no `<` or `>` |
| Tags | Optional, comma-separated; all tags together up to 500 characters (a tag with a space counts its quotation marks) |
| Altered or synthetic content | Optional disclosure for realistic altered or AI-generated content |
| **Release** | *Relay uploads at the scheduled time* (default) or *Let YouTube release it* |

## Scheduling: two ways

| Option | What happens | When to use |
|---|---|---|
| **Relay uploads at the scheduled time** (default) | At the due time Relay uploads the video with your privacy choice. The video appears after YouTube finishes processing, which can take minutes for long videos. | Most posts. |
| **Let YouTube release it** | About 3 hours before the due time Relay uploads the video as **private** with a release time; YouTube makes it **public** at the scheduled time. Requires *Public* privacy and the `youtube.force-ssl` permission. If less than 15 minutes remain, Relay falls back to uploading at the due time and records it. | Long videos that need processing time to be ready exactly on time. |

If you **pause or cancel** a YouTube-held release, Relay sets the video back to private without a release time and
re-reads it to confirm. The uploaded video stays on the channel as private (delete it in YouTube Studio if you no
longer need it).

## Limits

| Rule | YouTube (verified 2026-11-09) | Relay |
|---|---|---|
| Title / description | 100 characters / 5,000 bytes; no `<` `>` | Same |
| Tags | 500 characters in total | Same |
| Video length | 15 min (unverified account) / 12 h (verified) | 15 min, or 12 h when YouTube reports long uploads allowed |
| File size | 256 GB | 256 GB (Relay's media library may impose a lower upload size) |
| Formats | `video/*` | MP4, MOV, WebM, AVI, MPEG |

## Publishing details

Uploads are resumable: if the connection drops, Relay continues where it stopped; nothing is visible on YouTube until
the last chunk arrives. If the final answer is lost, Relay asks the upload session and the channel before deciding.

## Analytics

From YouTube Analytics, lifetime per video: **Views, Watch time (minutes), Average view duration (seconds), Likes,
Comments, Shares, Subscribers gained**. Relay treats YouTube data as arriving about 2–3 days late, so the latest days
show *delayed by the network* rather than zero. Revenue is never read. See [Video and audience analytics](/help/analytics/video-and-audience-analytics).

## Inbox

Comment threads on your videos (checked every few minutes); replies are public. You can hold a comment for review,
publish it, or delete your own reply. Needs `youtube.force-ssl` — reconnect if you connected without it.

## Reconnect, revoke, disconnect

- **Reconnect** to grant `yt-analytics.readonly` or `youtube.force-ssl`, or after Google revokes the sign-in.
- **Disconnect** deletes the stored sign-in and blocks scheduled posts; videos stay on YouTube. Revoke Relay at
  **myaccount.google.com → Security → Third-party apps & services**. The menu names are the network's and may change (not verified in a live account).

## Common problems

| Message | Fix |
|---|---|
| YouTube: a video title is required. / choose Public, Unlisted or Private explicitly. / say whether the video is made for kids | Fill in the required field in the YouTube variant. |
| YouTube: titles and descriptions cannot contain < or >. | Remove the angle brackets. |
| YouTube: the description is … of 5000 bytes. | Shorten it; emoji and accented letters use several bytes. |
| YouTube-held scheduling needs the "manage videos" permission | Reconnect and grant it, or choose *Relay uploads at the scheduled time*. |
| A YouTube-held release makes the video public at that time; choose Public. | Set privacy to Public or switch release to Relay. |
| Upload quota exceeded | The app's 100 uploads/day are used; Relay retries later. |
