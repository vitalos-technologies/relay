---
title: Schedule a post
summary: Pick a date, time and time zone, set how late it may still go out, and schedule one or more destinations.
section: calendar-and-scheduling
audience: user
roles: [owner, admin, brand_manager, publisher]
status: available
related: [time-zones-and-dst, reschedule-pause-or-cancel, publish-now, submit-a-post-for-review, check-before-sending, delivery-statuses, posting-slots-and-queue]
product_version: "2026-11"
reviewed: 2026-11-09
order: 20
keywords: [schedule, publish later, date, time, deadline, scheduling]
---

## Before you start

- **Required permission:** `content.schedule` on the brand (Publisher, Brand manager, Admin, Owner). Your workspace may
  require two-step verification for this.
- The brand must **not** require approval. If it does, use [Submit for review](/help/teams-and-approvals/submit-a-post-for-review)
  instead (the Schedule button explains why it's unavailable).
- Your plan must include publishing and the workspace must not be restricted for billing.

## Steps

1. Open the post (**Create**, or from the planner) and select its **Destinations**.
2. Select **Schedule**. The dialog shows how many destinations and which brand.
3. **Date and time**: enter the local date and time.
4. **Time zone**: pick from **Suggested** (the brand's and workspace's zones) or **All time zones**. *The schedule keeps
   this zone — your browser's zone is never assumed.* Below, Relay confirms the exact moment, for example
   *Mon 1 Dec 2026, 09:00 GMT · 09:00 UTC*, and your own local time if it differs.
5. **Deadline (minutes)**: how long after the scheduled time the post may still go out (1–10,080; default from the brand,
   15 minutes unless changed). *If it can't send within this window (outage, pause), it expires instead of posting late.*
6. Review the **Readiness** checks in the dialog. Failures must be fixed; a duplicate warning needs **Post anyway**.
7. Select **Schedule**.

![Reschedule dialog: date and time 9 Nov 2026 12:00, time zone Europe/London (brand) confirmed as 12:00 GMT and 12:00 UTC, deadline 15 minutes, two simulated destinations, a readiness panel with a "Similar post to the same destination" warning and a Post anyway checkbox](/help/img/calendar-and-scheduling/schedule-dialog.png)

**Result:** every destination is **Scheduled**. The post appears on the planner, and the **Delivery** panel on the post
shows the time, deadline and destinations.

## What gets sent

Scheduling freezes an exact copy of the post (a *revision*). If you edit the draft afterwards, the scheduled copy does
**not** change — select **Reschedule** to send the new version.

## Common errors

| Message | What to do |
|---|---|
| That time is in the past. Choose a future time or publish now. | Pick a later time (a minute of tolerance applies). |
| That time doesn't exist | The clock jumps forward at that time (DST). Pick another time. |
| … occurs twice (clocks go back). Which one? | Choose **First** or **Second**. See [Time zones and DST](/help/calendar-and-scheduling/time-zones-and-dst). |
| Fix the highlighted destinations or deselect them, then try again. | Fix the destination's text, media or required fields. |
| This brand requires approval: submit for review instead. | Use Submit for review. |
| This post changed since you opened it. | Someone else saved it; review the latest version, then schedule. |
| Two-step verification required | Set it up or verify now. |
| Changes not saved — nothing was scheduled. | Your latest edits couldn't be saved; fix the save problem first. |

## Limitations

- One active schedule per post. Scheduling again replaces the previous schedule.
- To send at different times per network, make separate posts (or use posting slots).
