---
title: Add or remove seats
summary: See how many people are billed, add seats before inviting more people, and reduce seats from the next period.
section: billing-and-plans
audience: admin
roles: [owner, admin]
status: needs-setup
related: [plans-and-features, change-plan-or-cancel, invite-people, invoices-and-payment-details]
product_version: "2026-11"
reviewed: 2026-11-09
order: 30
keywords: [seats, users, licences, add users, billable users, per user]
---

**Required:** `billing.manage` (Owner, Admin) with two-step verification — *Billing changes need two-step verification.*
Others with `billing.read` can view; *Only people who manage billing can make changes.*

## See who is billed

**Settings → Workspace → Plan and billing** ([/settings/workspace/billing](/settings/workspace/billing)) → **People**:

- **Billable users** — active members, including you.
- **Free guests** (for example *1 (up to 5)*) or **Guests over the free limit** — review-only guests beyond five are billed.
- **Pending invitations** — not billed until accepted.
- **Relay support (not billed)** — support staff present through an approved support-access request.

*All paid seats are in use. Add seats with "Change plan or seats" before inviting more people.*

## Change seats

1. Select **Change plan or seats**.
2. Use **More seats** / **Fewer seats**. Relay asks the payment provider for a preview: **New monthly total**, **From
   <date>**, **Prorated now** and **Next invoice**.
3. Select **Confirm change** (increase, applies now with a prorated charge) or **Schedule change** (decrease, applies at
   the period end).
4. **Result:** *Plan updated* or *Change scheduled*. **Keep current plan** removes a scheduled change.

## Limitations

- A paid subscription has at least one seat.
- Removing a member doesn't reduce seats automatically; reduce seats yourself.
- Live payments need the payment provider to be set up for your Relay installation. Otherwise you see **Payments not set
  up**, or **Test mode · no real payments** where a test environment is used.
