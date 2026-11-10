# Billing lifecycle and webhook design (V4 §9–11; V5 §8)

Stream BIL (D33 Free plan: stream PL). Code: `packages/services/src/billing/*`, `packages/providers/src/stripe/*`, migrations
`035_v4_billing.sql`, `040_free_plan.sql`.

## Free plan: no provider objects (D33)
A workspace on **Free** has **no** provider customer, subscription, checkout session, price, invoice or charge — ever. Its
`workspace_billing` row says `status = 'free'`, `plan_id = 'free'`, `seats = 0` and points at the current Free plan version
(£0, `purchasable = false`, no `billing_provider_prices` row). Checkout and trials refuse `plan: 'free'`; the customer
portal is not offered on Free. Code: `billing/free.ts` (`startFreeTx`, `moveToFreeTx`). A former subscriber that dropped to
Free keeps its provider references as history (a later checkout reuses the same provider customer) and its past invoices
stay listed. **No Stripe product or price is created for Free** (activation checklist).

## Provider
- **Stripe Billing**, hosted flows only: Checkout (`mode=subscription`, one line item = plan price × seat quantity) and the
  Customer Portal (payment method update, cancellation). Relay never sees or stores card numbers or security codes; it keeps a
  payment-method summary (brand, last 4, expiry) from the provider.
- Behind `BillingProvider` (`providers/stripe/types.ts`). Implementations: `StripeBillingProvider` (plain `fetch`, form
  encoding, `Idempotency-Key` on every mutation, pinned `Stripe-Version` `2026-10-28.endive`, override `RELAY_STRIPE_API_VERSION`;
  no SDK — a dozen calls do not justify a dependency in both web and worker bundles) and `TestBillingProvider` (deterministic
  test double; Stripe-shaped objects in `billing_test_objects`, so the same normalisers run).
- Selection (`billing/provider.ts`): `RELAY_STRIPE_SECRET_KEY` + `RELAY_STRIPE_WEBHOOK_SECRET` → Stripe (Relay-namespaced on purpose: a generic `STRIPE_SECRET_KEY` on a shared host may belong to another project and is ignored); a live key additionally needs
  `BILLING_LIVE_MODE=enabled` (explicit activation). Otherwise, outside production with mock providers enabled → test double
  (every surface labelled "Test mode · no real payments"). Otherwise → not configured: stored state is shown, checkout/portal
  answer `provider_not_configured`. **There are no Stripe keys in this environment; everything was verified with the test
  double and locally signed fixtures. Live mode is an activation item.**

## State dimensions (kept separate)
| Dimension | Values | Set by |
|---|---|---|
| Billing status | `free`, `trialing`, `active`, `payment_action_required`, `past_due`, `cancel_scheduled`, `cancelled`, `expired`, `incomplete`, `none`, `legacy` | provider-verified state + the local trial (`policy.ts deriveStatus`); `cancelled`/`expired` are persisted as `free` (D33) |
| Service state | `workspaces.state` = `active` / `suspended` | Relay operators only (Platform), never billing |
| Access level | `full` / `restricted` / `suspended` | derived (`policy.ts deriveAccess`) from the two above **and the clock** |

`getBillingState(db, workspaceId)` (`billing/state.ts`) is the contract ENT consumes (`core/contracts/v4-billing.ts`). It
derives access on read, so a grace period that passed before the sweep ran is already restricted, and a trial or
cancellation date that passed already reads as **Free** (`deriveAccess().free` → `plan_id 'free'`, `status 'free'`, access
`full`; an `incomplete` first payment keeps its status with Free's plan). A scheduled downgrade / seat reduction takes over at
its effective instant on read as well.

Provider status → billing status: `trialing`→trialing (or cancel_scheduled when cancelling); `active`→active
(payment_action_required when the open invoice needs authentication; cancel_scheduled when cancelling); `past_due`/`unpaid`
→past_due (or payment_action_required); `incomplete`→incomplete (trialing while the no-card trial still runs);
`incomplete_expired`→back to the local trial state; `paused`→expired (reads as Free); `canceled`→cancelled, persisted as
**free** (trialing while the no-card trial still runs — the promised free period is never cut, never extended).

## Transitions (documented; `policy.ts TRANSITIONS`)
| Trigger | From → To | Effect |
|---|---|---|
| Signup / onboarding on Free | none → free | `free_started` lifecycle event; no provider objects |
| Start trial (signup / Settings) | none / free (never redeemed) → trialing | redemption row; `billing.trial_started` |
| Verified checkout from Free, trial never used | free → trialing (provider trial 14 days) | redemption recorded when the provider confirms; first charge = trial end; activated event |
| Verified checkout (no trial left) | free / expired / cancelled / none / legacy → active | `billing.subscription_activated` |
| Verified checkout during the trial | trialing → trialing (provider trial to the same end) | first charge = trial end; activated event |
| First payment declined | → incomplete (Free's plan applies unless the trial still runs) | — |
| Trial expiry (no subscription) | trialing → **free** | `billing.trial_expired` + `billing.subscription_changed` (ENT holds what is over Free's limits); notice 3 days before (`billing.trial_ending`) |
| Renewal | active → active | invoice cached; period moves |
| Failed payment | active → past_due | grace 7 days (`PAST_DUE_GRACE_DAYS`), then restricted; `billing.payment_failed` |
| Authentication requested | active/past_due → payment_action_required | same grace |
| Payment recovery | past_due / payment_action_required → active | grace cleared; `billing.payment_recovered` |
| Upgrade / seat increase | active → active | immediate, `proration_behavior=create_prorations`, previewed `proration_date` |
| Downgrade / seat reduction | active → active (scheduled) | provider updated with `proration_behavior=none`; Relay keeps current plan/seats until period end; `billing.subscription_changed` |
| Cancel renewal | active/trialing → cancel_scheduled | service until period end; `billing.cancellation_scheduled` |
| Reactivate | cancel_scheduled → active/trialing | `billing.subscription_changed` |
| Period end after cancel ("downgrade to Free") | cancel_scheduled → **free** | nothing deleted; `billing.subscription_ended` + `billing.subscription_changed` |
| Grace exhausted | (status unchanged) | sweep persists `restricted`; `billing.access_changed` |

Every derived access change writes `billing.access_changed` to the outbox (ENT re-evaluates held work). An undocumented
transition is still applied (provider truth wins) and logged `billing_undocumented_transition`. Every change appends to
`billing_lifecycle_events` (append-only for app roles) with source (`user` / `staff` / `webhook` / `reconcile` / `system` /
`signup` / `migration`), actor and provider event id.

## Webhooks — `POST /api/webhooks/stripe`
1. **Verify** `Stripe-Signature` exactly per Stripe's manual-verification steps (checked 2026-11-08): split on `,` and `=`,
   take `t` and every `v1` (ignore `v0` and other schemes to prevent downgrade), `signed_payload = t + "." + raw body`,
   HMAC-SHA256 with the endpoint secret, constant-time compare against each `v1`, reject timestamps outside **300 s**
   (zero tolerance refused). Current + previous secret accepted (`RELAY_STRIPE_WEBHOOK_SECRET_PREVIOUS`) for rotation. Failures →
   `400`, nothing stored. Raw body read with `req.text()`; 1 MB limit.
2. **Store** in `billing_webhook_events` — `UNIQUE (provider, provider_event_id)`; duplicates are acknowledged (`200`,
   `duplicate: true`) and not re-processed. Events of types we don't handle, or of the other mode (test vs live), are stored
   as `ignored`.
3. **Process** (inline, never trusting the payload's object): map the object to a workspace through **our stored provider
   references** (subscription → customer); metadata (`relay_workspace_id`) only when the customer matches the one Relay
   created for that workspace. **Re-fetch** the checkout session / subscription / invoice from the provider and apply it
   (`sync.ts`). Because the provider's *current* object is applied, duplicate and out-of-order delivery (Stripe guarantees no
   order; `created` is in seconds) converge on the same state; re-applying is a no-op.
4. **Failures** (provider unreachable, etc.) → `failed`, retried by the worker with exponential backoff up to 10 attempts;
   the endpoint still returns `200` once stored (we own the retry). Staff see failures on the Platform billing panel.

Guards in `applySubscription`: a subscription whose customer is not the workspace's customer is ignored; a **second live
subscription** never replaces a live one (recorded as `duplicate_subscription` and shown to staff with a "cancel in provider"
banner); one open checkout per workspace (partial unique index) prevents it in the first place.

Handled events: `checkout.session.completed|expired|async_payment_*`, `customer.subscription.created|updated|deleted|paused|resumed|trial_will_end|pending_update_applied`,
`invoice.paid|payment_succeeded|payment_failed|payment_action_required|finalized|voided|marked_uncollectible`,
`customer.updated`, `payment_method.attached`. Configure exactly these on the Stripe endpoint (activation item).

## A success redirect is never evidence
Checkout's `success_url` returns to Settings → Billing (`?checkout=returned&session={CHECKOUT_SESSION_ID}`). The page shows
"Confirming with the payment provider…" and calls `POST /api/billing/refresh`, which **re-fetches** this workspace's open
checkout sessions and subscription from the provider (the session id in the URL is ignored). Only provider state activates
a plan. Tests: forged redirect, unsigned event, wrong secret, stale timestamp, and a validly signed event whose object does
not exist at the provider — none activate (`tests/integration/v4-billing.test.ts`, §18.9).

## Idempotency and concurrency
- Checkout: session-level advisory lock per workspace (`pg_try_advisory_lock`, held across the provider call) + one
  `pending|open` checkout row per workspace (unique index) + provider `Idempotency-Key = relay-checkout-<row id>`. Repeated
  clicks get the same hosted URL; a live subscription refuses a new checkout.
- Plan/seat changes, cancel, reactivate: same lock + optimistic `expected_version` (the billing row version the customer
  saw) + provider idempotency key derived from the request's `Idempotency-Key`.
- Customer creation: `relay-customer-<provider>-<workspace>` idempotency key; one customer per workspace and provider.
- A scheduled change is recorded **before** the provider update, so a webhook for that update that arrives before our
  transaction commits already keeps current entitlements.

## Reconciliation (worker, every minute — `reconcile.ts`)
Retries stored events; expires no-card trials and emits the 3-day notice once; expires abandoned checkout reservations;
re-fetches subscriptions from the provider (transitional states and due scheduled changes every 15 min, everything else every
6 h; open checkouts older than 10 min) — catching any event the provider never delivered; persists clock-driven access
changes (grace end, cancellation date); runs staff-scheduled suspensions; purges stored webhook bodies after 90 days.

## Notifications
`billing.trial_ending` (in-app), `billing.trial_expired` and `billing.payment_failed` (in-app + email when SMTP is configured
and preferences allow), `billing.payment_recovered`, `billing.cancellation_scheduled`, `billing.subscription_ended`,
`billing.subscription_activated` (in-app) to the workspace's owners/admins (billing managers). Deduplicated per user and
state; no amounts or card details in messages; link to Settings → Billing.

## Customer surfaces
Settings → Workspace → **Plan and billing** (`billing.read` to view, `billing.manage` to act; sensitive ⇒ MFA by workspace
policy): plan, status, trial/renewal/first-charge date, seats and billable users, monthly total, payment-method summary,
scheduled change, invoices (provider links), plan cards with seat stepper and total, change dialog with provider preview
(price, timing, proration), update payment details (portal), "Downgrade to Free" (= cancel renewal; effects listed), resume
renewal. On Free: price £0, users (Free includes 1), "Upgrade" plan cards for Standard/Professional ("Start free trial" while
the trial is unused, otherwise checkout straight to paid; `upgrade_trial_days` in the overview), no portal, no invoices unless
earlier ones exist. Billing stays reachable while access is restricted (and it is never gated by entitlements).

## Retention
`billing_lifecycle_events` and `billing_trial_redemptions` are kept for the life of the workspace (append-only / no delete for
app roles). Provider references and cached invoices are kept with the workspace. Stored webhook bodies are purged after 90
days (event id, type, status and timestamps stay). No legal retention certification is claimed.
