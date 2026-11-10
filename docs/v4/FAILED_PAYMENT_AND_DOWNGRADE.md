# Failed payment, trial expiry, cancellation and downgrade — grace, restriction and Free policy (V4 §13, V5 §7, D33)

Owner: stream ENT (enforcement). Billing states and their transitions are BIL's (`BILLING_LIFECYCLE_AND_WEBHOOKS.md`);
this document says what each **access level** does to the customer's work. Code: `packages/services/src/entitlements/**`,
dispatch checks in `engine/process.ts`, `inbox/replies.ts`, `connectors/jobs.ts`, `automation/engine.ts`,
`listening/ingest.ts`, MCP in `mcp/tools.ts`. Tests: `tests/integration/v4-entitlements*.test.ts`.

## D33 in one paragraph
**No paid plan in force ⇒ Free, not restricted.** A no-card trial that ends without a subscription, a subscription that ends
(cancellation reached its date — "downgrade to Free" is exactly that — or the provider ended it), and a first payment that
never completed after the trial all leave the workspace on the **Free** plan with **full access within Free's limits**.
Whatever is over those limits is **held** (paused), never deleted or disconnected, and the data export always works. The
only state that still **restricts** is a live subscription with an unpaid renewal past its 7-day grace: the customer still
owes that invoice; fixing payment restores the plan, and cancelling moves the workspace to Free. (Chosen because Free
with holds is never worse for the customer than "restricted", which held all publishing; a dunning subscription stays
restricted so an unpaid plan is not silently converted while the provider is still collecting.)

## Principles
- **Nothing is deleted, disconnected or silently published** because of billing. Data, accounts, drafts, media,
  analytics, conversations and settings are kept in every state.
- **Held, not dropped.** Queued work is held with a visible reason and released automatically when access returns. A held
  post whose publish-before deadline passes becomes **Missed** (the existing deadline rule) — it is never published late.
- **In-flight work keeps its rules.** Anything already sending, processing at the provider, Unknown or in manual handoff
  is never touched by a billing change; reconciliation (including metered X reads) continues, so billing can never cause
  a duplicate publication.
- **Checked twice.** Paid actions are refused at request time (API, MCP, UI) and re-checked when the worker dispatches
  (and again in the send gate, in the same transaction that moves a post to sending).
- **Always available:** reading everything, Settings → Billing, Help → Contact support / My requests, exports, editing
  drafts, recording approvals, managing the team, choosing what stays active.
- **No surprise charges.** No overage pricing exists; at a limit the action waits or is refused.

## Access levels
| Level | When (BIL `getBillingState().access`) | Effect |
|---|---|---|
| **full** | active, trialing (before the end), past due **within grace** (7 days, `PAST_DUE_GRACE_DAYS`), payment action required within grace, cancellation scheduled (until the effective date), legacy | Everything the plan includes, within allowances |
| **full on Free** (D33) | `free`: trial ended without a subscription, subscription ended / cancellation date reached, first payment incomplete after the trial, signed up on Free | Free's features within Free's limits; over-limit resources and work **held** (below) |
| **restricted** | past due / payment action required **after** the grace period (live subscription, unpaid), no plan (transient) | **Paid actions held**; everything in "Always available" works |
| **suspended** | Relay staff suspended the service (independent of billing; V3.1) | Members cannot use the workspace; dispatch paused (existing mechanics; resumes on reactivation) |

A Relay operator or billing staff member may keep **full access** on temporarily (audited override, reason, expiry ≤ 30
days) while a billing problem is resolved. It never lifts a staff suspension.

## What happens to each kind of work
| Work | Restricted | Back to full |
|---|---|---|
| **Scheduled posts** | Waiting deliveries are marked **Held** (`blocked`, `entitlement_hold`, reason shown in Queue/History/post); the worker re-checks at dispatch; publish-now is refused; timed scheduling is still accepted (held at due time if still restricted) | Released to Scheduled if still timely and delivered once; past deadline ⇒ Missed |
| **In-flight / Unknown / handoff publications** | Untouched; reconciliation continues | — |
| **Queued replies** (social inbox) | New sends refused; queued replies stay queued, marked held, re-checked every 15 min; nothing is sent | Re-queued immediately; the network's reply window rules still apply at send time |
| **Existing approvals** | Kept and still enforced; people can approve/reject (recording is not a paid action); approved posts are held at dispatch like any post | Publish if still timely |
| **Active automations** | Rules/policies kept as they are; each triggered run is recorded **blocked** with the reason (run log); no actions run | Next events run normally (blocked events are not replayed) |
| **AI jobs** | Requests refused; a queued run stops as **blocked** with the reason; nothing is generated or sent (outputs are drafts anyway) | New requests work |
| **Listening ingestion** | Public items are still observed and stored (no data lost) but not matched to saved searches; no alerts | Searches re-match the stored items automatically |
| **Business integrations** | Sync jobs stay queued with the reason (charged once when they finally run); Google posts stay scheduled with the reason; Slack alerts deferred; inbound events still recorded | Released and run once |
| **MCP** | Read tools work (plans with MCP); write tools refused with `entitlement_required` | Normal |
| **Storage uploads** | New uploads refused; uploads already in progress finish | Normal |
| **Exports** | Allowed (activity, handover, analytics, MCP report jobs) within the export allowance | — |
| **Support conversations** | Always available, never restricted, never billed | — |
| **Billing** | Always available (Settings → Billing, customer portal) | — |

Release triggers: BIL's `billing.access_changed` outbox event (worker → `onBillingAccessChanged`), override and selection
changes, and a 5-minute worker sweep that re-evaluates workspaces with held work (a missed event only delays a release).
Every re-evaluation that moves work is audited (`entitlements.reevaluated`).

## Dropping to Free (D33) — what is held
Applied by the same re-evaluation (`reevaluateHolds`) as soon as the workspace is on Free (BIL emits
`billing.trial_expired` / `billing.subscription_ended` + `billing.subscription_changed`; the worker sweep is the safety
net; every dispatch re-checks).

| Over Free's limit | What happens | Released when |
|---|---|---|
| Brands beyond 1 | Kept and editable; the brand is **paused**: its waiting posts are held ("this brand is over the plan’s limit"), new schedules for it refused. The owner chooses which brand stays active (Admin → Usage); default the oldest | Chosen, upgraded, or brands archived down to the limit |
| Social accounts beyond 2 | Stay connected (inbox/analytics data kept); publishing to them held; new schedules refused (existing V4 chooser) | Same |
| Scheduled posts beyond 10 in a month | Waiting posts use their publication month's allowance, earliest due first; the rest are held with the reason. Each post counts once per month | An allowance frees up in time (e.g. the next month, if still before publish-before) or upgrade; past the deadline ⇒ Missed |
| Members beyond 1 | **Owners always keep full access.** Others keep their account and membership but lose product access (no brands visible; only billing, support and workspace-read permissions); they see "Access paused — ask the owner to upgrade" | Upgrade, chosen in the people chooser, or someone removed |
| Storage over 500 MB | Nothing is deleted; new uploads refused until under the limit or upgraded | Upgrade / archive media |
| Features not in Free (inbox, approvals, analytics, listening, automation, integrations, MCP, report exports) | As for any plan without the feature (table above): configuration kept; new configuration refused; queued replies held; automations blocked; listening not matched; integration jobs held; MCP refused; analytics/inbox API return 402 with an upgrade prompt | Upgrade |
| Data export | **Always works** (handover export, activity export: counted, never refused by the plan) | — |
| Billing, support | Always available | — |

Pending invitations created before the drop cannot be accepted while the workspace is at its user limit ("This
workspace’s plan has no room for another person").

## Downgrades and lowered limits
- A downgrade or seat reduction takes effect at the **period end** (BIL scheduled change); until then the current plan's
  entitlements apply. **Downgrade to Free** = cancel renewal at period end (Settings → Billing → "Downgrade to Free"); at the
  end the workspace is on Free (section above). Nothing is charged for Free.
- **Features not in the new plan** (e.g. Professional → Standard): configuration is kept and visible; new configuration is
  refused with an upgrade prompt (new automations, saved searches, saved analytics reports, service-level policies,
  integration jobs); work depending on the feature is held/blocked as in the table (automations blocked, listening not
  matched, integrations held, MCP refused). Existing saved reports and SLA policies keep working and stay readable. Existing **multi-step approval policies stay in force** — a
  plan change never weakens an approval control — but a second stage cannot be added on Standard.
- **Allowances below current use** (connected accounts, active listening searches, and on Free brands and members): nothing is disconnected or archived.
  An owner/admin with `billing.manage` chooses which accounts/searches stay active (Admin → Usage); until they choose,
  the oldest stay active. Paused accounts stay connected (inbox and analytics continue); publishing to them is held and
  new schedules to them are refused with the reason. Paused searches keep their history and do not match new items.
- **Metered allowances** (AI tokens, storage, exports, MCP calls, integration jobs) apply from the next reservation;
  usage already recorded is never re-charged.

## Trial expiry (V5 §7, D33)
At the trial end without a subscription the workspace moves to **Free** (above) — no longer "restricted". Trial allowances
are bounded and one bucket for the whole trial (they never reset); Free's monthly allowances start with the calendar month.
Data, billing, support and the data export stay available; only what is over Free's limits is held; nothing is silently
published, deleted or discarded. Upgrading (checkout straight to paid — the trial was used) releases held work
(still-timely posts only).

## Cancellation
Cancellation ends the paid plan on the configured effective date (period end). Until then: full access. After it: **Free**
(D33), as above. The workspace is never deleted by cancellation; closing a workspace is a separate, explicit flow.

## Failed payment (unchanged policy)
Past due / payment action required: full access for the 7-day grace, then **restricted** while the live subscription stays
unpaid (V4 behaviour, kept on purpose — see "D33 in one paragraph"). If the provider finally cancels the unpaid
subscription, or the customer cancels, the workspace moves to Free.

## Usage periods and reset policy
| Situation | Period bucket | Resets |
|---|---|---|
| Trial | whole trial (`trial:<start date>`) | never (bounded) |
| Subscription | subscription period (`p:<period start>`) | at renewal |
| Legacy / no plan / Free | UTC calendar month | 1st of the month |
| Scheduled posts (Free) | calendar month of each post's publication | per month |
| Storage | running total | never (archive/delete frees space) |
| Connected accounts, active searches | live count | — |

Usage is recorded twice: atomic counters (reservations; race-free last unit) and a durable, deduplicated ledger
(`usage_events`, one row per consumption key, append-only for application roles).
