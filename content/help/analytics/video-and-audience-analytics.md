---
title: Video and audience analytics
summary: What the Video view (views, watch time, average view duration, top videos) and the Audience view (aggregate, privacy-thresholded breakdowns) show, and their current limits.
section: analytics
audience: user
roles: [owner, admin, brand_manager, analyst]
status: available
related: [metrics-by-network, analytics-metric-dictionary, youtube, use-analytics]
product_version: "2026-11"
reviewed: 2026-11-09
order: 80
keywords: [video, watch time, average view duration, retention, top videos, audience, demographics, country, age, gender, privacy threshold]
---

## Video view

**Analytics → Video** ([/analytics/video](/analytics/video)) covers video and Reel posts published in the period.

| Element | Meaning |
|---|---|
| Totals (up to 4 cards) | Video measures for the scope, each with its definition (ⓘ) |
| **By network** | Videos, Views, **Watch time** (minutes) and **Avg. duration** (seconds) per network |
| **Top videos** | Videos ranked by their main metric |
| Formats | Posts and views per format and network (in exports) |

- **Views are counted differently by each network** (the view says so). A YouTube view, a TikTok view and an Instagram
  Reel view are not the same thing.
- **Watch time** and **average view duration** come only from YouTube today. Average duration = Σ watch time ÷ Σ views
  over videos reporting both (never an average of averages).
- **Retention** (how much of a video people watch) is not read from any network; the view says so under the table.
- YouTube data is about 2–3 days late.

## Audience view

**Analytics → Audience** ([/analytics/audience](/analytics/audience)) shows **aggregate** audience breakdowns per account,
as reported by the network — never individual people.

| Card | Meaning |
|---|---|
| Breakdown (e.g. *Follower countries*) | Top buckets with value and share; "as of" date of the snapshot |
| *N in small groups (hidden for privacy)* | Buckets under 10 are folded together and never shown individually |
| **Without audience data** | Accounts with a reason: *Below privacy threshold* (the network only reports for accounts with enough followers, e.g. Instagram 100), *Not fetched yet*, *Not provided by this network*, *Missing permission* |

> **Important:** Relay defines Instagram and LinkedIn follower countries and YouTube viewer age & gender, but the
> current integrations **do not request them**. Live accounts therefore appear under **Without audience data** as *Not
> fetched yet*. Only demo workspaces show example breakdowns.
