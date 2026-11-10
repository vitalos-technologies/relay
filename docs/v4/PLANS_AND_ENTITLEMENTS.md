# Plans and entitlement definitions (V4 §9, §12; V5 §6–7; D33 Free plan)

<!-- BIL: catalogue, plan versions, seats and the migration of existing workspaces go above the Entitlements section. -->

## Catalogue (stream BIL)

**Single source:** `packages/core/src/contracts/v4-plans.ts`. Marketing (V5), the signup handoff, checkout, Settings →
Billing, entitlements and Platform admin all read it (directly, or through the persisted versions seeded from it).

| Plan | Price | Interval | Trial | Purchasable |
|---|---|---|---|---|
| Free | **£0** (1 user) | — | none | no — no checkout, no provider product or price, never charged |
| Standard | **£5 per billable user** | monthly | 14 days, no card | yes |
| Professional | **£15 per billable user** | monthly | 14 days, no card | yes |
| Legacy | no price | — | — | no (pre-V4 workspaces only) |

Examples: 3 Standard users = £15 / month; 3 Professional users = £45 / month; Free = £0 (`recurringTotalMinor('free', 1)` = 0).
Currency GBP. No annual option (V5: no
invented annual discount; the model supports intervals). Tax: prices are shown as configured in the provider's checkout —
Relay does not claim tax-inclusive or tax-exclusive pricing (activation item: configure tax in Stripe and the copy with it).

### Persisted plan versions (`035_v4_billing.sql`, `040_free_plan.sql`)
- `040_free_plan.sql` (D33) added the `free` plan (version 1: £0, not purchasable, no provider price) and published new
  current versions Standard **v2 £5** and Professional **v2 £15** (plus legacy v2 carrying the new allowance keys). The V4
  versions (Standard v1 £10, Professional v1 £25) are **retired for new purchases only**: every existing subscription keeps
  its `plan_version_id` and its provider price, so nobody is silently repriced (tested: a v1 Standard subscription still
  shows and bills £10). Moving an existing subscriber to the new price is an explicit plan change, never automatic.
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
- **Free** has no seats: the `members` allowance (1 = the owner) is enforced by the entitlement service — invitations and
  acceptances beyond it are refused with "Free includes 1 user. Upgrade to add teammates." (see "Free plan" below).
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
- Trials exist for the **paid** plans only (never Free). Started server-side in the same transaction as workspace creation
  (`createWorkspace` → `startTrialTx`) when the signup handoff passes `standard` or `professional` (switchable during the trial
  without changing the end date). **Decision (D33): onboarding without a plan, and `?plan=free`, start on Free** (no trial,
  no card) — the trial is an explicit choice, so nobody is surprised by a trial ending.
- A Free workspace that never redeemed its trial can still use it once: Settings → Billing → "Start free trial" (no card), or
  an upgrade checkout, which then includes the 14-day trial (provider subscription trialing; first charge at its end). The
  redemption is recorded when the provider confirms the subscription (`sync.ts`), so an abandoned checkout never uses it up.
  Once redeemed, an upgrade checkout charges straight away.
- Subscribing during the trial keeps the free period: Checkout `subscription_data.trial_end` = trial end (Stripe requires
  ≥ 48 h ahead); inside the last 48 h `billing_cycle_anchor` = trial end with no proration. The first charge date is shown in
  checkout and in Settings → Billing.
- Staff may extend an **eligible** trial (no-card, running or ended — i.e. back on Free — not subscribed): ≤ 30 days per
  extension, ≤ 3 extensions, reason + step-up + both audits. Extending an ended trial resumes it on its plan.
- **Expiry without a subscription → Free (D33)** (`sweepTrials`: status `free`, plan `free`, `billing.trial_expired` +
  `billing.subscription_changed`; until the sweep runs, `getBillingState` already reads Free from the clock). Anything over
  Free's limits is held, nothing is deleted (policy: `FAILED_PAYMENT_AND_DOWNGRADE.md`). A notice is sent 3 days before the
  end (in-app) and at the end (in-app + email when configured).

### Migration of existing workspaces
Migration `035_v4_billing.sql` gives **every workspace that exists when it runs** the `legacy` plan (`status = legacy`):
Professional features, no price, nothing metered by plan (existing workspace budgets still apply), full access, no trial, no
provider record. A `legacy_assigned` lifecycle event records it. Workspaces created later **outside** the product signup
path (seed/CLI scripts, tests) have no billing row and are read the same way (legacy). Legacy workspaces are never billed or
restricted by billing; an owner may move to a paid plan voluntarily (Settings → Billing → Choose a plan → checkout; no trial).
`040_free_plan.sql` moved every row that was `expired` (no-card trial ended) or `cancelled` (subscription ended) without a
live provider subscription to **Free** (`moved_to_free` lifecycle event) — the D33 replacement for "expired ⇒ restricted".

### Selected-plan signup handoff (for V5's marketing page)
`/signup?plan=free|standard|professional` (public) → `/signup/workspace?plan=…` (sign in or register at the identity provider
first) → create the workspace (`POST /api/billing/signup` with `plan`) → `standard|professional`: the trial starts on that
plan; `free`: the workspace starts on Free (no trial, no card, no provider objects) → Settings → Billing (welcome banner).
The plan in the URL only picks which public plan; unknown values are refused by the API. `GET /api/billing/signup` returns
the catalogue (Free, Standard, Professional) and the user's workspaces.
A user who already belongs to a workspace is sent to that workspace's Billing (no second trial). Public catalogue JSON:
`GET /api/billing/catalogue`.



## Free plan (D33; stream PL)

Free: **1 user, 1 brand, 2 social accounts, 10 scheduled posts a month, 500 MB media, 20,000 AI tokens a month, Planner +
composer, Help Centre support**; no analytics, approvals/collaboration, inbox, listening, automation, integrations, MCP or
report exports. Limits apply to what NEW work can start; existing content is never locked or deleted and **the data export
always works** (brand handover export and activity export reserve with `planExempt`: counted, but never refused by the plan;
Free's `exports: 0` only stops report exports).

| Limit | Enforced at (server, shared entitlement service) | Refusal (402 `entitlement_required`) |
|---|---|---|
| 10 scheduled posts / month | `posts/scheduling.ts` (schedule + publish now) → `assertScheduledPostAllowed`; dispatch + send gate (`publishingHold`) | `allowance_exhausted`, `allowance: scheduled_posts` |
| 1 brand | `brands.ts createBrand` → `assertCanCreateBrand` (gauge, advisory lock) | `allowance: brands` |
| 2 social accounts | connect / mock connect (existing gauge) | `allowance: social_accounts` |
| 1 user | invitation create + accept → `assertCanAddMember` (active + pending invitations) | "Free includes 1 user. Upgrade to add teammates." |
| 500 MB media, 20k AI tokens | existing reservations (`storage.bytes`, `ai.tokens`) with the Free ceiling | `budget_exhausted` (`limit_source: plan`) |
| Analytics, inbox | API wrapper route gate (`entitlements/routes.ts`: `/api/analytics/**`, `/api/inbox/**`) + `FeatureGate` on the pages | `feature_not_in_plan` |
| Approvals | submit for review, turning approvals on (`collaboration`) | `feature_not_in_plan` |
| Listening, automation, integrations, MCP, saved reports | existing feature gates | `feature_not_in_plan` |

**Scheduled posts** are counted once per post per calendar month **of publication** (UTC): a post with several destinations
is one unit; re-scheduling inside the same month or a retried request is free (ledger key `post:<id>:<YYYY-MM>`); moving it to
another month counts it in that month. The counter row is locked in the scheduling transaction, so concurrent requests take
the last unit exactly once (tested with 3 concurrent publish-now requests for 1 unit). Paid plans and trials don't meter it.

**Upgrade / downgrade:** Free → Standard/Professional = the normal checkout (with the 14-day trial if never redeemed). Paid →
Free = "Downgrade to Free" (= cancel renewal at period end; `POST /api/billing/preview|change` also accept `plan: 'free'`),
then Free. Free itself never creates a provider customer, subscription, checkout or charge.

**Over the limits after dropping to Free** (trial end, subscription end) — held, never deleted or disconnected:
- brands / social accounts beyond the limit: the customer chooses which stay active (Admin → Usage chooser; default: the
  oldest); posts to held brands/accounts are held with a visible reason;
- scheduled posts: waiting posts use their month's allowance earliest-due first; the rest are held (released when an
  allowance frees up in time, e.g. next month, or on upgrade; past their publish-before deadline they become Missed);
- members beyond 1: **owners always keep access**; the others keep their account but lose product access (no brands
  visible; only billing, support and workspace-read permissions pass) until the owner upgrades, chooses them, or removes
  someone. They see "Access paused" with the reason (`EntitlementsDto.member_hold`, shell strip).

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
| Feature | Free | Standard | Professional | Enforced at |
|---|---|---|---|---|
| Publishing and scheduling | ✓ | ✓ | ✓ | schedule / publish-now (service), dispatch + send gate (worker), X writes (meter) |
| Media library | ✓ | ✓ | ✓ | upload intents / URL imports (storage reservation) |
| Team collaboration (approvals, review) | | ✓ | ✓ | submit for review, turning approvals on |
| Standard analytics | | ✓ | ✓ | `/api/analytics/**` route gate (pages show the upgrade prompt) |
| Social inbox | | ✓ | ✓ | `/api/inbox/**` route gate; reply request (service) + reply dispatch (worker) |
| AI drafting | ✓ | ✓ | ✓ | AI reservations (`ai.tokens`), assistant run requests and worker runs |
| In-app support | ✓ | ✓ | ✓ | always available, never restricted |
| Advanced analytics and reports | | | ✓ | saving analytics reports |
| Listening | | | ✓ | saved-search creation (+ active-search allowance), matching at ingestion |
| Multi-step approvals | | | ✓ | adding a second review stage (existing ones stay in force) |
| Advanced customer care | | | ✓ | service-level policies |
| AI workflows | | | ✓ | (V5 AI workspace; flag ready) |
| Automations | | | ✓ | rule/policy creation + activation, every rule run (worker) |
| Business integrations | | | ✓ | sync-job enqueue, sync-job run (worker), Google posts, Slack deliveries |
| MCP access | | | ✓ | every MCP tool call and resource read |

### Allowances
| Allowance | Meter | Free | Standard (per period) | Professional | Trial | Notes |
|---|---|---|---|---|---|---|
| AI tokens | `ai.tokens` | 20k | 100k + 50k/seat | 500k + 200k/seat | 100k | reserved before the model call, settled to actual |
| Media storage | `storage.bytes` | 500 MB | 10 GB + 5 GB/seat | 50 GB + 10 GB/seat | 2 GB | running total |
| Report exports | `exports.count` | 0 | 20 | 200 | 5 | never blocked by restricted access; the data export is never blocked by the plan |
| X API posts / reads | `x.write` / `x.read` | 0 | not metered by plan | not metered by plan | 0 | workspace budgets still apply; reconciliation reads never blocked |
| Active listening searches | live count | 0 | 0 | 5 + 2/seat | 2 (Professional trial) | over-limit ⇒ customer chooses |
| Connected social accounts | live count | 2 | 5 + 3/seat | 10 + 5/seat | 5 | over-limit ⇒ customer chooses; nothing disconnected |
| Integration sync jobs | `integration.jobs` | 0 | 0 | 5,000 + 1,000/seat | 200 (Professional trial) | charged once per job, even across retries |
| MCP tool calls | `mcp.calls` | 0 | 0 | 10,000 + 2,000/seat | 500 (Professional trial) | a retry with the same idempotency key is charged once |
| Scheduled posts | `posts.scheduled` | 10 / month | not metered | not metered | not metered | once per post per month of publication |
| Brands | live count | 1 | not metered | not metered | not metered | over-limit ⇒ customer chooses; posts of held brands held |
| Users | live count | 1 | seats (billing) | seats (billing) | not metered | owners always keep access; extra people paused |

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
  for legacy and Free (scheduled posts: the calendar month of publication). See the reset table in
  `FAILED_PAYMENT_AND_DOWNGRADE.md`.

### Surfaces
- **API:** `GET /api/entitlements` (plan, features, access for every member; allowances/held work/overrides for
  `billing.read` or `workspace.manage`), `GET|PUT /api/entitlements/selections` (choose what stays active;
  `billing.manage`), `GET|POST /api/platform/entitlements/:workspaceId`, `POST …/overrides/:id/revoke`.
  Blocked actions return **402 `entitlement_required`** with `details.reason` (`feature_not_in_plan`,
  `access_restricted`, `access_suspended`, `allowance_exhausted`, `over_limit_held`, `no_plan`) and `upgrade_to`.
- **MCP:** the same code as `error.code = entitlement_required` (audited as denied); read tools stay available while
  restricted on plans with MCP.
- **Route gate (D33):** `apps/web/lib/api.ts route()` calls `assertRouteEntitled()` (`entitlements/routes.ts`) — API areas
  whose plan feature is missing (`/api/analytics/**` → Standard analytics, `/api/inbox/**` → Social inbox) return 402
  before the handler runs.
- **UI:** Admin → Usage (plan, allowances, held work, chooser — accounts, searches, brands, people — features, Relay
  adjustments, then your budgets); a shell strip when paid actions are paused (Billing, Held work and Support links) or
  when the viewer's own access is paused by the user limit; concise "Not in your plan" prompts on Listening, Automation,
  Integrations, Analytics and Inbox (`FeatureGate`); Platform → Workspaces → Entitlements panel.
- **Workers:** dispatch-time re-checks (posts, replies, sync jobs, Google posts, Slack alerts, automation runs, AI runs,
  listening matching); `billing.access_changed` and a 5-minute sweep re-evaluate held work.
