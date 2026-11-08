# Tenant lifecycle runbook (Relay staff) — V4 §14

Platform → Workspaces → *workspace* shows metadata, the **Billing** panel (operator / billing staff), Entitlements (ENT) and
support access. Every change needs a reason, a fresh MFA sign-in (step-up) and writes the platform audit **and** the
workspace's audit.

## Who can do what
| Action | operator | billing | support |
|---|---|---|---|
| See workspaces, health, platform audit (metadata) | ✓ | ✓ | ✓ |
| See billing record, provider references, invoices, lifecycle history | ✓ | ✓ | — (ticket card shows plan/status only) |
| Extend an eligible trial | ✓ | ✓ | — |
| Cancel / resume renewal at the provider | ✓ | ✓ | — |
| Map Stripe prices (Platform → Plans) | ✓ | ✓ | — |
| Publish a plan version | ✓ | — | — |
| Entitlement overrides (ENT) | ✓ | ✓ | read |
| Suspend / reactivate / schedule suspension | ✓ | — | — |
| Request support access (customer content) | ✓ | — | ✓ |
| Ticket internal notes (SUP) | ✓ | — | ✓ |

Billing staff never get customer content or ticket internal notes; support staff never get billing powers.

## Suspension ≠ cancellation
- **Suspend** (operator): members lose access on their next request, dispatch holds, nothing is deleted. Billing continues
  unchanged (the customer is still subscribed). Reactivate restores access.
- **Cancel renewal** (billing staff or the customer): the subscription ends at the period end; service continues until then;
  afterwards access is *restricted* (paid actions held; read, billing, support and exports available). The workspace is
  **not** suspended and nothing is deleted.
- Neither implies the other. To stop service for non-payment: let the grace period run (automatic restriction), or schedule
  a suspension explicitly.

## Common tasks
**Customer says they paid but Relay shows "Payment pending"** → Billing panel → *Re-fetch* (reads the provider now). If the
provider shows it paid, Relay updates. Check *Failed provider events*; a persistent failure means the webhook endpoint or
secret is misconfigured (activation checklist).

**Trial needs more time** → *Extend trial* (1–30 days, max 3 times; only no-card trials not yet subscribed). The customer sees
the new end date immediately.

**Refund / dispute / invoice correction** → not done in Relay. Use *Refunds in provider* (opens the customer in the Stripe
Dashboard). Relay picks up the resulting state from webhooks.

**Duplicate subscription banner** → cancel the extra subscription in the provider (with a refund there if it was charged).
Relay keeps the first one.

**Schedule a suspension** (operator) → *Schedule suspension* with a time and reason. The worker applies it at that time
(audited as `lifecycle-scheduler`, with the scheduling operator recorded). Cancel it from the banner before then.

**Move a legacy workspace to a plan** → the owner chooses a plan in Settings → Billing (checkout). Staff do not migrate
legacy workspaces silently.

**Price change** → edit `v4-plans.ts` in a release, then Platform → Plans → *Publish version* and map the new Stripe price.
Existing subscriptions keep their version; migrating them is a separate, explicit decision (not automated).

## Where things are recorded
`billing_lifecycle_events` (per workspace, append-only), `platform_audit_events` (`billing.*`, `lifecycle.*`,
`workspace.suspended`), workspace `audit_events` (`platform.billing_*`, `billing.*` customer actions),
`billing_webhook_events` (every verified provider event, deduplicated).
