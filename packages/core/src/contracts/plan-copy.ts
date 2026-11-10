// Upgrade-prompt copy shared by the app (entitlement prompts) and the server (402 entitlement_required messages), so a
// prompt always names the right plan and its catalogue price (D33). Copy only — never used for authorization.
import { PLANS, PUBLIC_PLAN_IDS, formatMinorGBP, type Allowance, type Feature, type PlanId, type PublicPlanId } from './v4-plans';

const byPrice = (): PublicPlanId[] => [...PUBLIC_PLAN_IDS].sort((a, b) => PLANS[a].unit_amount_minor! - PLANS[b].unit_amount_minor!);

/** Cheapest public plan that includes the feature (null = none). */
export function cheapestPlanWithFeature(feature: Feature): PublicPlanId | null {
  return byPrice().find((id) => PLANS[id].features.includes(feature)) ?? null;
}

/** Cheapest pricier public plan with more of the allowance than `current` (null limit = not metered by plan). */
export function cheapestPlanWithMore(allowance: Allowance, current: PlanId | null | undefined): PublicPlanId | null {
  const cur = current ? PLANS[current] : null;
  const curRule = cur?.allowances[allowance];
  if (cur && curRule === null) return null;
  return byPrice().find((id) => {
    const p = PLANS[id];
    if (cur && (p.unit_amount_minor ?? 0) <= (cur.unit_amount_minor ?? 0)) return false;
    const r = p.allowances[allowance];
    return r === null || !curRule || r.base + r.per_seat > curRule.base + curRule.per_seat;
  }) ?? null;
}

/** "£5 per user / month" (paid) · "£0" (Free). */
export function planPrice(id: PlanId): string {
  const minor = PLANS[id].unit_amount_minor;
  if (minor == null) return '';
  return minor === 0 ? formatMinorGBP(0) : `${formatMinorGBP(minor)} per user / month`;
}

/** "Upgrade to Standard (£5 per user / month)." — empty when there is nothing to upgrade to. */
export function upgradeSentence(to: PlanId | null | undefined): string {
  if (!to) return '';
  return `Upgrade to ${PLANS[to].name} (${planPrice(to)}).`;
}

/** "Analytics isn’t included in Free. Upgrade to Standard (£5 per user / month)." */
export function featureUpgradeMessage(featureLabel: string, planName: string | null | undefined, to: PlanId | null | undefined): string {
  return [`${featureLabel} isn’t included in ${planName ?? 'your plan'}.`, upgradeSentence(to)].filter(Boolean).join(' ');
}

/** "Free includes 10 scheduled posts a month. Upgrade to Standard (£5 per user / month)." */
export function limitUpgradeMessage(limitText: string, planName: string | null | undefined, to: PlanId | null | undefined): string {
  return [`${planName ?? 'Your plan'} includes ${limitText}.`, upgradeSentence(to) || 'Remove one first, or contact support.'].filter(Boolean).join(' ');
}
