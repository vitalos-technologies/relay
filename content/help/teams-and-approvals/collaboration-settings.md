---
title: Configure collaboration for the workspace
summary: Turn client comments and presence on or off, decide who may assign tasks, set reminders and notification defaults, and check email delivery.
section: teams-and-approvals
audience: admin
roles: [owner, admin]
status: available
related: [guests-and-client-reviews, tasks-and-deadlines, notifications-and-preferences, approval-policies-and-stages]
product_version: "2026-11"
reviewed: 2026-11-09
order: 70
keywords: [collaboration settings, client comments, presence, reminders, notification defaults, email delivery]
---

**Required permission:** `workspace.manage` to change; anyone can read. Open the admin console (**Admin console** in the
sidebar, or [/admin](/admin)) → **Collaboration → Collaboration settings**. Every change is in the audit log (category
Collaboration).

## Discussions and tasks

| Setting | Options | Effect |
|---|---|---|
| Clients can comment on shared reviews | On / Off | Off: guests can read shared discussions but not post. |
| Show who's viewing or editing a post | On / Off | Avatars in the post header. A hint only; never a lock. |
| Who can assign tasks to others | *Anyone who edits, submits or reviews* · *Brand managers and admins only* | Who may set an assignee other than themselves. |
| When someone loses access | *Keep the assignee, flag for reassignment* · *Unassign and flag for reassignment* | What happens to their open tasks. |
| Remind before a deadline (hours) | 1–168 (default 24) | The single "due soon" reminder. |
| Overdue reminders (max) | 0–10 (default 3) | At least 24 hours apart. |

## Notification defaults

For members who haven't changed their own settings: **In app** and **Email** per type. Quiet hours are always personal.

## Eligible reviewers

Choose a brand to see, per stage of its approval policy, who can approve right now. Use **Approval policy** to edit it.

## Notification delivery

**Collaboration → Notification delivery** lists emails that are waiting, failed or weren't sent, with a reason code
(for example *not configured* when email delivery isn't set up — never shown as sent), and lets you **retry**. Only
metadata is shown: type, recipient, state and error code.

## Collaboration overview

**Collaboration → Overview** shows overdue tasks and the review backlog for brands you can see.
