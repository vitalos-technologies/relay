# Billing webhooks and reconciliation

Audience: operators and billing staff. Repo only. Reviewed 2026-11-09 (product 2026-11). Background:
`content/help/developers/webhooks.md`, `docs/v4/*`.

> Current state: no Stripe keys are configured in this environment; billing runs against the labelled local test double
> outside production. Live billing needs Stripe keys, products and prices, the webhook endpoint and
> `BILLING_LIVE_MODE=enabled` (activation checklist). Nothing here creates charges.

**Affected resources:** `billing_webhook_events`, `workspace_billing`, `billing_invoices`, `billing_checkout_sessions`,
`billing_scheduled_actions`, entitlement state and holds (`workspace_entitlement_state`, deliveries with
`entitlement_hold`), the Stripe account.

## Symptoms

- A customer paid but the workspace still shows trial ended, past due or restricted; paid actions are held.
- A cancellation or plan change in Stripe is not reflected in Relay.
- `/admin/platform/billing` shows failed webhook events or provider drift.
- Stripe's dashboard shows webhook delivery failures to `/api/webhooks/stripe`.
- Billing pages say the provider is not configured.

## Diagnostics (READ-ONLY)

1. Provider status: `/admin/platform/billing` (and the billing page's `missing` list) shows whether Stripe, the test
   double or nothing is active. Stripe is active only with both `RELAY_STRIPE_SECRET_KEY` and
   `RELAY_STRIPE_WEBHOOK_SECRET`; a live key additionally needs `BILLING_LIVE_MODE=enabled`.
2. Webhook events:
   ```sql
   SELECT provider_event_id, type, status, attempts, last_error, received_at, next_attempt_at, workspace_id
     FROM billing_webhook_events ORDER BY received_at DESC LIMIT 30;
   SELECT status, count(*) FROM billing_webhook_events GROUP BY status;
   ```
   `failed` rows are retried by the billing sweep every minute with backoff (2^attempts minutes, at most 6 hours apart),
   up to 10 attempts; after that `next_attempt_at` is `infinity` (needs a person).
3. Signature failures are rejected **before** storage, so they appear only in Stripe's dashboard and in logs as
   `401 unauthenticated` on `/api/webhooks/stripe`. Usual cause: wrong or rotated `RELAY_STRIPE_WEBHOOK_SECRET`, or a
   proxy altering the raw body.
4. Workspace record: `/admin/platform/billing/workspaces/<id>` (`GET /api/platform/billing/workspaces/<id>`): state,
   provider references, trial, invoices, scheduled lifecycle actions.
5. Held work: `/admin/platform/workspaces/<id>` (entitlements: plan, usage, held work, overrides).

## Corrective actions

| Cause | Action |
|---|---|
| Event processing failed (transient) | Wait for the sweep, or reconcile now (below). |
| Event failed 10 times | Fix the cause in `last_error`, then reconcile the workspace now. Do not edit `billing_webhook_events` rows. |
| Missed or out-of-order events | **CHANGES DATA** Reconcile now: `/admin/platform/billing/workspaces/<id>` → Reconcile (`POST /api/platform/billing/workspaces/<id>/reconcile`, billing staff). Relay re-fetches the subscription from Stripe and applies current truth. The sweep also re-fetches on its own (every 15 minutes for transitional states, every 6 hours otherwise). |
| Signature verification failing | Correct the secret. While rotating, set the old value as `RELAY_STRIPE_WEBHOOK_SECRET_PREVIOUS`. Then use Stripe's dashboard to resend the failed events; duplicates are acknowledged without re-processing. |
| Paid but still restricted after reconcile | Check the Stripe subscription itself (status, latest invoice). If Relay matches Stripe, the customer must resolve payment in the billing portal. |
| Goodwill or support case | Billing staff may extend an eligible no-card trial (`…/trial`, step-up, audited) or apply a time-limited entitlement override with a reason. Never edit plan state in SQL. |
| Renewal must stop or resume | `…/renewal { cancel, reason }` (billing staff, step-up). |
| Service suspension needed | Schedule it: `…/lifecycle { action: 'suspend', run_at, reason }` (operator, step-up); cancel with `…/lifecycle/<action id>`. |

When access returns, held work is released automatically (entitlement-holds sweep every 5 minutes, or immediately on
the access change). Held deliveries past their deadline expire instead of publishing late.

## Verification

- `billing_webhook_events` for the workspace shows `processed`; the workspace billing record matches Stripe; held
  deliveries move to Scheduled; the customer's billing page shows the right plan and state.

## Escalation

Systematic signature failures, events mapped to the wrong workspace, or any suspicion that a live charge was made
outside the customer's action: stop and escalate to the billing owner and the incident lead. Webhook bodies are kept
90 days for investigation.
