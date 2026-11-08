// Billing policy (pure; no IO). Three SEPARATE dimensions (brief V4 §10):
//   1. billing status   — SUBSCRIPTION_STATUSES + 'none' | 'legacy'; derived from verified provider state + the local trial.
//   2. service state    — workspaces.state ('active' | 'suspended'), set only by Relay staff; never by billing.
//   3. access level     — derived from 1 + 2: full | restricted (paid actions held) | suspended.
// Documented in docs/v4/BILLING_LIFECYCLE_AND_WEBHOOKS.md (transition table mirrors TRANSITIONS below).
import type { AccessLevel, SubscriptionStatus } from '@social-lite/core/contracts/v4-plans';
import type { ProviderSubscription } from '@social-lite/providers/stripe/types';

export type BillingStatus = SubscriptionStatus | 'none' | 'legacy';

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
  | 'provider_sync';

/** Documented transitions. Provider state is authoritative; an undocumented transition is still applied but flagged. */
export const TRANSITIONS: ReadonlyArray<{ from: BillingStatus[]; to: BillingStatus; on: TransitionTrigger[] }> = [
  { from: ['none'], to: 'trialing', on: ['trial_started'] },
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
}

export const ACCESS_REASONS = {
  suspended: 'This workspace is suspended by Relay. Contact support.',
  trial_expired: 'Your free trial has ended. Choose a plan to continue.',
  cancelled: 'Your subscription has ended. Choose a plan to continue.',
  payment: 'Payment failed. Update your payment details to continue.',
  payment_action: 'Your bank needs you to confirm a payment. Update your payment details to continue.',
  incomplete: 'Your first payment has not completed. Update your payment details to continue.',
  none: 'Choose a plan to start.',
} as const;

export function deriveAccess(i: AccessInput): { access: AccessLevel; reason: string | null } {
  if (i.serviceSuspended) return { access: 'suspended', reason: ACCESS_REASONS.suspended };
  const now = i.now.getTime();
  switch (i.status) {
    case 'legacy':
    case 'active':
      return { access: 'full', reason: null };
    case 'trialing':
      // Persisted status may lag the sweep: the clock decides.
      return i.trialEndsAt && i.trialEndsAt.getTime() <= now ? { access: 'restricted', reason: ACCESS_REASONS.trial_expired } : { access: 'full', reason: null };
    case 'cancel_scheduled':
      return i.cancelAt && i.cancelAt.getTime() <= now ? { access: 'restricted', reason: ACCESS_REASONS.cancelled } : { access: 'full', reason: null };
    case 'past_due':
    case 'payment_action_required':
      return i.graceEndsAt && i.graceEndsAt.getTime() > now ? { access: 'full', reason: null }
        : { access: 'restricted', reason: i.status === 'past_due' ? ACCESS_REASONS.payment : ACCESS_REASONS.payment_action };
    case 'incomplete':
      return i.trialEndsAt && i.trialEndsAt.getTime() > now ? { access: 'full', reason: null } : { access: 'restricted', reason: ACCESS_REASONS.incomplete };
    case 'expired':
      return { access: 'restricted', reason: ACCESS_REASONS.trial_expired };
    case 'cancelled':
      return { access: 'restricted', reason: ACCESS_REASONS.cancelled };
    case 'none':
      return { access: 'restricted', reason: ACCESS_REASONS.none };
  }
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
