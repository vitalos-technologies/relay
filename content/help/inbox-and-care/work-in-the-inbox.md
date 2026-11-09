---
title: Work through the social inbox
summary: Find conversations by queue, filter and search, assign them, and move them through waiting, snoozed, resolved or spam.
section: inbox-and-care
audience: user
roles: [owner, admin, brand_manager, care_agent]
status: not-live-verified
related: [inbox-channels-by-network, reply-and-add-internal-notes, cases-and-service-levels, saved-replies-and-views, link-a-customer-across-channels]
product_version: "2026-11"
reviewed: 2026-11-09
order: 10
keywords: [inbox, conversations, messages, comments, queue, assign, care, social inbox]
---

The **Inbox** ([/inbox](/inbox)) collects messages, comments, mentions and reviews from the channels your workspace has
added. It's separate from Relay support: messages here go to and from **your customers** through your social accounts.

> **Note:** The inbox workflows are implemented and tested against simulated channels. Receiving and answering on a
> real network also needs that network's messaging approval; see [Inbox channels by network](/help/inbox-and-care/inbox-channels-by-network).

## Who can use it

| Permission | Owner, Admin | Brand manager | Care agent | Others |
|---|---|---|---|---|
| Read conversations (`inbox.read`) | ✓ | ✓ | ✓ | — |
| Reply (`inbox.reply`) | ✓ | ✓ | ✓ | — |
| Assign (`inbox.assign`) | ✓ | ✓ | ✓ | — |
| Work on cases (`cases.manage`) | ✓ | ✓ | ✓ | — |
| Channels, service levels, saved replies (`inbox.manage`) | ✓ | — | — | — |

Inbox access is per brand. Publishing roles never imply inbox access, and Relay staff never see your conversations.

## Find conversations

1. Choose a **queue**: **Unassigned**, **Mine**, **Team** (assigned to one of your teams), **Waiting**, **Snoozed**,
   **Resolved**, **Spam**, **All**.
2. Narrow with **Type** (Message, Comment, Mention, Review), **Channel** and **Priority** (Low, Normal, High, Urgent), or
   **Search**. Save a filter combination as a view (see [Saved replies and views](/help/inbox-and-care/saved-replies-and-views)).
3. **Live** shows that the list updates by itself.

![Inbox with queues on the left, two synthetic Facebook conversations waiting one day, and an open public comment with Unassigned, Resolve and a reply box offering Public reply, Private message and Internal note](/help/img/inbox-and-care/inbox.png)

## Handle a conversation

- **Assign to** a person (or yourself — *Assigned to you*), or **Unassign**.
- **Resolve** when done; **Reopen** to continue.
- **More actions**: **Waiting on customer**, **Snooze 1 hour**, **Snooze until tomorrow 9:00**, **Mark as spam**.
- **Customer and case** (side panel; on phones a button) shows the customer, *Waiting since…* / *Answered · …*,
  **Satisfaction**, **Priority**, and the case.

A new customer message reopens a waiting, snoozed or resolved conversation. Snoozed conversations come back by themselves.

## Moderate a comment

On a public comment, **Moderate this message** offers network actions where supported, such as hide/**Unhide** or deleting
your own reply (*Delete your reply on the network?*). For a Google review, only your **owner reply** can be deleted; *the
customer's review stays*.

## On phones

Inbox-only roles (for example care agents) get **Overview · Inbox** in the bottom bar; others find **Inbox** under **More**.
