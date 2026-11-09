---
title: Rank content and compare channels
summary: Sort published posts by engagements, engagement rate, views or impressions, open a post's metrics and history, and compare accounts only within groups that can fairly be compared.
section: analytics
audience: user
roles: [owner, admin, brand_manager, analyst]
status: available
related: [use-analytics, analytics-metric-dictionary, engagement-rate-and-comparisons, lifetime-totals-and-reach]
product_version: "2026-11"
reviewed: 2026-11-09
order: 70
keywords: [content table, sort, top posts, ranking, top content, channels, compare accounts, share, followers, change]
---

## Content view

**Analytics → Content** ([/analytics/content](/analytics/content)) lists every post published in the period: thumbnail,
title or excerpt, account, campaign, publish time, and **Engagements**, **Eng. rate**, **Views** and **Impressions**
(the metric columns appear on wider screens). 25 posts per page; the header shows the total.

- Select a column header to sort; select again to reverse. Default: newest first.
- **—** in a cell means the network doesn't report that number for this post, or it isn't available yet.
- The engagement rate per post uses views when the post has them, otherwise impressions.

### A post's detail

Select a post to open its detail:

![A demo Facebook post's detail drawer showing its caption and metrics: Views 1,313, Viewers (unique) 935, Clicks 16 and two Reactions values](/help/img/analytics/analytics-content-detail.png)


- media and caption;
- **Metrics** — every native metric with its network name (Facebook reactions appear once per reaction type, currently
  without the type's name) (hover to see the native id), "(unique)" for unique counts,
  and the reason when there is no value;
- **<metric> over time** — the lifetime total as observed on each date (not daily activity), with the number of later
  corrections by the network;
- **Open on <network>** and, for live posts, **Refresh**.

Demo and simulated posts carry a **Demo data** or **Simulated** badge.

## Top content

The Overview's **Top content** lists the five posts with the most engagements. Because engagements are lifetime
totals and definitions differ by network, a post on a network with more engagement types (or an older post) can rank
higher; use the network filter for like-for-like rankings.

## Channels view

**Analytics → Channels** ([/analytics/channels](/analytics/channels)) shows one row per account:

![Channels view with demo data: four accounts with posts, followers, change, views, impressions and reach, and an engagements comparison with each account's share](/help/img/analytics/analytics-channels.png)

| Column | Meaning |
|---|---|
| Posts | Posts published to this account in the period |
| Followers | Latest follower snapshot (— in live data: not read from networks yet) |
| Change | Latest minus earliest snapshot in the period (needs at least two snapshots) |
| Engagements, Views, Impressions, Reach | Lifetime totals of posts published in the period; — when the network doesn't report it. **Known issue:** the Engagements column currently always shows —; use the engagements comparison below the table |

### Comparison groups

Bar comparisons only put **comparable** accounts side by side:

- Additive measures (engagements, views, impressions, likes …) are compared across all accounts that report them, with
  each account's share of the total; when networks are mixed the label says "network-reported; definitions differ by
  network".
- **Reach** is compared only **within one network**, without shares, because unique counts can't be added.
- Accounts whose network does not report the measure are listed under **Not comparable** with the reason.
