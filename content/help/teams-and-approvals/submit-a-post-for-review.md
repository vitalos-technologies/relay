---
title: Submit a post for review
summary: Send a post to reviewers when its brand requires approval, ask specific people, and know what happens if you edit it afterwards.
section: teams-and-approvals
audience: user
roles: [owner, admin, brand_manager, editor]
status: available
related: [approve-or-request-changes, approval-policies-and-stages, when-an-approval-is-reset, guests-and-client-reviews, schedule-a-post]
product_version: "2026-11"
reviewed: 2026-11-09
order: 40
keywords: [submit for review, send for approval, request review, reviewer]
---

## Before you start

- **Required permission:** `content.edit` on the brand (Editor, Brand manager, Admin, Owner).
- Submitting is needed only when the brand has an approval policy with at least one stage
  (Settings → Publishing → Approval policies). On a brand **without** review, **Submit for review** is refused with
  "This brand does not require approval. Schedule it directly."
- On a brand **with** review, nobody can schedule directly, not even Owners: everyone submits.

## Steps

1. Open the post in **Create** and pick its destinations.
2. Select **Submit for review** in the action bar (on phones it is the main button, or under **⋯**).
3. In the dialog choose when it should go out:
   - **At a set time**: pick a date, time and time zone. Approval then schedules it for that time.
   - Without a time: it **publishes as soon as it is finally approved**.
4. Select **Submit**.

**Result:** the post shows *Awaiting approval — nothing sends until approved*. Everyone eligible for the first stage is
notified. The review appears in **Approvals** ([/approvals](/approvals)).

## Ask specific reviewers

1. Open the post's **Collaborate** panel → **Review**.
2. Under **Requested reviewers**, search eligible reviewers and select a name. Only people the policy allows for a stage
   are offered (role, team, guest rules and separation of duties). You can't request yourself.
3. **Result:** they get a dedicated notification. Requesting someone doesn't stop other eligible reviewers from deciding.

You can also set a **Reviewer** and a **Review by** date on the review (Approvals → open the review → **Assignment**).
The date is a reminder; it never changes the schedule.

## What resets a review

Relay approves **exactly what will be sent**. If you change the text, media, link or destinations of a submitted post,
the pending review is **invalidated** ("Reset — the post changed"), the author and reviewers are notified, and you must
submit again. See [When an approval is reset](/help/teams-and-approvals/when-an-approval-is-reset).

## Common errors

| Message | What to do |
|---|---|
| Fix the highlighted destinations or deselect them, then try again. | A channel's limits or required fields aren't met. Fix them in the channel tab. |
| That time is in the past. Choose a future time or publish now. | Pick a later time. |
| This brand requires approval: submit for review instead. | Shown if you try to schedule on a review brand. |
| Mandatory brand rule findings | Brand rules marked mandatory block submission until fixed. |

## Limitations

- A comment that says "approved" approves nothing. Only **Approve** in the review does.
- Finishing a task never approves or publishes a post.
