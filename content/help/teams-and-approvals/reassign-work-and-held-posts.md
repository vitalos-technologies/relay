---
title: Reassign work and adopt held posts
summary: Move drafts, tasks, reviews and scheduled posts from someone who lost access, and release posts Relay held for safety.
section: teams-and-approvals
audience: user
roles: [owner, admin, brand_manager, publisher]
status: available
related: [scheduled-posts-when-someone-leaves, suspend-or-remove-a-member, effective-access-and-overlapping-roles, delivery-statuses]
product_version: "2026-11"
reviewed: 2026-11-09
order: 52
keywords: [held, adopt, handover, reassign, authority hold, offboarding]
---

## Why posts get held

When a post is scheduled, Relay records **who authorised it** (the scheduler, or the approvers) and checks that record
again whenever access changes and once more just before sending. If the person who scheduled it no longer may publish
to every destination, or an approver lost their approval right, the post is **held**: its not-yet-started destinations
are blocked and **nothing is sent**. Destinations already sending finish normally.

Holds are never released automatically, not even when the person gets their access back. Someone must **adopt** the post.

## Adopt a held post

**Required:** `content.schedule` on the brand and every destination (`content.publish` for a publish-now post), plus
two-step verification if your workspace requires it.

1. Go to **Team → Held posts** ([/team/held](/team/held)). Admins also find it in the admin console under **People and teams →
   Held publications**.
2. Each row shows the post, brand, due time, how many destinations are held, who scheduled it and when it was held.
   The badge says what's needed:
   - **Needs publisher**: anyone allowed to publish can adopt it.
   - **Needs new review**: the approval itself is no longer valid (approval withdrawn, approver lost access, or the
     content changed). It can't be adopted; the author must submit again.
3. Select **Adopt**. **Result:** you become the person who authorised it. Destinations still before their deadline go back
   to the queue ("N re-queued"); those past their deadline are marked missed and are **not** sent late.

## Reassign someone's open work

From the member page (**Team → member → Handover**):

1. Review the counts: drafts, scheduled, reviews requested/assigned, service accounts, connected accounts, other workspaces.
2. Choose **Reassign to** and select **Reassign**.
3. **Result:** a summary such as *4 drafts · 2 scheduled · 1 service accounts · 1 skipped (not authorised)*. Items the new
   person isn't allowed to handle are skipped, never forced.

From the admin console (**Collaboration → Reassign work**, needs `members.manage`):

1. Choose **From** (a former or current member).
2. Pick the open **Tasks**, **Reviews** and **Post owners** to move, choose the new person, and select **Move**, or
   **Unassign** to clear them.
3. Each item only moves to someone who can see its brand.

## Limitations

- Relay can't move ownership of a social account on the network; reconnect flagged accounts yourself.
- Reassigning a scheduled post moves the *authority*; it doesn't change its content, time or destinations.
