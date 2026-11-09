---
title: Approve a post or request changes
summary: Review exactly what will be sent to each channel, then approve your stage or request changes with a reason.
section: teams-and-approvals
audience: user
roles: [owner, admin, approver, guest]
status: available
related: [submit-a-post-for-review, approval-policies-and-stages, when-an-approval-is-reset, guests-and-client-reviews]
product_version: "2026-11"
reviewed: 2026-11-09
order: 41
keywords: [approve, reject, request changes, review queue, approvals]
---

## Before you start

- **Required permission:** `content.approve` on the brand (Approver, Admin, Owner; guests only for reviews shared with
  them and only when the stage allows guests).
- You must also be **eligible for the current stage**: the stage may be limited to certain roles or teams, and with
  separation of duties on, people who wrote or edited the post can't approve it.

## Find what's waiting for you

1. Open **Approvals** ([/approvals](/approvals)). The header says how many are *waiting for you*; items marked
   **Your turn** are ones you can decide now.
2. Use **Waiting / Decided**, **Group by** (Due, Brand, Assignee) and **All / Mine** to narrow the list.
3. **Preview what will be sent** expands the exact versions inline.

![Approvals list in the Relay Showcase workspace with Waiting and Decided, Group by and Mine filters](/help/img/teams-and-approvals/approvals-list.png)

## Decide

1. Open the review. **What will be sent** shows each destination's final text and media; **Changed** marks what differs
   from the base text.
2. Check **Schedule**: the planned time, its **Deadline** (after which it expires instead of posting late) and destinations.
3. Choose:
   - **Approve** → confirm. The dialog tells you the consequence: *Publishes at the scheduled time* or *Publishes
     immediately* (when no time was set). With two stages, your approval completes your stage and the next stage's
     reviewers are notified.
   - **Request changes** → enter a **Reason** (required; the author sees it) → **Request changes**. The request is closed;
     the author edits and submits again.

![A review page: What will be sent for Lumen Lane Events Instagram with the exact text, link and media and a preview, the Review stage progress 0 of 1, an internal discussion box, and Request changes and Approve buttons](/help/img/teams-and-approvals/review-detail.png)

## Rules Relay enforces

- **Quorum:** a stage may need several approvals from **different** people.
- **One stage per person:** if you approved stage 1 you can't also approve stage 2.
- **Exact version:** if the post changes while you're reviewing, your decision is refused ("The submission changed while
  you were reviewing. Reload to review the current version.").
- **Too late:** if both the scheduled time and its deadline have passed, approval is refused; request changes and ask
  for a new time.
- Eligibility is checked again when the post is sent. If an approver loses access before then, the post is **held** and
  needs a new review.

## Common errors

| Message | Meaning |
|---|---|
| Your role is not eligible for "<stage>" / Only listed teams can approve "<stage>" | The stage is limited to other people. |
| You worked on this content, so you cannot give its independent approval. | Separation of duties is on. |
| You already approved this stage. Another eligible person must approve. | Quorum needs someone else. |
| This request was invalidated because the post changed. | Review the new submission instead. |

## Limitations

- Approvals can't be withdrawn after the final approval; to stop the post, someone with publishing rights cancels the
  schedule (see [Reschedule, pause or cancel](/help/calendar-and-scheduling/reschedule-pause-or-cancel)).
