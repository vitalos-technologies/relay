---
title: Use listening alerts and dashboards
summary: Get told about mention spikes with the evidence behind them, and build dashboards for your own or your team's use.
section: listening
audience: user
roles: [owner, admin, brand_manager, editor, analyst]
status: not-live-verified
related: [set-up-listening, read-listening-results, notifications-and-preferences]
product_version: "2026-11"
reviewed: 2026-11-09
order: 30
keywords: [alert, spike, notification, dashboard, widget, listening alert]
---

## Alerts

Alert rules (set up by people with `listening.manage`) fire on a **Mention spike** or **Negative mention spike**: the count
in a window must reach a minimum sample and be clearly above the usual level of the previous monitored days.

When one fires, recipients (by default the rule's creator) get a notification under **Account health**. Open the alert
(**Open alerts** on Listening) to see:

- **In window**, **Usual**, **Threshold** and the **Minimum sample**.
- **Mentions counted (N)** — the exact evidence; mentions since removed at the source are shown as removed.
- **Coverage at fire time**.
- Actions: **Acknowledge**, **Dismiss**, **Reopen**, and **Act on it** → **Create task** / **Create content draft**.

## Dashboards

1. On **Listening**, under **Dashboards**, create a **New dashboard**: **Name**, **Brand**, and **Shared with the team**
   (off = *Only you*).
2. Add widgets (**Mentions over time**, **Share of voice**, **Latest mentions**, sentiment and topics, alerts), each with
   its **Searches** and **Period**.
3. **Save**. **Edit** or **Delete** later.

## Limitations

- Alerts and dashboards use only monitored connected channels (see [Set up listening](/help/listening/set-up-listening)).
- While paid actions are paused, mentions are still stored but not matched and no alerts fire; matching catches up later.
