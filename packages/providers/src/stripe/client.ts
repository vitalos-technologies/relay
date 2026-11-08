// Stripe Billing adapter over plain fetch (no SDK: a dozen form-encoded calls do not justify a large dependency in both the
// web and worker bundles). Only hosted flows: Checkout (subscription mode, per-seat quantity) and the Customer Portal —
// card data never touches Relay. Every mutating call carries an Idempotency-Key. API version pinned (RELAY_STRIPE_API_VERSION).
// No keys exist in this environment; this adapter is exercised by unit tests with a stubbed fetch, and goes live only when
// an operator configures RELAY_STRIPE_SECRET_KEY + RELAY_STRIPE_WEBHOOK_SECRET (activation checklist).
import { normalizeCheckoutSession, normalizeInvoice, normalizeSubscription, summarizePaymentMethod } from './normalize.js';
import {
  BillingProviderError, type BillingProvider, type ChangePreview, type PaymentMethodSummary, type PortalFlow, type ProviderCheckoutSession,
  type ProviderInvoice, type ProviderSubscription,
} from './types.js';

export const STRIPE_API_VERSION_DEFAULT = '2026-10-28.endive';
const API = 'https://api.stripe.com';

export interface StripeConfig {
  secretKey: string;
  webhookSecrets: string[];
  apiVersion?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

type Obj = Record<string, unknown>;
type Form = Record<string, unknown>;

/** Stripe form encoding: nested objects → a[b]=v, arrays → a[0][b]=v; undefined/null skipped. */
export function formEncode(data: Form, prefix = ''): string {
  const out: string[] = [];
  const walk = (v: unknown, key: string) => {
    if (v === undefined || v === null) return;
    if (Array.isArray(v)) { v.forEach((x, i) => walk(x, `${key}[${i}]`)); return; }
    if (typeof v === 'object' && !(v instanceof Date)) { for (const [k, x] of Object.entries(v as Obj)) walk(x, key ? `${key}[${k}]` : k); return; }
    const s = v instanceof Date ? String(Math.floor(v.getTime() / 1000)) : String(v);
    out.push(`${encodeURIComponent(key)}=${encodeURIComponent(s)}`);
  };
  walk(data, prefix);
  return out.join('&');
}

export class StripeBillingProvider implements BillingProvider {
  readonly name = 'stripe' as const;
  readonly livemode: boolean;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly cfg: StripeConfig) {
    if (!/^(sk|rk)_(test|live)_/.test(cfg.secretKey)) throw new Error('Stripe secret key has an unexpected format');
    this.livemode = /^(sk|rk)_live_/.test(cfg.secretKey);
    this.fetchImpl = cfg.fetchImpl ?? fetch;
  }

  webhookSecrets(): string[] { return this.cfg.webhookSecrets.filter(Boolean); }

  private async call<T = Obj>(method: 'GET' | 'POST', path: string, body?: Form, idempotencyKey?: string): Promise<T> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.cfg.secretKey}`,
      'stripe-version': this.cfg.apiVersion ?? STRIPE_API_VERSION_DEFAULT,
    };
    let url = `${API}${path}`;
    let payload: string | undefined;
    if (method === 'GET' && body) url += `?${formEncode(body)}`;
    if (method === 'POST') { headers['content-type'] = 'application/x-www-form-urlencoded'; payload = formEncode(body ?? {}); }
    if (idempotencyKey) headers['idempotency-key'] = idempotencyKey.slice(0, 255);
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.cfg.timeoutMs ?? 15_000);
    try {
      const res = await this.fetchImpl(url, { method, headers, body: payload, signal: ctl.signal });
      const json = (await res.json().catch(() => ({}))) as Obj;
      if (!res.ok) {
        const e = (json.error ?? {}) as Obj;
        throw new BillingProviderError(typeof e.message === 'string' ? e.message : `Stripe request failed (${res.status})`, res.status,
          typeof e.code === 'string' ? e.code : null, typeof e.type === 'string' ? e.type : null);
      }
      return json as T;
    } finally {
      clearTimeout(timer);
    }
  }

  private async retrieve(path: string, query?: Form): Promise<Obj | null> {
    try {
      return await this.call('GET', path, query);
    } catch (e) {
      if (e instanceof BillingProviderError && (e.status === 404 || e.code === 'resource_missing')) return null;
      throw e;
    }
  }

  async createCustomer(p: { workspaceId: string; name: string; email: string | null; idempotencyKey: string }) {
    const c = await this.call('POST', '/v1/customers', { name: p.name, email: p.email ?? undefined, metadata: { relay_workspace_id: p.workspaceId } }, p.idempotencyKey);
    return { ref: String(c.id) };
  }

  async createCheckoutSession(p: Parameters<BillingProvider['createCheckoutSession']>[0]): Promise<ProviderCheckoutSession> {
    const meta = { relay_workspace_id: p.workspaceId, relay_checkout_id: p.checkoutId };
    const s = await this.call('POST', '/v1/checkout/sessions', {
      mode: 'subscription',
      customer: p.customerRef,
      client_reference_id: p.workspaceId,
      line_items: [{ price: p.priceRef, quantity: p.quantity }],
      success_url: p.successUrl,
      cancel_url: p.cancelUrl,
      expires_at: p.expiresAt,
      metadata: meta,
      subscription_data: {
        metadata: meta,
        trial_end: p.trialEnd ?? undefined,
        billing_cycle_anchor: p.trialEnd ? undefined : (p.billingCycleAnchor ?? undefined),
        proration_behavior: !p.trialEnd && p.billingCycleAnchor ? 'none' : undefined,
      },
    }, p.idempotencyKey);
    return normalizeCheckoutSession(s);
  }

  async retrieveCheckoutSession(ref: string) {
    const s = await this.retrieve(`/v1/checkout/sessions/${encodeURIComponent(ref)}`);
    return s ? normalizeCheckoutSession(s) : null;
  }

  async expireCheckoutSession(ref: string): Promise<void> {
    try { await this.call('POST', `/v1/checkout/sessions/${encodeURIComponent(ref)}/expire`, {}); } catch (e) {
      if (!(e instanceof BillingProviderError && e.status === 400)) throw e; // already complete/expired
    }
  }

  async createPortalSession(p: { customerRef: string; returnUrl: string; flow: PortalFlow; subscriptionRef?: string | null }) {
    const flow = p.flow === 'payment_method_update' ? { type: 'payment_method_update' }
      : p.flow === 'subscription_cancel' && p.subscriptionRef ? { type: 'subscription_cancel', subscription_cancel: { subscription: p.subscriptionRef } } : undefined;
    const s = await this.call('POST', '/v1/billing_portal/sessions', { customer: p.customerRef, return_url: p.returnUrl, flow_data: flow });
    return { url: String(s.url) };
  }

  async retrieveSubscription(ref: string): Promise<ProviderSubscription | null> {
    const s = await this.retrieve(`/v1/subscriptions/${encodeURIComponent(ref)}`);
    return s ? normalizeSubscription(s) : null;
  }

  async previewChange(p: Parameters<BillingProvider['previewChange']>[0]): Promise<ChangePreview> {
    const inv = await this.call('POST', '/v1/invoices/create_preview', {
      subscription: p.subscriptionRef,
      subscription_details: { items: [{ id: p.itemRef, price: p.priceRef, quantity: p.quantity }], proration_date: p.prorationDate, proration_behavior: p.prorationBehavior },
    });
    const lines = ((inv.lines as Obj | undefined)?.data as Obj[] | undefined) ?? [];
    const out = lines.map((l) => {
      const parent = (l.parent as Obj | undefined)?.subscription_item_details as Obj | undefined;
      return { description: typeof l.description === 'string' ? l.description : '', amount_minor: Number(l.amount ?? 0), proration: parent?.proration === true || l.proration === true };
    });
    return {
      currency: String(inv.currency ?? 'gbp').toUpperCase(),
      proration_minor: out.filter((l) => l.proration).reduce((a, l) => a + l.amount_minor, 0),
      next_invoice_minor: Number(inv.total ?? inv.amount_due ?? 0),
      next_invoice_at: typeof inv.next_payment_attempt === 'number' ? new Date(inv.next_payment_attempt * 1000) : typeof inv.period_end === 'number' ? new Date(inv.period_end * 1000) : null,
      proration_date: p.prorationDate,
      lines: out,
    };
  }

  async updateSubscription(p: Parameters<BillingProvider['updateSubscription']>[0]): Promise<ProviderSubscription> {
    const body: Form = { cancel_at_period_end: p.cancelAtPeriodEnd ?? undefined };
    if (p.itemRef && (p.priceRef || p.quantity)) body.items = [{ id: p.itemRef, price: p.priceRef ?? undefined, quantity: p.quantity ?? undefined }];
    if (p.prorationBehavior) body.proration_behavior = p.prorationBehavior;
    if (p.prorationDate) body.proration_date = p.prorationDate;
    const s = await this.call('POST', `/v1/subscriptions/${encodeURIComponent(p.subscriptionRef)}`, body, p.idempotencyKey);
    return normalizeSubscription(s);
  }

  async retrieveInvoice(ref: string): Promise<ProviderInvoice | null> {
    const i = await this.retrieve(`/v1/invoices/${encodeURIComponent(ref)}`);
    return i ? normalizeInvoice(i) : null;
  }

  async listInvoices(customerRef: string, limit: number): Promise<ProviderInvoice[]> {
    const r = await this.call<{ data: Obj[] }>('GET', '/v1/invoices', { customer: customerRef, limit: Math.min(100, Math.max(1, limit)) });
    return (r.data ?? []).map(normalizeInvoice);
  }

  async paymentMethodSummary(customerRef: string, subscriptionRef?: string | null): Promise<PaymentMethodSummary | null> {
    if (subscriptionRef) {
      const s = await this.retrieve(`/v1/subscriptions/${encodeURIComponent(subscriptionRef)}`, { expand: ['default_payment_method'] });
      const pm = summarizePaymentMethod(s?.default_payment_method);
      if (pm) return pm;
    }
    const c = await this.retrieve(`/v1/customers/${encodeURIComponent(customerRef)}`, { expand: ['invoice_settings.default_payment_method'] });
    return summarizePaymentMethod((c?.invoice_settings as Obj | undefined)?.default_payment_method);
  }

  dashboardUrl(kind: 'customer' | 'subscription' | 'invoice', ref: string): string {
    const base = `https://dashboard.stripe.com/${this.livemode ? '' : 'test/'}`;
    return `${base}${kind === 'customer' ? 'customers' : kind === 'subscription' ? 'subscriptions' : 'invoices'}/${encodeURIComponent(ref)}`;
  }
}
