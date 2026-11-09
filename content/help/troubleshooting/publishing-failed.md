---
title: A post failed to publish
summary: Find out why a destination failed, fix the cause and retry safely without posting twice.
section: troubleshooting
audience: user
roles: [owner, admin, brand_manager, publisher]
status: available
related: [delivery-statuses, retry-or-resolve-a-delivery, connection-status-and-fixes, check-before-sending]
product_version: "2026-11"
reviewed: 2026-11-09
order: 30
keywords: [failed post, not published, publish error, rejected by network, retry]
---

1. Open the post → **Delivery**, or **Overview → Needs attention → Resolve**. The failed destination shows **Not
   published** and the network's reason.
2. Match the reason:

| Reason (examples) | Fix |
|---|---|
| Account needs reconnecting, token expired, permission missing | Reconnect the account in **Connections** ([connection fixes](/help/social-connections/connection-status-and-fixes)). |
| Text too long, too many hashtags, link not allowed | Shorten or customise that destination's version. |
| Media format, size, ratio or duration not accepted | Replace the media, crop it, or give that destination a custom media set. |
| Rate limited / *asked to wait* | Relay retries automatically; otherwise retry later. |
| X budget reached | Raise the X budget in Usage and limits, or wait for the next month. |
| Retries ran out before the deadline | Retry or reschedule. |

3. Select **Retry** on that destination. Only it is retried; destinations that already published aren't touched.

If the status is **Unknown — needs review** instead of Failed, **don't retry first** — check the network, then
[Resolve](/help/calendar-and-scheduling/retry-or-resolve-a-delivery).

Simulated destinations (demo workspaces) never reach a network; their results are labelled *Simulated*.
