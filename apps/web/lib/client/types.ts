// Client-side mirrors of the HTTP contract in docs/API.md. Types only; no runtime.
import type {
  Action, ChannelCapabilities, ConnectionStatus, DeliveryState, DraftContent, Permission, PostAggregateStatus,
  Provider, ResolvedVariant, Role, ValidationIssue,
} from '@social-lite/core';

export type { Action, ConnectionStatus, DeliveryState, DraftContent, PostAggregateStatus, Provider, Role, ValidationIssue };

export interface SessionInfo {
  user: { id: string; email: string; name: string | null };
  csrf_token: string;
  workspace: { id: string; name: string; role: Role; is_demo: boolean; timezone: string; publishing_paused: boolean; primary_role?: string } | null;
  workspaces: Array<{ id: string; name: string; role: Role; is_demo: boolean }>;
  brands: SessionBrand[];
  permissions: Record<Action, boolean>;
  /** V2 flags (stream B): permission held anywhere, per-brand permissions, policy version. */
  v2?: { permissions: Partial<Record<Permission, boolean>>; brands: Record<string, Permission[]>; policy_version: number; mfa_verified: boolean;
    pending_ownership_transfer: { id: string; from_email: string } | null };
  mock_providers_enabled: boolean;
  app_env: 'development' | 'test' | 'production';
  /** Present in the implementation: whether this user may create a workspace (POST /api/workspaces). */
  can_create_workspace?: boolean;
}

export interface SessionBrand {
  id: string; name: string; timezone: string; publishing_paused: boolean; approval_required: boolean; is_demo: boolean;
}

export interface Workspace {
  id: string; name: string; timezone: string; is_demo: boolean; publishing_paused: boolean;
  paused_reason: string | null; paused_at: string | null; limits: Record<string, unknown> | null; created_at: string;
}

export interface Member {
  user_id: string; email: string; name: string | null; role: Role; brand_ids: string[] | null; joined_at: string;
}
export interface Invitation {
  id: string; email: string; role: Role; brand_ids: string[] | null; expires_at: string; created_at: string;
  invited_by_email: string | null; status: 'pending' | 'expired';
  /** Not in the contract; shown only if the server chooses to return it (e.g. development). */
  accept_url?: string; token?: string; email_sent?: boolean;
}
export interface RemovalImpact { approved_schedules_remaining: number; drafts_losing_access: number; pending_approvals: number }
export interface InvitationPreview { workspace_name: string; email_hint: string | null; role: Role; expires_at: string; status: string }

export interface BrandVoice {
  tone?: string; terminology?: string[]; prohibited?: string[]; default_cta?: string; hashtags?: string[]; footer?: string;
}
export interface Brand {
  id: string; name: string; timezone: string; approval_required: boolean; editors_can_publish: boolean;
  default_deadline_minutes: number; publishing_paused: boolean; paused_reason: string | null; paused_at: string | null;
  voice: BrandVoice; is_demo: boolean; connection_count: number; created_at: string;
}

export type MockScenario =
  | 'success' | 'fail_permanent' | 'fail_transient_once' | 'timeout_after_send'
  | 'rate_limited_once' | 'processing' | 'revoked' | 'missing_permission';

export interface ProviderStatus {
  provider: Provider; configured: boolean; missing: string[]; callback_url: string | null;
  required_scopes: string[]; mock_available: boolean; notes: string;
}

export interface Connection {
  id: string; brand_id: string; provider: Provider; provider_account_id: string; display_name: string;
  username: string | null; status: ConnectionStatus; status_label: string; is_mock: boolean;
  capabilities: ChannelCapabilities | Record<string, never>;
  health: { message: string | null; checked_at: string | null; missing_permissions?: string[]; expires_at?: string | null };
  paused: boolean; throttled_until: string | null; mock_scenario?: MockScenario; created_at: string; disconnected_at: string | null;
}

export interface DestinationCandidate {
  providerAccountId?: string; provider_account_id?: string;
  displayName?: string; display_name?: string;
  username?: string | null;
  provider: Provider;
  unavailableReason?: string | null; unavailable_reason?: string | null;
}
export interface ConnectionFlow { provider: Provider; brand_id: string; candidates: DestinationCandidate[]; expires_at: string }

export type AssetStatus = 'pending_upload' | 'quarantined' | 'ready' | 'rejected' | 'archived';
export interface Asset {
  id: string; brand_id: string; status: AssetStatus; rejection_reason: string | null; original_filename: string;
  mime: string | null; bytes: number | null; width: number | null; height: number | null; alt_text: string | null;
  tags: string[]; created_at: string; preview_url: string | null; thumb_url: string | null; usage_count: number;
}
export interface UploadIntent { asset_id: string; upload: { method: 'POST'; url: string; fields: Record<string, string> } }

export interface Template { id: string; brand_id?: string; name: string; body: string; tags: string[]; created_at?: string; updated_at?: string }

export interface PostDestination { connection_id: string; provider: Provider; is_mock: boolean; state: DeliveryState | null }
export interface PostSummary {
  id: string; brand_id: string; title: string | null; excerpt: string; tags: string[]; status: PostAggregateStatus;
  version: number; updated_at: string; due_at: string | null; destinations: PostDestination[];
}

export interface Schedule {
  id: string; post_id: string; revision_id: string; revision_number: number; generation: number; due_at: string;
  input_timezone: string; input_local_time: string | null; input_offset: string | null; publish_before: string | null;
  is_immediate: boolean; status: 'pending_approval' | 'active' | 'superseded' | 'cancelled' | 'completed' | 'rejected';
  created_at: string; created_by_email: string | null;
}
export interface Approval {
  id: string; decision: 'pending' | 'approved' | 'rejected' | 'invalidated'; requested_by_email: string | null;
  reviewer_email: string | null; decided_at: string | null; reason: string | null; fingerprint: string;
}

export interface DeliveryAttempt {
  attempt_number: number; kind: string; phase: string; outcome: string | null; safe_code: string | null;
  safe_message: string | null; started_at: string; ended_at: string | null; actor_email: string | null;
  duplicate_risk_acknowledged: boolean;
}
export interface Delivery {
  id: string; schedule_id: string; post_id: string; connection_id: string; provider: Provider; display_name: string;
  is_mock: boolean; state: DeliveryState; state_label: string; due_at: string; publish_before: string | null;
  attempt_count: number; max_attempts: number; next_attempt_at: string | null; provider_ids: string[];
  provider_url: string | null; published_at: string | null; last_error_code: string | null; last_error_message: string | null;
  blocked_reason: string | null; unknown_since: string | null; can_retry: boolean; retry_requires_ack: boolean;
  /** Scheduled/retrying but past its dispatch time (publisher stopped or backlogged). */
  overdue?: boolean;
  attempts?: DeliveryAttempt[];
}
export interface HistoryRow extends Delivery {
  brand_id: string; brand_name: string; post_title: string | null; excerpt: string; revision_number: number;
  scheduled_input: string; input_timezone: string;
}

export interface PostDetail extends PostSummary {
  draft: DraftContent; created_by: string; updated_by_email: string | null;
  brand: Brand; connections: Connection[]; assets: Asset[];
  current_schedule: Schedule | null; approval: Approval | null; deliveries: Delivery[];
  can: { edit: boolean; schedule: boolean; schedule_reason?: string; submit: boolean; publish_now: boolean; cancel: boolean };
}

export interface ValidateResponse {
  ok: boolean; issues: ValidationIssue[];
  per_destination: Record<string, { ok: boolean; measured_length: number; limit: number }>;
}

export interface PlannerItem {
  schedule_id: string; post_id: string; brand_id: string; title: string | null; excerpt: string; due_at: string;
  input_timezone: string; input_local_time: string | null; status: PostAggregateStatus; schedule_status: Schedule['status'];
  destinations: Array<{ connection_id: string; provider: Provider; is_mock: boolean; state: DeliveryState; overdue?: boolean }>;
  /** Past its time and not sent (publisher stopped or backlogged). */
  overdue?: boolean;
  /** V2 calendar ownership (stream C) — only for brands already in scope. */
  campaign?: { id: string; name: string | null } | null; team?: { id: string; name: string | null } | null;
  assignee?: { id: string; email: string | null; name: string | null } | null;
  review?: { id: string; decision: string; stage: number; stage_count: number } | null;
}

/** Contract names ApprovalSummary without fields; everything beyond Approval is optional and rendered defensively. */
export interface ApprovalSummary extends Partial<Approval> {
  id: string; post_id?: string; post_title?: string | null; title?: string | null; excerpt?: string | null;
  brand_id?: string; brand_name?: string; brand?: { id: string; name: string };
  created_at?: string; requested_at?: string; due_at?: string | null; schedule?: Schedule | null;
  destinations?: Array<{ connection_id?: string; provider: Provider; is_mock?: boolean; display_name?: string }>;
}
export interface ApprovalDetail extends Approval {
  post_id: string; brand: Brand; schedule: Schedule;
  variants: Array<ResolvedVariant & { connection: Connection; assets: Asset[] }>;
  diff: { previous_revision_number: number | null; base_text: { before: string; after: string } | null; changed_destinations: string[] };
  post_title?: string | null; created_at?: string;
}

export interface Dashboard {
  today: PlannerItem[];
  attention: { blocked: Delivery[]; unknown: Delivery[]; failed: Delivery[]; expired: Delivery[]; handoff?: Delivery[] };
  delayed?: { overdue: number; oldest_due_at: string | null; publisher_running: boolean; dispatch_enabled: boolean };
  account_warnings: Connection[];
  recent: HistoryRow[];
  paused: { workspace: boolean; brands: string[] };
}

export interface AppNotification {
  id: string; severity: 'info' | 'warning' | 'critical'; kind: string; title: string; body: string | null;
  reference_type: string | null; reference_id: string | null; occurrences?: number; created_at: string;
  last_seen_at?: string; read_at: string | null; url?: string | null;
}

export interface SetupItem {
  key: string; label: string; secret: boolean; is_set: boolean; source: 'env' | 'setup' | null; hint: string | null;
  value?: string; docs_url?: string;
  /** Implementation extras: whether the value can be entered here, and a safety warning about the current value. */
  editable?: boolean; warning?: string;
}
export interface SetupGroup { id: string; title: string; items: SetupItem[]; required?: boolean; ready?: boolean }

export interface DiagnosticsCheck { name: string; ok: boolean; detail: string | null }

export interface Page<T> { items: T[]; next_cursor: string | null }
