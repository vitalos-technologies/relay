---
title: Follow deliveries - statuses, partial success and retries
summary: What each delivery status means, how automatic retries work, and what to do when a post is partly published, failed or not confirmed.
section: calendar-and-scheduling
audience: user
status: available
related: [retry-or-resolve-a-delivery, delivery-history, schedule-a-post, publishing-failed, pause-publishing-in-an-emergency]
product_version: "2026-11"
reviewed: 2026-11-09
order: 60
keywords: [delivery, status, failed, retry, partial, unknown, expired, blocked, handoff, published]
---

A post goes to each destination separately. Each of those is a **delivery** with its own status. The post's overall
status summarises them (for example **Partial success** when some destinations were published and others weren't).

## Delivery statuses

| Status | Meaning | What you do |
|---|---|---|
| **Scheduled** | Waiting for its time. | Nothing. |
| **Preparing** / **Publishing** / **Processing** | Being sent, or the network is still processing (for example a video). | Wait. |
| **Retrying soon** | A temporary error; Relay retries automatically (*Retrying automatically*, with **Next attempt**). | Wait, or fix the cause. |
| **Published** | The network confirmed it. **View on <network>** opens it. | — |
| **Simulated · delivered** | Sent to a simulated (demo) account. Nothing reached a network. | — |
| **Failed** | *Not published* — the network rejected it, or retries ran out. The reason is shown. | Fix and [retry](/help/calendar-and-scheduling/retry-or-resolve-a-delivery). |
| **Unknown — needs review** | *Sent, not confirmed.* The request went out but no answer came back. | Check the network, then **Resolve**. Don't just retry. |
| **Blocked** | Can't be sent yet: account needs fixing, approval missing, authority held, plan or billing hold. Reason shown. | Fix the reason; held posts need adopting. |
| **Paused** | Workspace, brand or account paused. *Sends on resume if before its deadline.* | Resume. |
| **Expired** | *Missed deadline* — it couldn't go out within the deadline window, so it was **not sent late**. | Retry or reschedule. |
| **Cancelled** | Its schedule was cancelled before it started. | — |
| **Manual handoff** | The network needs you to finish in its own app (for example TikTok inbox drafts). *Post it in the app.* | Finish in the app, then record the outcome. |
| **Overdue** | Past its time and not started (for example the publisher is behind or off). | See the Overview banner. |

## Automatic retries

- Up to **5 attempts** in total, roughly 30 s, 2 min, 5 min and 10 min apart (±20%), or later if the network asks Relay
  to wait.
- Never beyond the **deadline**: if the next attempt would be too late, the delivery fails or expires instead.
- **Unknown** results are **never** retried automatically, because a retry could post twice.

## Partial success

When some destinations are **Published** and others **Failed**, **Expired** or **Unknown**, the post shows **Partial
success**. Only the problem destinations need attention; retrying one destination never re-sends the others.

## Where to look

- The post's **Delivery** panel: each destination with status, **Attempts**, **Next attempt**, **Since**, **Deadline**,
  and actions.
- **Overview** → items needing attention (*Not confirmed — check before retrying*, *Missed its deadline*, *Post it in the app*).
- **Planner** → **History** for all deliveries ([Delivery history](/help/calendar-and-scheduling/delivery-history)).
- Notifications of type **Publishing problems**.
