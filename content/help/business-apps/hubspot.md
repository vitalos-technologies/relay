---
title: Use HubSpot contacts and tickets in the inbox
summary: Connect HubSpot, search contacts, link a contact to an inbox customer, create one HubSpot ticket per case and add approved notes — without ever inferring marketing consent.
section: business-apps
audience: user
roles: [owner, admin, brand_manager, care_agent]
status: needs-setup
related: [business-apps-overview, inbox-channels-by-network, asana]
product_version: "2026-11"
reviewed: 2026-11-09
order: 40
keywords: [hubspot, crm, contact, ticket, case, service hub, note, webhook]
sources:
  - title: "HubSpot — Validating webhook requests (v3 signature, 5-minute window)"
    url: https://developers.hubspot.com/docs/api/webhooks/validating-requests
    verified: 2026-11-09
---

## Before you start

- The workspace owner registers a HubSpot app (OAuth) in **Setup**.
- Relay requests `crm.objects.contacts.read`, `crm.objects.companies.read`, `tickets`, `crm.objects.owners.read`.
- Tickets need a HubSpot portal with **Service Hub** (as HubSpot sells it).

## Connect

**Connections → Business apps → HubSpot** ([/integrations](/integrations)) → **Connect** → approve. Under **Resources**
select the **Ticket pipelines** and **Owners** to use, and set ticket defaults (pipeline, stage) in **Settings**.

## In the inbox

Inbox → conversation → customer panel → **External work**:

| Action | Who | What happens |
|---|---|---|
| Search contacts | Inbox access | Exact email or text search; emails are shown masked |
| Link contact ↔ customer | Case management | Explicit, audited and reversible. It says **nothing** about marketing consent |
| Create ticket | Case management | One ticket per case: subject, priority and stage set once at creation; owner chosen explicitly; the linked contact is associated |
| Add note | Case management | Adds an approved summary as a ticket note; exactly the text shown, once per distinct text |

The ticket's current stage and owner are shown in Relay from HubSpot. HubSpot never changes the Relay case state.

## Sync and verification

HubSpot sends events to Relay signed with the app's client secret (v3 signature, requests older than 5 minutes
refused). Deleting a ticket or contact in HubSpot, or revoking access, marks the link unavailable; Relay records stay.

## Disconnect

Deletes Relay's tokens and marks links unavailable. Uninstall the app in HubSpot to revoke it there.
