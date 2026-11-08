'use client';
// Shell-level strip (all app pages) when paid actions are paused or the workspace is suspended. Billing and support
// links are always present: restricted access never blocks them (V4 §11/§13).
import Link from 'next/link';
import { Hourglass } from 'lucide-react';
import type { EntitlementsDto } from '@social-lite/core/contracts/v4-entitlements';
import { useApi } from '@/lib/client/use-api';
import { BILLING_HREF, SUPPORT_HREF, USAGE_HREF } from './use-entitlements';

export function EntitlementStrip() {
  const { data } = useApi<EntitlementsDto>('/api/entitlements', { redirectOn401: false });
  if (!data || data.access === 'full') return null;
  const suspended = data.access === 'suspended';
  return (
    <div role="status" data-testid="entitlement-strip" className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 border-b border-[color-mix(in_srgb,var(--warn)_35%,transparent)] bg-warn-soft px-4 py-2 text-[13px]">
      <Hourglass aria-hidden className="size-4 text-warn" />
      <span className="font-medium">{suspended ? 'Workspace suspended' : 'Paid actions paused'}</span>
      {data.access_reason ? <span className="min-w-0 text-muted">{data.access_reason}</span> : null}
      {!suspended && data.can_manage ? <Link href={BILLING_HREF} className="font-medium underline">Billing</Link> : null}
      {!suspended && data.allowances.length ? <Link href={USAGE_HREF} className="font-medium underline">Held work</Link> : null}
      <Link href={SUPPORT_HREF} className="font-medium underline">Support</Link>
    </div>
  );
}
