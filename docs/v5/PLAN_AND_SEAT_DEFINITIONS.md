# Plan and seat definitions (V5 §5–6) — presentation view

The behaviour is V4's and is documented in full in `docs/v4/PLANS_AND_ENTITLEMENTS.md` (catalogue, persisted plan versions,
billable seats, entitlements, allowances). This page states what V5 shows publicly and where each number comes from.

## One catalogue
`packages/core/src/contracts/v4-plans.ts` is the only source. The marketing page (`components/marketing/plan-data.ts`), the
signup handoff, checkout, Settings → Billing, entitlements and Platform → Plans/Billing all read it (directly or through the
immutable persisted plan versions). No price or allowance is written in marketing code; a unit test generates the comparison
from `FEATURES`/`ALLOWANCES` and fails if they drift.

| Plan | Public price | Interval | Trial | Purchasable |
|---|---|---|---|---|
| Standard | £10 per user / month | monthly (GBP) | 14 days, no card | yes |
| Professional | £25 per user / month | monthly (GBP) | 14 days, no card | yes |
| Legacy (pre-V4 workspaces) | — | — | — | no; never shown publicly |

No annual price, no third tier, no "unlimited". Tax: "Any tax is shown at checkout" (no inclusive/exclusive claim until tax is
configured in the provider — activation item in V4).

## Billable user
Active, accepted member including the owner (`billableSeats()`, `services/billing/seats.ts`). Not billable: pending
invitations, Relay support staff present through a support-access grant, service accounts, suspended/removed members, and up
to **5** review-only guests (`GUEST_SEAT_EXEMPTION`). A paid subscription has at least one seat.

## Where seats and totals are shown before anything is bought
| Surface | Shows | Source |
|---|---|---|
| Marketing pricing cards | team-size stepper → *N users · £total / month after the trial* per plan | `recurringTotalMinor(plan, N)` |
| `/signup?plan=…&seats=N` | *N users × £price = £total / month on Plan, after the 14-day trial* (estimate; checkout counts billable users) | same function |
| Settings → Billing (V4) | billable users, paid seats, plan cards with seat stepper and total; change dialog with provider preview | `billingOverview()` |
| Checkout (V4) | seat quantity = max(1, billable users); `recurring_total_minor` | `startCheckout()` |
| Platform → Billing (V4) | paid seats, billable users, plan, status | `platformBillingDetail()` |

Acceptance (§18.7) — `tests/integration/v5-marketing.test.ts`: for 3 Standard users and for 3 Professional users (plus one
pending invitation, not billed) the marketing estimate (£30 / £75) equals Billing's billable seats and total, checkout's
quantity and total, the provider-confirmed state after the test checkout, and Platform admin's seats.

## Plan capabilities shown publicly
Card bullets are the catalogue's `highlights`; the comparison lists every catalogue feature (✓/—) and allowance per billing
month plus the bounded trial allowances. Feature mapping and enforcement points: `docs/v4/PLANS_AND_ENTITLEMENTS.md`
"Features". Capabilities that need provider access are labelled on the page (Connect your tools, Explore previews).
