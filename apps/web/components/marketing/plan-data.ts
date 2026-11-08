// Pricing presentation derived ONLY from the shared catalogue (packages/core/src/contracts/v4-plans.ts). No price, plan
// name, trial length, feature or allowance is written here — labels only. Used by the pricing cards, the comparison
// table, the seat estimate and the FAQ (so the page can never drift from checkout / billing / entitlements).
import {
  ALLOWANCES, CURRENCY, FEATURES, GUEST_SEAT_EXEMPTION, MIN_PAID_SEATS, PLANS, TRIAL_DAYS, TRIAL_REQUIRES_CARD, formatMinorGBP, publicCatalogue,
  recurringTotalMinor, type Allowance, type AllowanceRule, type Feature, type PlanCatalogueEntry, type PublicPlanId,
} from '@social-lite/core/contracts/v4-plans';

export { TRIAL_DAYS, TRIAL_REQUIRES_CARD, CURRENCY, GUEST_SEAT_EXEMPTION, MIN_PAID_SEATS, formatMinorGBP, recurringTotalMinor };
export type { PublicPlanId };

/** Feature labels for the comparison (presentation only; the keys and plan membership come from the catalogue). */
export const FEATURE_LABEL: Record<Feature, string> = {
  publishing: 'Publishing and scheduling',
  media_library: 'Shared calendar and media library',
  collaboration: 'Team collaboration (comments, tasks, single-stage approval)',
  analytics_standard: 'Standard analytics',
  inbox: 'Social inbox (supported networks)',
  ai_drafting: 'AI drafting help',
  support: 'In-app support',
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
  ai_tokens: 'AI usage (tokens)',
  storage_bytes: 'Media storage',
  exports: 'Exports',
  x_writes: 'X API posts',
  x_reads: 'X API reads',
  listening_searches: 'Active listening searches',
  social_accounts: 'Connected social accounts',
  integration_jobs: 'Integration sync jobs',
  mcp_calls: 'MCP tool calls',
};

const GB = 1024 ** 3;
function amount(key: Allowance, n: number): string {
  if (key === 'storage_bytes') return `${Math.round(n / GB)} GB`;
  if (key === 'ai_tokens' || key === 'mcp_calls' || key === 'integration_jobs') {
    if (n >= 1_000_000 && n % 1_000_000 === 0) return `${n / 1_000_000}M`;
    if (n >= 1000 && n % 1000 === 0) return `${(n / 1000).toLocaleString('en-GB')}k`;
  }
  return n.toLocaleString('en-GB');
}

/** "100k + 50k per user" · "5" · "Not included" · "Workspace budget". */
export function describeAllowance(key: Allowance, rule: AllowanceRule | null, opts: { trial?: boolean } = {}): string {
  if (rule == null) return key === 'x_writes' || key === 'x_reads' ? 'Workspace budget · X charges per request' : 'Not metered by plan';
  if (rule.base === 0 && rule.per_seat === 0) return 'Not included';
  const base = amount(key, rule.base);
  if (!rule.per_seat) return opts.trial ? `${base} for the trial` : base;
  return `${base} + ${amount(key, rule.per_seat)} per user`;
}

export interface PricingPlan extends PlanCatalogueEntry {
  price: string; // "£10"
  examples: Array<{ seats: number; total: string }>;
}

/** Exactly the public, purchasable plans, in catalogue order. */
export function pricingPlans(): PricingPlan[] {
  return publicCatalogue().map((p) => ({
    ...p,
    price: formatMinorGBP(p.unit_amount_minor),
    examples: [1, 3, 10].map((seats) => ({ seats, total: formatMinorGBP(recurringTotalMinor(p.id, seats)) })),
  }));
}

export interface ComparisonRow { key: string; label: string; values: Record<PublicPlanId, string | boolean> }
export interface ComparisonGroup { id: string; title: string; note?: string; rows: ComparisonRow[] }

/** Features (✓/—), per-period allowances, and the bounded trial allowances — all straight from the catalogue. */
export function comparison(): ComparisonGroup[] {
  const ids = publicCatalogue().map((p) => p.id);
  const per = <T,>(f: (id: PublicPlanId) => T) => Object.fromEntries(ids.map((id) => [id, f(id)])) as Record<PublicPlanId, T>;
  return [
    {
      id: 'features', title: 'Features',
      rows: FEATURES.map((f) => ({ key: f, label: FEATURE_LABEL[f], values: per((id) => PLANS[id].features.includes(f)) })),
    },
    {
      id: 'allowances', title: 'Allowances per billing month', note: 'No overage charges: at a limit the action waits or is refused.',
      rows: ALLOWANCES.filter((a) => a !== 'x_reads').map((a) => ({
        key: a, label: a === 'x_writes' ? 'X API posts and reads' : ALLOWANCE_LABEL[a], values: per((id) => describeAllowance(a, PLANS[id].allowances[a])),
      })),
    },
    {
      id: 'trial', title: `During the ${TRIAL_DAYS}-day trial`, note: 'Trial allowances cover the whole trial and do not reset.',
      rows: ALLOWANCES.filter((a) => a !== 'x_reads').map((a) => ({
        key: `trial_${a}`, label: a === 'x_writes' ? 'X API posts and reads' : ALLOWANCE_LABEL[a], values: per((id) => describeAllowance(a, PLANS[id].trial_allowances[a], { trial: true })),
      })),
    },
  ];
}
