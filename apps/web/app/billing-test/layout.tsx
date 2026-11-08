// Test-mode stand-ins for the provider's hosted Checkout and Customer Portal (deterministic billing test double only; the
// API refuses these unless the test double is the active provider). Clearly labelled; no payment is taken.
import { cookies } from 'next/headers';
import type { ReactNode } from 'react';
import { BareProviders } from '@/components/shell/providers';
import { RedirectToLogin } from '@/components/shell/redirect-to-login';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Test payment page', robots: { index: false } };

export default async function BillingTestLayout({ children }: { children: ReactNode }) {
  const jar = await cookies();
  if (!jar.has('sl_session') && !jar.has('__Host-sl_session')) return <RedirectToLogin />;
  return <BareProviders>{children}</BareProviders>;
}
