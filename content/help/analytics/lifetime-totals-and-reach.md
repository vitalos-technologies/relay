---
title: Lifetime totals, reach and unique people
summary: Why Relay reports the lifetime totals of posts published in a period rather than activity during it, and why reach added across posts or networks does not count unique people.
section: analytics
audience: user
roles: [owner, admin, brand_manager, analyst]
status: available
related: [analytics-metric-dictionary, engagement-rate-and-comparisons, data-status-and-freshness, use-analytics]
product_version: "2026-11"
reviewed: 2026-11-09
order: 40
keywords: [lifetime, cumulative, period, activity, reach, unique, people, audience size, deduplicate, cross-platform, as of]
---

## Relay reports the lifetime of posts published in the period

Networks give apps **lifetime counters** per post: "this post has 160 impressions so far". They do not say *when*
each impression happened. So in Analytics, a period such as 1–28 October means:

> **The posts published from 1 to 28 October, with their lifetime totals as last observed.**

The label under every number says so: *Lifetime of posts in period*. It does **not** mean "impressions that happened
between 1 and 28 October".

### Worked example: a lifetime counter is not activity in the period

A post is published on **30 September**. Its impressions as Relay observed them:

| Observed on | Lifetime impressions |
|---|---|
| 30 Sep | 100 |
| 2 Oct | 160 |
| 9 Oct | 210 |

- In the **October** view the post does **not** appear (it was published in September), even though it gained 110
  impressions during October.
- In the **September** view it shows **210** today — the latest lifetime value — although on 30 September it only had 100.
- The detail drawer of the post shows the three observations as a line "lifetime total as observed on each date
  (not daily activity)". The differences (+60, +50) are stored as *observed changes*; they can include corrections by
  the network and are not exact daily counts.

Consequences:

1. **Recent periods look smaller** because their posts have had less time to collect views. Compare periods only when
   their posts are similarly old, or wait until counters settle (most growth happens in the first days).
2. **A past period's numbers can still change** as old posts keep growing or the network corrects values.
3. **The trend chart** plots, for each day, the totals of posts **published that day**. A spike means posts published
   that day did well over their lifetime — not that something happened that day.
4. **Pinterest** is the exception: it reports at most 90 days back, so for older Pins Relay shows a rolling 90-day total.

## Reach is not unique people

**Reach** (Instagram reach, Facebook viewers, LinkedIn unique impressions / members reached) counts the unique
accounts that saw **one post** on **one network**.

### Worked example: adding reach counts people more than once

Three posts by the same Instagram account in a week, each reached by 1,000 accounts:

| Post | Reach |
|---|---|
| Monday | 1,000 |
| Wednesday | 1,000 |
| Friday | 1,000 |
| **Shown in Relay** | **3,000** — labelled "sum of per-post unique counts (people can be counted more than once)" |

If the same 1,000 followers saw all three, the account actually reached **1,000** people. Relay cannot know the true
number of unique people across posts: networks do not give apps the identities behind reach, and Relay does not request
account-level reach for a period.

### Worked example: cross-network reach is never added

Instagram reach 4,200 and Facebook viewers 3,100 for the same campaign. Relay **refuses** to show 7,300: "Reach
(unique accounts) cannot be combined across networks (instagram, facebook)". A person who follows you on both networks
would be counted twice, and each network defines "unique" for its own users only. On the trend, reach is drawn one
line per account; on Channels, reach is compared only within one network.

### Worked example: cross-network views are a labelled sum

Instagram views 1,200 and TikTok video views 5,400 → **6,600**, labelled "Views — sum of network-reported values
(instagram:views, tiktok:view_count); definitions differ by network". This is allowed because it is a count of
showings, not people — but remember each network decides what counts as a view (for example how long a video must play).

## Followers across accounts

Followers are snapshots (a count on a date), so Relay never adds the same account's followers across dates. Across
accounts it adds one latest value per account, labelled "people may follow several accounts". (Relay does not read
follower counts from live networks yet; only demo data shows them.)
