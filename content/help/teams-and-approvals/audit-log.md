---
title: Review the audit log
summary: See who changed access, accounts, publishing, security and content settings, filter by category, brand and date, and export to CSV.
section: teams-and-approvals
audience: admin
roles: [owner, admin]
status: available
related: [roles-and-permissions, suspend-or-remove-a-member, manage-sessions, support-access]
product_version: "2026-11"
reviewed: 2026-11-09
order: 80
keywords: [audit, activity log, history, compliance, export audit, who changed]
---

**Required permission:** Owner or Admin (`audit.read`; the page shows *Owners and admins only* to others). Open
**Settings → Operations → Audit log** or [/activity](/activity). The admin console has the same log under **Security and
audit → Audit log**.

## Read and filter

1. Choose a **Category**: All, Access, Accounts, Publishing, Security, Collaboration, Inbox and AI, Content.
2. **Search** by action, resource or person; choose a **Brand**; set **From** and **To** dates.
3. Each row shows **When**, **Type**, **Action** (for example `member.suspended`, `schedule.created`,
   `approval.invalidated`), **Brand** and **Details** (a short, safe summary of what changed).

## Export

Select **Export CSV**. The file contains the filtered events. Cells that start with `=`, `+`, `-` or `@` are neutralised
so they can't run as spreadsheet formulas. Exporting needs `exports.create` and counts toward your plan's export allowance.

## What's recorded

Access changes (invitations, grants, restrictions, teams, suspensions, removals, ownership transfers), connections,
scheduling and publishing actions (including retries and manual outcome records), approvals and invalidations, security
policy and sign-in method changes, service accounts and keys, trash and restore, billing changes, support-access
requests and decisions, collaboration settings, inbox and AI actions.

Audit entries can't be edited or deleted by anyone in the workspace. They never include passwords, keys or message text.

## Limitations

- The details column is a summary; it doesn't show full before/after content of posts (use the post's
  [version history](/help/publishing/version-history-and-restore)).
- Problem reports and support-access history have their own pages under **Security and audit** in the admin console.
