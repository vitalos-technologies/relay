# Plans and entitlement definitions (V4 §9, §12; V5 §6–7)

<!-- BIL: catalogue, plan versions, seats and the migration of existing workspaces go above the Entitlements section. -->

## Catalogue (stream BIL)

**Single source:** `packages/core/src/contracts/v4-plans.ts`. Marketing (V5), the signup handoff, checkout, Settings →
Billing, entitlements and Platform admin all read it (directly, or through the persisted versions seeded from it).

| Plan | Price | Interval | Trial | Purchasable |
|---|---|---|---|---|
| Standard | **£10 per billable user** | monthly | 14 days, no card | yes |
| Professional | **£25 per billable user** | monthly | 14 days, no card | yes |
| Legacy | no price | — | — | no (pre-V4 workspaces only) |

Examples: 3 Standard users = £30 / month; 3 Professional users = £75 / month. Currency GBP. No annual option (V5: no
invented annual discount; the model supports intervals). Tax: prices are shown as configured in the provider's checkout —
Relay does not claim tax-inclusive or tax-exclusive pricing (activation item: configure tax in Stripe and the copy with it).

### Persisted plan versions (`035_v4_billing.sql`)
- `billing_plans` → `billing_plan_versions` (**immutable**: a trigger refuses any change except retiring a version, and
  refuses deletes) → `billing_provider_prices` (provider price id per version and mode).
- A subscription is bound to the version it was bought at (`workspace_billing.plan_version_id`). Editing the catalogue file or
  a label never reprices anyone: Platform → Plans shows **"Catalogue changed"** when the file's canonical hash differs from the
  current version, and an operator publishes a **new** version (the previous one is retired for *new* purchases only).
- Provider prices: the test double's prices (`price_test_<plan>_v<n>`) are seeded/created automatically. Stripe price ids are
  mapped by billing staff in Platform → Plans → "Map Stripe price" (step-up, audited) after creating the price in Stripe with
  the same amount, GBP, monthly, per unit — **activation item**. Without a mapping, checkout refuses with
  `provider_not_configured` (never a fake success).

### Billable seats (V5 §5) — `billableSeats(db, workspaceId)` in `services/billing/seats.ts`
One function used by checkout, Settings → Billing, Platform admin, webhooks and the invite/accept checks.

| Counted | Not counted |
|---|---|
| Owner and every **active, accepted** member | Pending invitations |
| Guests beyond the free-guest cap | Relay staff present only through an active support-access grant |
| | Service accounts (not memberships) |
| | Suspended or removed members; accounts disabled by Relay |
| | Guests holding **only** the `guest` preset, up to **5** per workspace (`GUEST_SEAT_EXEMPTION`) |

- A paid subscription carries `max(1, billable users)` seats at least (checkout quantity; seat reductions can't go lower).
- **Seat increases** happen only in Settings → Billing → "Change plan or seats" (`billing.manage`): the dialog shows the new
  seat count, the new monthly total and the provider's prorated amount **before** confirming. Applied immediately with
  proration on the next invoice.
- **Seat reductions** are scheduled for the period end (current seats kept until then).
- **Invitations** (only while a paid subscription exists): pending member invitations reserve seats; when no paid seat is free
  the invitation is refused with "All N paid seats are in use. Add a seat in Billing (£X per user / month), then invite." —
  Relay never adds paid seats silently. Acceptance re-checks (seats may have been reduced meanwhile). During a no-card trial
  there is no seat limit (the trial is time-bounded; checkout then counts everyone).

### Trials (V5 §7)
- 14 days, **no card**, on the selected plan's features with the plan's bounded `trial_allowances` (never "unlimited").
- **Once per workspace, ever:** `billing_trial_redemptions` (primary key = workspace) records the redeeming user, source
  (`signup` / `onboarding` / `settings`) and exact `started_at` / `ends_at` (whole seconds, server time). Joining a workspace,
  switching the trial plan, refreshing, repeating checkout or replaying a request never creates or extends a trial (trigger:
  the row can only be *extended*, never moved back or deleted).
- Started server-side in the same transaction as workspace creation (`createWorkspace` → `startTrialTx`): the signup handoff
  passes the selected plan; the plain onboarding flow defaults to **Standard** (switchable during the trial without changing
  the end date).
- Subscribing during the trial keeps the free period: Checkout `subscription_data.trial_end` = trial end (Stripe requires
  ≥ 48 h ahead); inside the last 48 h `billing_cycle_anchor` = trial end with no proration. The first charge date is shown in
  checkout and in Settings → Billing.
- Staff may extend an **eligible** trial (no-card, running or expired, not subscribed): ≤ 30 days per extension, ≤ 3
  extensions, reason + step-up + both audits.
- Expiry without a subscription → `expired` → access `restricted` (policy: `FAILED_PAYMENT_AND_DOWNGRADE.md`). A notice is
  sent 3 days before the end (in-app) and at the end (in-app + email when configured).

### Migration of existing workspaces
Migration `035_v4_billing.sql` gives **every workspace that exists when it runs** the `legacy` plan (`status = legacy`):
Professional features, no price, nothing metered by plan (existing workspace budgets still apply), full access, no trial, no
provider record. A `legacy_assigned` lifecycle event records it. Workspaces created later **outside** the product signup
path (seed/CLI scripts, tests) have no billing row and are read the same way (legacy). Legacy workspaces are never billed or
restricted by billing; an owner may move to a paid plan voluntarily (Settings → Billing → Choose a plan → checkout; no trial).

### Selected-plan signup handoff (for V5's marketing page)
`/signup?plan=standard|professional` (public) → "Start free trial" → `/signup/workspace?plan=…` (sign in or register at the
identity provider first) → create the workspace → trial starts on that plan → Settings → Billing (welcome banner). The plan in
the URL only picks which public plan to trial; unknown values fall back to Standard on the page and are refused by the API.
A user who already belongs to a workspace is sent to that workspace's Billing (no second trial). Public catalogue JSON:
`GET /api/billing/catalogue`.



## Entitlements (stream ENT)

One shared entitlement service — `packages/services/src/entitlements/` — answers "may this workspace do X now, and how
much is left" for the app, admin, API routes, workers, MCP, AI actions and integrations. Contract:
`packages/core/src/contracts/v4-entitlements.ts`. Policy for restricted access: `FAILED_PAYMENT_AND_DOWNGRADE.md`.

### Where the answer comes from (layering)
1. **Billing facts** — only `getBillingState()` (billing stream): plan, trial, seats, period, access level + reason.
   Nothing a client sends (plan name, flag, header) grants anything.
2. **Plan definition** — `v4-plans.ts`: features and allowances (`base + per_seat × seats`; trial allowances during a
   trial). `legacy` (every pre-V4 workspace) = Professional features, nothing metered by plan, full access.
3. **Platform overrides** — audited (platform + workspace audit), reason ≥ 10 characters, optional expiry (required and
   ≤ 30 days for temporary full access), operator or billing staff with a fresh MFA sign-in; support staff can read only.
   Scopes: one feature on/off, one allowance limit (or unmetered), temporary full access (never lifts a suspension). A
   feature granted by override comes with the Professional default allowance for that feature unless an allowance
   override says otherwise. Expired overrides stop applying without a job.
4. **Customer budgets** — Settings/Admin → Usage → Your budgets (`workspaces.limits`, team budgets). They can only
   **lower** a plan allowance: enforced limit = min(customer budget, plan allowance). Without a plan ceiling (legacy) the
   pre-V4 behaviour is unchanged (including the 200,000-token AI safety default).

### Features (plan capabilities)
| Feature | Standard | Professional | Enforced at |
|---|---|---|---|
| Publishing and scheduling | ✓ | ✓ | schedule / publish-now (service), dispatch + send gate (worker), X writes (meter) |
| Media library | ✓ | ✓ | upload intents / URL imports (storage reservation) |
| Team collaboration | ✓ | ✓ | — (never restricted) |
| Standard analytics | ✓ | ✓ | — |
| Social inbox | ✓ | ✓ | reply request (service) + reply dispatch (worker) |
| AI drafting | ✓ | ✓ | AI reservations (`ai.tokens`), assistant run requests and worker runs |
| In-app support | ✓ | ✓ | always available, never restricted |
| Advanced analytics and reports | | ✓ | saving analytics reports |
| Listening | | ✓ | saved-search creation (+ active-search allowance), matching at ingestion |
| Multi-step approvals | | ✓ | adding a second review stage (existing ones stay in force) |
| Advanced customer care | | ✓ | service-level policies |
| AI workflows | | ✓ | (V5 AI workspace; flag ready) |
| Automations | | ✓ | rule/policy creation + activation, every rule run (worker) |
| Business integrations | | ✓ | sync-job enqueue, sync-job run (worker), Google posts, Slack deliveries |
| MCP access | | ✓ | every MCP tool call and resource read |

### Allowances
| Allowance | Meter | Standard (per period) | Professional | Trial | Notes |
|---|---|---|---|---|---|
| AI tokens | `ai.tokens` | 100k + 50k/seat | 500k + 200k/seat | 100k | reserved before the model call, settled to actual |
| Media storage | `storage.bytes` | 10 GB + 5 GB/seat | 50 GB + 10 GB/seat | 2 GB | running total |
| Exports | `exports.count` | 20 | 200 | 5 | never blocked by restricted access |
| X API posts / reads | `x.write` / `x.read` | not metered by plan | not metered by plan | 0 | workspace budgets still apply; reconciliation reads never blocked |
| Active listening searches | live count | 0 | 5 + 2/seat | 2 (Professional trial) | over-limit ⇒ customer chooses |
| Connected social accounts | live count | 5 + 3/seat | 10 + 5/seat | 5 | over-limit ⇒ customer chooses; nothing disconnected |
| Integration sync jobs | `integration.jobs` | 0 | 5,000 + 1,000/seat | 200 (Professional trial) | charged once per job, even across retries |
| MCP tool calls | `mcp.calls` | 0 | 10,000 + 2,000/seat | 500 (Professional trial) | a retry with the same idempotency key is charged once |

Values are the defaults in `v4-plans.ts`; final commercial allowances are an activation item. Nothing is advertised as
unlimited and **no overage is charged** (`AllowanceState.overage = 'none'`).

Each allowance reports: **included** (plan/trial/override), **used**, **reserved** (in-flight reservations), **customer
budget**, **hard limit** (the enforced one), **warning** at 80 % (notifications at 50/80/100 %), remaining and status.

### Race-free consumption and durable usage
- Metered allowances use the shared reservation mechanism (`product/budgets.ts`): counter rows are locked in a fixed
  order and `used + reserved + amount ≤ limit` is checked under the lock, so concurrent requests can never take the last
  unit twice (tested with 12 concurrent consumers for 3 units).
- Live-count allowances (accounts, searches) take a per-workspace advisory lock in the transaction that creates the
  resource (tested with 6 concurrent connects for one slot).
- Every settled consumption is written once to `usage_events` (unique per workspace + meter + dedupe key; append-only for
  application roles) in its billing-period bucket. Periods: whole trial = one bucket; subscription period; calendar month
  for legacy. See the reset table in `FAILED_PAYMENT_AND_DOWNGRADE.md`.

### Surfaces
- **API:** `GET /api/entitlements` (plan, features, access for every member; allowances/held work/overrides for
  `billing.read` or `workspace.manage`), `GET|PUT /api/entitlements/selections` (choose what stays active;
  `billing.manage`), `GET|POST /api/platform/entitlements/:workspaceId`, `POST …/overrides/:id/revoke`.
  Blocked actions return **402 `entitlement_required`** with `details.reason` (`feature_not_in_plan`,
  `access_restricted`, `access_suspended`, `allowance_exhausted`, `over_limit_held`, `no_plan`) and `upgrade_to`.
- **MCP:** the same code as `error.code = entitlement_required` (audited as denied); read tools stay available while
  restricted on plans with MCP.
- **UI:** Admin → Usage (plan, allowances, held work, chooser, features, Relay adjustments, then your budgets); a shell
  strip when paid actions are paused (Billing, Held work and Support links); concise "Not in your plan" prompts on
  Listening, Automation and Integrations; Platform → Workspaces → Entitlements panel.
- **Workers:** dispatch-time re-checks (posts, replies, sync jobs, Google posts, Slack alerts, automation runs, AI runs,
  listening matching); `billing.access_changed` and a 5-minute sweep re-evaluate held work.
