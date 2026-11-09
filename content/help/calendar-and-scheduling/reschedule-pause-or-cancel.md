---
title: Reschedule, pause or cancel a scheduled post
summary: Move a post to a new time, stop it for now, or cancel its schedule - and understand how each differs from deleting a published post.
section: calendar-and-scheduling
audience: user
roles: [owner, admin, brand_manager, publisher, editor, approver]
status: available
related: [schedule-a-post, pause-publishing-in-an-emergency, delivery-statuses, archive-trash-and-delete, when-an-approval-is-reset]
product_version: "2026-11"
reviewed: 2026-11-09
order: 40
keywords: [reschedule, move post, cancel schedule, unschedule, pause, stop post, delete post]
---

## Which action do I need?

| You want to… | Use | What happens on the networks |
|---|---|---|
| Send it at another time | **Reschedule** | Nothing yet; it goes out at the new time. |
| Stop it for now, everywhere in a brand or workspace | **Pause brand** / **Pause publishing** | Nothing is sent while paused; posts past their deadline expire. |
| Stop one post for good | **Cancel** the schedule | Destinations not yet started won't send. The draft is kept. |
| Remove a post that's already published | Delete it on the network itself | **Relay never deletes or edits posts on a network.** Archive it in Relay. |
| Get rid of a draft | **Move to Trash** | Nothing (drafts were never sent). |

## Reschedule

**Required:** `content.schedule` on the brand. On brands with review, editors and approvers can also move posts that are
awaiting approval.

1. On the post, select **Reschedule** (or in the planner: drag it to another day, or **⋯ → Reschedule**).
2. Choose the new date, time and zone, and optionally a new deadline.
3. Select **Move to <new time>**.

**Consequences:**
- The schedule is replaced by a new one for the same revision.
- **Approved posts need re-approval** (*Approval will be re-requested*) on brands with review.
- Refused when *Publishing has already started for at least one destination* — cancel the remaining destinations instead.
- If someone else changed the schedule meanwhile: *This schedule changed since you loaded it. Reload and try again.*

To send **edited content**, select **Reschedule** on the post after editing: a new revision is frozen and replaces the
scheduled one.

## Cancel a schedule

**Required:** `content.schedule` on the brand; the person who submitted a post that is still awaiting approval can also
cancel it.

1. On the post, in the **Delivery** panel, select **Cancel**.
2. Confirm **Cancel schedule?** — *Unstarted destinations won't send. The draft is kept.*

**Consequences:**
- Destinations that haven't started are **Cancelled**. A pending review is closed.
- Destinations **already sending** can't be stopped (*Already sending*) and finish normally.
- The post returns to a draft you can schedule again later.

## Pause

- **Pause brand** (Settings → Publishing → Defaults) or **Pause publishing** (whole workspace, sidebar): see
  [Pause publishing in an emergency](/help/calendar-and-scheduling/pause-publishing-in-an-emergency).
- A paused connected account (Connections) holds only that destination: *Destination paused — sends after it is resumed.*

## Common errors

| Message | Meaning |
|---|---|
| You cannot reschedule posts for this brand / You cannot cancel this schedule | You don't have `content.schedule` on the brand. |
| This schedule is cancelled and cannot be moved. | Schedule it again from the post. |
| Pick a different time. | The new time equals the old one. |
