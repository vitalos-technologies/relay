// V4 billing (BIL) unit tests: Stripe-Signature verification (docs.stripe.com/webhooks "Verify webhook signatures manually"),
// Stripe-shaped fixtures (tests/fixtures/stripe — snapshot events, fake ids, signed locally with a throwaway secret), the
// normalisers, the Stripe adapter's request encoding (stubbed fetch; no network, no keys) and the billing policy.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { computeSignature, parseSignatureHeader, signPayload, StripeSignatureError, verifySignature } from '@social-lite/providers/stripe/signature';
import { normalizeCheckoutSession, normalizeInvoice, normalizeSubscription, summarizePaymentMethod, workspaceIdOf } from '@social-lite/providers/stripe/normalize';
import { StripeBillingProvider, formEncode } from '@social-lite/providers/stripe/client';
import { ACCESS_REASONS, TRANSITIONS, checkoutTiming, classifyChange, deriveAccess, deriveStatus, isDocumentedTransition } from '@social-lite/services/billing/policy';
import { recurringTotalMinor, formatMinorGBP, publicCatalogue } from '@social-lite/core/contracts/v4-plans';
import { catalogueHash, planVersionDefinition } from '@social-lite/services/billing/catalogue-def';
import type { ProviderSubscription } from '@social-lite/providers/stripe/types';

const fx = (name: string) => readFileSync(join(__dirname, '..', 'fixtures', 'stripe', `${name}.json`), 'utf8');
const SECRET = 'whsec_unit_test_only_0123456789';
const T = 1794000000;

describe('Stripe-Signature verification', () => {
  const raw = fx('checkout.session.completed');
  it('accepts a correct v1 signature within tolerance (raw body, t.payload, HMAC-SHA256 hex)', () => {
    const header = signPayload(raw, SECRET, T);
    expect(header).toBe(`t=${T},v1=${computeSignature(SECRET, T, raw)}`);
    expect(verifySignature(raw, header, [SECRET], { now: T + 10 })).toBe(T);
  });
  it('rejects a modified body, a wrong secret, a missing header and stale or future timestamps', () => {
    const header = signPayload(raw, SECRET, T);
    const reason = (f: () => unknown) => { try { f(); return null; } catch (e) { return (e as StripeSignatureError).reason; } };
    expect(reason(() => verifySignature(raw.replace('"paid"', '"unpaid"'), header, [SECRET], { now: T }))).toBe('no_matching_signature');
    expect(reason(() => verifySignature(raw, header, ['whsec_other'], { now: T }))).toBe('no_matching_signature');
    expect(reason(() => verifySignature(raw, null, [SECRET], { now: T }))).toBe('missing_header');
    expect(reason(() => verifySignature(raw, header, [SECRET], { now: T + 301 }))).toBe('timestamp_outside_tolerance');
    expect(reason(() => verifySignature(raw, header, [SECRET], { now: T - 301 }))).toBe('timestamp_outside_tolerance');
    expect(reason(() => verifySignature(raw, header, [], { now: T }))).toBe('no_secret');
    expect(reason(() => verifySignature(raw, 'v1=abc', [SECRET], { now: T }))).toBe('malformed_header');
  });
  it('ignores v0 (fake test scheme) to prevent downgrade, and accepts any of several v1 during secret rotation', () => {
    const v0only = `t=${T},v0=${computeSignature(SECRET, T, raw)}`;
    expect(() => verifySignature(raw, v0only, [SECRET], { now: T })).toThrow(StripeSignatureError);
    const rotated = signPayload(raw, ['whsec_new_secret_1', SECRET], T);
    expect(parseSignatureHeader(rotated).v1).toHaveLength(2);
    expect(verifySignature(raw, rotated, [SECRET], { now: T })).toBe(T);
    expect(verifySignature(raw, signPayload(raw, SECRET, T), ['whsec_current', SECRET], { now: T })).toBe(T); // previous secret still accepted
  });
  it('refuses a zero tolerance (it would disable the replay check)', () => {
    expect(() => verifySignature(raw, signPayload(raw, SECRET, T), [SECRET], { now: T, toleranceSeconds: 0 })).toThrow(/tolerance/);
  });
});

describe('normalisers (fixtures)', () => {
  it('subscription: item-level period fields, quantity, cancellation', () => {
    const s = normalizeSubscription(JSON.parse(fx('customer.subscription.updated')).data.object);
    expect(s).toMatchObject({ ref: 'sub_1QfixtureSub0001', customer_ref: 'cus_Tfixture0001', status: 'active', price_ref: 'price_1QfixtureStandard', quantity: 3, cancel_at_period_end: true, item_ref: 'si_Tfixture0001' });
    expect(s.current_period_end!.getTime()).toBe(1796592000 * 1000);
    const d = normalizeSubscription(JSON.parse(fx('customer.subscription.deleted')).data.object);
    expect(d.status).toBe('canceled');
    expect(d.ended_at!.getTime()).toBe(1796592000 * 1000);
  });
  it('older subscription-level periods and expanded customer objects are tolerated', () => {
    const s = normalizeSubscription({ id: 'sub_x', customer: { id: 'cus_y' }, status: 'weird', current_period_end: 10, items: { data: [{ id: 'si', price: 'price_z', quantity: 2 }] } });
    expect(s).toMatchObject({ customer_ref: 'cus_y', status: 'incomplete', price_ref: 'price_z', quantity: 2 });
    expect(s.current_period_end!.getTime()).toBe(10_000);
  });
  it('invoice: subscription from parent.subscription_details, links, amounts', () => {
    const i = normalizeInvoice(JSON.parse(fx('invoice.payment_failed')).data.object);
    expect(i).toMatchObject({ ref: 'in_1QfixtureInvoice02', subscription_ref: 'sub_1QfixtureSub0001', status: 'open', currency: 'GBP', amount_due: 3000, number: 'RELAY-0002' });
    expect(i.hosted_url).toMatch(/^https:\/\/invoice\.stripe\.com/);
  });
  it('checkout session + workspace id from metadata', () => {
    const o = JSON.parse(fx('checkout.session.completed')).data.object;
    expect(normalizeCheckoutSession(o)).toMatchObject({ status: 'complete', subscription_ref: 'sub_1QfixtureSub0001', customer_ref: 'cus_Tfixture0001' });
    expect(workspaceIdOf(o)).toBe('4b0f6c55-58a3-4c50-9d77-8e8c3c7e0a11');
    expect(workspaceIdOf(JSON.parse(fx('invoice.payment_failed')).data.object)).toBe('4b0f6c55-58a3-4c50-9d77-8e8c3c7e0a11');
  });
  it('payment method summary keeps brand, last 4 and expiry only', () => {
    expect(summarizePaymentMethod({ type: 'card', card: { brand: 'visa', last4: '4242', exp_month: 1, exp_year: 2030, fingerprint: 'secret' } })).toEqual({ brand: 'visa', last4: '4242', exp_month: 1, exp_year: 2030 });
    expect(summarizePaymentMethod({ type: 'bacs_debit', bacs_debit: { last4: '2345' } })).toEqual({ brand: 'bacs debit', last4: '2345', exp_month: null, exp_year: null });
    expect(summarizePaymentMethod(null)).toBeNull();
  });
});

describe('Stripe adapter requests (stubbed fetch)', () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    if (url.includes('/v1/subscriptions/sub_missing')) return new Response(JSON.stringify({ error: { type: 'invalid_request_error', code: 'resource_missing', message: 'No such subscription' } }), { status: 404 });
    if (url.includes('/v1/checkout/sessions')) return new Response(JSON.stringify({ id: 'cs_test_1', status: 'open', url: 'https://checkout.stripe.com/c/pay/cs_test_1', livemode: false }), { status: 200 });
    return new Response(JSON.stringify(JSON.parse(fx('customer.subscription.updated')).data.object), { status: 200 });
  }) as unknown as typeof fetch;
  const p = new StripeBillingProvider({ secretKey: 'sk_test_unit000000', webhookSecrets: [SECRET], fetchImpl });

  it('form-encodes nested params and sends version + idempotency headers', async () => {
    expect(formEncode({ a: { b: [{ c: 1 }], d: null }, e: 'x y' })).toBe('a%5Bb%5D%5B0%5D%5Bc%5D=1&e=x%20y');
    const trialEnd = new Date(1794500000 * 1000);
    await p.createCheckoutSession({ customerRef: 'cus_1', priceRef: 'price_1', quantity: 3, workspaceId: 'ws1', checkoutId: 'ck1', trialEnd, billingCycleAnchor: null,
      successUrl: 'https://relay.example/settings/workspace/billing?checkout=returned&session={CHECKOUT_SESSION_ID}', cancelUrl: 'https://relay.example/x', expiresAt: new Date(1794003600 * 1000), idempotencyKey: 'relay-checkout-ck1' });
    const c = calls.at(-1)!;
    const body = decodeURIComponent(String(c.init.body));
    expect(c.url).toBe('https://api.stripe.com/v1/checkout/sessions');
    expect(body).toContain('mode=subscription');
    expect(body).toContain('line_items[0][quantity]=3');
    expect(body).toContain('subscription_data[trial_end]=1794500000');
    expect(body).toContain('client_reference_id=ws1');
    expect(body).not.toContain('billing_cycle_anchor');
    const h = c.init.headers as Record<string, string>;
    expect(h['idempotency-key']).toBe('relay-checkout-ck1');
    expect(h['stripe-version']).toBe('2026-10-28.endive');
    expect(h.authorization).toBe('Bearer sk_test_unit000000');
  });
  it('inside the last 48 h of a trial uses billing_cycle_anchor with no proration instead of trial_end', async () => {
    await p.createCheckoutSession({ customerRef: 'cus_1', priceRef: 'price_1', quantity: 1, workspaceId: 'ws1', checkoutId: 'ck2', trialEnd: null, billingCycleAnchor: new Date(1794100000 * 1000),
      successUrl: 'https://r/s', cancelUrl: 'https://r/c', expiresAt: new Date(), idempotencyKey: 'k2' });
    const body = decodeURIComponent(String(calls.at(-1)!.init.body));
    expect(body).toContain('subscription_data[billing_cycle_anchor]=1794100000');
    expect(body).toContain('subscription_data[proration_behavior]=none');
  });
  it('missing objects come back as null; live keys are recognised; dashboard links point at test mode', async () => {
    expect(await p.retrieveSubscription('sub_missing')).toBeNull();
    expect((await p.retrieveSubscription('sub_1QfixtureSub0001'))!.quantity).toBe(3);
    expect(p.livemode).toBe(false);
    expect(p.dashboardUrl('customer', 'cus_1')).toBe('https://dashboard.stripe.com/test/customers/cus_1');
    expect(() => new StripeBillingProvider({ secretKey: 'pk_live_x', webhookSecrets: [] })).toThrow();
  });
});

describe('billing policy', () => {
  const now = new Date('2026-11-08T12:00:00Z');
  const sub = (o: Partial<ProviderSubscription>): ProviderSubscription => ({ ref: 's', customer_ref: 'c', status: 'active', item_ref: 'i', price_ref: 'p', quantity: 1, current_period_start: null,
    current_period_end: new Date('2026-12-08T12:00:00Z'), trial_start: null, trial_end: null, cancel_at_period_end: false, cancel_at: null, canceled_at: null, ended_at: null,
    latest_invoice_ref: null, default_payment_method_ref: null, metadata: {}, livemode: false, created: now, ...o });
  const trial = { started_at: new Date('2026-11-01T00:00:00Z'), ends_at: new Date('2026-11-15T00:00:00Z') };
  it('derives status from provider truth plus the local trial', () => {
    expect(deriveStatus({ sub: null, trial, actionRequired: false, now })).toBe('trialing');
    expect(deriveStatus({ sub: null, trial: { ...trial, ends_at: new Date('2026-11-07T00:00:00Z') }, actionRequired: false, now })).toBe('expired');
    expect(deriveStatus({ sub: null, trial: null, actionRequired: false, now })).toBe('none');
    expect(deriveStatus({ sub: sub({ cancel_at_period_end: true }), trial: null, actionRequired: false, now })).toBe('cancel_scheduled');
    expect(deriveStatus({ sub: sub({ status: 'past_due' }), trial: null, actionRequired: true, now })).toBe('payment_action_required');
    expect(deriveStatus({ sub: sub({ status: 'canceled' }), trial, actionRequired: false, now })).toBe('trialing'); // cancelled during the no-card trial: the trial runs out as promised
    expect(deriveStatus({ sub: sub({ status: 'canceled' }), trial: null, actionRequired: false, now })).toBe('cancelled');
    expect(deriveStatus({ sub: sub({ status: 'incomplete_expired' }), trial: null, actionRequired: false, now })).toBe('none');
    expect(deriveStatus({ sub: sub({ status: 'paused' }), trial: null, actionRequired: false, now })).toBe('expired');
  });
  it('keeps billing status, service suspension and access as separate dimensions', () => {
    expect(deriveAccess({ status: 'active', serviceSuspended: true, graceEndsAt: null, trialEndsAt: null, cancelAt: null, now })).toEqual({ access: 'suspended', reason: ACCESS_REASONS.suspended, free: false });
    expect(deriveAccess({ status: 'past_due', serviceSuspended: false, graceEndsAt: new Date('2026-11-10T00:00:00Z'), trialEndsAt: null, cancelAt: null, now }).access).toBe('full');
    expect(deriveAccess({ status: 'past_due', serviceSuspended: false, graceEndsAt: new Date('2026-11-01T00:00:00Z'), trialEndsAt: null, cancelAt: null, now })).toMatchObject({ access: 'restricted', free: false });
    expect(deriveAccess({ status: 'legacy', serviceSuspended: false, graceEndsAt: null, trialEndsAt: null, cancelAt: null, now }).access).toBe('full');
    expect(deriveAccess({ status: 'none', serviceSuspended: false, graceEndsAt: null, trialEndsAt: null, cancelAt: null, now }).access).toBe('restricted');
  });
  it('D33: no paid entitlement in force ⇒ Free (full access within Free limits), never restricted', () => {
    const base = { serviceSuspended: false, graceEndsAt: null, cancelAt: null, now };
    const past = new Date('2026-11-01T00:00:00Z');
    const future = new Date('2026-11-20T00:00:00Z');
    expect(deriveAccess({ ...base, status: 'free', trialEndsAt: null })).toEqual({ access: 'full', reason: null, free: true });
    expect(deriveAccess({ ...base, status: 'trialing', trialEndsAt: past })).toEqual({ access: 'full', reason: null, free: true }); // no-card trial ended
    expect(deriveAccess({ ...base, status: 'trialing', trialEndsAt: past, liveSubscription: true })).toEqual({ access: 'full', reason: null, free: false }); // provider trial: first charge pending
    expect(deriveAccess({ ...base, status: 'trialing', trialEndsAt: future }).free).toBe(false);
    expect(deriveAccess({ ...base, status: 'expired', trialEndsAt: past })).toMatchObject({ access: 'full', free: true });
    expect(deriveAccess({ ...base, status: 'cancelled', trialEndsAt: null })).toMatchObject({ access: 'full', free: true });
    expect(deriveAccess({ ...base, status: 'cancel_scheduled', trialEndsAt: null, cancelAt: past })).toMatchObject({ access: 'full', free: true });
    expect(deriveAccess({ ...base, status: 'cancel_scheduled', trialEndsAt: null, cancelAt: future })).toMatchObject({ access: 'full', free: false });
    expect(deriveAccess({ ...base, status: 'incomplete', trialEndsAt: null })).toMatchObject({ access: 'full', free: true }); // declined upgrade never worse than Free
    expect(deriveAccess({ ...base, status: 'free', trialEndsAt: null, serviceSuspended: true })).toMatchObject({ access: 'suspended', free: true });
  });
  it('documents the lifecycle transitions of the brief (§10)', () => {
    for (const [a, b] of [['none', 'trialing'], ['trialing', 'active'], ['trialing', 'expired'], ['active', 'past_due'], ['past_due', 'active'], ['active', 'cancel_scheduled'], ['cancel_scheduled', 'active'], ['cancel_scheduled', 'cancelled'], ['expired', 'active'],
      ['none', 'free'], ['trialing', 'free'], ['cancel_scheduled', 'free'], ['free', 'trialing'], ['free', 'active']] as const) {
      expect(isDocumentedTransition(a, b), `${a} → ${b}`).toBe(true);
    }
    expect(isDocumentedTransition('cancelled', 'past_due')).toBe(false);
    expect(TRANSITIONS.length).toBeGreaterThan(10);
  });
  it('classifies changes and computes checkout timing (first charge = trial end; ≥ 48 h → trial_end else anchor)', () => {
    expect(classifyChange({ fromUnit: 1000, toUnit: 2500, fromSeats: 2, toSeats: 2 })).toBe('immediate');
    expect(classifyChange({ fromUnit: 2500, toUnit: 1000, fromSeats: 2, toSeats: 2 })).toBe('scheduled');
    expect(classifyChange({ fromUnit: 1000, toUnit: 1000, fromSeats: 2, toSeats: 1 })).toBe('scheduled');
    expect(classifyChange({ fromUnit: 1000, toUnit: 2500, fromSeats: 3, toSeats: 2 })).toBe('mixed');
    const far = new Date(now.getTime() + 5 * 86400_000);
    expect(checkoutTiming(far, now)).toEqual({ trialEnd: far, billingCycleAnchor: null, firstChargeAt: far });
    const soon = new Date(now.getTime() + 24 * 3600_000);
    expect(checkoutTiming(soon, now)).toEqual({ trialEnd: null, billingCycleAnchor: soon, firstChargeAt: soon });
    expect(checkoutTiming(null, now)).toEqual({ trialEnd: null, billingCycleAnchor: null, firstChargeAt: now });
  });
  it('prices (D33): Free £0, Standard £5, Professional £15; 3 Standard users £15, 3 Professional users £45; ≥ 1 seat', () => {
    expect(publicCatalogue().map((p) => [p.id, p.unit_amount_minor, p.trial_days])).toEqual([['free', 0, 0], ['standard', 500, 14], ['professional', 1500, 14]]);
    expect(formatMinorGBP(recurringTotalMinor('standard', 3))).toBe('£15');
    expect(formatMinorGBP(recurringTotalMinor('professional', 3))).toBe('£45');
    expect(recurringTotalMinor('free', 1)).toBe(0);
    expect(() => recurringTotalMinor('standard', 0)).toThrow();
    expect(catalogueHash(planVersionDefinition('standard'))).toMatch(/^[0-9a-f]{64}$/);
  });
});
