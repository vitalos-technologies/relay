---
title: Workflow reporting
summary: Review turnaround, on-time publishing, delivery reliability and workload by team — facts Relay records itself, reported per team and stage, never as individual performance scores.
section: analytics
audience: user
roles: [owner, admin, brand_manager, analyst]
status: available
related: [use-analytics, analytics-exports-and-reports, connection-status-and-fixes]
product_version: "2026-11"
reviewed: 2026-11-09
order: 90
keywords: [workflow, review turnaround, approval time, on time, schedule adherence, delivery reliability, failed, unknown, expired, workload, team, overdue]
---

**Analytics → Workflow** ([/analytics/workflow](/analytics/workflow)) uses Relay's own records, not network data, so it
is complete and immediate. It is reported per team and stage — never as individual scores. The period, network and
account filters apply; the period uses the selected time zone.

![Workflow view with demo data: review turnaround, on time 100 %, delivered (live), in review now 2, workload counts and delivery reliability for live and simulated destinations](/help/img/analytics/analytics-workflow.png)

## Key numbers

| Card | Definition |
|---|---|
| **Review turnaround** | **Median** hours from review request to decision (approved or rejected), for reviews **requested** in the period; the foot shows the 90th percentile (p90) |
| **On time** | Share of scheduled (not "publish now") deliveries **due** in the period that were published at most **5 minutes** after their scheduled time. The foot shows the tolerance and how many were published |
| **Delivered (live)** | Published ÷ (published + failed + unknown + expired) for deliveries **due** in the period to live (non-simulated) accounts |
| **In review now** | Posts currently waiting for a review decision (not limited to the period); *N overdue* = posts past their due date and not yet published |

## Workload

Counts for the period: **Created** (posts created), **Submitted for review**, **Scheduled** (schedules created, excluding
publish-now), **Published**. **Workload by team** splits them by the post's team (*No team* when unassigned), plus posts
in review now.

## Delivery reliability

| Row | Published · Failed · Unknown · Expired |
|---|---|
| Live networks | Deliveries due in the period to real accounts |
| Simulated | Deliveries to simulated destinations, kept separate so they never inflate live reliability |

**Top errors** lists the most frequent error codes of failed or expired live deliveries. *Unknown* means the network's
answer was lost and nobody has resolved it yet.

## Worked example (synthetic)

In October, 40 scheduled deliveries were due: 36 published within 5 minutes, 2 published 12 minutes late (the network
was rate limiting), 1 failed (expired sign-in), 1 expired (account paused past its deadline).

- **On time** = 36 ÷ 38 published = **95 %**.
- **Delivered (live)** = 38 ÷ (38 + 1 + 0 + 1) = **95 %**.
