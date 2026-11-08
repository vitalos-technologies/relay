# Trial and subscription lifecycle (V5 §7–8) — V5 view over V4 behaviour

Implementation and full state machine: `docs/v4/BILLING_LIFECYCLE_AND_WEBHOOKS.md` (provider, webhooks, idempotency,
reconciliation) and `docs/v4/FAILED_PAYMENT_AND_DOWNGRADE.md` (what restriction does to work). V5 adds the public entry point
and the presentation; it does not add a second trial or billing path.

## Marketing → trial (the handoff)
1. `/` pricing card → **Start free trial** → `/signup?plan=standard|professional&seats=N` (public; unknown plan falls back to
   Standard on the page and is refused by the API; seats are display-only).
2. **Start free trial on <Plan>** → `/signup/workspace?plan=…`. Without a session: `/login?returnTo=…` → identity provider.
   New visitors register there (local realm: self-registration on, **email verification required** so D20's verified-email
   binding stays safe) and come back to the same step.
3. Create workspace → `createWorkspace` starts the workspace's **one** 14-day no-card trial on the selected plan in the same
   transaction (`billing_trial_redemptions`, exact `started_at` / `ends_at`, whole seconds).
4. Settings → Billing (welcome) shows plan, trial end, billable users and the monthly total after the trial.

A user who already belongs to a workspace is sent to that workspace's Billing (no second trial). Joining a workspace,
switching the trial plan, refreshing, repeating checkout or replaying requests never creates or extends a trial
(`tests/integration/v4-billing.test.ts`, `tests/integration/v5-marketing.test.ts`).

## What the page promises, and where it is enforced
| Page says | Enforced by |
|---|---|
| "14 days free", "No card required" | `TRIAL_DAYS`, `TRIAL_REQUIRES_CARD=false` in the catalogue; trial row created without a provider object |
| Trial allowances are bounded (e.g. 100,000 AI tokens for the whole trial) | `trial_allowances` → entitlement reservations; one bucket for the trial |
| Switching plan during the trial keeps the end date | `changeTrialPlanTx` |
| Subscribing during the trial: first charge on the day the trial ends | Checkout `trial_end` / `billing_cycle_anchor` = trial end |
| At the end without a subscription: paid actions pause, scheduled posts held (never published or deleted); data, billing, support, exports stay | `deriveAccess` → `restricted`; entitlement holds (`FAILED_PAYMENT_AND_DOWNGRADE.md`) |
| Cancel renewal any time; plan runs to the period end; resume before then | `cancelRenewal` / `reactivateRenewal` |
| Seat reductions take effect at the period end; seat increases show the new total first | `previewChange` / `applyChange` (scheduled vs immediate) |
| No overage charges | `AllowanceState.overage = 'none'` |

## Test mode
No Stripe keys exist in this environment: checkout and the customer portal run on the labelled test double ("Test mode · no
real payments"). Live products/prices and webhook configuration are V4 activation items; production self-registration
(with email verification) and `ALLOW_SELF_SERVE_WORKSPACES=true` are V5 activation items.
