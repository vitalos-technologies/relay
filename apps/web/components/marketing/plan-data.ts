// Pricing presentation derived ONLY from the shared catalogue (packages/core/src/contracts/v4-plans.ts). No price, plan
// name, trial length, feature or allowance is written here — labels only (three public plans since D33: Free, Standard,
// Professional). Used by the pricing cards, the comparison
// table, the seat estimate and the FAQ (so the page can never drift from checkout / billing / entitlements).
import {
  CURRENCY, FEATURES, GUEST_SEAT_EXEMPTION, MIN_PAID_SEATS, PLANS, TRIAL_DAYS, TRIAL_REQUIRES_CARD, formatMinorGBP, publicCatalogue,
  recurringTotalMinor, type Allowance, type AllowanceRule, type Feature, type PlanCatalogueEntry, type PublicPlanId,
} from '@social-lite/core/contracts/v4-plans';

export { TRIAL_DAYS, TRIAL_REQUIRES_CARD, CURRENCY, GUEST_SEAT_EXEMPTION, MIN_PAID_SEATS, formatMinorGBP, recurringTotalMinor };
export type { PublicPlanId };

/** Feature labels for the comparison (presentation only; the keys and plan membership come from the catalogue). */
export const FEATURE_LABEL: Record<Feature, string> = {
  publishing: 'Publishing and scheduling',
  media_library: 'Calendar and media library',
  collaboration: 'Team collaboration (comments, tasks, single-stage approval)',
  analytics_standard: 'Standard analytics',
  inbox: 'Social inbox (supported networks)',
  ai_drafting: 'AI drafting help',
  support: 'Support',
  analytics_advanced: 'Advanced analytics and saved reports',
  listening: 'Listening on activated sources',
  approvals_advanced: 'Multi-step approvals',
  care_advanced: 'Advanced customer care (service levels, routing)',
  ai_workflows: 'Multi-step AI workflows',
  automation: 'Configured automations',
  integrations_business: 'Business integrations (Slack, Asana, monday.com, HubSpot, Mailchimp, Google)',
  mcp: 'MCP access for AI clients',
};

export const ALLOWANCE_LABEL: Record<Allowance, string> = {
  ai_tokens: 'AI usage a month (tokens)',
  storage_bytes: 'Media storage',
  exports: 'Report exports a month',
  x_writes: 'X API posts',
  x_reads: 'X API reads',
  listening_searches: 'Active listening searches',
  social_accounts: 'Connected social accounts',
  integration_jobs: 'Integration sync jobs a month',
  mcp_calls: 'MCP tool calls a month',
  scheduled_posts: 'Scheduled posts a month',
  brands: 'Brands',
  members: 'Users',
};

/** Comparison order: the limits people hit first (Free's) at the top. Every allowance appears (X reads share the X row). */
const ALLOWANCE_ORDER: readonly Allowance[] = ['members', 'brands', 'social_accounts', 'scheduled_posts', 'storage_bytes', 'ai_tokens', 'exports', 'x_writes', 'listening_searches', 'integration_jobs', 'mcp_calls'];

const GB = 1024 ** 3;
const MB = 1024 ** 2;
function amount(key: Allowance, n: number): string {
  if (key === 'storage_bytes') return n < GB ? `${Math.round(n / MB)} MB` : `${Math.round(n / GB)} GB`;
  if (key === 'ai_tokens' || key === 'mcp_calls' || key === 'integration_jobs') {
    if (n >= 1_000_000 && n % 1_000_000 === 0) return `${n / 1_000_000}M`;
    if (n >= 1000 && n % 1000 === 0) return `${(n / 1000).toLocaleString('en-GB')}k`;
  }
  return n.toLocaleString('en-GB');
}

/** "100k + 50k per user" · "5" · "Not included" · "Workspace budget". */
export function describeAllowance(key: Allowance, rule: AllowanceRule | null, opts: { trial?: boolean } = {}): string {
  if (rule == null) {
    if (key === 'x_writes' || key === 'x_reads') return 'Workspace budget · X charges per request';
    if (key === 'members') return opts.trial ? 'No seat limit' : 'Billed per user';
    return 'Not metered by plan';
  }
  if (rule.base === 0 && rule.per_seat === 0) return 'Not included';
  const base = amount(key, rule.base);
  if (!rule.per_seat) return opts.trial ? `${base} for the trial` : base;
  return `${base} + ${amount(key, rule.per_seat)} per user`;
}

export interface PricingPlan extends PlanCatalogueEntry {
  price: string; // "£5"
  /** £0 plan (D33 Free): one user, no trial, no seat estimate. */
  free: boolean;
  examples: Array<{ seats: number; total: string }>;
}

/** Exactly the public plans (Free + paid), in catalogue order. */
export function pricingPlans(): PricingPlan[] {
  return publicCatalogue().map((p) => ({
    ...p,
    price: formatMinorGBP(p.unit_amount_minor),
    free: p.unit_amount_minor === 0,
    examples: (p.unit_amount_minor === 0 ? [1] : [1, 3, 10]).map((seats) => ({ seats, total: formatMinorGBP(recurringTotalMinor(p.id, seats)) })),
  }));
}

export const paidPlans = (): PricingPlan[] => pricingPlans().filter((p) => !p.free);
export const freePlan = (): PricingPlan | undefined => pricingPlans().find((p) => p.free);

/** A plan's effective allowance for one user, for copy ("10 scheduled posts a month"). null = not metered. */
export const planAllowance = (id: PublicPlanId, key: Allowance): number | null => {
  const r = PLANS[id].allowances[key];
  return r == null ? null : r.base + r.per_seat;
};
export const formatAllowance = (key: Allowance, n: number): string => amount(key, n);

/** Pricing-card checklist groups: a group is listed on the first plan whose features include all of it. */
const CHECK_GROUPS: ReadonlyArray<{ label: string; features: readonly Feature[] }> = [
  { label: 'Team collaboration and approvals', features: ['collaboration'] },
  { label: 'Social inbox', features: ['inbox'] },
  { label: 'Standard analytics', features: ['analytics_standard'] },
  { label: 'Advanced analytics and listening', features: ['analytics_advanced', 'listening'] },
  { label: 'Multi-step approvals and customer care', features: ['approvals_advanced', 'care_advanced'] },
  { label: 'AI workflows and automation', features: ['ai_workflows', 'automation'] },
  { label: 'Business integrations and MCP', features: ['integrations_business', 'mcp'] },
];
export const CHECKLIST_LENGTH = 5;

/**
 * The five checklist lines on a pricing card, from the catalogue only: the first plan lists its catalogue highlights; each
 * later plan says "Everything in <previous plan>" (unit-tested: it includes every feature and at least every allowance of
 * the previous plan) and then the feature groups it adds, topped up with its connected-accounts allowance if short.
 */
export function cardChecklist(id: PublicPlanId): string[] {
  const ids = publicCatalogue().map((p) => p.id);
  const i = ids.indexOf(id);
  const plan = PLANS[id];
  if (i <= 0) return plan.highlights.slice(0, CHECKLIST_LENGTH);
  const prev = PLANS[ids[i - 1]!];
  const has = (p: { features: readonly Feature[] }, fs: readonly Feature[]) => fs.every((f) => p.features.includes(f));
  const lines = [`Everything in ${prev.name}`, ...CHECK_GROUPS.filter((g) => has(plan, g.features) && !has(prev, g.features)).map((g) => g.label)];
  const acc = plan.allowances.social_accounts;
  if (lines.length < CHECKLIST_LENGTH && acc) lines.push(`${acc.base} social accounts + ${acc.per_seat} per user`);
  return lines.slice(0, CHECKLIST_LENGTH);
}

/** `null` = not applicable (e.g. trial allowances on a plan without a trial). */
export interface ComparisonRow { key: string; label: string; values: Record<PublicPlanId, string | boolean | null> }
export interface ComparisonGroup { id: string; title: string; note?: string; rows: ComparisonRow[] }

/** Features (✓/—), per-period allowances, and the bounded trial allowances — all straight from the catalogue. */
export function comparison(): ComparisonGroup[] {
  const ids = publicCatalogue().map((p) => p.id);
  const per = <T,>(f: (id: PublicPlanId) => T) => Object.fromEntries(ids.map((id) => [id, f(id)])) as Record<PublicPlanId, T>;
  return [
    {
      id: 'features', title: 'Features',
      // D33: Free's support is the Help Centre (paid plans also contact Relay support from the app).
      rows: FEATURES.map((f) => ({ key: f, label: FEATURE_LABEL[f], values: per((id) => (f === 'support' && PLANS[id].unit_amount_minor === 0 ? 'Help Centre' : PLANS[id].features.includes(f))) })),
    },
    {
      id: 'allowances', title: 'Limits and allowances', note: 'No overage charges: at a limit the action waits or is refused. Data export always works.',
      rows: ALLOWANCE_ORDER.map((a) => ({
        key: a, label: a === 'x_writes' ? 'X API posts and reads' : ALLOWANCE_LABEL[a], values: per((id) => describeAllowance(a, PLANS[id].allowances[a])),
      })),
    },
    {
      id: 'trial', title: `During the ${TRIAL_DAYS}-day trial`, note: 'Paid plans only. Trial allowances cover the whole trial and don’t reset.',
      rows: ALLOWANCE_ORDER.map((a) => ({
        key: `trial_${a}`, label: a === 'x_writes' ? 'X API posts and reads' : ALLOWANCE_LABEL[a],
        values: per((id) => (PLANS[id].trial_days > 0 ? describeAllowance(a, PLANS[id].trial_allowances[a], { trial: true }) : null)),
      })),
    },
  ];
}
