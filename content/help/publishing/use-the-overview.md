---
title: Use the Overview dashboard
summary: What the Overview cards, banners and lists tell you, and the actions they lead to.
section: publishing
audience: user
status: available
related: [delivery-statuses, use-the-planner, approve-or-request-changes, connection-status-and-fixes]
product_version: "2026-11"
reviewed: 2026-11-09
order: 5
keywords: [dashboard, home, overview, alerts, issues, summary]
---

**Overview** ([/overview](/overview)) is the first page after sign-in. It follows the **Brand filter** in the header.

![Overview of the synthetic Relay Showcase workspace: four summary cards (Scheduled 1, In review 2, Published 28, Issues 4), an Upcoming list grouped by day, a Needs attention list with Resolve buttons and a Channel health card asking to reconnect LinkedIn](/help/img/publishing/overview-dashboard.png)

## Banners (only when something is wrong)

| Banner | Meaning | Action |
|---|---|---|
| **Workspace paused** | Emergency pause is on; nothing is sent. | Resume when safe ([Pause publishing](/help/calendar-and-scheduling/pause-publishing-in-an-emergency)). |
| **N posts are overdue** | Scheduled posts haven't started. The text says why: *Publishing is off for maintenance*, *Publishing is running behind. These go out shortly.*, or *The publisher is not running.* They send when it's back, unless their deadline passes. | Admins: **Operations**. |
| **Paused: <brands>** | Those brands are paused. | Resume in brand settings. |

## Summary cards

| Card | Shows | Opens |
|---|---|---|
| **Scheduled** | Posts due in the next 7 days. | Planner |
| **In review** | Reviews awaiting a decision. | Approvals |
| **Published** | Posts published in the last 7 days (*simulated* on demo workspaces). | Planner |
| **Issues** | Unresolved deliveries. | Needs attention |

## Lists

- **Upcoming** — the next scheduled posts by day (**Today**, **Tomorrow**, dates). **Create post** when nothing is scheduled.
- **Needs attention** — deliveries that need you: failed, *Not confirmed — check before retrying*, *Missed its
  deadline*, *Post it in the app* (manual handoff), blocked. **Resolve** opens the post's delivery panel.
- **Channel health** — only connected accounts that need something (reconnect, missing permission, expiring, paused),
  with the fix. *All connections healthy* otherwise. **Connections** opens the accounts page.
- **Performance** — headline analytics for the last 28 days with the previous period for comparison, and how many posts
  are reporting data. **Demo data** marks synthetic numbers. **Analytics** opens the full reports (see the **Analytics
  and reporting** section for what each number means).

## Good to know

- What you see follows your roles: people without publishing rights don't see publishing actions.
- On phones, the bottom bar depends on your role: publishers and approvers get Overview · Planner · Create · Approvals;
  people who answer the inbox but don't approve get Inbox instead of Approvals; inbox-only roles get Overview · Inbox.
  Everything else is under **More**.
