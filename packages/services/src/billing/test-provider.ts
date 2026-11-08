// Deterministic billing test double (non-production only; selected by provider.ts when no Stripe keys exist). It keeps
// Stripe-SHAPED objects in billing_test_objects and emits Stripe-shaped events signed with the same `Stripe-Signature` v1
// scheme, delivered through the production webhook ingestion (ingestWebhook → verifySignature → event store). Nothing here
// charges anyone; everything it shows is labelled Test mode. Hosted pages are in-app test pages (/billing-test/*).
import { randomUUID } from 'node:crypto';
import { AppError } from '@social-lite/core';
import { getPool, maybeOne, type Queryable } from '@social-lite/db';
import { normalizeCheckoutSession, normalizeInvoice, normalizeSubscription, summarizePaymentMethod } from '@social-lite/providers/stripe/normalize';
import { signPayload } from '@social-lite/providers/stripe/signature';
import type { BillingProvider, ChangePreview, PortalFlow, ProviderCheckoutSession, ProviderInvoice, ProviderSubscription } from '@social-lite/providers/stripe/types';
import { config } from '../config.js';

type Obj = Record<string, unknown>;
export const TEST_API_VERSION = '2026-10-28.endive';
/** Dev/test-only signing secret for test-double events (not a credential; never accepted when Stripe is configured). */
export function testWebhookSecret(): string { return process.env.BILLING_TEST_WEBHOOK_SECRET || 'whsec_relay_local_test_double_only'; }

const id = (prefix: string) => `${prefix}_test_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
const secs = (d: Date | number) => Math.floor((typeof d === 'number' ? d : d.getTime()) / 1000);
const addMonth = (s: number) => { const d = new Date(s * 1000); d.setUTCMonth(d.getUTCMonth() + 1); return secs(d); };
const app = (p: string) => new URL(p, config().APP_BASE_URL).toString();

async function put(db: Queryable, kind: string, ref: string, data: Obj): Promise<void> {
  await db.query(`INSERT INTO billing_test_objects(kind, ref, data) VALUES ($1,$2,$3) ON CONFLICT (kind, ref) DO UPDATE SET data=EXCLUDED.data, updated_at=now()`, [kind, ref, JSON.stringify(data)]);
}
async function get(db: Queryable, kind: string, ref: string): Promise<Obj | null> {
  return (await maybeOne<{ data: Obj }>(db, `SELECT data FROM billing_test_objects WHERE kind=$1 AND ref=$2`, [kind, ref]))?.data ?? null;
}
async function unitAmount(db: Queryable, priceRef: string): Promise<number> {
  const r = await maybeOne<{ unit_amount_minor: number | null }>(db,
    `SELECT v.unit_amount_minor FROM billing_provider_prices p JOIN billing_plan_versions v ON v.id=p.plan_version_id WHERE p.provider='test' AND p.price_ref=$1`, [priceRef]);
  if (r?.unit_amount_minor == null) throw new AppError('validation_failed', `No such price: ${priceRef}`);
  return r.unit_amount_minor;
}

export function testEvent(type: string, object: Obj, created = Date.now()): Obj {
  return { id: id('evt'), object: 'event', api_version: TEST_API_VERSION, created: secs(created), livemode: false, type, data: { object } };
}

export class TestBillingProvider implements BillingProvider {
  readonly name = 'test' as const;
  readonly livemode = false;
  constructor(private readonly db: () => Queryable = getPool) {}
  webhookSecrets(): string[] { return [testWebhookSecret()]; }

  async createCustomer(p: { workspaceId: string; name: string; email: string | null; idempotencyKey: string }) {
    const existing = await maybeOne<{ ref: string }>(this.db(), `SELECT ref FROM billing_test_objects WHERE kind='customer' AND data->>'_idem'=$1`, [p.idempotencyKey]);
    if (existing) return { ref: existing.ref };
    const ref = id('cus');
    await put(this.db(), 'customer', ref, { id: ref, object: 'customer', name: p.name, email: p.email, metadata: { relay_workspace_id: p.workspaceId }, invoice_settings: { default_payment_method: null }, livemode: false, _idem: p.idempotencyKey });
    return { ref };
  }

  async createCheckoutSession(p: Parameters<BillingProvider['createCheckoutSession']>[0]): Promise<ProviderCheckoutSession> {
    const existing = await maybeOne<{ data: Obj }>(this.db(), `SELECT data FROM billing_test_objects WHERE kind='checkout_session' AND data->>'_idem'=$1`, [p.idempotencyKey]);
    if (existing) return normalizeCheckoutSession(existing.data);
    if (p.trialEnd && p.trialEnd.getTime() - Date.now() < 48 * 3600_000) throw new AppError('validation_failed', 'trial_end must be at least 48 hours in the future');
    await unitAmount(this.db(), p.priceRef);
    const ref = id('cs');
    const meta = { relay_workspace_id: p.workspaceId, relay_checkout_id: p.checkoutId };
    const s: Obj = {
      id: ref, object: 'checkout.session', mode: 'subscription', status: 'open', payment_status: 'unpaid', customer: p.customerRef, client_reference_id: p.workspaceId,
      metadata: meta, url: app(`/billing-test/checkout?session=${ref}`), expires_at: secs(p.expiresAt), created: secs(Date.now()),
      success_url: p.successUrl.replace('{CHECKOUT_SESSION_ID}', ref), cancel_url: p.cancelUrl, line_items: [{ price: p.priceRef, quantity: p.quantity }],
      subscription: null, subscription_data: { trial_end: p.trialEnd ? secs(p.trialEnd) : null, billing_cycle_anchor: !p.trialEnd && p.billingCycleAnchor ? secs(p.billingCycleAnchor) : null, metadata: meta },
      livemode: false, _idem: p.idempotencyKey,
    };
    await put(this.db(), 'checkout_session', ref, s);
    return normalizeCheckoutSession(s);
  }

  async retrieveCheckoutSession(ref: string) { const s = await get(this.db(), 'checkout_session', ref); return s ? normalizeCheckoutSession(s) : null; }

  async expireCheckoutSession(ref: string): Promise<void> {
    const s = await get(this.db(), 'checkout_session', ref);
    if (s && s.status === 'open') await put(this.db(), 'checkout_session', ref, { ...s, status: 'expired' });
  }

  async createPortalSession(p: { customerRef: string; returnUrl: string; flow: PortalFlow; subscriptionRef?: string | null }) {
    const ref = id('bps');
    await put(this.db(), 'portal_session', ref, { id: ref, customer: p.customerRef, return_url: p.returnUrl, flow: p.flow, subscription: p.subscriptionRef ?? null, created: secs(Date.now()) });
    return { url: app(`/billing-test/portal?session=${ref}`) };
  }

  async retrieveSubscription(ref: string): Promise<ProviderSubscription | null> { const s = await get(this.db(), 'subscription', ref); return s ? normalizeSubscription(s) : null; }

  async previewChange(p: Parameters<BillingProvider['previewChange']>[0]): Promise<ChangePreview> {
    const s = await get(this.db(), 'subscription', p.subscriptionRef);
    if (!s) throw new AppError('not_found', 'Subscription not found');
    const n = normalizeSubscription(s);
    const oldUnit = await unitAmount(this.db(), n.price_ref!);
    const newUnit = await unitAmount(this.db(), p.priceRef);
    const start = secs(n.current_period_start ?? new Date());
    const end = secs(n.current_period_end ?? new Date());
    const frac = end > start ? Math.max(0, Math.min(1, (end - p.prorationDate) / (end - start))) : 0;
    const prorate = p.prorationBehavior !== 'none' && n.status !== 'trialing';
    const proration = prorate ? Math.round((newUnit * p.quantity - oldUnit * n.quantity) * frac) : 0;
    const lines = [
      ...(prorate && proration !== 0 ? [{ description: 'Remaining time on the new plan (prorated)', amount_minor: proration, proration: true }] : []),
      { description: `${p.quantity} × seat`, amount_minor: newUnit * p.quantity, proration: false },
    ];
    return { currency: 'GBP', proration_minor: proration, next_invoice_minor: newUnit * p.quantity + proration, next_invoice_at: n.trial_end && n.status === 'trialing' ? n.trial_end : n.current_period_end, proration_date: p.prorationDate, lines };
  }

  async updateSubscription(p: Parameters<BillingProvider['updateSubscription']>[0]): Promise<ProviderSubscription> {
    const s = await get(this.db(), 'subscription', p.subscriptionRef);
    if (!s) throw new AppError('not_found', 'Subscription not found');
    if (['canceled', 'incomplete_expired'].includes(String(s.status))) throw new AppError('invalid_state', 'This subscription has ended');
    const item = ((s.items as Obj).data as Obj[])[0]!;
    const next: Obj = { ...s };
    if (p.priceRef || p.quantity) {
      const price = p.priceRef ?? String((item.price as Obj).id);
      const qty = p.quantity ?? Number(item.quantity);
      const pv = await this.previewChange({ subscriptionRef: p.subscriptionRef, itemRef: String(item.id), priceRef: price, quantity: qty, prorationDate: p.prorationDate ?? secs(Date.now()), prorationBehavior: p.prorationBehavior ?? 'create_prorations' });
      next.items = { object: 'list', data: [{ ...item, price: { id: price, unit_amount: await unitAmount(this.db(), price), currency: 'gbp' }, quantity: qty }] };
      next._pending_proration_minor = Number(s._pending_proration_minor ?? 0) + pv.proration_minor;
    }
    if (p.cancelAtPeriodEnd != null) { next.cancel_at_period_end = p.cancelAtPeriodEnd; next.cancel_at = p.cancelAtPeriodEnd ? item.current_period_end : null; next.canceled_at = p.cancelAtPeriodEnd ? secs(Date.now()) : null; }
    await put(this.db(), 'subscription', p.subscriptionRef, next);
    await deliverTestEvents([testEvent('customer.subscription.updated', next)]);
    return normalizeSubscription(next);
  }

  async retrieveInvoice(ref: string): Promise<ProviderInvoice | null> { const i = await get(this.db(), 'invoice', ref); return i ? normalizeInvoice(i) : null; }

  async listInvoices(customerRef: string, limit: number): Promise<ProviderInvoice[]> {
    const rows = await this.db().query<{ data: Obj }>(`SELECT data FROM billing_test_objects WHERE kind='invoice' AND data->>'customer'=$1 ORDER BY (data->>'created')::bigint DESC LIMIT $2`, [customerRef, limit]);
    return rows.rows.map((r) => normalizeInvoice(r.data));
  }

  async paymentMethodSummary(customerRef: string) {
    const c = await get(this.db(), 'customer', customerRef);
    return summarizePaymentMethod((c?.invoice_settings as Obj | undefined)?.default_payment_method);
  }

  dashboardUrl(): string | null { return null; } // no provider dashboard for the test double
}

// ------------------------------------------------------------------ test controls (simulate the outside world)
const TEST_CARD = { id: 'pm_test_card_visa', object: 'payment_method', type: 'card', card: { brand: 'visa', last4: '4242', exp_month: 12, exp_year: new Date().getUTCFullYear() + 3 } };

/** Sign and deliver events through the production ingestion path (signature verified, stored, deduplicated). */
export async function deliverTestEvents(events: Obj[]): Promise<void> {
  const { ingestWebhook } = await import('./webhooks.js');
  for (const e of events) {
    const raw = JSON.stringify(e);
    await ingestWebhook(raw, signPayload(raw, testWebhookSecret()), { provider: 'test' });
  }
}

async function newInvoice(db: Queryable, sub: Obj, opts: { amount: number; status: 'paid' | 'open'; reason: string; periodStart: number; periodEnd: number }): Promise<Obj> {
  const ref = id('in');
  const n = await maybeOne<{ n: number }>(db, `SELECT count(*)::int n FROM billing_test_objects WHERE kind='invoice'`);
  const inv: Obj = {
    id: ref, object: 'invoice', customer: sub.customer, parent: { type: 'subscription_details', subscription_details: { subscription: sub.id, metadata: sub.metadata } },
    number: `TEST-${String((n?.n ?? 0) + 1).padStart(4, '0')}`, status: opts.status, currency: 'gbp', amount_due: opts.amount, amount_paid: opts.status === 'paid' ? opts.amount : 0,
    total: opts.amount, hosted_invoice_url: null, invoice_pdf: null, period_start: opts.periodStart, period_end: opts.periodEnd, created: secs(Date.now()),
    billing_reason: opts.reason, livemode: false,
  };
  await put(db, 'invoice', ref, inv);
  return inv;
}

export type TestCheckoutOutcome = 'paid' | 'declined' | 'requires_action';

/** The customer completes hosted checkout with a test card. Returns the events (already delivered unless deliver=false). */
export async function completeTestCheckout(sessionRef: string, outcome: TestCheckoutOutcome = 'paid', opts: { deliver?: boolean } = {}): Promise<Obj[]> {
  const db = getPool();
  const s = await get(db, 'checkout_session', sessionRef);
  if (!s) throw new AppError('not_found', 'Checkout session not found');
  if (s.status !== 'open' || (s.expires_at as number) * 1000 <= Date.now()) throw new AppError('invalid_state', 'This checkout is no longer open');
  const li = (s.line_items as Obj[])[0]!;
  const sd = s.subscription_data as Obj;
  const unit = await unitAmount(db, String(li.price));
  const qty = Number(li.quantity);
  const now = secs(Date.now());
  const trialEnd = typeof sd.trial_end === 'number' ? sd.trial_end : null;
  const anchor = typeof sd.billing_cycle_anchor === 'number' ? sd.billing_cycle_anchor : null;
  const periodEnd = trialEnd ?? anchor ?? addMonth(now);
  const subRef = id('sub');
  const customer = await get(db, 'customer', String(s.customer));
  if (customer) await put(db, 'customer', String(s.customer), { ...customer, invoice_settings: { default_payment_method: TEST_CARD } });
  const sub: Obj = {
    id: subRef, object: 'subscription', customer: s.customer, status: trialEnd ? 'trialing' : outcome === 'paid' ? 'active' : 'incomplete',
    items: { object: 'list', data: [{ id: id('si'), object: 'subscription_item', price: { id: li.price, unit_amount: unit, currency: 'gbp' }, quantity: qty, current_period_start: now, current_period_end: periodEnd }] },
    trial_start: trialEnd ? now : null, trial_end: trialEnd, cancel_at_period_end: false, cancel_at: null, canceled_at: null, ended_at: null,
    latest_invoice: null, default_payment_method: TEST_CARD.id, metadata: sd.metadata, created: now, livemode: false,
  };
  const free = !!(trialEnd || anchor);
  const inv = await newInvoice(db, sub, { amount: free ? 0 : unit * qty, status: free || outcome === 'paid' ? 'paid' : 'open', reason: 'subscription_create', periodStart: now, periodEnd });
  sub.latest_invoice = inv.id;
  await put(db, 'subscription', subRef, sub);
  const done = { ...s, status: 'complete', payment_status: free ? 'no_payment_required' : outcome === 'paid' ? 'paid' : 'unpaid', subscription: subRef };
  await put(db, 'checkout_session', sessionRef, done);
  const events = [
    testEvent('checkout.session.completed', done),
    testEvent('customer.subscription.created', sub),
    testEvent(inv.status === 'paid' ? 'invoice.paid' : outcome === 'requires_action' ? 'invoice.payment_action_required' : 'invoice.payment_failed', inv),
  ];
  if (opts.deliver !== false) await deliverTestEvents(events);
  return events;
}

export async function expireTestCheckout(sessionRef: string, opts: { deliver?: boolean } = {}): Promise<Obj[]> {
  const db = getPool();
  const s = await get(db, 'checkout_session', sessionRef);
  if (!s || s.status !== 'open') return [];
  const done = { ...s, status: 'expired' };
  await put(db, 'checkout_session', sessionRef, done);
  const events = [testEvent('checkout.session.expired', done)];
  if (opts.deliver !== false) await deliverTestEvents(events);
  return events;
}

export type TestSubscriptionAction = 'renew' | 'fail_payment' | 'require_action' | 'recover' | 'update_card' | 'end_now';

/** Simulate what happens at the provider over time (renewal, failed payment, recovery …). */
export async function simulateSubscription(subRef: string, action: TestSubscriptionAction, opts: { deliver?: boolean } = {}): Promise<Obj[]> {
  const db = getPool();
  const s = await get(db, 'subscription', subRef);
  if (!s) throw new AppError('not_found', 'Subscription not found');
  const item = ((s.items as Obj).data as Obj[])[0]!;
  const unit = Number((item.price as Obj).unit_amount);
  const qty = Number(item.quantity);
  const events: Obj[] = [];
  const next: Obj = { ...s };
  const advance = () => {
    const start = Number(item.current_period_end);
    next.items = { object: 'list', data: [{ ...item, current_period_start: start, current_period_end: addMonth(start) }] };
    return start;
  };
  switch (action) {
    case 'renew': {
      if (s.cancel_at_period_end) {
        Object.assign(next, { status: 'canceled', ended_at: Number(item.current_period_end), canceled_at: s.canceled_at ?? secs(Date.now()) });
        events.push(testEvent('customer.subscription.deleted', next));
        break;
      }
      const start = advance();
      const amount = unit * qty + Number(s._pending_proration_minor ?? 0);
      const inv = await newInvoice(db, s, { amount, status: 'paid', reason: 'subscription_cycle', periodStart: start, periodEnd: addMonth(start) });
      Object.assign(next, { status: 'active', latest_invoice: inv.id, _pending_proration_minor: 0, trial_end: s.status === 'trialing' ? s.trial_end : s.trial_end });
      events.push(testEvent('invoice.paid', inv), testEvent('customer.subscription.updated', next));
      break;
    }
    case 'fail_payment':
    case 'require_action': {
      const start = advance();
      const inv = await newInvoice(db, s, { amount: unit * qty + Number(s._pending_proration_minor ?? 0), status: 'open', reason: 'subscription_cycle', periodStart: start, periodEnd: addMonth(start) });
      Object.assign(next, { status: 'past_due', latest_invoice: inv.id, _pending_proration_minor: 0 });
      events.push(testEvent(action === 'fail_payment' ? 'invoice.payment_failed' : 'invoice.payment_action_required', inv), testEvent('customer.subscription.updated', next));
      break;
    }
    case 'recover': {
      const inv = s.latest_invoice ? await get(db, 'invoice', String(s.latest_invoice)) : null;
      if (inv && inv.status === 'open') {
        const paid = { ...inv, status: 'paid', amount_paid: inv.amount_due };
        await put(db, 'invoice', String(inv.id), paid);
        events.push(testEvent('invoice.paid', paid));
      }
      Object.assign(next, { status: 'active' });
      events.push(testEvent('customer.subscription.updated', next));
      break;
    }
    case 'update_card': {
      const c = await get(db, 'customer', String(s.customer));
      const card = { ...TEST_CARD, id: id('pm'), card: { brand: 'mastercard', last4: '4444', exp_month: 6, exp_year: new Date().getUTCFullYear() + 4 } };
      if (c) { const nc = { ...c, invoice_settings: { default_payment_method: card } }; await put(db, 'customer', String(s.customer), nc); events.push(testEvent('customer.updated', nc)); }
      next.default_payment_method = card.id;
      break;
    }
    case 'end_now': {
      Object.assign(next, { status: 'canceled', ended_at: secs(Date.now()), canceled_at: secs(Date.now()) });
      events.push(testEvent('customer.subscription.deleted', next));
      break;
    }
  }
  await put(db, 'subscription', subRef, next);
  if (opts.deliver !== false) await deliverTestEvents(events);
  return events;
}

export async function testPortalSession(ref: string): Promise<{ customer: string; return_url: string; flow: PortalFlow; subscription: string | null } | null> {
  const s = await get(getPool(), 'portal_session', ref);
  return s ? { customer: String(s.customer), return_url: String(s.return_url), flow: (s.flow as PortalFlow) ?? null, subscription: (s.subscription as string | null) ?? null } : null;
}

export async function testCheckoutSessionRaw(ref: string): Promise<Obj | null> { return get(getPool(), 'checkout_session', ref); }
