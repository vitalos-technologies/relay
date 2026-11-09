---
title: Answer WhatsApp messages in the inbox
summary: Connect a WhatsApp Business number, reply inside the 24-hour customer service window, send approved templates outside it, and see Meta's per-message charges before sending.
section: inbox-and-care
audience: user
roles: [owner, admin, care_agent]
status: needs-provider-approval
related: [inbox-channels-by-network, business-apps-overview]
product_version: "2026-11"
reviewed: 2026-11-09
order: 30
keywords: [whatsapp, waba, template, 24 hour window, customer service window, charges, pricing, per message]
sources:
  - title: "WhatsApp Business Platform pricing (per-message pricing, service window, 2026 changes)"
    url: https://developers.facebook.com/docs/whatsapp/pricing
    verified: 2026-11-09
---

## Before you start

- A **WhatsApp Business Account** with a registered phone number, **Meta Business verification**, and a payment method
  on the account. Message templates you want to use must be approved by Meta.
- An Owner or Admin connects it in **Settings → Inbox → Channels** ([/settings](/settings)) → WhatsApp: enter the
  WhatsApp Business Account ID, the phone number ID and a Meta system-user access token (stored encrypted). Relay
  verifies the number with Meta before saving. Each phone number becomes one inbox channel. **⋯ → Templates and
  charges…** lists the approved templates and lets you enter an optional rate card for charge estimates.

> **Important:** Built and tested against a simulated WhatsApp API only. Live use needs the account above; no messages
> have been sent through a real number.

## Meta's rules (verified 2026-11-09)

- **Per-message pricing since 1 July 2025:** Meta charges for delivered messages you send, by message category
  (marketing, utility, authentication, service) and the recipient's country code.
- **Customer service window:** 24 hours from the customer's last message. Free-form (non-template) replies are only
  possible inside it; outside it you must use an approved template.
- **Service messages:** from 1 October 2026 each business number gets **1,000 free service messages per month**.
- **Utility templates inside the window:** free from 1 July 2025 until Meta **resumed charging on 1 October 2026**.
- Businesses without a payment method by 30 September 2026 may have service message delivery stopped.

## Replying

1. Open the conversation in **Inbox**. The composer shows whether the 24-hour window is open.
2. **Inside the window:** type a reply and send.
3. **Outside the window:** choose an approved **template** and fill in its parameters.
4. If the message is chargeable, Relay shows the charge first (category and, if the owner entered a rate card for the
   channel, an estimate) and asks you to **acknowledge the charge** before sending. The server re-checks this.
5. After sending, the price Meta reports for the message is stored and shown on it; failures reported later by Meta
   appear on the message too.

> **Warning:** Relay currently treats a **utility template sent inside an open window as free** and does not ask for
> charge acknowledgement in that case. Meta resumed charging for these on 1 October 2026. Until Relay is updated,
> assume utility templates are charged.

## When a send's result is lost

WhatsApp has no lookup API. Relay tags each send and waits for Meta's status notification carrying that tag; it never
sends again automatically.

## Limitations

- No message history before the channel was connected (webhooks only).
- Templates are created and approved in Meta's tools; Relay refreshes and uses them.
