// Apply verified provider state to workspace_billing. The provider object passed in is ALWAYS freshly retrieved from the
// provider (webhook processing re-fetches; reconciliation fetches; API responses to our own authenticated calls), never a
// redirect parameter or an unverified payload. Re-applying the same state is a no-op, so duplicates and out-of-order
// events converge on the provider's current truth.
import type { BillingEvent } from '@social-lite/core/contracts/v4-billing';
import type { PaymentMethodSummary, ProviderInvoice, ProviderSubscription } from '@social-lite/providers/stripe/types';
import type { PlanId } from '@social-lite/core/contracts/v4-plans';
import { maybeOne, type Queryable } from '@social-lite/db';
import { log } from '../log.js';
import { currentVersion, versionByPriceRef } from './catalogue.js';
import { freeRow } from './free.js';
import { PAST_DUE_GRACE_DAYS, deriveStatus, type BillingStatus } from './policy.js';
import { lockBilling, saveBilling, type BillingRow, type LifecycleEntry } from './store.js';

const LIVE: readonly string[] = ['trialing', 'active', 'past_due', 'unpaid', 'incomplete', 'paused'];
const PAID_STATES: readonly BillingStatus[] = ['active', 'past_due', 'payment_action_required', 'cancel_scheduled', 'incomplete'];

export interface ApplyResult { row: BillingRow; changed: boolean; ignored?: string }

function eventsFor(prev: BillingRow, next: BillingRow, hadSub: boolean): BillingEvent[] {
  const out: BillingEvent[] = [];
  const a = prev.status;
  const b = next.status;
  const subNew = !!next.provider_subscription_ref && next.provider_subscription_ref !== prev.provider_subscription_ref;
  if ((b === 'active' && !['active', 'past_due', 'payment_action_required', 'cancel_scheduled'].includes(a) && !(a === 'trialing' && hadSub)) || (subNew && ['trialing', 'active', 'incomplete'].includes(b) && !hadSub)) out.push('billing.subscription_activated');
  if ((b === 'past_due' || b === 'payment_action_required') && a !== 'past_due' && a !== 'payment_action_required') out.push('billing.payment_failed');
  if ((a === 'past_due' || a === 'payment_action_required') && (b === 'active' || b === 'cancel_scheduled')) out.push('billing.payment_recovered');
  if (b === 'cancel_scheduled' && a !== 'cancel_scheduled') out.push('billing.cancellation_scheduled');
  if ((b === 'cancelled' || b === 'expired' || b === 'free') && (PAID_STATES.includes(a) || (a === 'trialing' && hadSub))) out.push('billing.subscription_ended');
  if (prev.plan_version_id !== next.plan_version_id || prev.seats !== next.seats || prev.scheduled_effective_at?.getTime() !== next.scheduled_effective_at?.getTime()
      || (a === 'cancel_scheduled' && b !== 'cancel_scheduled' && b !== 'cancelled')) out.push('billing.subscription_changed');
  return [...new Set(out)];
}

/**
 * Apply a provider subscription snapshot to its workspace (inside the caller's transaction).
 * Guards: the subscription must belong to the workspace's provider customer; a second live subscription never replaces a
 * live one silently (flagged for staff as `duplicate_subscription`).
 */
export async function applySubscription(tx: Queryable, workspaceId: string, sub: ProviderSubscription, p: {
  provider: 'stripe' | 'test'; entry: LifecycleEntry; paymentMethod?: PaymentMethodSummary | null; now?: Date;
}): Promise<ApplyResult> {
  const now = p.now ?? new Date();
  const prev = await lockBilling(tx, workspaceId);
  if (prev.provider_customer_ref && sub.customer_ref && prev.provider_customer_ref !== sub.customer_ref) {
    log.warn('billing_customer_mismatch', { workspaceId, subscription: sub.ref });
    return { row: prev, changed: false, ignored: 'customer_mismatch' };
  }
  if (prev.provider_subscription_ref && prev.provider_subscription_ref !== sub.ref) {
    const prevLive = !!prev.provider_status && LIVE.includes(prev.provider_status);
    if (prevLive && LIVE.includes(sub.status)) {
      const seen = await maybeOne(tx, `SELECT 1 FROM billing_lifecycle_events WHERE workspace_id=$1 AND kind='duplicate_subscription' AND detail->>'subscription'=$2`, [workspaceId, sub.ref]);
      if (!seen) {
        await tx.query(`INSERT INTO billing_lifecycle_events(workspace_id, kind, from_status, to_status, source, actor_service, provider_event_id, detail)
                        VALUES ($1,'duplicate_subscription',$2,$2,$3,'billing',$4,$5)`,
          [workspaceId, prev.status, p.entry.source, p.entry.providerEventId ?? null, JSON.stringify({ subscription: sub.ref, kept: prev.provider_subscription_ref })]);
      }
      return { row: prev, changed: false, ignored: 'duplicate_subscription' };
    }
    if (!LIVE.includes(sub.status)) return { row: prev, changed: false, ignored: 'stale_subscription' }; // an old ended one
  }
  const hadSub = !!prev.provider_subscription_ref && !!prev.provider_status && LIVE.includes(prev.provider_status);
  const version = sub.price_ref ? await versionByPriceRef(tx, p.provider, sub.price_ref) : null;
  if (!version) log.warn('billing_unknown_price', { workspaceId, price: sub.price_ref });
  // D33: an upgrade checkout from Free that included the workspace's one trial — record the redemption when the
  // provider confirms the trialing subscription (once per workspace, PK), so the trial can never be used twice. An
  // abandoned checkout records nothing.
  let providerTrial: { start: Date; end: Date; plan: PlanId } | null = null;
  if (!prev.trial_started_at && version && sub.trial_start && sub.trial_end && sub.trial_end.getTime() > sub.trial_start.getTime() && LIVE.includes(sub.status)) {
    const t0 = new Date(Math.floor(sub.trial_start.getTime() / 1000) * 1000);
    const red = await tx.query(
      `INSERT INTO billing_trial_redemptions(workspace_id, plan_id, plan_version_id, redeemed_by, source, started_at, ends_at, original_ends_at)
       SELECT $1, $2, $3, (SELECT created_by FROM billing_checkout_sessions WHERE workspace_id=$1 AND provider_subscription_ref=$5 ORDER BY created_at DESC LIMIT 1), 'settings', $4, $6, $6
       ON CONFLICT (workspace_id) DO NOTHING`,
      [workspaceId, version.plan_id, version.id, t0, sub.ref, sub.trial_end]);
    if (red.rowCount) providerTrial = { start: t0, end: sub.trial_end, plan: version.plan_id };
  }
  const trial = prev.trial_started_at && prev.trial_ends_at ? { started_at: prev.trial_started_at, ends_at: prev.trial_ends_at }
    : providerTrial ? { started_at: providerTrial.start, ends_at: providerTrial.end } : null;
  const status = deriveStatus({ sub, trial, actionRequired: prev.payment_action_required && sub.status !== 'trialing', now });
  const next: BillingRow = { ...prev };
  Object.assign(next, {
    provider: p.provider, livemode: sub.livemode, provider_customer_ref: prev.provider_customer_ref ?? sub.customer_ref, provider_subscription_ref: sub.ref,
    provider_item_ref: sub.item_ref, provider_price_ref: sub.price_ref, provider_status: sub.status, status,
    current_period_start: sub.current_period_start, current_period_end: sub.current_period_end,
    cancel_at_period_end: sub.cancel_at_period_end, cancel_at: sub.cancel_at ?? (sub.cancel_at_period_end ? sub.current_period_end : null),
    cancelled_at: sub.canceled_at, ended_at: sub.ended_at, provider_synced_at: now,
  });
  if (!LIVE.includes(sub.status)) next.payment_action_required = false;
  if (providerTrial) Object.assign(next, { trial_started_at: providerTrial.start, trial_ends_at: providerTrial.end, trial_plan_id: providerTrial.plan });
  // Plan + seats. A pending scheduled change (downgrade / seat reduction) keeps the CURRENT entitlements until its
  // effective instant even though the provider already carries the new price/quantity (proration_behavior=none).
  const target = { versionId: version?.id ?? prev.plan_version_id, planId: version?.plan_id ?? prev.plan_id, seats: sub.quantity };
  const pending = !!prev.scheduled_effective_at && prev.scheduled_effective_at.getTime() > now.getTime();
  const matchesSchedule = pending && (prev.scheduled_plan_version_id ?? prev.plan_version_id) === target.versionId && (prev.scheduled_seats ?? prev.seats) === target.seats;
  if (pending && matchesSchedule && LIVE.includes(sub.status)) {
    // keep plan/seats; schedule stays
  } else {
    next.plan_version_id = target.versionId;
    next.plan_id = target.planId;
    next.seats = target.seats;
    next.scheduled_plan_version_id = null;
    next.scheduled_seats = null;
    next.scheduled_effective_at = null;
  }
  if (status === 'past_due' || status === 'payment_action_required') {
    next.past_due_since = prev.past_due_since ?? now;
    next.grace_ends_at = prev.grace_ends_at ?? new Date(next.past_due_since.getTime() + PAST_DUE_GRACE_DAYS * 86400_000);
  } else if (['active', 'trialing', 'cancel_scheduled'].includes(status)) {
    next.past_due_since = null;
    next.grace_ends_at = null;
  }
  if (p.paymentMethod !== undefined) next.payment_method = p.paymentMethod;
  // D33: an ended subscription (cancelled, or a trial the provider ended without payment) lands on Free — no provider
  // charge, nothing deleted; the provider references stay as history so a later checkout reuses the customer.
  const ended = status === 'cancelled' || (status === 'expired' && !LIVE.includes(sub.status));
  const finalRow = ended ? freeRow(next, (await currentVersion(tx, 'free')).id) : next;
  const saved = await saveBilling(tx, prev, finalRow, p.entry, eventsFor(prev, finalRow, hadSub));
  return { row: saved.row, changed: true };
}

/** Cache an invoice and update the "customer action needed" flag from its CURRENT status (re-fetched). */
export async function applyInvoice(tx: Queryable, workspaceId: string, inv: ProviderInvoice, p: { provider: 'stripe' | 'test'; eventType: string }): Promise<void> {
  await tx.query(
    `INSERT INTO billing_invoices(workspace_id, provider, provider_invoice_ref, number, status, currency, amount_due_minor, amount_paid_minor, total_minor, hosted_url, pdf_url, period_start, period_end, provider_created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     ON CONFLICT (provider, provider_invoice_ref) DO UPDATE SET number=EXCLUDED.number, status=EXCLUDED.status, amount_due_minor=EXCLUDED.amount_due_minor,
       amount_paid_minor=EXCLUDED.amount_paid_minor, total_minor=EXCLUDED.total_minor, hosted_url=EXCLUDED.hosted_url, pdf_url=EXCLUDED.pdf_url, updated_at=now()
     WHERE billing_invoices.workspace_id = EXCLUDED.workspace_id`,
    [workspaceId, p.provider, inv.ref, inv.number, inv.status, inv.currency, inv.amount_due, inv.amount_paid, inv.total, inv.hosted_url, inv.pdf_url, inv.period_start, inv.period_end, inv.created]);
  const prev = await lockBilling(tx, workspaceId);
  if (inv.subscription_ref && prev.provider_subscription_ref && inv.subscription_ref !== prev.provider_subscription_ref) return;
  let flag = prev.payment_action_required;
  if (inv.status === 'paid' || inv.status === 'void' || inv.status === 'uncollectible') flag = false;
  else if (inv.status === 'open' && p.eventType === 'invoice.payment_action_required') flag = true;
  else if (inv.status === 'open' && p.eventType === 'invoice.payment_failed') flag = false; // a plain decline, not an authentication request
  if (flag !== prev.payment_action_required) {
    await tx.query(`UPDATE workspace_billing SET payment_action_required=$2, updated_at=now() WHERE workspace_id=$1`, [workspaceId, flag]);
  }
}
