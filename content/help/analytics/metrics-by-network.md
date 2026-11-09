---
title: Metrics by network
summary: The exact native metrics Relay reads from each network, what each means, its unit and time basis, how late it arrives, which permission it needs and how Relay groups it.
section: analytics
audience: user
roles: [owner, admin, brand_manager, analyst]
status: not-live-verified
related: [analytics-metric-dictionary, lifetime-totals-and-reach, data-status-and-freshness, instagram, facebook, x-twitter, tiktok, youtube, linkedin, threads, pinterest, bluesky, telegram]
product_version: "2026-11"
reviewed: 2026-11-09
order: 30
keywords: [native metrics, insights, public metrics, instagram insights, facebook insights, youtube analytics, linkedin statistics, pinterest analytics, tiktok, threads, bluesky]
sources:
  - title: "Instagram — Media insights"
    url: https://developers.facebook.com/docs/instagram-platform/reference/instagram-media/insights
    verified: 2026-11-09
  - title: "Facebook — Insights (Page post metrics)"
    url: https://developers.facebook.com/docs/graph-api/reference/insights
    verified: 2026-11-09
  - title: "Threads — Insights"
    url: https://developers.facebook.com/docs/threads/insights
    verified: 2026-11-09
  - title: "YouTube Analytics — metrics"
    url: https://developers.google.com/youtube/analytics/metrics
    verified: 2026-11-09
  - title: "TikTok — Video object"
    url: https://developers.tiktok.com/doc/tiktok-api-v2-video-object
    verified: 2026-11-09
  - title: "LinkedIn — Community Management overview (share statistics, member post statistics)"
    url: https://learn.microsoft.com/en-us/linkedin/marketing/community-management/community-management-overview
    verified: 2026-11-09
  - title: "X API pricing (billed reads)"
    url: https://docs.x.com/x-api/getting-started/pricing
    verified: 2026-11-09
---

All metrics are **per post** and **lifetime** values (cumulative since publication, observed at a moment), except
Pinterest (rolling window of up to 90 days). "Delay" is how late Relay assumes the network's data is; the **Complete
through** date in Analytics accounts for it. None of these has been read from a live account yet.

## Instagram

Needs `instagram_basic`, `instagram_manage_insights`, `pages_read_engagement`. Meta: data can be delayed up to 48 h,
kept up to 2 years, and comes back empty (not 0) when unavailable; no insights for items inside a carousel.

| Native | Shown as | Meaning | Family |
|---|---|---|---|
| `views` | Views | Times the media was played or displayed (Meta marks it *in development*) | views |
| `reach` | Reach | Unique accounts that saw it (estimated). Unique — never added across posts or networks | reach |
| `likes` | Likes | Likes | likes |
| `comments` | Comments | Comments | comments |
| `saved` | Saves | Saves | saves |
| `shares` | Shares | Shares | shares |
| `total_interactions` | Total interactions | Instagram's composite (likes + saves + comments + shares minus undo); **not** added to Relay engagements | own |

Relay delay: 24 h. `impressions` is deprecated by Meta for media after 2 July 2024 and not read.

## Facebook Page

Needs `read_insights` + `pages_read_engagement` (person with the ANALYZE task). Meta: most metrics update once every
24 hours; last two years available. All lifetime; include paid distribution of boosted posts.

| Native | Shown as | Meaning | Family |
|---|---|---|---|
| `post_media_view` | Views | Times the content was played or displayed | views |
| `post_total_media_view_unique` | Viewers | Unique viewers of the post | reach |
| `post_clicks` | Clicks | Clicks anywhere in the post (refreshes several times a day) | clicks |
| `post_reactions_by_type_total` | Reactions | Reactions by type (like, love, wow, haha, sorry, anger); summed for totals | likes |

Relay delay: 24 h. `post_impressions*` is deprecated above Graph API v25 and not read.

## X

Each read is billed by X and uses the workspace X read budget. Relay reads X metrics for 30 days after publication.

| Native | Shown as | Family |
|---|---|---|
| `impression_count` | Impressions | impressions |
| `like_count` | Likes | likes |
| `repost_count` (`retweet_count`) | Reposts | shares |
| `reply_count` | Replies | comments |
| `quote_count` | Quotes | quotes |
| `bookmark_count` | Bookmarks | saves |

Relay delay: none (public metrics). Includes promoted delivery.

## TikTok

Needs `video.list`. Public videos only — private (*Only me*) and inbox drafts report nothing.

| Native | Shown as | Family |
|---|---|---|
| `view_count` | Video views | views |
| `like_count` | Likes | likes |
| `comment_count` | Comments | comments |
| `share_count` | Shares | shares |

Relay delay: 24 h.

## YouTube

Needs `yt-analytics.readonly` and `youtube.readonly`. Read from YouTube Analytics with the publication date as start
date (so lifetime).

| Native | Shown as | Meaning | Family |
|---|---|---|---|
| `views` | Views | Video views (YouTube's definition varies by report) | views |
| `estimatedMinutesWatched` | Watch time (min) | Minutes watched | watch time |
| `averageViewDuration` | Avg view duration (s) | Average playback length in seconds (excludes looping-clip traffic) | ratio |
| `likes` | Likes | Positive ratings | likes |
| `comments` | Comments | Comments | comments |
| `shares` | Shares | Shares using the Share button | shares |
| `subscribersGained` | Subscribers gained | Subscriptions from this video's watch page | followers gained |

Relay delay: 72 h. Revenue metrics are never read.

## LinkedIn

All LinkedIn metrics need permissions from LinkedIn's Community Management API (shown as *missing permission* until
then). Company Pages and profiles use different metric sets, kept separate.

| Native | Shown as | Destination | Family |
|---|---|---|---|
| `impressionCount` | Impressions | Company Page | impressions |
| `uniqueImpressionsCount` | Unique impressions | Company Page | reach |
| `clickCount` | Clicks | Company Page | clicks |
| `likeCount` | Reactions | Company Page | likes |
| `commentCount` | Comments | Company Page | comments |
| `shareCount` | Reposts | Company Page | shares |
| `IMPRESSION` | Impressions (member) | Profile | impressions |
| `MEMBERS_REACHED` | Members reached | Profile | reach |
| `REACTION` | Reactions (member) | Profile | likes |
| `COMMENT` | Comments (member) | Profile | comments |
| `RESHARE` | Reposts (member) | Profile | shares |

Relay delay: 24 h. LinkedIn documents missing organic share statistics as 0.

## Threads

Needs `threads_manage_insights`. Meta marks `views` and `shares` *in development*. Replies on a root post count all
replies in the conversation.

| Native | Shown as | Family |
|---|---|---|
| `views` | Views | views |
| `likes` | Likes | likes |
| `replies` | Replies | comments |
| `reposts` | Reposts | shares |
| `quotes` | Quotes | quotes |
| `shares` | Shares | shares |

Relay delay: 24 h. Reposts and shares are both in the *Shares & reposts* family and are added together.

## Pinterest

Window totals: Pinterest reports at most 90 days back (Relay reads up to 89 days), so a Pin older than that shows a
rolling 90-day total, not its lifetime. (Pinterest's analytics documentation could not be re-checked on 2026-11-09.)

| Native | Shown as | Family |
|---|---|---|
| `IMPRESSION` | Impressions | impressions |
| `SAVE` | Saves | saves |
| `PIN_CLICK` | Pin clicks | clicks |
| `OUTBOUND_CLICK` | Outbound clicks | outbound link clicks |
| `TOTAL_COMMENTS` | Comments | comments |
| `TOTAL_REACTIONS` | Reactions | likes |

Relay delay: 48 h.

## Bluesky

Public counts from Bluesky's AppView; no permission needed; no views or impressions exist, so engagement rate is not
available.

| Native | Shown as | Family |
|---|---|---|
| `likeCount` | Likes | likes |
| `repostCount` | Reposts | shares |
| `replyCount` | Replies | comments |
| `quoteCount` | Quotes | quotes |
| `bookmarkCount` | Bookmarks | saves |

## Telegram

None. The Bot API gives bots no post or channel statistics. Telegram posts count in *Posts published*; every network
metric shows *not provided by the network*.

## Account-level metrics not read today

Followers (all networks), Instagram/LinkedIn follower countries and YouTube viewer age & gender are defined in Relay
but **not requested** by the current integrations. In live data the Channels view therefore shows **—** for followers
and Audience shows *Not fetched yet*. Demo workspaces show synthetic examples.
