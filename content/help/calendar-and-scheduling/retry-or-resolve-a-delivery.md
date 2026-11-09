---
title: Retry a failed delivery or resolve an unconfirmed one
summary: Safely retry one destination, or record what really happened when Relay couldn't confirm a post, without posting twice.
section: calendar-and-scheduling
audience: user
roles: [owner, admin, brand_manager, publisher]
status: available
related: [delivery-statuses, delivery-history, publishing-failed, connection-status-and-fixes]
product_version: "2026-11"
reviewed: 2026-11-09
order: 61
keywords: [retry, resend, unknown, not confirmed, resolve, duplicate post, manual outcome]
---

**Required permission:** `publishing.retry` on the brand (Publisher, Brand manager, Admin, Owner). Every retry and
resolution is recorded with your name.

## Retry a failed or expired destination

1. Open the post → **Delivery** panel and find the destination.
2. Fix the cause first (for example reconnect the account, shorten the text, replace the media). Retrying the same
   problem fails again.
3. Select **Retry**. The dialog says *Only this destination is retried.*
4. **Result:** "Retry queued". The destination goes back to sending; other destinations are not touched.

Retries follow the same deadline rules; to send much later, reschedule instead. Retry is available for **Failed**,
**Expired**, **Unknown** and **Blocked** destinations. A destination blocked because its scheduler lost publishing rights
can't be retried: adopt it from **Team → Held posts**. If the approval is no longer valid, submit for review again.

## Resolve an "Unknown — needs review" delivery

*Sent, not confirmed* means Relay sent the post but never got an answer (for example a timeout). It may or may not be live.

1. **Check the network first** — open the account on Instagram, X, etc. and look for the post.
2. Select **Resolve** on the destination and choose:
   - **It was posted** — *Won't be sent again.* Paste the **Post link** (a full `https://` link) and an optional **Note**.
   - **It wasn't posted** — *Safe to retry.* Then retry it.
3. **Result:** "Outcome recorded".

## Retrying an Unknown delivery anyway

If you retry without resolving, Relay warns *The last attempt may have posted. Retrying may post twice.* You must tick
**I understand this may create a duplicate post** (*Logged with your name*).

## Simulated destinations

On demo workspaces the buttons say **Retry (simulated)**; nothing reaches a network.

## Limitations

- Relay can't delete a duplicate from the network; remove it there.
- Some networks (for example Telegram) don't let Relay look up whether a post exists, so Relay never guesses: you decide.
