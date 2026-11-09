---
title: When paid actions are paused
summary: What a billing restriction does to scheduled posts, replies, AI, automations and integrations - and what always keeps working.
section: billing-and-plans
audience: user
status: available
related: [invoices-and-payment-details, change-plan-or-cancel, start-a-free-trial, delivery-statuses]
product_version: "2026-11"
reviewed: 2026-11-09
order: 60
keywords: [restricted, paused, read only, trial ended, payment failed, held, billing hold]
---

When a trial ends without a subscription, a payment problem outlasts the grace period, or a cancellation takes effect,
the workspace becomes **restricted**. A **Paid actions paused** strip appears with links to **Billing**, **Held work** and
**Support**: *Scheduled posts and replies are held until this is resolved. Your data, exports, billing and support stay
available.*

**Nothing is deleted, disconnected or silently published.**

## What happens to each kind of work

| Work | While restricted | When access returns |
|---|---|---|
| Scheduled posts | **Held** (shown as Blocked with the reason). New timed schedules are accepted but held at their time. **Publish now** is refused. | Released and sent once if still within their deadline; otherwise **Expired** — never sent late. |
| Posts already sending, Unknown or in manual handoff | Untouched. | — |
| Inbox replies | New sends refused; queued replies held. | Sent if the network's reply window still allows. |
| Approvals | Still recorded; approved posts are held at their time like any post. | Published if still on time. |
| Automations | Rules kept; each triggered run is recorded **blocked**. | Next events run (blocked ones aren't replayed). |
| AI | Requests refused; running tasks stop as blocked. | Works again. |
| Listening | Mentions still stored, but not matched; no alerts. | Searches re-match stored mentions. |
| Business apps | Jobs wait; Slack alerts deferred. | Run once. |
| MCP | Read tools work; write tools refused. | Normal. |
| Uploads | New uploads refused (ones in progress finish). | Normal. |
| Exports, billing, support, reading, editing drafts, managing the team | **Always available.** | — |

## See what's held

Admins open **Admin console → Usage and limits** (**Held work**: scheduled posts held, replies held, integration jobs
held, automation runs blocked, accounts and searches over the limit — *Nothing is deleted*).

## Over a plan limit (not a billing problem)

If a downgrade leaves you with more connected accounts or listening searches than the plan allows, nothing is
disconnected. An admin with `billing.manage` chooses **Accounts that stay active** / **Searches that stay active** and
**Save choice**; until then the oldest stay active. Paused accounts stay connected (inbox and analytics continue), but
publishing to them is held.

A Relay operator may keep full access on temporarily while a billing issue is resolved; it's shown as **Full access kept
on** *Until <date>*.
