---
title: Track cases and service levels
summary: Turn a conversation into a case, follow first-response and resolution targets, and set business hours and holidays.
section: inbox-and-care
audience: user
roles: [owner, admin, brand_manager, care_agent]
status: available
related: [work-in-the-inbox, reply-and-add-internal-notes, plans-and-features]
product_version: "2026-11"
reviewed: 2026-11-10
order: 30
keywords: [case, ticket, sla, service level, first response time, resolution time, business hours]
---

**Plan:** cases work on every plan with the inbox (Standard and Professional). **Changing service-level targets** needs **Professional**; on Standard,
existing targets keep working and stay readable.

## Work with a case

**Required:** `cases.manage` on the brand (Care agent, Brand manager, Admin, Owner).

1. Open a conversation → **Customer and case** → **Create case**. Give it a **Title** (for example *Customer request*).
   One conversation belongs to at most one case.
2. The case shows targets for **First response** and **Resolution**, with time left or how long overdue.
3. **Waiting on customer** pauses the clock (*Clock paused*); **Resume** restarts it.
4. **Resolve case** needs a **Resolution reason**. **Reopen** if the customer comes back; reopening is counted and the
   resolution clock continues.

When a target is missed, Relay records the breach once and notifies the case owner (without message text).

## How the clocks work

- The clock starts at the earliest unanswered customer message.
- **First response** = the first reply the network confirmed. Internal notes never count. Automated acknowledgements count
  only if the policy allows it.
- The clock pauses while *Waiting on customer* or *Resolved*.
- Only business hours count; holidays have none; with no hours set, the clock runs 24/7.

## Set the default service levels (admins)

**Required:** `inbox.manage` (Owner, Admin). Open **Settings → Inbox → Service levels**
([/settings/inbox/service-levels](/settings/inbox/service-levels)):

- **First response target (minutes)** and **Resolution target (minutes)**.
- **Time zone**, **Business days**, **Opens** / **Closes**, or **Around the clock (24/7)**.
- **Holidays** (`YYYY-MM-DD`, comma separated).
- **Automated acknowledgements count as a first response**.

Select **Save**. New targets apply to new cases.
