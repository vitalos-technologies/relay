---
title: Check usage and set workspace limits
summary: See this period's usage against plan allowances, set your own safety budgets, and choose what stays active when over a limit.
section: billing-and-plans
audience: user
roles: [owner, admin]
status: available
related: [plans-and-features, when-paid-actions-are-paused, ai-limits-privacy-and-usage]
product_version: "2026-11"
reviewed: 2026-11-09
order: 70
keywords: [usage, limits, budget, quota, allowance, meter, x budget, storage used]
---

**Required:** Owner or Admin (`workspace.manage`) — *Owners, admins and billing managers only.*

## Plan usage

**Admin console → Usage and limits** ([/admin/usage](/admin/usage)) and **Plan and billing → Usage this period** show:

- **Plan** (Trial, Billing state, or *Legacy · all features*), **Allowances reset** (or *Not during the trial*),
  **Billing period** / **Calendar month**.
- **Plan features** — **Included** / **Not included**.
- **Allowances** — used vs allowed per meter; **Limit reached** when full. *No overage is ever charged: at a limit, the
  action waits or is refused.* Legacy: *Nothing is limited by your plan. Your own budgets below still apply.*
- **Held work** — see [When paid actions are paused](/help/billing-and-plans/when-paid-actions-are-paused).

## Your own budgets (safety caps)

**Settings → Operations → Usage and limits** ([/settings/operations/usage](/settings/operations/usage)) — *Monthly meters
reset each billing period. Storage is a running total. A budget can only lower your plan's allowance. Empty = plan limit
(or no cap).*

| Meter | What it counts | At the cap |
|---|---|---|
| X posts | X posts sent this month | X posts are held; other networks continue. |
| X reads | Billable X reads (status checks, analytics) | They are skipped. |
| AI tokens | AI tokens this month | AI requests are refused. |
| Storage | Media originals stored (all time), in megabytes | New uploads are refused. |
| Exports | Activity and client handover exports this month | Exports are refused. |
| MCP calls | Tool calls from connected AI clients this month | Calls are refused. |
| Integration jobs | Business-integration sync jobs this month | Jobs wait. |

**Teams** caps limit what members of a team use together; their usage also counts toward the workspace. Use whole numbers
≥ 0; leave empty for *No cap*. People with the **Budgets** notification type are told as a budget fills up.

## Choose what stays active

When accounts or listening searches exceed the allowance, choose **Accounts that stay active** / **Searches that stay
active** (**Active** / **Paused**) and **Save choice** (needs `billing.manage`).
