---
title: Other numbers you see in Relay
summary: Definitions of numbers shown outside Analytics: Overview tiles, Listening, inbox service levels and satisfaction, Google Business Profile metrics and Mailchimp reports.
section: analytics
audience: user
status: available
related: [analytics-metric-dictionary, google-business-profile, mailchimp, use-analytics]
product_version: "2026-11"
reviewed: 2026-11-09
order: 120
keywords: [overview tiles, scheduled, in review, issues, listening, share of voice, sentiment, mentions, sla, first response, csat, google business profile metrics, mailchimp opens clicks]
---

## Overview (home) tiles

| Tile | Definition |
|---|---|
| **Scheduled** | Posts scheduled in the next 7 days (shown as *N+* when the list is truncated) |
| **In review** | Posts awaiting a review decision |
| **Published** | Posts published in the last 7 days (*simulated* noted when they went to simulated destinations) |
| **Issues** | Unresolved deliveries needing attention plus manual handoffs |
| **Performance** card | The Analytics Overview's key numbers for the last 28 days (posts published excluded) with the trend and coverage — same definitions as [the metric dictionary](/help/analytics/analytics-metric-dictionary) |

## Listening

| Number | Definition |
|---|---|
| Mention | A public comment, mention or review from a monitored source that matches the search. Private messages are never included |
| Unique mentions | Mentions after collapsing repeats: identical normalised text from the same brand within 7 days counts once |
| Sentiment | **Inferred, not fact.** A word-list baseline with negation; only English is scored; low-confidence results are marked uncertain; a person can correct them. Shares exclude unscored mentions from their denominator |
| Topics | Keywords co-occurring in matching mentions (search terms excluded); one mention can be in several topics |
| Share of voice | Each search's mentions ÷ the sum across the compared searches, over the same sources and window — observed data only, not "the whole internet" |
| Spike alert | Fires when a window reaches the minimum sample **and** exceeds both baseline mean × multiplier and mean + 3 standard deviations |
| Coverage | Which sources were monitored and since when; periods before monitoring began are "not collected", never zero |

## Inbox service levels and satisfaction

| Number | Definition |
|---|---|
| First response | First reply confirmed by the network after the clock starts. Internal notes never count; automated acknowledgements only if the policy allows |
| Clock start | Earliest unanswered customer message when the case is created (or creation time) |
| Pauses | The clock stops while waiting on the customer or resolved |
| Business hours | Only time inside the policy's weekly hours counts; holidays have none; no hours = 24/7 |
| Reopened | Resolution clock resumes from the reopen time; first response is not re-measured |
| Backlog | Cases open, reopened or waiting at the end of the window |
| Satisfaction (CSAT) | Requests sent, responses, response rate, average and distribution of explicit 1–5 answers given within 7 days |

## Google Business Profile location metrics

Shown per location in the Google Business Profile settings: **Search views (desktop)**, **Search views (mobile)**,
**Calls**, **Website clicks**, **Directions** — each the **sum of Google's daily values for the last 28 days**, fetched
when someone selects **Refresh**, with the fetch time. Not combined with social analytics. Values Google doesn't
return stay missing.

## Mailchimp campaign report

On a post's Mailchimp draft after sending: **sent** (emails sent), **opens** (unique opens), **clicks** (unique
subscriber clicks), as Mailchimp reports them when someone refreshes.

> **Note:** If Mailchimp has not returned a number yet, the post's integration card currently shows **0** instead of
> leaving it blank (known display issue).
