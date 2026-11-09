---
title: Invoices and payment details
summary: View invoices, update your card, and handle a payment that needs confirmation or failed.
section: billing-and-plans
audience: admin
roles: [owner, admin]
status: needs-setup
related: [change-plan-or-cancel, when-paid-actions-are-paused]
product_version: "2026-11"
reviewed: 2026-11-09
order: 50
keywords: [invoice, receipt, card, payment method, failed payment, update card, vat]
---

Open **Settings → Workspace → Plan and billing** ([/settings/workspace/billing](/settings/workspace/billing)).

## Invoices

**Invoices** lists each invoice with its amount and status; **View** opens it on the payment provider's page. *No invoices
yet* during a trial. Invoices from a test environment are labelled **Test**.

## Update payment details

Select **Update payment details**. You're taken to the payment provider's secure page; Relay never sees card numbers.
The summary shows **Payment method** (*Not needed for the trial* during a trial).

## When a payment needs attention

| Banner | Meaning | Do this |
|---|---|---|
| *Your bank needs you to confirm a payment* | Strong customer authentication is required. | **Update payment details** and confirm with your bank. |
| Payment failed (past due) | A renewal payment failed. Full access continues for a **7-day grace period**. | Update payment details; the provider retries. |
| *Paid actions are paused* | Grace ended, the trial ended, or the subscription was cancelled. | **Update payment details** or **Choose a plan**. |

**Refresh** re-reads the state from the provider.

## Limitations

- Billing contact details, tax IDs and invoice addresses are managed on the payment provider's page.
- Live payments need the payment provider to be set up for your Relay installation (*Payments not set up* otherwise).
