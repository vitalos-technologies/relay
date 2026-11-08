'use client';
// UI side of the shared entitlement service: one GET per page (/api/entitlements), used to hide/upgrade controls and
// show concise prompts. It is a HINT only — every action is enforced on the server (402 entitlement_required).
import { PLANS, PUBLIC_PLAN_IDS, type Feature, type PlanId } from '@social-lite/core/contracts/v4-plans';
import { FEATURE_LABEL, type EntitlementsDto } from '@social-lite/core/contracts/v4-entitlements';
import { useApi } from '@/lib/client/use-api';

export type ClientCheck = { ok: true } | { ok: false; reason: 'feature_not_in_plan' | 'access_restricted' | 'access_suspended'; message: string; upgradeTo: PlanId | null };

export function upgradeTarget(feature: Feature): PlanId | null {
  return PUBLIC_PLAN_IDS.find((id) => PLANS[id].features.includes(feature)) ?? null;
}

/** Mirror of the server's checkFeature (copy only; never trusted for authorization). */
export function checkFeatureClient(e: EntitlementsDto | undefined, feature: Feature, opts: { paid?: boolean } = {}): ClientCheck {
  if (!e) return { ok: true }; // unknown yet: never block a control on a missing read
  const f = e.features[feature];
  if (f?.source === 'always') return { ok: true };
  if (opts.paid && e.access === 'suspended') return { ok: false, reason: 'access_suspended', message: e.access_reason ?? 'This workspace is suspended by Relay.', upgradeTo: null };
  if (!f?.enabled) {
    const to = upgradeTarget(feature);
    return { ok: false, reason: 'feature_not_in_plan', upgradeTo: to,
      message: f?.source === 'override' ? `${FEATURE_LABEL[feature]} is turned off for this workspace.` : `${FEATURE_LABEL[feature]} isn’t included in ${e.plan?.name ?? 'your plan'}.${to ? ` It’s part of ${PLANS[to].name}.` : ''}` };
  }
  if (opts.paid && e.access === 'restricted') return { ok: false, reason: 'access_restricted', message: e.access_reason ?? 'Paid actions are paused.', upgradeTo: null };
  return { ok: true };
}

export function useEntitlements(enabled = true) {
  const r = useApi<EntitlementsDto>(enabled ? '/api/entitlements' : null);
  return { ...r, check: (feature: Feature, opts: { paid?: boolean } = {}) => checkFeatureClient(r.data, feature, opts) };
}

/** Where people manage the plan (billing stream: Settings → Billing). */
export const BILLING_HREF = '/settings/workspace/billing';
/** Help → Contact support (support stream). Reachable whatever the billing state. */
export const SUPPORT_HREF = '/help';
export const USAGE_HREF = '/admin/usage';
