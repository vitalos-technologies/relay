---
title: Data status, coverage and freshness
summary: How often Relay refreshes metrics, how late each network's data is, what coverage and "Complete through" mean, and the exact meaning of zero, missing, stale, delayed, unsupported and permission-missing values.
section: analytics
audience: user
roles: [owner, admin, brand_manager, analyst]
status: available
related: [analytics-metric-dictionary, metrics-by-network, use-analytics, connection-status-and-fixes]
product_version: "2026-11"
reviewed: 2026-11-09
order: 50
keywords: [refresh, sync, delay, stale, coverage, complete through, missing data, zero, unsupported, permission missing, retention, last sync]
---

## How often Relay reads metrics

Relay reads each published post's metrics on a schedule that slows down as the post ages (lifetime counters settle):

| Post age | Normal networks | X (billed reads) |
|---|---|---|
| First 48 hours | about every 6 hours | about every 12 hours |
| Up to 14 days | about daily | about every 2 days |
| Up to the horizon | weekly | weekly |
| Horizon | **90 days** — one final read, then the value is final | **30 days** |

After the horizon the last observation is final (not "stale"). Failures back off (from 2 hours up to 48 hours); rate
limits wait for the time the network asks; an exhausted budget waits 24 hours. Missing permissions, revoked access,
deleted posts and unsupported metrics stop the reads until something changes (for example a reconnect).

When a workspace connects an account, Relay also reads posts from the last 90 days (Pinterest 89, X 30) that were
published through Relay. Publishing always has priority over metric reads.

**Manual refresh:** **Analytics → Content** → open a post → **Refresh** (live posts only; at most once every 15 minutes
per post; X refreshes use the X read budget).

## How late the networks are

| Network | Delay Relay assumes |
|---|---|
| X, Bluesky | none |
| Instagram, Facebook, TikTok, LinkedIn, Threads | about 24 hours |
| Pinterest | about 48 hours |
| YouTube | about 72 hours |

**Complete through** (view footer) = the earliest "observed time minus delay" among the included data: values for
anything newer may still be incomplete. A view that includes YouTube shows "YouTube reports with a delay of 2–3 days".

## Coverage

`18 of 24 posts with data` means 24 posts in the period are on networks that report this measure (*eligible*) and 18
of them have values. Totals and rates cover **only those 18**. Posts on networks that never report the measure are
counted separately ("6 posts on networks without this measure") and are not "missing".

## What each state means

| State | Meaning | What to do |
|---|---|---|
| **ok** | Values for every eligible post | — |
| **reported zero** | The network said 0 | — |
| **not provided by the network** (unsupported) | The network has no such metric for this content | Nothing; it will never have data |
| **missing permission** | The connection lacks a permission, the sign-in was revoked, or it needs reconnecting | Reconnect (after the network approved the permission) |
| **not fetched yet** | Never read yet, or Relay doesn't request this metric | Wait for the next sync |
| **delayed by the network** | The network reports late; recent posts have no data yet | Wait |
| **partial** | Some eligible posts have data, some don't | Check the reasons listed in the footer |
| **stale** | An account has not synced successfully for 48 hours while its posts are still being refreshed | Check the connection's health |
| **fetch failed** | The last attempts failed (errors, rate limits, budget) | Relay retries; check the connection if it persists |

Missing values are blank in tables and exports and gaps in charts — **never 0**.

## When access ends or posts are deleted

| Event | What Analytics keeps |
|---|---|
| Account disconnected | Reads stop immediately. Collected values stay, labelled "Access ended <date>; data shown as last observed", for **90 days**, then are deleted |
| Post deleted on the network | Reads stop; the last values stay |
| Post deleted in Relay | Its metrics are removed |
| Raw observations | Kept 400 days; summarised values stay with the account |
| Late corrections by a network | Stored as a new revision; the post's detail shows "N later corrections" |
