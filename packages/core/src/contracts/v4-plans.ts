// V4 plan catalogue + entitlement vocabulary (briefs docs/queue/03g_V4_PROMPT.md §9–13 and docs/queue/03h_V5_PROMPT.md §5–7).
// The ONE source for public plans, prices, trial length, plan features and default allowances. Marketing (V5), checkout,
// Settings → Billing, entitlements and Platform admin all read this (directly or via the persisted catalogue that the
// billing migration seeds from it). Never hard-code a price or plan name elsewhere.
//
// Persisted plan versions (billing stream) are the billing record: a subscription points at an immutable plan version, so
// editing this file or a plan label never silently reprices an existing subscription. Changing a public price = a new plan
// version (+ a new provider price), existing subscriptions keep theirs until explicitly migrated.

export const CURRENCY = 'GBP' as const;
export const BILLING_INTERVALS = ['month'] as const; // V5: monthly only, no invented annual discount.
export type BillingInterval = (typeof BILLING_INTERVALS)[number];
export const TRIAL_DAYS = 14 as const;
/** V5 §7: no card required to start a trial (no established policy requires one). */
export const TRIAL_REQUIRES_CARD = false as const;

// ------------------------------------------------------------------ features (plan capabilities, V5 §6)
/** Capability keys enforced by the shared entitlement service. Map 1:1 to implemented product areas. */
export const FEATURES = [
  // Standard
  'publishing', // compose, schedule, publish (simulated/live per connection), planner/calendar
  'media_library',
  'collaboration', // comments, mentions, tasks, approvals (single stage), review links
  'analytics_standard',
  'inbox', // supported social inbox workflows (V3.5): conversations, replies, notes, assignment
  'ai_drafting', // basic AI drafting assistance in the composer / inbox draft suggestions
  'support', // in-app support (always on, never restricted)
  // Professional
  'analytics_advanced', // reports, exports, comparisons, custom dashboards
  'listening', // listening on activated sources only (no third-party data licence included)
  'approvals_advanced', // multi-step approval policies, approval routing
  'care_advanced', // cases, SLAs, service levels, automatic routing
  'ai_workflows', // multi-step AI workflows (V5 AI workspace)
  'automation', // configured automation rules / bounded automation policies
  'integrations_business', // Asana, monday.com, HubSpot, Slack, Mailchimp, Google Business Profile, Translation
  'mcp', // MCP server access for AI clients
] as const;
export type Feature = (typeof FEATURES)[number];

/** Features that stay available whatever the billing state (brief V4 §11/§13: billing and support stay reachable). */
export const ALWAYS_AVAILABLE: readonly Feature[] = ['support'];

// ------------------------------------------------------------------ allowances (costly resources, V5 §6)
/**
 * Metered allowances per billing period (calendar month for trials; subscription period otherwise). Values are DEFAULTS —
 * configurable per plan version and overridable per workspace (audited). Final commercial allowances are an activation
 * item. `null` = not metered by plan (still subject to workspace safety caps). Never advertised as unlimited.
 */
export const ALLOWANCES = [
  'ai_tokens', // AI usage (maps to budgets meter ai.tokens)
  'storage_bytes', // media storage (maps to storage.bytes)
  'exports', // exports per period (maps to exports.count)
  'x_writes', // paid X API writes (maps to x.write) — X has per-call costs
  'x_reads', // paid X API reads (maps to x.read)
  'listening_searches', // active saved searches
  'social_accounts', // connected social accounts (connections)
  'integration_jobs', // business-integration sync jobs per period
  'mcp_calls', // MCP tool calls per period
  'scheduled_posts', // posts scheduled or published per period (D33: Free = 10/month)
  'brands', // active brands (gauge)
  'members', // billable members (gauge; D33: Free = 1, i.e. no teammates)
] as const;
export type Allowance = (typeof ALLOWANCES)[number];

export interface AllowanceRule {
  /** Included per workspace per period. */
  base: number;
  /** Added per billable seat. */
  per_seat: number;
}
export type AllowanceTable = Record<Allowance, AllowanceRule | null>;

// ------------------------------------------------------------------ plans
export const PUBLIC_PLAN_IDS = ['free', 'standard', 'professional'] as const;
export type PublicPlanId = (typeof PUBLIC_PLAN_IDS)[number];
/** `free` = £0 plan (D33). `legacy` = pre-V4 workspaces (not purchasable, no price; see docs/v4/PLANS_AND_ENTITLEMENTS.md "Migration"). */
export type PlanId = PublicPlanId | 'legacy';

export interface PlanDefinition {
  id: PlanId;
  name: string;
  /** One line for pricing cards. */
  summary: string;
  public: boolean;
  /** Price per billable user per interval, in minor units (pence). 0 = Free. null = no price (legacy). */
  unit_amount_minor: number | null;
  currency: typeof CURRENCY;
  interval: BillingInterval;
  per_seat: true;
  trial_days: number;
  features: readonly Feature[];
  allowances: AllowanceTable;
  /** Bounded trial allowances (V5 §7: trials are not unlimited). */
  trial_allowances: AllowanceTable;
  /** Short card bullets (marketing + billing). Detailed comparison is generated from features/allowances. */
  highlights: readonly string[];
}

const GB = 1024 ** 3;
const STANDARD_FEATURES: readonly Feature[] = ['publishing', 'media_library', 'collaboration', 'analytics_standard', 'inbox', 'ai_drafting', 'support'];
/** D33 Free: solo publishing only — no analytics, collaboration/approvals, inbox, listening, automation, integrations, MCP. */
const FREE_FEATURES: readonly Feature[] = ['publishing', 'media_library', 'ai_drafting', 'support'];
const PROFESSIONAL_FEATURES: readonly Feature[] = [...STANDARD_FEATURES, 'analytics_advanced', 'listening', 'approvals_advanced', 'care_advanced', 'ai_workflows', 'automation', 'integrations_business', 'mcp'];

const TRIAL_ALLOWANCES: AllowanceTable = {
  ai_tokens: { base: 100_000, per_seat: 0 },
  storage_bytes: { base: 2 * GB, per_seat: 0 },
  exports: { base: 5, per_seat: 0 },
  x_writes: { base: 0, per_seat: 0 }, // paid third-party API: not included in trials
  x_reads: { base: 0, per_seat: 0 },
  listening_searches: { base: 2, per_seat: 0 },
  social_accounts: { base: 5, per_seat: 0 },
  integration_jobs: { base: 200, per_seat: 0 },
  mcp_calls: { base: 500, per_seat: 0 },
  scheduled_posts: null,
  brands: null,
  members: null,
};

const MB = 1024 ** 2;
/** D33 Free allowances: what NEW work can start. Existing content is never locked or deleted; data export always works. */
const FREE_ALLOWANCES: AllowanceTable = {
  ai_tokens: { base: 20_000, per_seat: 0 },
  storage_bytes: { base: 500 * MB, per_seat: 0 },
  exports: { base: 0, per_seat: 0 }, // report/analytics exports; the workspace data export is never metered
  x_writes: { base: 0, per_seat: 0 }, // paid third-party API calls are not part of Free
  x_reads: { base: 0, per_seat: 0 },
  listening_searches: { base: 0, per_seat: 0 },
  social_accounts: { base: 2, per_seat: 0 },
  integration_jobs: { base: 0, per_seat: 0 },
  mcp_calls: { base: 0, per_seat: 0 },
  scheduled_posts: { base: 10, per_seat: 0 },
  brands: { base: 1, per_seat: 0 },
  members: { base: 1, per_seat: 0 },
};

export const PLANS: Record<PlanId, PlanDefinition> = {
  free: {
    id: 'free',
    name: 'Free',
    summary: 'For one person getting started.',
    public: true,
    unit_amount_minor: 0,
    currency: CURRENCY,
    interval: 'month',
    per_seat: true,
    trial_days: 0,
    features: FREE_FEATURES,
    allowances: FREE_ALLOWANCES,
    trial_allowances: FREE_ALLOWANCES,
    highlights: ['1 user', '1 brand and 2 social accounts', '10 scheduled posts a month', 'Planner, composer and 500 MB media', 'Help Centre support'],
  },
  standard: {
    id: 'standard',
    name: 'Standard',
    summary: 'Plan, publish and reply together.',
    public: true,
    unit_amount_minor: 500,
    currency: CURRENCY,
    interval: 'month',
    per_seat: true,
    trial_days: TRIAL_DAYS,
    features: STANDARD_FEATURES,
    allowances: {
      ai_tokens: { base: 100_000, per_seat: 50_000 },
      storage_bytes: { base: 10 * GB, per_seat: 5 * GB },
      exports: { base: 20, per_seat: 0 },
      x_writes: null, // X paid API: workspace safety caps only (existing budgets), costs disclosed in Connections
      x_reads: null,
      listening_searches: { base: 0, per_seat: 0 },
      social_accounts: { base: 5, per_seat: 3 },
      integration_jobs: { base: 0, per_seat: 0 },
      mcp_calls: { base: 0, per_seat: 0 },
      scheduled_posts: null,
      brands: null,
      members: null,
    },
    trial_allowances: { ...TRIAL_ALLOWANCES, listening_searches: { base: 0, per_seat: 0 }, integration_jobs: { base: 0, per_seat: 0 }, mcp_calls: { base: 0, per_seat: 0 } },
    highlights: ['Publishing and scheduling', 'Shared calendar and media library', 'Team collaboration', 'Social inbox', 'Standard analytics', 'AI drafting help'],
  },
  professional: {
    id: 'professional',
    name: 'Professional',
    summary: 'Everything in Standard, plus advanced workflows.',
    public: true,
    unit_amount_minor: 1500,
    currency: CURRENCY,
    interval: 'month',
    per_seat: true,
    trial_days: TRIAL_DAYS,
    features: PROFESSIONAL_FEATURES,
    allowances: {
      ai_tokens: { base: 500_000, per_seat: 200_000 },
      storage_bytes: { base: 50 * GB, per_seat: 10 * GB },
      exports: { base: 200, per_seat: 0 },
      x_writes: null,
      x_reads: null,
      listening_searches: { base: 5, per_seat: 2 },
      social_accounts: { base: 10, per_seat: 5 },
      integration_jobs: { base: 5_000, per_seat: 1_000 },
      mcp_calls: { base: 10_000, per_seat: 2_000 },
      scheduled_posts: null,
      brands: null,
      members: null,
    },
    trial_allowances: TRIAL_ALLOWANCES,
    highlights: ['Everything in Standard', 'Advanced analytics and reports', 'Listening on activated sources', 'Advanced approvals and customer care', 'AI workflows and automation', 'Business integrations and MCP'],
  },
  legacy: {
    id: 'legacy',
    name: 'Legacy',
    summary: 'Workspaces created before plans existed.',
    public: false,
    unit_amount_minor: null,
    currency: CURRENCY,
    interval: 'month',
    per_seat: true,
    trial_days: 0,
    features: PROFESSIONAL_FEATURES,
    allowances: {
      ai_tokens: null, storage_bytes: null, exports: null, x_writes: null, x_reads: null,
      listening_searches: null, social_accounts: null, integration_jobs: null, mcp_calls: null,
      scheduled_posts: null, brands: null, members: null,
    },
    trial_allowances: {
      ai_tokens: null, storage_bytes: null, exports: null, x_writes: null, x_reads: null,
      listening_searches: null, social_accounts: null, integration_jobs: null, mcp_calls: null,
      scheduled_posts: null, brands: null, members: null,
    },
    highlights: [],
  },
};

/** Monthly recurring total for `seats` billable users, in minor units (0 for Free). Throws for plans without a price. */
export function recurringTotalMinor(plan: PlanId, seats: number): number {
  const p = PLANS[plan];
  if (p.unit_amount_minor == null) throw new Error(`plan ${plan} has no price`);
  if (!Number.isInteger(seats) || seats < 1) throw new Error('at least one paid seat is required');
  return p.unit_amount_minor * seats;
}

/** "£10" / "£12.50" — display only; never parse back. */
export function formatMinorGBP(minor: number): string {
  const pounds = minor / 100;
  return `£${Number.isInteger(pounds) ? pounds.toString() : pounds.toFixed(2)}`;
}

/** Effective allowance for a plan + seat count (null = not metered by plan). */
export function allowanceFor(table: AllowanceTable, key: Allowance, seats: number): number | null {
  const r = table[key];
  return r == null ? null : r.base + r.per_seat * Math.max(1, seats);
}

// ------------------------------------------------------------------ seats (V5 §5)
/**
 * Billable user = active, accepted workspace member (owner included). NOT billable: pending invitations, Relay support
 * operators present through a support-access grant (`created_membership` / source 'support_access'), service accounts,
 * guests limited to shared review links (role preset `guest`, capped by GUEST_SEAT_EXEMPTION).
 */
export const GUEST_SEAT_EXEMPTION = {
  /** Guests are free only while they hold nothing but the `guest` preset (review/comment on shared items). */
  role: 'guest',
  /** Hard cap on free guests per workspace; guests beyond it count as billable seats. */
  max_free_guests: 5,
} as const;
export const MIN_PAID_SEATS = 1 as const;

// ------------------------------------------------------------------ subscription + lifecycle states (V4 §10)
export const SUBSCRIPTION_STATUSES = [
  'trialing', // in the free trial (no card)
  'active',
  'payment_action_required', // provider needs customer action (e.g. SCA)
  'past_due', // renewal payment failed; grace period running
  'cancel_scheduled', // active/trialing with cancel at period end
  'cancelled', // ended by cancellation (effective date reached)
  'expired', // trial ended without subscription, or grace exhausted
  'incomplete', // checkout started, first payment not confirmed by the provider
] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

/** Product access derived from billing + service state (separate dimensions; V4 §10). */
export const ACCESS_LEVELS = [
  'full', // everything the plan includes
  'restricted', // paid actions held (publishing dispatch, sends, AI, sync, uploads); read, billing, support, exports allowed
  'suspended', // service suspended by Relay staff (independent of billing)
] as const;
export type AccessLevel = (typeof ACCESS_LEVELS)[number];

export interface PlanCatalogueEntry {
  id: PublicPlanId;
  name: string;
  summary: string;
  unit_amount_minor: number;
  currency: typeof CURRENCY;
  interval: BillingInterval;
  trial_days: number;
  highlights: readonly string[];
  features: readonly Feature[];
}

/** Public catalogue (marketing page, signup handoff, checkout, billing settings). Exactly the purchasable plans. */
export function publicCatalogue(): PlanCatalogueEntry[] {
  return PUBLIC_PLAN_IDS.map((id) => {
    const p = PLANS[id];
    return { id, name: p.name, summary: p.summary, unit_amount_minor: p.unit_amount_minor!, currency: p.currency, interval: p.interval, trial_days: p.trial_days, highlights: p.highlights, features: p.features };
  });
}
