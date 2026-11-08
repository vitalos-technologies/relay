// V4 billing ↔ entitlements contract (lead-defined; docs/V4_WORKSTREAMS.md). The billing stream (BIL) implements
// `getBillingState()` in packages/services/src/billing/state.ts; the entitlement stream (ENT) consumes it and must not
// read billing tables directly. BIL may ADD fields; renaming/removing needs the lead.
import type { AccessLevel, PlanId, SubscriptionStatus } from './v4-plans.js';

/** Verified billing facts for one workspace (from provider-verified events + reconciliation; never from redirects). */
export interface BillingState {
  workspace_id: string;
  /** Plan whose features apply now (trial plan during a trial; legacy for pre-V4 workspaces; null = no plan). */
  plan_id: PlanId | null;
  /** Immutable persisted plan version the subscription is bound to (null for legacy/no plan). */
  plan_version_id: string | null;
  status: SubscriptionStatus | 'none' | 'legacy';
  /** Paid (or trial) seat quantity on the subscription; billable-user count is computed separately. */
  seats: number;
  trial: { started_at: string; ends_at: string; plan_id: PlanId } | null;
  current_period: { start: string; end: string } | null;
  /** Renewal cancelled; service continues until this instant. */
  cancel_at: string | null;
  /** A downgrade / seat reduction scheduled for the next period boundary. */
  scheduled_change: { plan_id: PlanId | null; seats: number | null; effective_at: string } | null;
  /** past_due grace end (paid actions continue until then, per policy). */
  grace_ends_at: string | null;
  /** Relay staff service suspension (independent of billing). */
  service_suspended: boolean;
  /** Derived access level: full / restricted (paid actions held) / suspended. */
  access: AccessLevel;
  /** Human-readable reason when access ≠ full (shown in banners and on held work). */
  access_reason: string | null;
  /** Server time the state was computed. */
  as_of: string;
}

/** Billing event names written to the outbox by BIL (ENT/SUP/notifications consume them). */
export const BILLING_EVENTS = [
  'billing.trial_started',
  'billing.trial_ending', // 3 days before expiry
  'billing.trial_expired',
  'billing.subscription_activated',
  'billing.subscription_changed', // plan / seats / scheduled change
  'billing.payment_failed',
  'billing.payment_recovered',
  'billing.cancellation_scheduled',
  'billing.subscription_ended',
  'billing.access_changed', // derived access level changed (ENT re-evaluates holds)
] as const;
export type BillingEvent = (typeof BILLING_EVENTS)[number];
