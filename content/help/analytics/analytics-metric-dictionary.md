---
title: Analytics metric dictionary
summary: Every measure Relay shows in Analytics — meaning, source, formula and denominator, unit, time basis, scope, networks, how it may be combined, and what zero, blank, stale and unsupported mean.
section: analytics
audience: user
roles: [owner, admin, brand_manager, analyst]
status: available
related: [metrics-by-network, lifetime-totals-and-reach, engagement-rate-and-comparisons, data-status-and-freshness, use-analytics, other-metrics-in-relay]
product_version: "2026-11"
reviewed: 2026-11-09
order: 20
keywords: [metric, measure, definition, dictionary, engagements, engagement rate, views, impressions, reach, likes, comments, shares, saves, clicks, watch time, followers]
---

Relay stores every network metric under its **native name** and never renames one network's metric into another's.
For the views, metrics are grouped into **families** (views, impressions, reach, likes, …). A **measure** is what a
view shows; it is built from one or more families. This page defines every measure. For each network's native
metrics see [Metrics by network](/help/analytics/metrics-by-network).

> **Note:** Network metrics have not yet been collected from live accounts (none are connected); the definitions and
> calculations below are verified with tests and synthetic data.

## Measures

| Measure | Meaning | Formula / denominator | Unit | Time basis | Networks that report it |
|---|---|---|---|---|---|
| **Posts published** | Successful deliveries in the period (one per account a post went to) | Count of published deliveries by publish time in the selected time zone | count | App record, event time | All |
| **Engagements** | People interacting with posts | Likes & reactions + Comments & replies + Shares & reposts + Quotes + Saves & bookmarks, as each network reports them. **Not** included: views, impressions, clicks and network composites such as Instagram *Total interactions* | count | Lifetime of posts published in the period | All except Telegram |
| **Engagement rate (by views)** | Engagements relative to views | Σ engagements ÷ Σ views, over posts that report **both** (ratio of sums) | % | Lifetime | Instagram, Facebook, TikTok, YouTube, Threads |
| **Engagement rate (by impressions)** | Engagements relative to impressions | Σ engagements ÷ Σ impressions, over posts that report both | % | Lifetime | X, LinkedIn, Pinterest |
| **Views** | Times content was shown or played, as the network defines it | Sum of network-reported values | count | Lifetime | Instagram, Facebook, TikTok, YouTube, Threads (*in development* at Meta) |
| **Impressions** | Times content was seen, as the network defines it | Sum of network-reported values | count | Lifetime (Pinterest: rolling 90 days) | X, LinkedIn, Pinterest |
| **Reach (sum of per-post unique counts)** | Unique accounts that saw each post | Sum over posts of each post's unique count — **counts a person once per post they saw** | count | Lifetime | Instagram (reach), Facebook (viewers), LinkedIn (unique impressions / members reached) |
| **Likes & reactions** | Likes and reactions | Sum | count | Lifetime | All except Telegram |
| **Comments & replies** | Comments and replies | Sum | count | Lifetime | All except Telegram, Facebook |
| **Shares & reposts** | Shares, reposts | Sum | count | Lifetime | Instagram, X, TikTok, YouTube, LinkedIn, Threads, Bluesky |
| **Quotes** | Quote posts | Sum | count | Lifetime | X, Threads, Bluesky |
| **Saves & bookmarks** | Saves and bookmarks | Sum | count | Lifetime | Instagram, X, Pinterest, Bluesky |
| **Clicks** | Clicks on the post | Sum | count | Lifetime | Facebook, LinkedIn (Company Pages), Pinterest (Pin clicks) |
| **Outbound link clicks** | Clicks to the destination link | Sum | count | Rolling 90 days | Pinterest |
| **Watch time** | Minutes watched | Sum | minutes | Lifetime | YouTube |
| **Average view duration** | Average seconds watched per view | Σ watch time (seconds) ÷ Σ views over videos reporting both — never an average of averages | seconds | Lifetime | YouTube |
| **Followers (latest snapshot)** | Follower count at a point in time | Latest snapshot per account; across accounts a labelled sum | count | Snapshot | None from live networks yet — Relay does not request follower counts from any network today; only demo data shows followers |

## Combination rules

Relay refuses to produce numbers that would mislead:

- **Only the same family is added.** Views + impressions is refused ("Cannot add Views + Impressions: different measures").
- **Cross-network totals are labelled.** Instagram views + TikTok views is allowed but shown as "Views — sum of
  network-reported values (instagram:views, tiktok:view_count); definitions differ by network".
- **Unique counts (reach) are never added across accounts or networks.** On the trend, reach is drawn per account.
  Within one account, summing over posts counts people more than once — the label says so.
- **Rates and averages are ratios of sums,** never averages of per-post rates.
- **Snapshots (followers) are never summed over dates;** across accounts only one latest value per account is added,
  labelled "people may follow several accounts".
- **Paid distribution:** Facebook and X totals include boosted/promoted delivery if a post was promoted. Paid-only
  metrics (such as YouTube revenue) are never read.

## Zero, blank and other states

| You see | Meaning |
|---|---|
| **0** | The network reported zero. |
| **—** or blank | No value: not provided by the network, not fetched yet, permission missing, delayed or failed. **Never** zero. Charts leave a gap. |
| *not provided by the network* | The network has no such metric for this content (Telegram everything; Bluesky views; TikTok private posts). |
| *missing permission* | The connection lacks the permission (for example Meta insights, LinkedIn analytics). Reconnect after approval. |
| *not fetched yet* | Relay has not read it yet, or does not request it. |
| *delayed by the network* | The network reports late (YouTube about 2–3 days, Pinterest about 2, Meta/TikTok/LinkedIn about 1). |
| *partial* / `18/24 posts with data` | Only some eligible posts have data; totals cover only those. |
| *stale* | An account has not synced successfully for 48 hours while its posts are still being refreshed. |
| *fetch failed* | Recent attempts failed (errors, rate limits, budget). |

Details: [Data status and freshness](/help/analytics/data-status-and-freshness).

## Measures not in the measure list

Shown in a post's detail but not combined into measures: Instagram **Total interactions** (Instagram's own composite;
adding it would double count), YouTube **Subscribers gained**, Facebook reactions **by type**.
