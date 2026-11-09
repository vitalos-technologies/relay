---
title: Create Mailchimp campaign drafts from approved posts
summary: Connect Mailchimp, select audiences, turn an approved, scheduled post into a Mailchimp campaign draft, and see its status and report — Relay never sends or touches audience members.
section: business-apps
audience: user
roles: [owner, admin, brand_manager, publisher]
status: needs-setup
related: [business-apps-overview, other-metrics-in-relay]
product_version: "2026-11"
reviewed: 2026-11-09
order: 60
keywords: [mailchimp, email, campaign, draft, audience, newsletter]
sources:
  - title: "Mailchimp — Sync audience data with webhooks (security, retries)"
    url: https://mailchimp.com/developer/marketing/guides/sync-audience-data-webhooks/
    verified: 2026-11-09
---

## Before you start

The workspace owner registers a Mailchimp OAuth app in **Setup**. Mailchimp's access is account-wide (Mailchimp has no
granular permissions — the hub says so before you connect). Relay's own client refuses Mailchimp's send, schedule,
test-email and audience-member endpoints, so it **cannot** send email or change subscribers.

## Connect

**Connections → Business apps → Mailchimp** ([/integrations](/integrations)) → **Connect** → approve. Select
**Audiences** (and optionally existing **Campaigns** to link) under **Resources**.

## Create a draft

1. Open a post that has passed approval and is scheduled.
2. Composer → **Integrations** card → **Mailchimp** → **Create email draft**.
3. The preview says that nobody is subscribed and nothing is sent. Relay re-runs the approval check for that schedule.
4. The draft appears in Mailchimp; finish and send it **in Mailchimp**. One draft per post.

You can also link a Relay campaign to an existing Mailchimp campaign.

## Status and report

**Refresh** fetches the campaign status and, once sent, Mailchimp's report: **emails sent**, **opens** (unique opens),
**clicks** (unique subscriber clicks) — see [Other metrics in Relay](/help/analytics/other-metrics-in-relay).
Unsubscribes and suppression stay authoritative in Mailchimp; audience webhooks are recorded only (verified by a URL
key or Mailchimp's optional signature).

## Disconnect

Deletes Relay's token; links become unavailable; drafts stay in Mailchimp. Automation cannot create Mailchimp drafts.
