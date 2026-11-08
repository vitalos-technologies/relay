# V4 implementation gaps (final)

What V4 does **not** do yet, and why. Lead (F4), 2026-11-08. External activation steps are in
`FINAL_ACTIVATION_CHECKLIST.md`; this file lists product/engineering gaps.

## Externally blocked

| Gap | Blocked on | Notes |
|---|---|---|
| No billing flow verified against Stripe | Stripe account + keys (none in this environment, never requested in chat) | Everything runs on the labelled test double; webhooks are verified with Stripe's v1 HMAC scheme on locally signed fixtures; the adapter is unit-tested with stubbed `fetch`. |
| Self-service signup from outside | Keycloak realm has `registrationAllowed: false` | `/signup?plan=…` works for signed-in users and creates the workspace + trial; a brand-new visitor needs registration enabled (or another sign-up path). V5's marketing page depends on this. |
| Malware scanning of support attachments | No scanner configured | Quarantine = allow-list + size + magic-byte check; rejected files are deleted; attachments on internal notes are never served to customers. |
| Real AI summaries/drafts for staff | AI provider key | Honest "AI is not set up" state; category suggestion and related tickets are deterministic and work without AI. |
| Production email for support/billing notices | SMTP sender | In-app notifications work; email rows show `not_configured`. |
| Tax | Stripe Tax / tax settings + copy | Prices are shown as "£10 per user / month" with no inclusive/exclusive claim until tax is configured. |

## Not implemented (product/engineering)

| Gap | Notes | Suggested next step |
|---|---|---|
| Help-article store | Saved replies act as the approved knowledge for staff AI suggestions. | Docs + Help Centre (queue item 9) adds the article store; point AI retrieval at it. |
| Inbound email replies to tickets | Deliberately not claimed: emails carry the reference and a link only. | Needs an authenticated inbound pipeline (threading, attachments, abuse controls). |
| Annual billing | Not offered (V5: monthly only, no invented discount); the catalogue model supports intervals. | Add a plan version per interval when commercially decided. |
| Refund button | Staff use "Refunds in provider" (link); no unverified refund action. | Only if refunds enter the billing scope. |
| `reschedule()` for an over-limit account | Relies on the dispatch-time hold rather than refusing up front. | Add the allowance check to reschedule (small). |
| `ai_workflows` feature | Defined in the catalogue; nothing to gate until V5's AI workspace. | V5 gates its multi-step runs with it. |
| Staff AI usage | Not charged to the customer's AI budget; rate-limited per staff member and recorded in the platform audit. | Decision recorded; revisit if staff AI becomes costly. |
| Workspace closure/deletion flow | Not in the V4 brief's scope; suspension ≠ cancellation is implemented and documented. | Tenant offboarding runbook + export-then-delete flow later. |
| Flaky integration test | `v31-analytics-summary` (pre-V4) occasionally fails under full-suite load and passes alone. | Investigate the time-window assumption in that test. |
