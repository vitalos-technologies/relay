// Provider-neutral billing interface (services/billing uses only this). Implemented by the Stripe adapter (client.ts) and
// by the deterministic test double (services/billing/test-provider.ts), which stores Stripe-shaped objects so the same
// normalisers (normalize.ts) run in tests and in production.

export type BillingProviderName = 'stripe' | 'test';

/** Stripe subscription statuses (docs.stripe.com/api/subscriptions/object, status enum). */
export type ProviderSubscriptionStatus = 'incomplete' | 'incomplete_expired' | 'trialing' | 'active' | 'past_due' | 'canceled' | 'unpaid' | 'paused';

export interface ProviderSubscription {
  ref: string;
  customer_ref: string;
  status: ProviderSubscriptionStatus;
  item_ref: string | null;
  price_ref: string | null;
  quantity: number;
  /** Since API 2025-03-31 the period lives on the subscription item; normalised here. */
  current_period_start: Date | null;
  current_period_end: Date | null;
  trial_start: Date | null;
  trial_end: Date | null;
  cancel_at_period_end: boolean;
  cancel_at: Date | null;
  canceled_at: Date | null;
  ended_at: Date | null;
  latest_invoice_ref: string | null;
  default_payment_method_ref: string | null;
  metadata: Record<string, string>;
  livemode: boolean;
  created: Date;
}

export interface ProviderCheckoutSession {
  ref: string;
  status: 'open' | 'complete' | 'expired';
  payment_status: string | null;
  customer_ref: string | null;
  subscription_ref: string | null;
  client_reference_id: string | null;
  metadata: Record<string, string>;
  url: string | null;
  expires_at: Date | null;
  livemode: boolean;
}

export interface ProviderInvoice {
  ref: string;
  customer_ref: string | null;
  subscription_ref: string | null;
  number: string | null;
  status: string;
  currency: string;
  amount_due: number;
  amount_paid: number;
  total: number;
  hosted_url: string | null;
  pdf_url: string | null;
  period_start: Date | null;
  period_end: Date | null;
  created: Date;
  billing_reason: string | null;
  livemode: boolean;
}

export interface PaymentMethodSummary { brand: string; last4: string; exp_month: number | null; exp_year: number | null }

export interface ChangePreviewLine { description: string; amount_minor: number; proration: boolean }
export interface ChangePreview {
  currency: string;
  /** Sum of proration lines (charged on the next invoice; negative = credit). */
  proration_minor: number;
  /** Total of the next invoice the provider would issue. */
  next_invoice_minor: number;
  next_invoice_at: Date | null;
  proration_date: number;
  lines: ChangePreviewLine[];
}

/** A verified provider event (snapshot format: the object as of the event). */
export interface ProviderEvent {
  id: string;
  type: string;
  created: number;
  livemode: boolean;
  object: Record<string, unknown>;
  api_version: string | null;
}

export type ProrationBehavior = 'create_prorations' | 'none' | 'always_invoice';
export type PortalFlow = 'payment_method_update' | 'subscription_cancel' | null;

export interface BillingProvider {
  readonly name: BillingProviderName;
  readonly livemode: boolean;
  /** Active endpoint signing secrets (current first, then previous during rotation). */
  webhookSecrets(): string[];
  createCustomer(p: { workspaceId: string; name: string; email: string | null; idempotencyKey: string }): Promise<{ ref: string }>;
  createCheckoutSession(p: {
    customerRef: string; priceRef: string; quantity: number; workspaceId: string; checkoutId: string;
    /** Free period that the subscription keeps (≥ 48 h ahead, Stripe rule). */
    trialEnd: Date | null;
    /** Used instead of trialEnd inside the last 48 h of a trial: first charge at the anchor, no proration. */
    billingCycleAnchor: Date | null;
    successUrl: string; cancelUrl: string; expiresAt: Date; idempotencyKey: string;
  }): Promise<ProviderCheckoutSession>;
  retrieveCheckoutSession(ref: string): Promise<ProviderCheckoutSession | null>;
  expireCheckoutSession(ref: string): Promise<void>;
  createPortalSession(p: { customerRef: string; returnUrl: string; flow: PortalFlow; subscriptionRef?: string | null }): Promise<{ url: string }>;
  retrieveSubscription(ref: string): Promise<ProviderSubscription | null>;
  previewChange(p: { subscriptionRef: string; itemRef: string; priceRef: string; quantity: number; prorationDate: number; prorationBehavior: ProrationBehavior }): Promise<ChangePreview>;
  updateSubscription(p: {
    subscriptionRef: string; itemRef?: string | null; priceRef?: string | null; quantity?: number | null;
    prorationBehavior?: ProrationBehavior | null; prorationDate?: number | null; cancelAtPeriodEnd?: boolean | null; idempotencyKey: string;
  }): Promise<ProviderSubscription>;
  retrieveInvoice(ref: string): Promise<ProviderInvoice | null>;
  listInvoices(customerRef: string, limit: number): Promise<ProviderInvoice[]>;
  paymentMethodSummary(customerRef: string, subscriptionRef?: string | null): Promise<PaymentMethodSummary | null>;
  /** Staff link to the provider's own record (refunds and disputes are handled there). */
  dashboardUrl(kind: 'customer' | 'subscription' | 'invoice', ref: string): string | null;
}

export class BillingProviderError extends Error {
  constructor(message: string, public readonly status: number, public readonly code: string | null, public readonly type: string | null) { super(message); }
}
