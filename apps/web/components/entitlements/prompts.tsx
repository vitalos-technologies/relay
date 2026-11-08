'use client';
// Concise upgrade / restriction prompts. Shown only when the server says a capability is missing or paused.
import Link from 'next/link';
import { ArrowUpRight, LifeBuoy, LockKeyhole } from 'lucide-react';
import type { Feature } from '@social-lite/core/contracts/v4-plans';
import type { EntitlementsDto } from '@social-lite/core/contracts/v4-entitlements';
import { Banner, buttonClass } from '@/components/ui';
import { BILLING_HREF, SUPPORT_HREF, checkFeatureClient, useEntitlements } from './use-entitlements';

function BillingLink({ e, label }: { e: EntitlementsDto | undefined; label: string }) {
  if (!e?.can_manage) return <span className="text-xs text-muted">Ask an owner to change the plan.</span>;
  return <Link href={BILLING_HREF} className={buttonClass('secondary', 'sm')}>{label}<ArrowUpRight aria-hidden className="size-3.5" /></Link>;
}

/** Inline prompt for a page or panel whose capability is not in the plan (or paused). Renders nothing when allowed. */
export function UpgradePrompt({ feature, paid = false, className }: { feature: Feature; paid?: boolean; className?: string }) {
  const { data, check } = useEntitlements();
  const c = check(feature, { paid });
  if (c.ok) return null;
  return (
    <Banner tone={c.reason === 'feature_not_in_plan' ? 'info' : 'warn'} icon={<LockKeyhole aria-hidden className="size-4 text-muted" />} className={className}
      title={c.reason === 'feature_not_in_plan' ? 'Not in your plan' : 'Paused'}
      actions={<BillingLink e={data} label={c.reason === 'feature_not_in_plan' ? 'See plans' : 'Billing'} />}>
      {c.message}
    </Banner>
  );
}

/** Workspace-wide strip when paid actions are paused (trial ended, payment problem) or the service is suspended. */
export function AccessBanner({ entitlements, className }: { entitlements?: EntitlementsDto; className?: string }) {
  const own = useEntitlements(!entitlements);
  const e = entitlements ?? own.data;
  if (!e || e.access === 'full') return null;
  const suspended = e.access === 'suspended';
  return (
    <Banner role="status" tone={suspended ? 'danger' : 'warn'} className={className} title={suspended ? 'Workspace suspended' : 'Paid actions are paused'}
      actions={<>
        {!suspended ? <BillingLink e={e} label="Billing" /> : null}
        <Link href={SUPPORT_HREF} className={buttonClass('ghost', 'sm')}><LifeBuoy aria-hidden className="size-3.5" />Support</Link>
      </>}>
      {e.access_reason ?? 'Scheduled posts and replies are held until this is resolved.'} {!suspended ? 'Your data, exports, billing and support stay available.' : null}
    </Banner>
  );
}

export { checkFeatureClient };
