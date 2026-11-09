---
title: Use Analytics
summary: Find your way around the Analytics views, set the period, time zone, networks, accounts and format, compare with the previous period, read charts and tables, and understand which data set you are looking at.
section: analytics
audience: user
roles: [owner, admin, brand_manager, analyst]
status: available
related: [analytics-metric-dictionary, lifetime-totals-and-reach, data-status-and-freshness, engagement-rate-and-comparisons, content-and-channel-rankings, analytics-exports-and-reports]
product_version: "2026-11"
reviewed: 2026-11-09
order: 10
keywords: [analytics, dashboard, overview, filters, period, date range, compare, previous period, time zone, network, account, format, chart]
---

**Analytics** ([/analytics](/analytics)) shows how published posts performed, using the numbers each network reports,
plus workflow facts Relay records itself. You need the **Analytics** permission (Owner, Admin, Brand manager, Analyst);
exporting also needs **Exporter**, Admin or Owner.

> **Note:** The calculations, filters and charts are tested with real databases and synthetic data. Metrics from live
> network accounts have not been collected yet, because no live account is connected; demo workspaces show clearly
> labelled **Demo data**.

## The six views

| View | What it answers |
|---|---|
| **Overview** | Up to four key numbers with comparison, a daily trend, channels compared, top content and calculated observations |
| **Content** | Every published post with its metrics; sort, page through and open a post's detail |
| **Channels** | One row per connected account: posts, followers, key metrics; comparison inside comparable groups |
| **Video** | Videos only: views, watch time, average view duration by network; top videos |
| **Audience** | Aggregate audience breakdowns (country, age/gender) where the network provides them |
| **Workflow** | Relay's own facts: review turnaround, on-time publishing, delivery reliability, workload by team |

The **Overview** page of the app (home) shows a small **Performance** card with the same numbers for the last 28 days.

## Filters

All filters live in the address bar, so a filtered view can be bookmarked, shared with colleagues who have the same
access, and reopened with the browser's back button.

| Filter | Options | Notes |
|---|---|---|
| **Period** | 7d · 28d (default) · 90d · Custom | Days are **local calendar days** in the time zone shown. Custom ranges can be up to 400 days. |
| Time zone | The selected brand's time zone, otherwise the workspace's | Days around clock changes are 23 or 25 hours long and are handled exactly. |
| **Network** | Networks connected in the selected brands | |
| **Account** | Individual connections | |
| **Format** | Text, Image, Album, Video, Reel | Not shown on Channels, Video, Audience and Workflow |
| **Data** | *Live data*; *Simulated* (only where simulated destinations are enabled); *Demo data* (demo workspaces) | Each set is kept completely separate; a banner says when you are not looking at live data |
| **Compare** | On (default) / Off | Compares with the same number of days immediately before the period |
| Brand | The brand switcher at the top of the app | Analytics only includes brands where you have the Analytics permission |

Campaign and team filters exist in Relay's API and exports but are not on the Analytics screen yet.

**Which posts are included:** posts **published** in the period (by publish time in the selected time zone), with
their latest known lifetime values. See [Lifetime totals, reach and unique people](/help/analytics/lifetime-totals-and-reach) — this matters.

## Reading the Overview

![Analytics Overview with demo data: period, network, account, format and data filters, four key numbers with comparisons, and the Engagements trend against the previous period](/help/img/analytics/analytics-overview.png)

Note how the trend falls towards the end of the period: the newest posts have had less time to collect engagement
(see [lifetime totals](/help/analytics/lifetime-totals-and-reach)).


- **Key numbers (up to 4):** always *Posts published*; *Engagements* when a selected network reports engagement;
  one *Engagement rate* (by views or by impressions, whichever covers more of your posts); then *Followers* if
  follower snapshots exist, otherwise a single network's *Views* or *Impressions*, or *Watch time*. The **ⓘ** shows
  the exact definition and basis; the footer says *Lifetime of posts in period*, *Latest snapshot*, *App records*, or
  how many posts have data (for example `18/24 posts with data`).
- **Trend chart:** choose the **Measure** (unavailable ones are marked *n/a*) and **Total** or **By network**. Each day
  shows the measure for **posts published that day** — it is not "activity on that day". The dashed line is the
  previous period. Gaps mean no posts or no data that day; they are never drawn as zero. Every chart has a **table
  view** with the same numbers.
- **Channels:** accounts compared inside groups that can be compared (see [Rankings](/help/analytics/content-and-channel-rankings)).
- **Top content:** the five posts with the most engagements.
- **Calculated from this data:** short observations computed from these numbers — not AI. See
  [Calculated insights and AI explanations](/help/analytics/calculated-insights-and-ai).
- **Footer:** coverage (`posts with data` of `eligible`), *Complete through* date, last sync time, and counts of posts
  without data by reason. See [Data status and freshness](/help/analytics/data-status-and-freshness).

## Refreshing a post's numbers

Relay refreshes metrics on its own schedule. In **Content**, open a post and select **Refresh** to ask for an update
now (live posts only; once every 15 minutes per post). For X, each refresh uses the workspace's X read budget.

## Common questions

| Question | Answer |
|---|---|
| Why are all values blank? | No published posts in the period, or no data yet from the networks (see the footer). Blank never means zero. |
| Why does a measure say *n/a*? | None of the selected networks reports it (for example Telegram reports nothing; Bluesky has no views). |
| Why can't I see a brand? | You lack the Analytics permission on it. |
| Why don't my numbers match the network's app? | Networks count differently and update late; Relay shows lifetime values of posts published in the period, as last observed. |
