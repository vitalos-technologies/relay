---
title: Engagement rate and period comparisons
summary: How Relay calculates engagement rate (a ratio of sums over posts that report both numbers), how the previous-period comparison works, and what "new", "flat" and "insufficient" mean — with worked examples.
section: analytics
audience: user
roles: [owner, admin, brand_manager, analyst]
status: available
related: [analytics-metric-dictionary, lifetime-totals-and-reach, data-status-and-freshness, content-and-channel-rankings]
product_version: "2026-11"
reviewed: 2026-11-09
order: 60
keywords: [engagement rate, ratio, percentage, compare, previous period, change, up, down, new, insufficient, best time]
---

## Engagement rate

**Engagement rate (by views)** = Σ engagements ÷ Σ views, and **(by impressions)** = Σ engagements ÷ Σ impressions,
summed over the posts in scope that report **both** numbers. It is never the average of per-post rates, and posts
missing either number are left out (and counted in coverage).

The Overview shows the variant that covers more of your posts. Networks: by views — Instagram, Facebook, TikTok,
YouTube, Threads; by impressions — X, LinkedIn, Pinterest. Bluesky and Telegram have neither.

### Worked example (synthetic numbers)

| Post | Engagements | Views |
|---|---|---|
| A (Instagram) | 10 | 100 |
| B (TikTok) | 90 | 300 |
| C (Bluesky) | 50 | — (Bluesky has no views) |

Engagement rate (by views) = (10 + 90) ÷ (100 + 300) = **25.0 %** over 2 posts. Post C is excluded: no compatible
denominator. The average of the per-post rates (10 % and 30 % → 20 %) is **not** used, because it would give a post with
100 views the same weight as one with 300.

### Average view duration works the same way

Video 1: 50 minutes watched / 100 views; video 2: 50 minutes / 300 views → (3,000 s + 3,000 s) ÷ 400 views = **15 s**,
not the average of 30 s and 10 s.

## Comparing with the previous period

With **Compare** on, each key number is compared with the **same number of days immediately before** the period
(28 October–24 November is compared with 30 September–27 October). Both periods use the same rules: posts published in
that period, with their latest lifetime values.

| State | When | Shown as |
|---|---|---|
| **Up** / **Down** | Both periods have enough data and the previous value isn't 0 | ±% change |
| **Flat** | No change (including 0 → 0) | no % |
| **New** | Previous value 0, current value above 0 | no % (never "∞ %") |
| **Insufficient** | A value is missing, or fewer than half of the eligible posts in either period have data | no % |

*Posts published* is an app record, so it is always comparable.

### Worked examples

- Engagements 120 now vs 100 before → **up 20 %**.
- 42 now vs 0 before → **new**; the calculated observation says "No engagements were recorded for the previous
  period, so no percentage change is shown."
- 120 now vs 100 before, but only 9 of 24 previous-period posts have data → **insufficient**.

> **Note:** Because values are lifetime totals, the current period's posts have had less time to collect engagement
> than the previous period's. A "down" shortly after the period can simply mean the newest posts are still young.
> See [Lifetime totals, reach and unique people](/help/analytics/lifetime-totals-and-reach).

## Best time to post (API only)

Relay's API (`/api/analytics/best-time`) can rank weekday/hour slots by the **median** engagement rate of your own past
posts in scope. It needs at least 30 posts with both numbers, and at least 3 posts per slot, and returns at most three
slots with the caveat that it is an observational heuristic that does not predict results. It is not shown in the
Analytics screens yet.
