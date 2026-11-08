// Stripe object → provider-neutral shapes. Tolerates both the item-level period fields (API ≥ 2025-03-31) and the older
// subscription-level ones, expanded or id-only references, and missing optional fields.
import type { PaymentMethodSummary, ProviderCheckoutSession, ProviderInvoice, ProviderSubscription, ProviderSubscriptionStatus } from './types.js';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const ts = (v: unknown): Date | null => { const n = num(v); return n === null ? null : new Date(n * 1000); };
const ref = (v: unknown): string | null => (typeof v === 'string' ? v : isObj(v) ? str(v.id) : null);
const meta = (v: unknown): Record<string, string> => (isObj(v) ? Object.fromEntries(Object.entries(v).filter(([, x]) => typeof x === 'string')) as Record<string, string> : {});

const SUB_STATUSES: readonly ProviderSubscriptionStatus[] = ['incomplete', 'incomplete_expired', 'trialing', 'active', 'past_due', 'canceled', 'unpaid', 'paused'];

export function normalizeSubscription(o: Obj): ProviderSubscription {
  const items = isObj(o.items) && Array.isArray(o.items.data) ? (o.items.data as unknown[]).filter(isObj) : [];
  const item = items[0] ?? null;
  const status = SUB_STATUSES.includes(o.status as ProviderSubscriptionStatus) ? o.status as ProviderSubscriptionStatus : 'incomplete';
  const price = item ? (isObj(item.price) ? str(item.price.id) : str(item.price)) : null;
  return {
    ref: String(o.id),
    customer_ref: ref(o.customer) ?? '',
    status,
    item_ref: item ? str(item.id) : null,
    price_ref: price,
    quantity: num(item?.quantity) ?? num(o.quantity) ?? 1,
    current_period_start: ts(item?.current_period_start ?? o.current_period_start),
    current_period_end: ts(item?.current_period_end ?? o.current_period_end),
    trial_start: ts(o.trial_start),
    trial_end: ts(o.trial_end),
    cancel_at_period_end: o.cancel_at_period_end === true,
    cancel_at: ts(o.cancel_at),
    canceled_at: ts(o.canceled_at),
    ended_at: ts(o.ended_at),
    latest_invoice_ref: ref(o.latest_invoice),
    default_payment_method_ref: ref(o.default_payment_method),
    metadata: meta(o.metadata),
    livemode: o.livemode === true,
    created: ts(o.created) ?? new Date(0),
  };
}

export function normalizeCheckoutSession(o: Obj): ProviderCheckoutSession {
  const status = o.status === 'complete' || o.status === 'expired' ? o.status : 'open';
  return {
    ref: String(o.id), status, payment_status: str(o.payment_status), customer_ref: ref(o.customer), subscription_ref: ref(o.subscription),
    client_reference_id: str(o.client_reference_id), metadata: meta(o.metadata), url: str(o.url), expires_at: ts(o.expires_at), livemode: o.livemode === true,
  };
}

export function normalizeInvoice(o: Obj): ProviderInvoice {
  // Subscription reference moved to parent.subscription_details.subscription in newer API versions.
  const parent = isObj(o.parent) && isObj(o.parent.subscription_details) ? o.parent.subscription_details : null;
  return {
    ref: String(o.id), customer_ref: ref(o.customer), subscription_ref: ref(o.subscription) ?? ref(parent?.subscription),
    number: str(o.number), status: str(o.status) ?? 'draft', currency: (str(o.currency) ?? 'gbp').toUpperCase(),
    amount_due: num(o.amount_due) ?? 0, amount_paid: num(o.amount_paid) ?? 0, total: num(o.total) ?? 0,
    hosted_url: str(o.hosted_invoice_url), pdf_url: str(o.invoice_pdf), period_start: ts(o.period_start), period_end: ts(o.period_end),
    created: ts(o.created) ?? new Date(0), billing_reason: str(o.billing_reason), livemode: o.livemode === true,
  };
}

/** Card summary from an expanded PaymentMethod (brand + last 4 + expiry only; never anything else). */
export function summarizePaymentMethod(pm: unknown): PaymentMethodSummary | null {
  if (!isObj(pm)) return null;
  const card = isObj(pm.card) ? pm.card : null;
  if (card) return { brand: str(card.brand) ?? 'card', last4: String(card.last4 ?? '').slice(-4), exp_month: num(card.exp_month), exp_year: num(card.exp_year) };
  const type = str(pm.type);
  if (type && isObj(pm[type])) {
    const d = pm[type] as Obj;
    const last4 = str(d.last4);
    if (last4) return { brand: type.replace(/_/g, ' '), last4: last4.slice(-4), exp_month: null, exp_year: null };
  }
  return type ? { brand: type.replace(/_/g, ' '), last4: '', exp_month: null, exp_year: null } : null;
}

/** Workspace id we attach as metadata/client_reference_id (server-set at creation; events are signature-verified). */
export function workspaceIdOf(o: Obj): string | null {
  const m = meta(o.metadata);
  if (m.relay_workspace_id) return m.relay_workspace_id;
  if (isObj(o.subscription_details) && isObj(o.subscription_details.metadata)) {
    const sm = meta(o.subscription_details.metadata);
    if (sm.relay_workspace_id) return sm.relay_workspace_id;
  }
  if (isObj(o.parent) && isObj(o.parent.subscription_details)) {
    const pm = meta(o.parent.subscription_details.metadata);
    if (pm.relay_workspace_id) return pm.relay_workspace_id;
  }
  return str(o.client_reference_id);
}
