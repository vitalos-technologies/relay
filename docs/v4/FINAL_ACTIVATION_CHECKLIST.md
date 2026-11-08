# V4 activation checklist

Only genuinely remaining external steps. Everything listed under "Built" in the stream reports works today in test mode
(billing) or with local services (support, entitlements). Consolidated into the final Relay checklist after Docs + Help
Centre. Never paste keys into chat: use the deployment secret manager.

## Billing (Stripe)
1. Stripe account; set `RELAY_STRIPE_SECRET_KEY` (start with a **test** key). Relay ignores the generic
   `STRIPE_SECRET_KEY` name on purpose.
2. Webhook endpoint `<APP_BASE_URL>/api/webhooks/stripe` subscribed to the events listed in
   `BILLING_LIFECYCLE_AND_WEBHOOKS.md`; set `RELAY_STRIPE_WEBHOOK_SECRET` (and `RELAY_STRIPE_WEBHOOK_SECRET_PREVIOUS`
   during rotation).
3. Create two Products with monthly per-unit **GBP** prices: Standard £10, Professional £25. Map the price ids to the plan
   versions in Platform → Plans.
4. Customer Portal configuration: payment-method update, cancel at period end, invoices; plan switching stays in Relay.
5. Tax settings (and the matching price copy) if tax is to be collected.
6. Live mode only after test-mode verification: `sk_live_…` key **and** `BILLING_LIVE_MODE=enabled`.
7. Decisions to confirm: final per-plan allowances (defaults in `packages/core/src/contracts/v4-plans.ts`), past-due grace
   (7 days, `PAST_DUE_GRACE_DAYS`), trial-ending notice (3 days), free guests (5 per workspace).

## Sign-up
8. Enable Keycloak self-registration (realm `registrationAllowed`) or provide another sign-up path, so a new visitor can
   reach `/signup?plan=…` (needed by V5's marketing page).

## Support
9. Assign support staff: `pnpm platform:operator` with role `support` (and `billing` for billing staff; `operator` for
   full platform access). Privileged actions require MFA step-up.
10. SMTP sender (`SMTP_URL`, `EMAIL_FROM`) for support and billing emails.
11. AI provider key (Setup) for staff ticket summaries and draft replies (optional).
12. Malware scanning for attachments, if required by policy (none configured; validation-only quarantine).
13. Customer-facing policy text: billing terms, cancellation, refund handling, support retention (resolved tickets archive
    after 30 days, purge 730 days after archive — see `SUPPORT_VISIBILITY_MATRIX.md`).

## Deploy
14. Run migrations 034–036 (`pnpm db:migrate`, then `pnpm db:roles` for the append-only grants) and restart the worker
    (new sweeps: `billing-sweep`, `support-sweeps`, `entitlement-holds`).
