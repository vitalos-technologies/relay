// V3.1 stream GOV — typed contracts for the UI stream and MCP: brand profile + rules + reviews (§12), asset
// governance (§12), content reuse + evergreen queue (§13), campaign links / UTM / measurement (§14), integration
// diagnostics (§15), feature flags / support reports / release notes (§16), onboarding checklist (§7).
// Served by /api/** routes (see docs/v3-1-progress/gov.md for the route list). Pure: no IO.
import type { Provider } from '../types.js';

// ================================================================== §12 brand rules
export const BRAND_RULE_KINDS = ['prohibited_phrase', 'discouraged_phrase', 'preferred_term', 'required_footer', 'required_disclaimer', 'approved_link_domain'] as const;
export type BrandRuleKind = (typeof BRAND_RULE_KINDS)[number];
/** mandatory = blocks submit/schedule/publish (server-enforced); advisory = warning only. Never mixed. */
export type RuleSeverity = 'mandatory' | 'advisory';

/** Default severity offered by the editor for each kind (the stored rule's severity is always explicit). */
export const BRAND_RULE_DEFAULT_SEVERITY: Record<BrandRuleKind, RuleSeverity> = {
  prohibited_phrase: 'mandatory', discouraged_phrase: 'advisory', preferred_term: 'advisory',
  required_footer: 'mandatory', required_disclaimer: 'mandatory', approved_link_domain: 'mandatory',
};

export interface BrandRuleDto {
  id: string;
  brand_id: string;
  kind: BrandRuleKind;
  /** Phrase / term to avoid / footer or disclaimer text / domain (example.com). */
  value: string;
  /** preferred_term only: the term to use instead. */
  replacement: string | null;
  severity: RuleSeverity;
  /** Empty = all destinations. */
  providers: Provider[];
  note: string | null;
  created_at: string;
  updated_at: string;
}

export interface BrandColour { name: string; hex: string }

export interface BrandProfileDto {
  brand_id: string;
  rules_version: number;
  tone: string | null;
  colours: BrandColour[];
  /** Approved logo assets (must be this brand's assets). */
  logo_asset_ids: string[];
  cta_default: string | null;
  /** Legacy brand voice (brands.voice): prohibited terms there are treated as ADVISORY discouraged phrases. */
  voice: { tone?: string; terminology?: string[]; prohibited?: string[]; default_cta?: string; hashtags?: string[]; footer?: string };
  rules: BrandRuleDto[];
  can_edit: boolean;
  updated_at: string | null;
}

export type BrandFindingCode =
  | 'prohibited_phrase' | 'discouraged_phrase' | 'preferred_term' | 'missing_footer' | 'missing_disclaimer' | 'unapproved_link'
  | 'asset_expired' | 'asset_expires_before_publish' | 'asset_superseded' | 'asset_archived'
  | 'tipsignal_fact_altered' | 'tipsignal_fact_dropped' | 'tipsignal_fact_invented' | 'tipsignal_link' | 'tipsignal_promise_language'
  | 'tipsignal_expired';

export interface BrandFinding {
  code: BrandFindingCode;
  severity: RuleSeverity;
  message: string;
  /** null = applies to the base copy / every destination. */
  connection_id: string | null;
  rule_id: string | null;
  asset_id: string | null;
  source: 'brand_rule' | 'brand_voice' | 'asset' | 'tipsignal';
}

export interface BrandCheckResult {
  post_id: string;
  brand_id: string;
  rules_version: number;
  /** false when any mandatory finding exists (schedule/submit/publish is refused). */
  ok: boolean;
  mandatory: BrandFinding[];
  advisory: BrandFinding[];
  /** Evaluated at this instant (asset expiry is checked against the publish time when known). */
  evaluated_at: string;
}

export type ReviewDecision = 'keep' | 'will_edit' | 'cancel_schedule';

export interface BrandRuleReviewDto {
  id: string;
  brand_id: string;
  rules_version: number;
  post_id: string;
  post_title: string | null;
  schedule_id: string | null;
  kind: 'draft' | 'schedule';
  due_at: string | null;
  findings: BrandFinding[];
  mandatory_count: number;
  advisory_count: number;
  status: 'open' | 'decided' | 'superseded';
  decision: ReviewDecision | null;
  decided_by: string | null;
  decided_at: string | null;
  created_at: string;
}

/** Response of every rule/profile/asset-governance mutation: content is never rewritten, only listed for review. */
export interface RuleChangeImpact {
  rules_version: number;
  affected: { drafts: number; schedules: number; reviews_opened: number; truncated: boolean };
}

// ================================================================== §12 asset governance
export type AssetOwnership = 'owned' | 'licensed' | 'stock' | 'partner' | 'user_generated' | 'unknown';
export type AssetLifecycle = 'active' | 'superseded' | 'archived';

export interface AssetGovernanceDto {
  asset_id: string;
  brand_id: string;
  ownership: AssetOwnership;
  owner_name: string | null;
  licence: string | null;
  licence_url: string | null;
  notes: string | null;
  expires_at: string | null;
  lifecycle: AssetLifecycle;
  superseded_by: string | null;
  /** Derived now: expired | expiring (≤14 days) | ok. */
  expiry_state: 'expired' | 'expiring' | 'ok' | 'none';
  is_approved_logo: boolean;
  usage: { drafts: number; live_schedules: number };
  updated_at: string | null;
}

// ================================================================== §13 reuse + queue
export type TimeSensitiveReason =
  | 'tipsignal_source' | 'derived_from_time_sensitive' | 'contains_date_or_time' | 'contains_score' | 'contains_probability'
  | 'campaign_ended' | 'content_expired' | 'asset_expired' | 'promotion_tag';

export interface ReuseEligibility {
  post_id: string;
  evergreen: boolean;
  eligible: boolean;
  /** Why it may not be recycled (time-sensitive picks, expired promotions, outdated results …). */
  reasons: Array<{ code: TimeSensitiveReason | 'not_marked_evergreen' | 'archived' | 'already_queued' | 'already_used'; message: string }>;
  expires_at: string | null;
}

export interface ProvenanceDto {
  derived_post_id: string;
  original_post_id: string | null;
  original_post_ref: string;
  original_revision_id: string | null;
  kind: 'duplicate' | 'reuse';
  created_at: string;
}

export interface SimilarPostWarning {
  connection_id: string;
  other_post_id: string;
  other_title: string | null;
  other_excerpt: string;
  other_at: string;
  similarity: number;
  same_media: boolean;
}

export interface ReuseResult {
  post_id: string;
  provenance: ProvenanceDto;
  eligibility: ReuseEligibility;
  similar: SimilarPostWarning[];
}

export interface ContentQueueItemDto {
  id: string;
  post_id: string;
  title: string | null;
  excerpt: string;
  status: 'queued' | 'scheduled' | 'removed';
  position: number;
  added_at: string;
  schedule_id: string | null;
  scheduled_at: string | null;
  eligibility: ReuseEligibility;
}

export interface ContentQueueDto {
  brand_id: string;
  paused: boolean;
  paused_reason: string | null;
  paused_at: string | null;
  items: ContentQueueItemDto[];
  can: { add: boolean; pause: boolean; resume: boolean; schedule_next: boolean };
}

// ================================================================== §14 campaign links
export const UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'] as const;
export type UtmKey = (typeof UTM_KEYS)[number];
export type UtmParams = Partial<Record<UtmKey, string>>;

export interface UtmDefaultsDto {
  brand_id: string;
  campaign_id: string | null;
  params: UtmParams;
  /** Effective params after brand → campaign layering (campaign wins). */
  effective: UtmParams;
  updated_at: string | null;
}

export interface LinkPreview {
  ok: boolean;
  /** Final URL; null when the destination is invalid. */
  url: string | null;
  params: Array<{ key: string; value: string; origin: 'existing' | 'default' | 'override' | 'derived' }>;
  /** Existing query keys kept as-is (never duplicated). */
  preserved: string[];
  errors: string[];
  warnings: string[];
}

export interface TrackedLinkDto {
  id: string;
  brand_id: string;
  campaign_id: string | null;
  post_id: string | null;
  code: string;
  short_url: string;
  destination_url: string;
  disabled: boolean;
  created_at: string;
  clicks: number;
}

/** The four measurement families are NEVER summed or mixed. */
export interface CampaignMeasurement {
  campaign_id: string;
  native_social: {
    label: 'Native social metrics (reported by each network)';
    /** Per provider, per metric; never summed across providers. */
    by_provider: Array<{ provider: Provider; metrics: Record<string, number>; posts: number }>;
    freshness: string | null;
  };
  app_clicks: {
    label: 'Clicks observed by Relay short links';
    status: 'available' | 'no_links';
    total: number;
    by_day: Array<{ day: string; clicks: number }>;
    caveat: string;
  };
  website_events: { label: 'Website events'; status: 'not_configured'; reason: string };
  conversions: { label: 'Attributed conversions'; status: 'unavailable'; model: null; reason: string };
}

// ================================================================== §15 integration diagnostics
export type DiagnosticStatus = 'ok' | 'warning' | 'failing' | 'unknown' | 'not_applicable';

export interface DiagnosticCheck {
  key: 'authorization' | 'selected_account' | 'capabilities' | 'token' | 'publishing' | 'media' | 'analytics' | 'quota' | 'scheduled_work';
  status: DiagnosticStatus;
  title: string;
  detail: string;
  /** Actionable remedy, or null. */
  remedy: string | null;
}

export interface ConnectionDiagnostics {
  connection: { id: string; brand_id: string; provider: Provider; display_name: string; username: string | null; simulated: boolean; status: string };
  overall: DiagnosticStatus;
  checks: DiagnosticCheck[];
  selected_account: { display_name: string; username: string | null; resource_kind: string | null };
  capabilities: { granted_scopes: string[]; missing_scopes: string[]; formats: string[]; publish_mode: string; can_read_metrics: boolean };
  token: { expires_at: string | null; refresh_expires_at: string | null; refreshable: boolean; reconnect_required: boolean };
  analytics: { supported: boolean; sync_status: 'active' | 'stopped' | 'never' | 'unsupported'; stop_reason: string | null; last_success_at: string | null; last_run_status: string | null };
  quota: { throttled_until: string | null; circuit_open_until: string | null; window: { label: string; used: number; max: number } | null; budget: { meter: string; used: number; cap: number | null } | null };
  scheduled_work: { count: number; next_due_at: string | null; at_risk: number };
  /** Safe ids only (request correlation id + last delivery attempt correlation id). Never tokens. */
  correlation: { request_id: string; last_attempt_id: string | null };
  checked_at: string | null;
}

export interface IntegrationDiagnosticsResponse {
  generated_at: string;
  read_only: true;
  items: ConnectionDiagnostics[];
}

// ================================================================== §16 release controls
export interface FeatureFlagDef { key: string; description: string; default_enabled: boolean }

/** Code-side registry (safe default: every flag off). DB rows may raise rollout; unknown keys are always off. */
export const FEATURE_FLAGS: readonly FeatureFlagDef[] = [
  { key: 'v31.onboarding_checklist', description: 'Guided onboarding checklist', default_enabled: false },
  { key: 'v31.content_queue', description: 'Evergreen content queue', default_enabled: false },
  { key: 'v31.tracked_links', description: 'Campaign short links with app-observed clicks', default_enabled: false },
  { key: 'v31.brand_rules', description: 'Brand rules editor and review list', default_enabled: false },
  { key: 'v31.integration_diagnostics', description: 'Integration test centre', default_enabled: false },
  { key: 'v31.release_notes', description: 'In-app release notes', default_enabled: false },
];

export interface EffectiveFlag {
  key: string;
  description: string;
  enabled: boolean;
  source: 'killed' | 'workspace_override' | 'rollout' | 'default' | 'unknown';
  workspace_override: boolean | null;
}

export interface FeatureFlagsResponse { workspace_id: string; flags: EffectiveFlag[]; can_override: boolean }

export const SUPPORT_CATEGORIES = ['bug', 'publishing', 'integration', 'performance', 'account', 'other'] as const;
export type SupportCategory = (typeof SUPPORT_CATEGORIES)[number];

export interface SupportReportDto {
  id: string;
  category: SupportCategory;
  summary: string;
  route: string | null;
  app_version: string | null;
  occurred_at: string | null;
  correlation_ids: string[];
  attachments: { draft_excerpt?: { post_id: string; text: string } };
  redactions: number;
  status: 'open' | 'closed';
  created_at: string;
}

export interface ReleaseNote { version: string; date: string; title: string; items: string[]; flag?: string }

export const RELEASE_NOTES: readonly ReleaseNote[] = [
  {
    version: '3.1.0', date: '2026-11-07', title: 'Brand safeguards, reuse and diagnostics',
    items: [
      'Brand rules: mandatory rules block scheduling; advisory rules only warn. Rule changes list affected posts for review.',
      'Asset licences and expiry: expired assets can’t be published; superseded assets are flagged.',
      'Reuse a successful post as a new draft, with a link back to the original.',
      'Campaign links with UTM defaults and preview.',
      'Integration test centre: read-only checks for every connected account.',
    ],
  },
];

export interface ReleaseNotesResponse { current_version: string; notes: ReleaseNote[]; last_seen_version: string | null; unseen: number }

// ================================================================== §7 onboarding
export const ONBOARDING_STEPS = ['workspace', 'brand', 'brand_defaults', 'connect_destination', 'invite_teammates', 'create_draft', 'schedule_first_post'] as const;
export type OnboardingStepKey = (typeof ONBOARDING_STEPS)[number];

export interface OnboardingStep {
  key: OnboardingStepKey;
  title: string;
  status: 'done' | 'todo' | 'skipped' | 'not_applicable';
  /** What to do next (when todo), or who can do it when the viewer cannot. */
  action: { label: string; href: string } | null;
  /** The viewer lacks permission: who to ask instead (never tells guests/viewers to administer). */
  ask: string | null;
  optional: boolean;
}

export interface ConnectionReadiness {
  connection_id: string;
  display_name: string;
  provider: Provider;
  checks: Record<'authorization' | 'selected_account' | 'posting_permission' | 'supported_formats' | 'analytics_permission', DiagnosticStatus>;
}

export interface OnboardingState {
  workspace_id: string;
  role_view: 'admin' | 'manager' | 'contributor' | 'reader';
  dismissed: boolean;
  complete: boolean;
  progress: { done: number; total: number };
  next: OnboardingStep | null;
  steps: OnboardingStep[];
  connections: ConnectionReadiness[];
}
