// V4 entitlements contract (stream ENT; brief docs/queue/03g_V4_PROMPT.md §12–13, V5 §6–7). Types + const enums only.
// One shared entitlement service (packages/services/src/entitlements) answers "may this workspace do X now, and how much
// is left" for the app, admin, API routes, workers, MCP, AI actions and integrations. Billing facts come only from
// BillingState (v4-billing.ts); plan features/allowances from v4-plans.ts; platform overrides are audited.
import type { AccessLevel, Allowance, Feature, PlanId } from './v4-plans.js';
import type { BillingStatusValue } from './v4-billing.js';

/** Error code returned by API/MCP when an entitlement blocks an action (HTTP 402). */
export const ENTITLEMENT_ERROR = 'entitlement_required' as const;
/** Hold code on scheduled posts / queued replies / sync jobs held by the plan or billing state (never dropped). */
export const ENTITLEMENT_HOLD = 'entitlement_hold' as const;

/** Why an action is not available. */
export const BLOCK_REASONS = [
  'feature_not_in_plan', // the plan does not include the capability (upgrade)
  'access_restricted', // billing state restricts paid actions (trial ended, payment failed past grace, cancelled)
  'access_suspended', // Relay staff suspended the service (independent of billing)
  'allowance_exhausted', // the period's allowance (or a customer budget below it) is used up
  'over_limit_held', // the resource is beyond a lowered limit and was not chosen to stay active
  'no_plan', // the workspace has no plan
] as const;
export type BlockReason = (typeof BLOCK_REASONS)[number];

/**
 * Paid actions: held while access is restricted. Everything else (reading, billing, support, exports, editing drafts,
 * recording approvals, managing the team) stays available. Listed for docs + UI copy; enforcement is in services.
 */
export const PAID_ACTIONS = [
  'publish', // scheduled + immediate publication (dispatch-time re-check; held, never dropped)
  'send_reply', // queued social-inbox replies (dispatch-time re-check; held)
  'ai', // AI drafting / assistant runs (stopped with a reason; outputs are drafts anyway)
  'upload', // new media uploads (storage)
  'integration_sync', // business-integration sync jobs (held)
  'listening', // matching new items to saved searches + alerts (observations kept; re-matched on restore)
  'automation', // automation rule runs (recorded as blocked with the reason)
  'mcp_write', // MCP tools that change something (read tools stay available on plans with MCP)
] as const;
export type PaidAction = (typeof PAID_ACTIONS)[number];
export const ALWAYS_ALLOWED = ['read', 'billing', 'support', 'export', 'drafts', 'approvals_record', 'team'] as const;

/** Budget meter behind each allowance (usage counters); `gauge` = counted live from resources (no period). */
export const ALLOWANCE_METER: Record<Allowance, 'ai.tokens' | 'storage.bytes' | 'exports.count' | 'x.write' | 'x.read' | 'integration.jobs' | 'mcp.calls' | 'posts.scheduled' | 'gauge'> = {
  ai_tokens: 'ai.tokens',
  storage_bytes: 'storage.bytes',
  exports: 'exports.count',
  x_writes: 'x.write',
  x_reads: 'x.read',
  integration_jobs: 'integration.jobs',
  mcp_calls: 'mcp.calls',
  listening_searches: 'gauge',
  social_accounts: 'gauge',
  // D33: posts scheduled or published now, counted once per post per calendar month of publication (Free only today).
  scheduled_posts: 'posts.scheduled',
  brands: 'gauge',
  members: 'gauge',
};

export const ALLOWANCE_LABEL: Record<Allowance, { label: string; unit: 'tokens' | 'bytes' | 'exports' | 'calls' | 'searches' | 'accounts' | 'jobs' | 'posts' | 'brands' | 'members' }> = {
  ai_tokens: { label: 'AI tokens', unit: 'tokens' },
  storage_bytes: { label: 'Media storage', unit: 'bytes' },
  exports: { label: 'Exports', unit: 'exports' },
  x_writes: { label: 'X API posts', unit: 'calls' },
  x_reads: { label: 'X API reads', unit: 'calls' },
  listening_searches: { label: 'Active listening searches', unit: 'searches' },
  social_accounts: { label: 'Connected social accounts', unit: 'accounts' },
  integration_jobs: { label: 'Integration sync jobs', unit: 'jobs' },
  mcp_calls: { label: 'MCP tool calls', unit: 'calls' },
  scheduled_posts: { label: 'Scheduled posts', unit: 'posts' },
  brands: { label: 'Brands', unit: 'brands' },
  members: { label: 'Users', unit: 'members' },
};

/**
 * Allowances where a lowered limit lets the customer choose which resources stay active (nothing deleted/disconnected).
 * members: owners always stay active; other people over the limit keep their account but lose product access (billing,
 * support and export stay reachable) until the plan allows them or they are removed.
 */
export const SELECTABLE_ALLOWANCES = ['social_accounts', 'listening_searches', 'brands', 'members'] as const;
export type SelectableAllowance = (typeof SELECTABLE_ALLOWANCES)[number];

/** Warning threshold (percent of the effective limit) shown in UI and notified once per period. */
export const WARNING_PERCENT = 80 as const;

export type AllowanceSource = 'plan' | 'trial' | 'override' | 'unmetered';

export interface AllowanceState {
  key: Allowance;
  label: string;
  unit: (typeof ALLOWANCE_LABEL)[Allowance]['unit'];
  /** 'period' = resets each billing period; 'trial' = whole trial; 'total' = storage gauge; 'gauge' = live count. */
  period_kind: 'period' | 'trial' | 'total' | 'gauge';
  /** Included by the plan (or override) for this period; null = not metered by plan. */
  included: number | null;
  used: number;
  reserved: number;
  /** Customer-set budget (Settings → Budgets), only ever lowers the limit. */
  customer_cap: number | null;
  /** The limit actually enforced: min(included, customer_cap) (null = no limit). */
  hard_limit: number | null;
  /** Usage at which a warning shows (WARNING_PERCENT of hard_limit). */
  warning_at: number | null;
  remaining: number | null;
  percent: number | null;
  status: 'ok' | 'warning' | 'exhausted' | 'over_limit' | 'unmetered';
  source: AllowanceSource;
  /** Overages are never charged (no overage pricing is configured). */
  overage: 'none';
}

export interface FeatureState {
  enabled: boolean;
  source: 'plan' | 'override' | 'always';
}

export interface EntitlementOverrideDto {
  id: string;
  kind: 'feature' | 'allowance' | 'access';
  key: string;
  /** feature: enabled flag; allowance: limit (null = unmetered); access: 'full'. */
  value: { enabled?: boolean; limit?: number | null; level?: 'full' };
  reason: string;
  expires_at: string | null;
  created_at: string;
  created_by_email: string | null;
  revoked_at: string | null;
  status: 'active' | 'expired' | 'revoked';
}

export interface HeldWorkSummary {
  scheduled_posts: number;
  queued_replies: number;
  sync_jobs: number;
  automation_runs_blocked_24h: number;
  held_social_accounts: number;
  held_listening_searches: number;
  held_brands: number;
  held_members: number;
}

export interface PeriodInfo {
  /** Opaque counter key for monthly meters ('YYYY-MM', 'p:YYYY-MM-DD' or 'trial:YYYY-MM-DD'). */
  key: string;
  kind: 'calendar_month' | 'subscription' | 'trial';
  start: string;
  /** When monthly allowances reset (null for a trial: trial allowances never reset). */
  resets_at: string | null;
}

export interface EntitlementsDto {
  workspace_id: string;
  plan: { id: PlanId; name: string; public: boolean } | null;
  status: BillingStatusValue;
  access: AccessLevel;
  access_reason: string | null;
  /**
   * The CALLER is over the plan's user limit (e.g. a teammate on a Free workspace): product access is paused for them
   * until the owner upgrades or removes them; billing, support and export stay available. null when not held.
   */
  member_hold: string | null;
  trial: { started_at: string; ends_at: string; plan_id: PlanId } | null;
  period: PeriodInfo;
  features: Record<Feature, FeatureState>;
  allowances: AllowanceState[];
  overrides: EntitlementOverrideDto[];
  held: HeldWorkSummary;
  /** Short human-readable reasons (banner lines), most important first. */
  reasons: string[];
  /** The caller may change over-limit selections / sees billing links. */
  can_manage: boolean;
  as_of: string;
}

export interface SelectionDto {
  allowance: SelectableAllowance;
  limit: number | null;
  active_count: number;
  over_limit: boolean;
  items: Array<{ id: string; name: string; detail: string | null; active: boolean; chosen: boolean }>;
}

/** Details on an `entitlement_required` error (API `error.details`, MCP error details). */
export interface EntitlementErrorDetails {
  reason: BlockReason;
  feature?: Feature;
  allowance?: Allowance;
  /** Smallest public plan that includes the feature (upgrade prompt). */
  upgrade_to?: PlanId | null;
  access?: AccessLevel;
}

/** Short UI names for plan features (upgrade prompts, usage page). */
export const FEATURE_LABEL: Record<Feature, string> = {
  publishing: 'Publishing and scheduling',
  media_library: 'Media library',
  collaboration: 'Team collaboration',
  analytics_standard: 'Standard analytics',
  inbox: 'Social inbox',
  ai_drafting: 'AI drafting',
  support: 'In-app support',
  analytics_advanced: 'Advanced analytics and reports',
  listening: 'Listening',
  approvals_advanced: 'Multi-step approvals',
  care_advanced: 'Advanced customer care',
  ai_workflows: 'AI workflows',
  automation: 'Automations',
  integrations_business: 'Business integrations',
  mcp: 'MCP access',
};
