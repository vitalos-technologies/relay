---
title: Fix a connection that needs attention
summary: What each connection state means (Missing permission, Reconnect required, Limited access, Manual handoff and more), what it does to scheduled posts, and the exact fix.
section: social-connections
audience: user
roles: [owner, admin, brand_manager, publisher]
status: available
related: [connect-social-accounts, network-limits-at-a-glance, instagram, facebook, telegram, x-twitter, tiktok, youtube, linkedin, threads, pinterest, bluesky]
product_version: "2026-11"
reviewed: 2026-11-09
order: 20
keywords: [reconnect required, missing permission, expired, token, blocked, limited access, awaiting approval, manual handoff, health, error]
---

Every connection shows one state badge on **Connections** ([/accounts](/accounts)) and on **Connection health**
([/accounts/health](/accounts/health)). Publishing formats and analytics are shown separately, because a connection can
publish while lacking analytics (or the other way round).

## States and fixes

| Badge | What it means | Effect on scheduled posts | Fix (Owner or Admin) |
|---|---|---|---|
| **Connected** | Sign-in and permissions work. | Send as scheduled. | — |
| **Verifying** | Relay is checking a new or reconnected destination. | Wait. | Wait a few seconds; select **Check now** if it stays. |
| **Expires soon** | The network's sign-in expires shortly (the card shows the date). | Still send. | **Reconnect** before the date. |
| **Missing permission** | A permission was declined or removed, or the person lost their role on the page/channel. The card lists the missing permissions when the network reports them. | Do not send; they wait as **Blocked**. | **Reconnect** and approve every permission. On Telegram: make the bot a channel admin with *Post messages*, then **Check now**. |
| **Reconnect required** | The sign-in expired or was revoked (for example the person removed Relay in the network's settings or changed their password). | Do not send; they wait as **Blocked**. | **Reconnect** with an account that still manages the destination. On Telegram: paste a new token from @BotFather. On Bluesky: create a new app password. |
| **Awaiting platform approval** | The network has not approved Relay's app for this kind of access yet. | Do not send. | Nothing you can do in Relay; the workspace owner needs the network's approval. |
| **Unsupported for this account** | This account type cannot publish through the API (for example a TikTok account with no posting permission). | Do not send. | Use the network's app, or reconnect and grant posting. |
| **Limited access** | Publishing works with a restriction set by the network (for example TikTok posts limited to *Only me*, Pinterest Trial access showing Pins only to you). The card explains the restriction. | Send, with that restriction. | Wait for the network's approval of Relay's app. |
| **Manual handoff** | The network accepts a draft but a person must finish posting in the network's app (TikTok inbox upload). | Delivered as a draft; the delivery shows **Manual handoff** until it is resolved. | Finish the post in the network's app. |
| **Paused** | Someone paused this destination in Relay. | Do not send; posts whose deadline passes **expire**. | **⋯ → Resume**. |
| **Disconnected** | Removed from Relay; stored credentials deleted. | **Blocked**. | Connect again from **Connections**. |

## Errors you may see on a delivery

These appear on the post's delivery history and in **Overview → Needs attention**.

| Error (plain words) | Typical cause | What to do |
|---|---|---|
| Reconnect *network* to resume | Expired or revoked sign-in. | Reconnect the destination. |
| Reconnect and approve all *network* permissions | A permission is missing. | Reconnect and approve everything. |
| Rate limited until *time* | The network asked Relay to slow down. | Nothing; Relay retries after that time. |
| Budget exhausted (X) | The workspace's X read/post budget, or the X app's prepaid credits, ran out. | Ask the workspace owner to raise the budget in **Settings → Operations → Usage and limits** or add credits in the X developer console. |
| Content rejected / exact limit message (for example "text is 2,310 of 2,200 allowed") | The post breaks a network rule Relay could not check in advance, or the network changed a rule. | Edit the channel variant and reschedule. |
| **Not confirmed — check before retrying** (state *Unknown*) | The network may have published, but its answer was lost. Relay checks the network automatically where it can. | Open the network and look for the post. Then mark the delivery *Published* or *Not published* in Relay. Never retry blindly: it could post twice. |
| Missed its deadline (state *Expired*) | The destination was paused, blocked or unreachable until the post's deadline. | Reschedule if the post is still relevant. |

Networks where Relay **cannot** confirm a lost result automatically: **Telegram** (no lookup for bots) and **LinkedIn
member profiles** (the read permission is closed by LinkedIn). For these, a lost response always needs a person to check.

## Why a connection can lose access without anyone touching Relay

- The network expires sign-ins (for example LinkedIn after 60 days, Threads after 60 days without use, X and others
  when a refresh fails).
- Someone removed Relay from the account's connected apps, changed their password, or lost their role on the Page,
  organization or channel.
- The network restricted the account or app (policy action, missing Page Publishing Authorization on Facebook/Instagram).

Relay checks connections in the background and shows the change on the card and in **Connection health**; it never
falls back to a different account or to simulated publishing.
