---
title: Why an approval was reset
summary: Relay approves exactly what will be sent, so edits, new media or destinations, a new time or a policy change invalidate a review.
section: teams-and-approvals
audience: user
roles: [owner, admin, brand_manager, editor, approver, publisher]
status: available
related: [submit-a-post-for-review, approve-or-request-changes, approval-policies-and-stages, reschedule-pause-or-cancel]
product_version: "2026-11"
reviewed: 2026-11-09
order: 43
keywords: [invalidated, review reset, approval invalidated, resubmit]
---

An approval is bound to one exact version: the text of every channel version, the media files and their versions, the
destinations, links, the scheduled time and deadline, and the approval policy version. If any of these change, the
approval no longer describes what would be sent.

## What invalidates what

| Change | While **waiting** for review | After **final approval** (scheduled) |
|---|---|---|
| Edit text, link or media for a submitted destination | Review **reset** ("Reset — the post changed"); author and reviewers notified | The scheduled version doesn't change. Your edits stay in the draft and are **not sent** unless you submit again. |
| Change destinations | Reset | Not sent unless resubmitted |
| Reschedule | Approval re-requested (the dialog warns *Approved posts need re-approval*) | Same |
| Media or link changed underneath (for example a replaced file, or an image's alt text edited in the library) | Refused at decision time ("Media, destinations or links changed after submission") | Held before sending ("…changed after approval. Resubmit it for review.") |
| Approval policy saved | Request invalidated ("The approval policy changed…") | Held ("The approval policy changed after this was approved.") |
| An approver loses access | — | Held ("…no longer has enough eligible approvals") |

## What to do

1. Open the post. The **Delivery** panel or **Review** tab says *Approval invalidated — submit again* or shows the reason.
2. Make sure the draft is what you want to send.
3. **Submit for review** again. Reviewers see a fresh request.

## Good to know

- Requesting changes and invalidation both keep the full history in the review's activity and the audit log.
- Comments and tasks stay attached to the post across resubmissions.
