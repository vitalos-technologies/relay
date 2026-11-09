---
title: Approve or end Relay support access
summary: Decide whether Relay support may look at your workspace read-only for a limited time, and end it whenever you want.
section: support
audience: admin
roles: [owner, admin]
status: available
related: [track-your-support-requests, audit-log, roles-and-permissions]
product_version: "2026-11"
reviewed: 2026-11-09
order: 30
keywords: [support access, give support access, read-only access, staff access, impersonation]
---

Relay staff can't see your workspace's content unless an owner or admin approves a time-limited, **read-only** request.

## When Relay asks

1. Owners and admins get a notification. The request shows on the support request (*Relay support asked for read-only
   access (60 min): <reason>*) and under **Admin console → Security and audit → Support access**.
2. Select **Approve** or **Decline**. Approving needs `members.manage` and a fresh two-step sign-in. The dialog says
   exactly what it means: *They can read posts, media and settings in this workspace until it ends. They can't change,
   approve or publish anything. You can end it any time.* Add an optional **Note**.
3. **Result:** *Access granted*. Everyone sees the banner **Relay support has read-only access**.

Requests are 30 minutes to 24 hours long and lapse after 24 hours if nobody answers.

## End access early

Select **End access** on the request or in **Support access** → *End support access now?* → **End access**. Access stops on
the support person's next request.

## What support can't do with it

- No changes, approvals or publishing.
- No access to your workspace's support requests list.
- Support staff aren't billed as seats.

Every request, approval, decline and end is recorded in your audit log and on the support request.
