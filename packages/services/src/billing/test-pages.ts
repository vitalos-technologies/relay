// Backing for the in-app TEST hosted pages (test double only): /billing-test/checkout and /billing-test/portal. They stand in
// for Stripe's hosted Checkout and Customer Portal so the full flow can be exercised without keys. Every outcome reaches
// Relay as signed provider events through the production webhook path (ingestWebhook). Refused unless the active provider is
// the test double; the session must belong to the caller's workspace; billing.manage required.
import { z } from 'zod';
import { AppError, notFound } from '@social-lite/core';
import { PLANS } from '@social-lite/core/contracts/v4-plans';
import { getPool, maybeOne } from '@social-lite/db';
import type { Ctx } from '../context.js';
import { requireAction } from '../tenancy.js';
import { getBillingProvider } from './provider.js';
import { completeTestCheckout, expireTestCheckout, simulateSubscription, testCheckoutSessionRaw, testPortalSession, type TestSubscriptionAction } from './test-provider.js';
import { versionByPriceRef } from './catalogue.js';
import { loadBilling } from './store.js';

function requireTestMode(): void {
  if (getBillingProvider()?.name !== 'test') throw new AppError('not_found', 'Not found');
}

async function ownedSession(ctx: Ctx, ref: string) {
  requireTestMode();
  requireAction(ctx, 'billing.manage');
  if (!/^cs_test_[a-z0-9]{8,40}$/.test(ref)) throw notFound('Checkout');
  const s = await testCheckoutSessionRaw(ref);
  const meta = (s?.metadata ?? {}) as Record<string, string>;
  if (!s || meta.relay_workspace_id !== ctx.access.workspaceId) throw notFound('Checkout');
  return s;
}

export async function testCheckoutSummary(ctx: Ctx, ref: string) {
  const s = await ownedSession(ctx, ref);
  const li = (s.line_items as Array<{ price: string; quantity: number }>)[0]!;
  const v = await versionByPriceRef(getPool(), 'test', li.price);
  const sd = s.subscription_data as { trial_end: number | null; billing_cycle_anchor: number | null };
  const firstCharge = sd.trial_end ?? sd.billing_cycle_anchor;
  const w = await maybeOne<{ name: string }>(getPool(), `SELECT name FROM workspaces WHERE id=$1`, [ctx.access.workspaceId]);
  return {
    session: ref, status: s.status as string, workspace: w?.name ?? '', plan: v ? { id: v.plan_id, name: PLANS[v.plan_id].name, unit_amount_minor: v.unit_amount_minor } : null,
    seats: li.quantity, recurring_minor: (v?.unit_amount_minor ?? 0) * li.quantity, due_today_minor: firstCharge ? 0 : (v?.unit_amount_minor ?? 0) * li.quantity,
    first_charge_at: firstCharge ? new Date(firstCharge * 1000).toISOString() : null, expires_at: new Date((s.expires_at as number) * 1000).toISOString(),
    success_url: s.success_url as string, cancel_url: s.cancel_url as string,
  };
}

const checkoutAction = z.object({ session: z.string().max(80), outcome: z.enum(['paid', 'declined', 'requires_action', 'cancel']) }).strict();

export async function testCheckoutAction(ctx: Ctx, raw: unknown) {
  const input = checkoutAction.parse(raw);
  const s = await ownedSession(ctx, input.session);
  if (input.outcome === 'cancel') {
    await expireTestCheckout(input.session);
    return { redirect: s.cancel_url as string };
  }
  await completeTestCheckout(input.session, input.outcome);
  return { redirect: s.success_url as string };
}

async function ownedPortal(ctx: Ctx, ref: string) {
  requireTestMode();
  requireAction(ctx, 'billing.manage');
  if (!/^bps_test_[a-z0-9]{8,40}$/.test(ref)) throw notFound('Portal');
  const s = await testPortalSession(ref);
  const b = await loadBilling(getPool(), ctx.access.workspaceId);
  if (!s || !b || b.provider_customer_ref !== s.customer) throw notFound('Portal');
  return { s, b };
}

export async function testPortalSummary(ctx: Ctx, ref: string) {
  const { s, b } = await ownedPortal(ctx, ref);
  return {
    session: ref, flow: s.flow, return_url: s.return_url, plan: PLANS[b.plan_id].name, status: b.status, seats: b.seats,
    cancel_at_period_end: b.cancel_at_period_end, current_period_end: b.current_period_end?.toISOString() ?? null, payment_method: b.payment_method,
    has_subscription: !!b.provider_subscription_ref,
  };
}

const portalAction = z.object({ session: z.string().max(80), action: z.enum(['update_card', 'cancel', 'resume', 'renew', 'fail_payment', 'require_action', 'recover']) }).strict();

export async function testPortalAction(ctx: Ctx, raw: unknown) {
  const input = portalAction.parse(raw);
  const { s, b } = await ownedPortal(ctx, input.session);
  if (!b.provider_subscription_ref) throw new AppError('invalid_state', 'No subscription');
  if (input.action === 'cancel' || input.action === 'resume') {
    // The portal changes the subscription at the provider; Relay learns it from the signed customer.subscription.updated event.
    const p = getBillingProvider()!;
    await p.updateSubscription({ subscriptionRef: b.provider_subscription_ref, cancelAtPeriodEnd: input.action === 'cancel', idempotencyKey: `test-portal-${input.session}-${input.action}-${Date.now()}` });
  } else {
    await simulateSubscription(b.provider_subscription_ref, input.action as TestSubscriptionAction);
  }
  return { ok: true as const, return_url: s.return_url };
}
