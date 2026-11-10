// Billing policy (pure; no IO). Three SEPARATE dimensions (brief V4 §10):
//   1. billing status   — SUBSCRIPTION_STATUSES + 'none' | 'legacy'; derived from verified provider state + the local trial.
//   2. service state    — workspaces.state ('active' | 'suspended'), set only by Relay staff; never by billing.
//   3. access level     — derived from 1 + 2: full | restricted (paid actions held) | suspended.
// D33 (Free plan): when no paid entitlement is in force — a no-card trial ended, a subscription ended (cancelled, or a
// cancellation reached its date), a first payment never completed after the trial — the workspace FALLS BACK TO FREE
// (full access within Free's limits; over-limit resources held by the entitlement service), never "restricted".
// Only a live subscription with an unpaid renewal past its grace period stays restricted (the customer still owes it;
// cancelling moves the workspace to Free). docs/v4/FAILED_PAYMENT_AND_DOWNGRADE.md.
// Documented in docs/v4/BILLING_LIFECYCLE_AND_WEBHOOKS.md (transition table mirrors TRANSITIONS below).
import type { AccessLevel } from '@social-lite/core/contracts/v4-plans';
import type { BillingStatusValue } from '@social-lite/core/contracts/v4-billing';
import type { ProviderSubscription } from '@social-lite/providers/stripe/types';

export type BillingStatus = BillingStatusValue;

/** Paid actions continue for this long after the first failed renewal (then access becomes restricted). */
export const PAST_DUE_GRACE_DAYS = 7;
/** `billing.trial_ending` is emitted once, this many days before the trial ends. */
export const TRIAL_ENDING_NOTICE_DAYS = 3;
/** Staff may extend a trial at most this many times, by at most this many days each. */
export const MAX_TRIAL_EXTENSIONS = 3;
export const MAX_TRIAL_EXTENSION_DAYS = 30;
/** Stripe Checkout: subscription_data.trial_end must be at least 48 hours in the future. */
export const CHECKOUT_MIN_TRIAL_END_MS = 48 * 3600_000;
export const CHECKOUT_TTL_MS = 60 * 60_000; // our hosted checkout links live 1 h (Stripe allows 30 min – 24 h)

export type TransitionTrigger =
  | 'trial_started' | 'checkout_completed' | 'trial_expired' | 'renewed' | 'payment_failed' | 'payment_action_required' | 'payment_recovered'
  | 'upgraded' | 'downgrade_scheduled' | 'change_applied' | 'cancellation_scheduled' | 'reactivated' | 'subscription_ended' | 'grace_exhausted'
  | 'provider_sync' | 'free_started' | 'moved_to_free';

/** Documented transitions. Provider state is authoritative; an undocumented transition is still applied but flagged. */
export const TRANSITIONS: ReadonlyArray<{ from: BillingStatus[]; to: BillingStatus; on: TransitionTrigger[] }> = [
  { from: ['none', 'free'], to: 'trialing', on: ['trial_started'] },
  // D33 Free: signup/onboarding on Free; a trial or subscription that ends without a paid plan lands on Free.
  { from: ['none'], to: 'free', on: ['free_started'] },
  { from: ['trialing', 'expired', 'cancelled', 'cancel_scheduled', 'incomplete', 'past_due', 'payment_action_required', 'active'], to: 'free', on: ['trial_expired', 'subscription_ended', 'moved_to_free', 'provider_sync'] },
  { from: ['free'], to: 'trialing', on: ['checkout_completed', 'provider_sync'] },
  { from: ['free'], to: 'active', on: ['checkout_completed', 'provider_sync'] },
  { from: ['free'], to: 'incomplete', on: ['checkout_completed', 'provider_sync'] },
  { from: ['free'], to: 'payment_action_required', on: ['checkout_completed', 'provider_sync'] },
  { from: ['trialing', 'expired', 'cancelled', 'none', 'incomplete'], to: 'trialing', on: ['checkout_completed', 'provider_sync'] }, // subscribed during the trial keeps the free period
  { from: ['trialing', 'expired', 'cancelled', 'none', 'incomplete', 'legacy'], to: 'active', on: ['checkout_completed', 'provider_sync'] },
  { from: ['trialing', 'expired', 'cancelled', 'none'], to: 'incomplete', on: ['checkout_completed', 'provider_sync'] },
  { from: ['trialing'], to: 'expired', on: ['trial_expired', 'provider_sync'] },
  { from: ['trialing', 'active'], to: 'active', on: ['renewed', 'upgraded', 'change_applied', 'provider_sync'] },
  { from: ['active', 'trialing', 'incomplete', 'cancel_scheduled'], to: 'past_due', on: ['payment_failed', 'provider_sync'] },
  { from: ['active', 'past_due', 'incomplete', 'trialing'], to: 'payment_action_required', on: ['payment_action_required', 'provider_sync'] },
  { from: ['past_due', 'payment_action_required', 'incomplete'], to: 'active', on: ['payment_recovered', 'provider_sync'] },
  { from: ['active', 'trialing'], to: 'cancel_scheduled', on: ['cancellation_scheduled', 'provider_sync'] },
  { from: ['cancel_scheduled'], to: 'active', on: ['reactivated', 'provider_sync'] },
  { from: ['cancel_scheduled'], to: 'trialing', on: ['reactivated', 'provider_sync'] },
  { from: ['active', 'cancel_scheduled', 'past_due', 'payment_action_required', 'trialing', 'incomplete'], to: 'cancelled', on: ['subscription_ended', 'provider_sync'] },
  { from: ['past_due', 'payment_action_required', 'incomplete'], to: 'expired', on: ['grace_exhausted', 'subscription_ended', 'provider_sync'] },
];

export function isDocumentedTransition(from: BillingStatus, to: BillingStatus): boolean {
  return from === to || TRANSITIONS.some((t) => t.to === to && t.from.includes(from));
}

export interface LocalTrial { started_at: Date; ends_at: Date }

/**
 * Billing status from the provider subscription (authoritative when present) and the local trial redemption.
 * `actionRequired` = the latest open invoice needs customer action (invoice.payment_action_required, re-fetched).
 */
export function deriveStatus(p: { sub: ProviderSubscription | null; trial: LocalTrial | null; actionRequired: boolean; now: Date }): BillingStatus {
  const trialRunning = !!p.trial && p.trial.ends_at.getTime() > p.now.getTime();
  const local: BillingStatus = trialRunning ? 'trialing' : p.trial ? 'expired' : 'none';
  const s = p.sub;
  if (!s) return local;
  const cancelling = s.cancel_at_period_end || (!!s.cancel_at && s.cancel_at.getTime() > p.now.getTime());
  switch (s.status) {
    case 'trialing': return cancelling ? 'cancel_scheduled' : 'trialing';
    case 'active': return p.actionRequired ? 'payment_action_required' : cancelling ? 'cancel_scheduled' : 'active';
    case 'past_due': return p.actionRequired ? 'payment_action_required' : 'past_due';
    case 'unpaid': return 'past_due'; // retries exhausted; grace end decides access
    case 'incomplete': return p.actionRequired ? 'payment_action_required' : trialRunning ? 'trialing' : 'incomplete';
    // The first payment never completed: the subscription never started. The promised no-card trial still applies.
    case 'incomplete_expired': return local;
    case 'paused': return 'expired';
    // Cancelled while the no-card trial is still running: the trial continues to its original end (never extended).
    case 'canceled': return trialRunning ? 'trialing' : 'cancelled';
  }
}

export interface AccessInput {
  status: BillingStatus;
  serviceSuspended: boolean;
  graceEndsAt: Date | null;
  trialEndsAt: Date | null;
  cancelAt: Date | null;
  now: Date;
  /**
   * A live provider subscription exists (trialing/active/past_due/unpaid/incomplete). Only matters for a 'trialing' row
   * whose trial end has passed: with a provider trial the provider decides (first charge pending ⇒ keep the plan);
   * a no-card trial ⇒ Free. Defaults to false.
   */
  liveSubscription?: boolean;
}

export const ACCESS_REASONS = {
  suspended: 'This workspace is suspended by Relay. Contact support.',
  payment: 'Payment failed. Update your payment details to continue.',
  payment_action: 'Your bank needs you to confirm a payment. Update your payment details to continue.',
  incomplete: 'Your first payment has not completed. Update your payment details to continue.',
  none: 'Choose a plan to start.',
} as const;

/**
 * Access level + whether the workspace falls back to the Free plan (D33). `free: true` means the plan whose features and
 * allowances apply now is Free, whatever plan the row still names (an ended trial / subscription keeps its history).
 */
export function deriveAccess(i: AccessInput): { access: AccessLevel; reason: string | null; free: boolean } {
  const r = baseAccess(i);
  if (i.serviceSuspended) return { access: 'suspended', reason: ACCESS_REASONS.suspended, free: r.free };
  return r;
}

function baseAccess(i: AccessInput): { access: AccessLevel; reason: string | null; free: boolean } {
  const now = i.now.getTime();
  const full = { access: 'full' as const, reason: null, free: false };
  const free = { access: 'full' as const, reason: null, free: true };
  switch (i.status) {
    case 'legacy':
    case 'active':
      return full;
    case 'free':
    case 'expired': // a no-card trial ended (or the provider paused a trial without payment details)
    case 'cancelled': // the subscription ended: downgrade to Free = cancel at period end, then Free
      return free;
    case 'trialing':
      // Persisted status may lag the sweep: the clock decides. A no-card trial past its end is Free.
      return i.trialEndsAt && i.trialEndsAt.getTime() <= now && !i.liveSubscription ? free : full;
    case 'cancel_scheduled':
      return i.cancelAt && i.cancelAt.getTime() <= now ? free : full;
    case 'past_due':
    case 'payment_action_required':
      // Unchanged V4 policy: paid actions continue through the grace period, then are held until payment is fixed
      // (or the subscription is cancelled, which moves the workspace to Free).
      return i.graceEndsAt && i.graceEndsAt.getTime() > now ? full
        : { access: 'restricted', reason: i.status === 'past_due' ? ACCESS_REASONS.payment : ACCESS_REASONS.payment_action, free: false };
    case 'incomplete':
      // The first payment never completed: the running trial continues; otherwise Free (never worse than before upgrading).
      return i.trialEndsAt && i.trialEndsAt.getTime() > now ? full : free;
    case 'none':
      return { access: 'restricted', reason: ACCESS_REASONS.none, free: false };
  }
}

/** Provider subscription statuses that are still live (may bill or recover). */
export const LIVE_PROVIDER_STATUSES: readonly string[] = ['trialing', 'active', 'past_due', 'unpaid', 'incomplete', 'paused'];
export function liveProviderSubscription(row: { provider_subscription_ref: string | null; provider_status: string | null }): boolean {
  return !!row.provider_subscription_ref && !!row.provider_status && LIVE_PROVIDER_STATUSES.includes(row.provider_status);
}

/** Is there a live provider subscription that bills seats (paid or provider-trialing)? */
export function hasPaidSubscription(status: BillingStatus, subscriptionRef: string | null): boolean {
  return !!subscriptionRef && ['active', 'past_due', 'payment_action_required', 'cancel_scheduled', 'trialing', 'incomplete'].includes(status);
}

export type ChangeKind = 'none' | 'immediate' | 'scheduled' | 'mixed';

/** Upgrades / seat increases apply now (prorated); downgrades / seat decreases at period end; mixed is refused. */
export function classifyChange(p: { fromUnit: number; toUnit: number; fromSeats: number; toSeats: number }): ChangeKind {
  const up = p.toUnit > p.fromUnit || p.toSeats > p.fromSeats;
  const down = p.toUnit < p.fromUnit || p.toSeats < p.fromSeats;
  if (up && down) return 'mixed';
  if (up) return 'immediate';
  if (down) return 'scheduled';
  return 'none';
}

/** First charge for a checkout started during a trial: the trial end (the promised free period is kept). */
export function checkoutTiming(trialEndsAt: Date | null, now: Date): { trialEnd: Date | null; billingCycleAnchor: Date | null; firstChargeAt: Date } {
  if (!trialEndsAt || trialEndsAt.getTime() <= now.getTime() + 60_000) return { trialEnd: null, billingCycleAnchor: null, firstChargeAt: now };
  if (trialEndsAt.getTime() - now.getTime() >= CHECKOUT_MIN_TRIAL_END_MS) return { trialEnd: trialEndsAt, billingCycleAnchor: null, firstChargeAt: trialEndsAt };
  return { trialEnd: null, billingCycleAnchor: trialEndsAt, firstChargeAt: trialEndsAt };
}
