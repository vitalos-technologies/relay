---
title: Upgrade, downgrade, cancel or resume
summary: Move between Standard and Professional, cancel renewal, resume it, and know when each change takes effect.
section: billing-and-plans
audience: admin
roles: [owner, admin]
status: needs-setup
related: [plans-and-features, manage-seats, when-paid-actions-are-paused, invoices-and-payment-details]
product_version: "2026-11"
reviewed: 2026-11-09
order: 40
keywords: [upgrade, downgrade, cancel subscription, resume, change plan, switch plan]
---

**Required:** `billing.manage` (Owner, Admin) with two-step verification. Open **Settings → Workspace → Plan and billing**
([/settings/workspace/billing](/settings/workspace/billing)).

## Subscribe (from a trial or a restricted workspace)

1. Select **Choose a plan** (or the plan card's button) and set the seats.
2. **Continue to checkout**. *Payment is collected on the provider's secure page. Relay never sees your card.*
3. Back in Relay you may see *Confirming with the payment provider…*; the plan updates once payment is confirmed. *Not
   confirmed yet* means wait a few minutes. *Checkout cancelled — Nothing was charged.*

During a trial, the first charge is on the day the trial ends.

## Upgrade or downgrade

1. **Change plan or seats** → pick the **Plan**.
2. Check the preview and confirm.

| Change | Takes effect |
|---|---|
| Standard → Professional | Immediately, with a prorated charge. |
| Professional → Standard | At the **end of the period**; until then you keep Professional. |
| Seats up | Immediately (prorated). |
| Seats down | End of the period. |

**After a downgrade:** configuration for Professional-only features is **kept and readable**, but you can't create new
ones (automations, saved searches, saved reports, service-level targets, business-app jobs); automations are blocked,
listening stops matching, business apps and MCP write tools are held. Existing two-stage approval policies **stay in
force**, but a second stage can't be added.

## Cancel renewal

1. Select **Cancel renewal** → **Cancel renewal?**
2. Read the consequences: until the period ends nothing changes. *After that, publishing, AI and other paid actions pause.
   Scheduled posts are held, not deleted. Your content, settings and exports are kept. You can resume or resubscribe any time.*
3. Confirm. **Result:** *Renewal cancelled*; the page shows **Service ends** with the date.

**Resume renewal** before that date undoes it (*Renewal resumed*).

## Limitations

- Monthly billing only; no annual plans.
- Cancelling never deletes the workspace. Closing a workspace is a separate request to Relay support.
