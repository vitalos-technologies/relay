---
title: Publish a post now
summary: Send a post to its destinations immediately after checking exactly what each one will receive.
section: publishing
audience: user
roles: [owner, admin, brand_manager, publisher]
status: available
related: [schedule-a-post, check-before-sending, delivery-statuses, retry-or-resolve-a-delivery, when-paid-actions-are-paused]
product_version: "2026-11"
reviewed: 2026-11-09
order: 50
keywords: [publish now, post now, send now, immediately]
---

## Before you start

- **Required permission:** `content.publish` on the brand (Publisher, Brand manager, Admin, Owner), with two-step
  verification if your workspace requires it.
- The brand must not require approval. On review brands, submit without a time instead: the post is published as soon
  as it's finally approved.
- Publish now needs paid access: it's refused during a billing restriction (scheduled posts can still be prepared).
- Real (non-simulated) destinations must be connected and healthy.

## Steps

1. Open the post and pick its destinations.
2. Select **Publish now** (desktop action bar, or **⋯ → Publish now** on phones).
3. The dialog **Publish now?** lists *Exactly what each of N destinations will receive*: final text, media and options per
   destination, plus the readiness checks.
4. Select the button, which says what will happen: **Publish to N**, **Publish N + simulate M** (some destinations are
   simulated) or **Simulate (M)**.

**Result:** "Publishing started" (or "Simulated publish started"). The **Delivery** panel shows each destination moving
through Preparing → Publishing → Published. Problems appear as **Failed** or **Unknown**; see
[Follow deliveries](/help/calendar-and-scheduling/delivery-statuses).

## Consequences

- Publishing creates a frozen revision of the post. Later edits don't change what was sent.
- Relay can't unpublish. To remove a post, delete it on the network; then **Archive** it in Relay.
- Like scheduled posts, it must start within the brand's deadline window (default 15 minutes) or it expires instead of
  posting late (for example during a pause).

## Common errors

| Message | Fix |
|---|---|
| You cannot publish posts for this brand | You lack `content.publish` there. |
| Changes not saved — nothing was published. | Resolve the save problem first. |
| Paid actions are paused | Billing restriction; see [When paid actions are paused](/help/billing-and-plans/when-paid-actions-are-paused). |
| This brand requires approval: submit for review instead. | Submit for review. |
