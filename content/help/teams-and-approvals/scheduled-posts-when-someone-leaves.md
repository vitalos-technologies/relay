---
title: What happens to scheduled posts when someone leaves
summary: Scheduled and approved posts are re-checked when a person's access changes, and are held - never published or deleted - until someone takes responsibility.
section: teams-and-approvals
audience: user
roles: [owner, admin, brand_manager, publisher, approver]
status: available
related: [reassign-work-and-held-posts, suspend-or-remove-a-member, approve-or-request-changes]
product_version: "2026-11"
reviewed: 2026-11-09
order: 53
keywords: [leaver, scheduled post held, authority, publishing when user removed]
---

Relay only publishes something while the people who authorised it are still allowed to. This table shows what happens
to a post scheduled for later when its scheduler or approver changes.

| Change | Post scheduled directly (brand without review) | Post approved through review |
|---|---|---|
| The **author** (writer of the draft) is removed | Not affected (authority comes from the scheduler). | Not affected. |
| The **scheduler** is suspended, removed, loses Publisher/Brand manager on the brand, or a team that gave them publishing is archived | **Held** | Not affected (authority comes from the approvals). |
| An **approver** loses `content.approve` or leaves before sending | — | **Held** ("Needs new review"). |
| The approval policy is changed | — | Existing approvals are voided; the post is held until reviewed again. |
| The person gets access back | Stays held until adopted. | Stays held. |
| A destination is already sending | Finishes; not affected. | Finishes. |

## What "held" means

- Nothing is published, and nothing is deleted. The post stays on the planner with a *held* state.
- If nobody adopts it before its **deadline** (scheduled time + the brand's deadline window), it is marked missed and is
  never published late.
- Admins and publishers see it under **Team → Held posts**. See [Reassign work and adopt held posts](/help/teams-and-approvals/reassign-work-and-held-posts).

## Good practice when someone is leaving

1. Before removing them, open their member page and read **Handover**.
2. Reassign to a colleague who can publish on the same brands.
3. Remove them; then check **Team → Held posts** for anything skipped.
