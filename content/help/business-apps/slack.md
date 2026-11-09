---
title: Get Relay alerts and approve posts in Slack
summary: Connect Slack, route alerts by category and brand to channels with quiet hours and rate limits, and approve posts from Slack buttons that re-check everything in Relay.
section: business-apps
audience: user
roles: [owner, admin, approver]
status: needs-setup
related: [business-apps-overview, asana, monday-com]
product_version: "2026-11"
reviewed: 2026-11-09
order: 50
keywords: [slack, alerts, notifications, channel, approve, approval button, quiet hours, link account]
sources:
  - title: "Slack — Verifying requests from Slack (signature, 5-minute window)"
    url: https://docs.slack.dev/authentication/verifying-requests-from-slack
    verified: 2026-11-09
---

## Before you start

The workspace owner registers a Slack app (OAuth v2) with a signing secret and an interactivity URL in **Setup**.
Relay requests only `chat:write`, `channels:read`, `groups:read` — not people's email addresses.

## Connect and route alerts

1. **Connections → Business apps → Slack** ([/integrations](/integrations)) → **Connect** → approve in Slack.
2. **Resources** → select the channels. Invite the Relay app to each channel in Slack.
3. **Settings** → create **routes**: categories (approvals, assignments, connection, publishing, care escalations,
   listening, daily summary), a brand filter, quiet hours, a maximum per hour and the daily summary time.

| Rule | Behaviour |
|---|---|
| Quiet hours | Alerts are **deferred**, not dropped |
| Max per hour | Extra alerts are delayed |
| Assignments, care escalations | Only to **private** channels (Relay confirms privacy and app membership with Slack when you save) |
| Content | Minimal: category, brand and a Relay link — no post text or customer messages |

Each event goes once per route. History shows each delivery as sent, deferred, failed or **not confirmed** (a lost
Slack answer is never resent).

## Approve from Slack

Approval alerts carry **Approve** buttons. When someone presses one:

1. Slack's request is verified (signature, at most 5 minutes old, signing-secret rotation supported).
2. Relay checks it as the **linked Relay person** with their current membership and permissions, against the exact
   revision the alert was about (buttons expire after 72 hours and work once).
3. If the content changed since, Slack shows "review in Relay" instead.

**Rejecting** needs a reason, so it opens Relay. People whose Slack account is not linked get a one-time link (valid
10 minutes) to confirm their Relay identity — Relay never matches people by name or email.

## Disconnect

Stops alerts, refuses buttons and **revokes Relay's Slack token** (Slack is the one business app where Relay revokes
at the provider).
