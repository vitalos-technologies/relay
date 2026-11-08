// V3.1 Admin contracts (brief docs/queue/03c_V3_1_ADMIN_PROMPT.md). Pure types/constants shared by services and UI.
import type { DeliveryState, Provider } from '../types.js';

/** Health vocabulary used by every admin card/row (brief §6). */
export const HEALTH_STATES = ['healthy', 'degraded', 'failed', 'paused', 'unknown', 'awaiting_setup', 'unsupported', 'demo'] as const;
export type HealthState = (typeof HEALTH_STATES)[number];

// ------------------------------------------------------------------ change feed (§5)
/** Topics the admin UI can subscribe to. Tokens are opaque; a changed token means "refetch this topic". */
export const ADMIN_TOPICS = ['access', 'publishing', 'content', 'approvals', 'connections', 'audit', 'jobs', 'support'] as const;
export type AdminTopic = (typeof ADMIN_TOPICS)[number];
export interface AdminChanges {
  workspace_id: string;
  policy_version: number;
  /** Server time the markers were read (the UI shows freshness from this). */
  at: string;
  topics: Record<AdminTopic, string>;
  /** Normal-operation poll interval the server recommends (ms). */
  poll_ms: number;
}
/** Sync targets (documented in docs/admin/SYNC_AND_EVENT_MODEL.md and tested). */
export const ADMIN_SYNC = { poll_ms: 10_000, max_backoff_ms: 60_000, safety_refetch_ms: 60_000 } as const;

// ------------------------------------------------------------------ workspace overview (§6)
export interface OverviewCard {
  key: 'publishing' | 'attention' | 'scheduled' | 'approvals' | 'connections' | 'queue' | 'analytics' | 'imports' | 'usage' | 'security';
  label: string;
  state: HealthState;
  /** Primary count (null = not measurable here; never shown as 0). */
  value: number | null;
  detail: string | null;
  /** Drill-down with filters preserved. */
  href: string;
}
export interface AdminOverview {
  generated_at: string;
  workspace: { id: string; name: string; is_demo: boolean; paused: boolean; paused_reason: string | null };
  cards: OverviewCard[];
  activity: Array<{ id: string; action: string; at: string; actor: string | null; resource_type: string }>;
  support_access: SupportAccessDto[];
}

// ------------------------------------------------------------------ publishing operations (§8)
export const ADMIN_DELIVERY_STATES = [
  'awaiting_approval', 'scheduled', 'queued', 'processing', 'provider_scheduled', 'published', 'failed', 'unknown', 'cancelled',
  'expired', 'paused', 'blocked', 'retrying', 'handoff',
] as const;
export type AdminDeliveryState = (typeof ADMIN_DELIVERY_STATES)[number];
/** Filter groups (URL `state=`). 'attention' = failed, unknown, blocked, handoff, expired (still in the window). */
export const ADMIN_DELIVERY_FILTERS = ['attention', ...ADMIN_DELIVERY_STATES] as const;
export type AdminDeliveryFilter = (typeof ADMIN_DELIVERY_FILTERS)[number];

export interface AdminDeliveryItem {
  id: string;
  post_id: string;
  schedule_id: string;
  brand_id: string;
  brand_name: string;
  connection_id: string;
  destination: string;
  provider: Provider;
  is_mock: boolean;
  state: DeliveryState;
  display_state: AdminDeliveryState;
  title: string | null;
  due_at: string;
  updated_at: string;
  published_at: string | null;
  attempt_count: number;
  error_code: string | null;
}
export interface AdminDeliveryList { items: AdminDeliveryItem[]; next_cursor: string | null; counts: Partial<Record<AdminDeliveryFilter, number>> }

export type RecoveryAction = 'retry' | 'retry_with_risk' | 'resolve' | 'cancel' | 'reschedule' | 'adopt' | 'pause_connection' | 'resume_connection';
export interface RecoveryOption { action: RecoveryAction; available: boolean; reason: string | null }

export interface AdminDeliveryDetail extends AdminDeliveryItem {
  excerpt: string | null;
  revision_number: number;
  schedule: { status: string; generation: number; input_local_time: string; input_timezone: string; publish_before: string };
  approval: { required: boolean; decision: string | null; decided_at: string | null; decided_by: string | null } | null;
  authority: { status: string; scheduled_by: string | null; hold_code: string | null } | null;
  provider_ids: string[];
  provider_url: string | null;
  error_message: string | null;
  reconcile: { needs_reconcile: boolean; unknown_since: string | null };
  remote_schedule: { publish_at: string | null; state: string | null } | null;
  connection: { status: string; paused: boolean; disconnected: boolean };
  attempts: Array<{ attempt_number: number; kind: string; phase: string; outcome: string | null; safe_code: string | null; safe_message: string | null; started_at: string; ended_at: string | null; actor_email: string | null }>;
  recovery: RecoveryOption[];
}

export interface DeadLetterItem { id: string; event_type: string; aggregate_type: string; aggregate_id: string; attempts: number; last_error: string | null; created_at: string; requeue_allowed: boolean; reason: string | null }

// ------------------------------------------------------------------ support access (§13)
export const SUPPORT_ACCESS_STATUSES = ['requested', 'active', 'declined', 'ended', 'cancelled', 'lapsed'] as const;
export type SupportAccessStatus = (typeof SUPPORT_ACCESS_STATUSES)[number];
export interface SupportAccessDto {
  id: string;
  workspace_id: string;
  workspace_name: string | null;
  operator: { id: string; email: string; name: string | null };
  reason: string;
  ticket_ref: string | null;
  access: 'read';
  duration_minutes: number;
  status: SupportAccessStatus;
  requested_at: string;
  request_expires_at: string;
  decided_at: string | null;
  decided_by: string | null;
  starts_at: string | null;
  expires_at: string | null;
  ended_at: string | null;
  end_reason: string | null;
}

// ------------------------------------------------------------------ platform (§4)
export const PLATFORM_ROLES = ['operator', 'support'] as const;
export type PlatformRole = (typeof PLATFORM_ROLES)[number];
export interface PlatformMe { operator: boolean; role: PlatformRole | null; fresh: boolean }

export interface PlatformOverview {
  generated_at: string;
  dispatch_enabled: boolean;
  workspaces: { active: number; suspended: number; demo: number };
  users: { total: number; disabled: number; signed_in_24h: number };
  workers: Array<{ worker_id: string; version: string | null; age_seconds: number; stopped: boolean }>;
  queues: Array<{ queue: string; waiting: number; oldest_age_seconds: number }>;
  /** false when the web role can't read the pg-boss schema (least privilege): only the deliveries gauge is shown. */
  jobs_visible: boolean;
  outbox: { pending: number; dead: number; oldest_age_seconds: number };
  circuits: Array<{ provider: string; state: string; failure_count: number; opened_until: string | null }>;
  deliveries_24h: { live: Record<string, number>; simulated: Record<string, number> };
  connections: Array<{ provider: Provider; total: number; problems: number; simulated: number }>;
  analytics: { failed_runs_24h: number; succeeded_runs_24h: number; stale_connections: number };
  support: { requested: number; active: number };
  flags: { killed: number; rolling_out: number };
  alerts: Array<{ severity: 'critical' | 'warning'; message: string }>;
}

export interface PlatformWorkspaceItem {
  id: string; name: string; state: 'active' | 'suspended'; is_demo: boolean; created_at: string;
  members: number; brands: number; connections: number; scheduled: number; failed_7d: number;
  last_activity_at: string | null; publishing_paused: boolean;
}
export interface PlatformWorkspaceDetail extends PlatformWorkspaceItem {
  suspended_at: string | null; suspended_reason: string | null; paused_reason: string | null;
  owners: Array<{ id: string; email: string; name: string | null }>;
  member_status: Record<string, number>;
  connections_by_provider: Array<{ provider: Provider; status: string; n: number; simulated: number }>;
  deliveries_7d: Record<string, number>;
  dispatch_concurrency: number | null;
  flag_overrides: Array<{ key: string; enabled: boolean }>;
  support_access: SupportAccessDto[];
  audit: PlatformAuditItem[];
}

export interface PlatformAuditItem {
  id: string; at: string; actor: string | null; action: string; target_type: string; target_id: string | null;
  workspace_id: string | null; workspace_name: string | null; reason: string | null; outcome: string; diff: Record<string, unknown>; correlation_id: string | null;
}

export interface PlatformFlag { key: string; description: string; default_enabled: boolean; rollout_percent: number; killed: boolean; overrides: number; updated_at: string | null; updated_by: string | null; registered: boolean }

export interface PlatformOperatorDto { user_id: string; email: string; name: string | null; role: PlatformRole; granted_at: string; granted_via: string; revoked_at: string | null; note: string | null }
