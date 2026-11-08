// Which billing provider is active. Missing credentials never become success:
//  - RELAY_STRIPE_SECRET_KEY + RELAY_STRIPE_WEBHOOK_SECRET present → Stripe (test-mode keys `sk_test_…`). A live key
//    (`sk_live_…`) is used only when BILLING_LIVE_MODE=enabled is also set (explicit activation step; never here).
//    The variables are Relay-namespaced ON PURPOSE: a generic STRIPE_SECRET_KEY in a shared host environment may belong to
//    another project and must never be picked up (project rule: use only this project's resources).
//  - otherwise, outside production with mock providers enabled → the deterministic test double (labelled "Test mode").
//  - otherwise → not configured: billing pages render stored state; checkout/portal refuse with provider_not_configured.
import { AppError } from '@social-lite/core';
import { StripeBillingProvider } from '@social-lite/providers/stripe/client';
import type { BillingProvider } from '@social-lite/providers/stripe/types';
import { config, mockProvidersEnabled } from '../config.js';
import { TestBillingProvider } from './test-provider.js';

export interface BillingProviderStatus {
  provider: 'stripe' | 'test' | null;
  livemode: boolean;
  configured: boolean;
  /** True for the local test double and Stripe test-mode keys. */
  test_mode: boolean;
  missing: string[];
}

let override: BillingProvider | null | undefined;
/** Tests only. */
export function setBillingProviderForTests(p: BillingProvider | null | undefined): void { override = p; }

export function billingProviderStatus(): BillingProviderStatus {
  if (override !== undefined) return { provider: override?.name ?? null, livemode: override?.livemode ?? false, configured: !!override, test_mode: !override?.livemode, missing: [] };
  const key = process.env.RELAY_STRIPE_SECRET_KEY ?? '';
  const whsec = process.env.RELAY_STRIPE_WEBHOOK_SECRET ?? '';
  if (key) {
    const live = /^(sk|rk)_live_/.test(key);
    const missing = [!whsec && 'RELAY_STRIPE_WEBHOOK_SECRET', live && process.env.BILLING_LIVE_MODE !== 'enabled' && 'BILLING_LIVE_MODE=enabled (live activation)'].filter(Boolean) as string[];
    return { provider: 'stripe', livemode: live, configured: missing.length === 0, test_mode: !live, missing };
  }
  if (config().APP_ENV !== 'production' && mockProvidersEnabled()) return { provider: 'test', livemode: false, configured: true, test_mode: true, missing: [] };
  return { provider: null, livemode: false, configured: false, test_mode: false, missing: ['STRIPE_SECRET_KEY', 'RELAY_STRIPE_WEBHOOK_SECRET'] };
}

let cached: { key: string; p: BillingProvider } | null = null;

export function getBillingProvider(): BillingProvider | null {
  if (override !== undefined) return override;
  const s = billingProviderStatus();
  if (!s.configured || !s.provider) return null;
  const key = `${s.provider}:${process.env.RELAY_STRIPE_SECRET_KEY?.slice(-6) ?? ''}`;
  if (cached?.key === key) return cached.p;
  const p: BillingProvider = s.provider === 'stripe'
    ? new StripeBillingProvider({
      secretKey: process.env.RELAY_STRIPE_SECRET_KEY!, apiVersion: process.env.RELAY_STRIPE_API_VERSION || undefined,
      webhookSecrets: [process.env.RELAY_STRIPE_WEBHOOK_SECRET ?? '', process.env.RELAY_STRIPE_WEBHOOK_SECRET_PREVIOUS ?? ''],
    })
    : new TestBillingProvider();
  cached = { key, p };
  return p;
}

export function requireBillingProvider(): BillingProvider {
  const p = getBillingProvider();
  if (!p) throw new AppError('provider_not_configured', 'Billing is not set up on this installation yet.', undefined, { missing: billingProviderStatus().missing });
  return p;
}

export function appUrl(path: string): string {
  return new URL(path, config().APP_BASE_URL).toString();
}
