// V3.1 DATA stream typed contracts (drafts/recovery §9, trash §10, bulk §11, search §8) shared by the services
// (packages/services/src/data/**), the API routes (apps/web/app/api/**) and the later V3.1 UI stream.
// Pure: no IO. Full client contract: docs/V3_1_DATA_API.md.
import type { Permission } from '../authz.js';
import type { DraftContent } from '../types.js';

// ================================================================== §9 Draft resilience

/**
 * Save states the composer shows. Only `saved` means the server committed the content (it carries a version).
 * `saved_locally` means it exists only in this browser (recovery storage) and MUST NOT be presented as saved.
 */
export type DraftSaveState = 'idle' | 'saving' | 'saved' | 'saved_locally' | 'offline' | 'save_failed' | 'conflict';

export interface AutosaveRequest {
  /** Version the editor last received from the server (optimistic concurrency). */
  base_version: number;
  /** Stable per editor tab (8-64 chars [A-Za-z0-9_-]); generated once per tab. */
  client_id: string;
  /** Monotonic per client_id (increment on every save attempt; retries reuse the same value). */
  client_revision: number;
  draft?: DraftContent;
  title?: string | null;
}

export interface AutosaveSaved {
  status: 'saved';
  post_id: string;
  version: number;
  saved_at: string;
  /** true when the content equalled the server copy (no new version) */
  unchanged: boolean;
  /** true when this exact save (client_id + client_revision) was already committed (retry after a lost response) */
  duplicate: boolean;
}

export interface AutosaveIgnored {
  status: 'stale_ignored';
  post_id: string;
  /** current server version; a newer save from the same tab already landed */
  version: number;
}

export type AutosaveResponse = AutosaveSaved | AutosaveIgnored;

/** 409 version_conflict error.details for autosave/recover: everything the client needs to resolve. */
export interface DraftConflictDetails {
  current: {
    version: number;
    updated_at: string;
    updated_by: string | null; // email of the last saver
    title: string | null;
    draft: DraftContent;
  };
  /** The rejected content is kept in History as a conflict copy (never lost). */
  conflict_copy_id: string | null;
}

export interface RecoverRequest {
  base_version: number;
  client_id: string;
  draft: DraftContent;
  title?: string | null;
  /** When the content was stored locally (client clock; informational, never trusted for ordering). */
  local_saved_at?: string | null;
}

export type RecoverResponse =
  | { status: 'applied'; post_id: string; version: number; saved_at: string; unchanged: boolean }
  /** Server has a newer version: nothing was overwritten; the recovered content was stored as a conflict copy. */
  | { status: 'kept_as_copy'; post_id: string; conflict_copy_id: string; current_version: number; current_updated_at: string; current_updated_by: string | null };

export type RecoveryBlockReason = 'no_permission' | 'archived' | 'trashed' | 'not_found';

export interface DraftRecoveryStatus {
  post_id: string;
  current_version: number;
  updated_at: string;
  updated_by: string | null;
  /** Caller may sync recovered content now (content.edit on the brand, post not archived/trashed). */
  editable: boolean;
  blocked_reason: RecoveryBlockReason | null;
  /** Compared with the base_version query parameter (null when not given). */
  server_newer: boolean | null;
  /** The caller's own recent conflict copies on this post (newest first, max 5). */
  conflict_copies: Array<{ id: string; base_version: number; created_at: string }>;
  policy: DraftRecoveryPolicy;
}

export type LocalRecoveryMode = 'persistent' | 'session' | 'off';

/** Workspace policy for browser-side recovery storage (exposed in GET /api/session as `draft_recovery`). */
export interface DraftRecoveryPolicy {
  /** persistent = survive browser restart (localStorage/IndexedDB); session = tab lifetime only; off = never store. */
  local_recovery: LocalRecoveryMode;
  /** Discard local copies older than this. */
  max_age_hours: number;
  /** Clear this user's local copies for the workspace on logout. */
  clear_on_logout: boolean;
  /** Storage key prefix: always namespaced by user + workspace; append `:<post_id>` per draft. */
  namespace: string;
}

export const DRAFT_RECOVERY_DEFAULTS = { local_recovery: 'persistent', max_age_hours: 72, clear_on_logout: true } as const;
/** Client debounce for autosave (ms). The server tolerates any cadence; this is the documented UI default. */
export const AUTOSAVE_DEBOUNCE_MS = 800;

// ================================================================== §10 Trash / soft delete / undo

export type TrashKind = 'post' | 'asset';

/** Documented retention: items stay restorable this long, then the purge job deletes them (after reference checks). */
export const TRASH_RETENTION_DAYS: Record<TrashKind, number> = { post: 30, asset: 30 };

export interface TrashConsequences {
  kind: TrashKind;
  id: string;
  title: string | null;
  can_trash: boolean;
  /** Why trashing is refused (e.g. live schedule, published history). */
  blocked_reason: string | null;
  /** Plain-language consequences to show before confirming. */
  consequences: string[];
  references: { live_schedules: number; active_deliveries: number; drafts: number; published_deliveries: number };
  retention_days: number;
  /** Deleting in Relay never deletes anything already published on a network. */
  external_posts_affected: false;
}

export interface UndoToken {
  /** Server operation that undoes the action; replay it with the same fields. */
  operation: 'trash.restore' | 'trash.delete';
  kind: TrashKind;
  id: string;
  /** Concurrency check: the trash state the undo expects (restore fails with conflict if it changed). */
  expected_deleted_at: string | null;
  /** For trash.delete (undo of a restore): the post version the undo expects. */
  expected_version?: number | null;
}

export interface TrashItemView {
  kind: TrashKind;
  id: string;
  brand_id: string;
  title: string | null;
  deleted_at: string;
  deleted_by: string | null;
  purge_after: string;
  /** Purge is deferred while something still references the item. */
  purge_blocked_reason: string | null;
  can_restore: boolean;
}

export interface TrashResult { kind: TrashKind; id: string; deleted_at: string; purge_after: string; undo: UndoToken }
export interface RestoreResult { kind: TrashKind; id: string; restored: true; republished: false; undo: UndoToken }

// ================================================================== §11 Bulk workflows

export const BULK_MAX_ITEMS = 500;

export const BULK_POST_ACTIONS = [
  'assign', 'add_tags', 'remove_tags', 'set_campaign', 'duplicate', 'archive', 'unarchive', 'reschedule', 'trash', 'restore',
] as const;
export const BULK_ASSET_ACTIONS = ['add_tags', 'remove_tags', 'archive', 'unarchive', 'trash', 'restore'] as const;
export type BulkPostAction = (typeof BULK_POST_ACTIONS)[number];
export type BulkAssetAction = (typeof BULK_ASSET_ACTIONS)[number];
export type BulkAction = BulkPostAction | BulkAssetAction | 'undo';

export interface BulkParams {
  /** assign: null clears; omit to leave unchanged */
  assignee_user_id?: string | null;
  team_id?: string | null;
  /** add_tags / remove_tags */
  tags?: string[];
  /** set_campaign: null removes the campaign */
  campaign_id?: string | null;
  /** reschedule: move each live schedule by this many minutes (wall-clock in its own timezone) */
  shift_minutes?: number;
}

export interface BulkRequest {
  target_kind: 'post' | 'asset';
  action: BulkPostAction | BulkAssetAction;
  item_ids: string[];
  params?: BulkParams;
}

/** Permission each action needs on every item's brand (checked per item, at preview AND when the job runs). */
export const BULK_ACTION_PERMISSION: Record<string, Permission> = {
  'post.assign': 'content.edit', 'post.add_tags': 'content.edit', 'post.remove_tags': 'content.edit', 'post.set_campaign': 'content.edit',
  'post.duplicate': 'content.edit', 'post.archive': 'content.archive', 'post.unarchive': 'content.archive', 'post.reschedule': 'content.schedule',
  'post.trash': 'content.archive', 'post.restore': 'content.archive',
  'asset.add_tags': 'assets.upload', 'asset.remove_tags': 'assets.upload', 'asset.archive': 'assets.upload', 'asset.unarchive': 'assets.upload',
  'asset.trash': 'assets.manage', 'asset.restore': 'assets.manage',
};

export type BulkItemEligibility = 'eligible' | 'ineligible' | 'not_found';

export interface BulkPreviewItem {
  id: string;
  brand_id: string | null;
  title: string | null;
  eligibility: BulkItemEligibility;
  /** Machine code + message when ineligible (no_permission, live_schedule, published, not_scheduled, ...). */
  reason_code: string | null;
  reason: string | null;
  /** Item-specific consequences (e.g. 'Needs approval again'). */
  consequences: string[];
}

export interface BulkPreview {
  action: BulkAction;
  target_kind: 'post' | 'asset';
  total: number;
  eligible: number;
  ineligible: number;
  items: BulkPreviewItem[];
  /** Action-level consequences (permission/policy effects). */
  consequences: string[];
  /** Pass to start; a changed selection/state/policy makes start fail with conflict (preview_stale). */
  preview_hash: string;
  policy_version: number;
}

export interface BulkStartRequest extends BulkRequest { preview_hash: string }

export type BulkJobStatus = 'queued' | 'running' | 'completed' | 'completed_with_errors' | 'failed' | 'cancelled';
export type BulkItemStatus = 'pending' | 'succeeded' | 'failed' | 'skipped';

export interface BulkJobItemView {
  id: string;
  brand_id: string | null;
  status: BulkItemStatus;
  error_code: string | null;
  error_message: string | null;
  /** e.g. duplicate → { post_id }; reschedule → { schedule_id, due_at } */
  result: Record<string, unknown> | null;
  attempts: number;
}

export interface BulkJobView {
  id: string;
  action: BulkAction;
  target_kind: 'post' | 'asset';
  status: BulkJobStatus;
  params: BulkParams;
  counts: { total: number; pending: number; succeeded: number; failed: number; skipped: number };
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  undo_of: string | null;
  /** Only items on brands the caller can still see (revocation-safe). */
  items: BulkJobItemView[];
  can_retry: boolean;
  can_undo: boolean;
  can_cancel: boolean;
}

// ================================================================== §8 Global search

export type SearchKind = 'post' | 'campaign' | 'asset' | 'brand' | 'setting';
export const SEARCH_KINDS: SearchKind[] = ['post', 'campaign', 'asset', 'brand', 'setting'];
export const SEARCH_LIMITS = { maxQueryLength: 100, maxTerms: 6, perKindDefault: 5, perKindMax: 20, recentMax: 20, timeoutMs: 2000 } as const;
/** Client debounce for the command menu (ms). */
export const SEARCH_DEBOUNCE_MS = 150;

export interface SearchResult {
  kind: SearchKind;
  id: string;
  title: string;
  /** Plain text (never HTML). Built only from fields the caller may read on that item. */
  snippet: string | null;
  /** [start, end) character ranges in snippet to highlight. */
  highlights: Array<[number, number]>;
  brand_id: string | null;
  /** App path to navigate to. */
  href: string;
  meta: Record<string, string | number | boolean | null>;
}

export interface SearchResponse {
  query: string;
  /** Results are valid only for this workspace + policy version; clients must drop cached results when either changes. */
  workspace_id: string;
  policy_version: number;
  results: SearchResult[];
  /** Kinds that hit their per-kind limit (more exist). */
  truncated: SearchKind[];
  /** true when the bounded time budget ran out: results are what was found in time. */
  partial: boolean;
  took_ms: number;
}

export interface SearchRequest {
  q: string;
  /** Default: every kind the caller may see. */
  kinds?: SearchKind[];
  /** Per kind (default 5, max 20). */
  limit?: number;
  include_archived?: boolean;
}

export interface RecentItemsResponse { workspace_id: string; policy_version: number; items: SearchResult[] }

/** Settings destinations offered by search; filtered server-side by permission. Mirrors the Settings registry. */
export interface SettingsDestination { id: string; label: string; href: string; keywords: string; requires: Permission | null }

export const SETTINGS_DESTINATIONS: SettingsDestination[] = [
  { id: 'personal/profile', label: 'Profile', href: '/settings/personal/profile', keywords: 'name email account', requires: null },
  { id: 'personal/appearance', label: 'Appearance', href: '/settings/personal/appearance', keywords: 'theme dark light mode', requires: null },
  { id: 'personal/notifications', label: 'Notifications', href: '/settings/personal/notifications', keywords: 'email alerts digest', requires: null },
  { id: 'personal/security', label: 'Security and sessions', href: '/security', keywords: 'two-step mfa passkey password sessions devices', requires: null },
  { id: 'workspace/general', label: 'Workspace', href: '/settings/workspace/general', keywords: 'name workspace general', requires: 'workspace.manage' },
  { id: 'workspace/branding', label: 'Brands', href: '/settings/workspace/branding', keywords: 'brand create new', requires: 'brands.manage' },
  { id: 'workspace/timezone', label: 'Time zone and locale', href: '/settings/workspace/timezone', keywords: 'timezone date format', requires: 'workspace.manage' },
  { id: 'people/members', label: 'Members', href: '/team', keywords: 'roles access people', requires: 'members.read' },
  { id: 'people/invitations', label: 'Invitations', href: '/team/invitations', keywords: 'invite', requires: 'members.invite' },
  { id: 'people/teams', label: 'Teams', href: '/team/teams', keywords: 'teams groups', requires: 'teams.read' },
  { id: 'people/security-policy', label: 'Workspace security', href: '/settings/people/security-policy', keywords: 'policy two-step mfa require session', requires: 'security.manage' },
  { id: 'publishing/defaults', label: 'Publishing defaults', href: '/settings/publishing/defaults', keywords: 'deadline pause brand defaults', requires: 'brands.manage' },
  { id: 'publishing/approvals', label: 'Approval policies', href: '/settings/publishing/approvals', keywords: 'review approval stages', requires: 'brands.manage' },
  { id: 'publishing/slots', label: 'Posting slots', href: '/settings/publishing/slots', keywords: 'queue times slots', requires: 'brands.manage' },
  { id: 'connections/social', label: 'Social accounts', href: '/accounts', keywords: 'connect instagram facebook x telegram tiktok youtube linkedin threads pinterest bluesky', requires: 'connections.read' },
  { id: 'connections/sources', label: 'Google and Notion', href: '/settings/connections/sources', keywords: 'drive docs notion import sources', requires: 'connections.read' },
  { id: 'connections/health', label: 'Connection health', href: '/accounts/health', keywords: 'reconnect permissions expiring', requires: 'connections.read' },
  { id: 'automation/voice', label: 'Brand voice', href: '/settings/automation/voice', keywords: 'tone terms hashtags footer cta', requires: 'brands.manage' },
  { id: 'developer/mcp', label: 'MCP', href: '/settings/developer/mcp', keywords: 'model context protocol clients ai agents', requires: 'workspace.read' },
  { id: 'developer/service-accounts', label: 'API and service accounts', href: '/settings/developer/service-accounts', keywords: 'api keys bots', requires: 'service_accounts.manage' },
  { id: 'operations/audit', label: 'Audit log', href: '/activity', keywords: 'activity events audit', requires: 'audit.read' },
  { id: 'operations/usage', label: 'Usage and limits', href: '/settings/operations/usage', keywords: 'budgets meters caps exports', requires: 'workspace.manage' },
  { id: 'operations/export', label: 'Data export', href: '/settings/operations/export', keywords: 'handover zip json download', requires: 'exports.create' },
  { id: 'operations/trash', label: 'Trash', href: '/trash', keywords: 'deleted restore recover bin', requires: 'content.read' },
];
