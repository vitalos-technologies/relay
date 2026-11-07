// MCP (V3 §13) typed contracts shared by the MCP server (services/mcp/**), the web routes and the
// Settings → Developer → MCP components (apps/web/components/mcp/**). Pure: no IO.
import type { Permission } from '../authz.js';

/** Pinned MCP protocol revision (the newest revision supported by @modelcontextprotocol/sdk 1.32.2). */
export const MCP_PROTOCOL_VERSION = '2025-11-25';
export const MCP_SDK_VERSION = '1.32.2';

export const MCP_SCOPES = [
  'social.read', 'drafts.write', 'reviews.submit', 'publishing.schedule', 'publishing.publish', 'analytics.read', 'reports.export',
] as const;
export type McpScope = (typeof MCP_SCOPES)[number];
export const isMcpScope = (s: string): s is McpScope => (MCP_SCOPES as readonly string[]).includes(s);

/** Scopes a client is challenged for by default (least privilege: read + draft). */
export const MCP_DEFAULT_SCOPES: McpScope[] = ['social.read', 'drafts.write'];

export const MCP_SCOPE_LABEL: Record<McpScope, string> = {
  'social.read': 'Read brands, destinations, posts and calendar',
  'drafts.write': 'Create and edit drafts',
  'reviews.submit': 'Submit drafts for review',
  'publishing.schedule': 'Prepare and commit scheduled publications, cancel schedules, pause a brand',
  'publishing.publish': 'Prepare and commit immediate publications',
  'analytics.read': 'Read analytics, metric definitions and data coverage',
  'reports.export': 'Create report exports',
};

/**
 * The most a scope can ever allow, expressed as V2 permissions. Effective permission per call =
 * (user/service-account V2 grants) ∩ (permissions of the client's granted scopes) ∩ (consented workspace/brands) ∩ product policy.
 * Everything not listed for a granted scope is denied through a policy restriction (services/mcp/principal.ts).
 */
export const MCP_SCOPE_PERMISSIONS: Record<McpScope, readonly Permission[]> = {
  'social.read': ['workspace.read', 'brands.read', 'connections.read', 'content.read', 'assets.read'],
  'drafts.write': ['content.create', 'content.edit', 'content.create_draft'],
  'reviews.submit': ['content.submit'],
  'publishing.schedule': ['content.schedule', 'publishing.pause'],
  'publishing.publish': ['content.schedule', 'content.publish'],
  'analytics.read': ['analytics.read'],
  'reports.export': ['exports.create'],
};

export interface McpToolInfo {
  name: string;
  group: 'discover' | 'find' | 'draft' | 'review' | 'publish' | 'recover' | 'analyse' | 'reports';
  /** Any one of these scopes admits the call (the tool re-checks argument-specific scopes). */
  scopes: McpScope[];
  readOnly: boolean;
  destructive: boolean;
  idempotent: boolean;
}

export const MCP_TOOLS: McpToolInfo[] = [
  { name: 'list_workspaces', group: 'discover', scopes: ['social.read'], readOnly: true, destructive: false, idempotent: true },
  { name: 'list_brands', group: 'discover', scopes: ['social.read'], readOnly: true, destructive: false, idempotent: true },
  { name: 'list_connections', group: 'discover', scopes: ['social.read'], readOnly: true, destructive: false, idempotent: true },
  { name: 'get_capabilities', group: 'discover', scopes: ['social.read'], readOnly: true, destructive: false, idempotent: true },
  { name: 'search_content', group: 'find', scopes: ['social.read'], readOnly: true, destructive: false, idempotent: true },
  { name: 'get_post', group: 'find', scopes: ['social.read'], readOnly: true, destructive: false, idempotent: true },
  { name: 'list_calendar', group: 'find', scopes: ['social.read'], readOnly: true, destructive: false, idempotent: true },
  { name: 'create_draft', group: 'draft', scopes: ['drafts.write'], readOnly: false, destructive: false, idempotent: true },
  { name: 'update_draft', group: 'draft', scopes: ['drafts.write'], readOnly: false, destructive: false, idempotent: true },
  { name: 'import_source_to_draft', group: 'draft', scopes: ['drafts.write'], readOnly: false, destructive: false, idempotent: true },
  { name: 'validate_post', group: 'review', scopes: ['social.read'], readOnly: true, destructive: false, idempotent: true },
  { name: 'submit_for_review', group: 'review', scopes: ['reviews.submit'], readOnly: false, destructive: false, idempotent: true },
  { name: 'get_review_status', group: 'review', scopes: ['social.read'], readOnly: true, destructive: false, idempotent: true },
  { name: 'prepare_publication', group: 'publish', scopes: ['publishing.schedule', 'publishing.publish'], readOnly: false, destructive: false, idempotent: false },
  { name: 'commit_publication', group: 'publish', scopes: ['publishing.schedule', 'publishing.publish'], readOnly: false, destructive: true, idempotent: true },
  { name: 'get_delivery_status', group: 'publish', scopes: ['social.read'], readOnly: true, destructive: false, idempotent: true },
  { name: 'cancel_schedule', group: 'recover', scopes: ['publishing.schedule', 'drafts.write'], readOnly: false, destructive: true, idempotent: true },
  { name: 'pause_brand', group: 'recover', scopes: ['publishing.schedule'], readOnly: false, destructive: true, idempotent: true },
  { name: 'query_analytics', group: 'analyse', scopes: ['analytics.read'], readOnly: true, destructive: false, idempotent: true },
  { name: 'get_metric_definitions', group: 'analyse', scopes: ['analytics.read'], readOnly: true, destructive: false, idempotent: true },
  { name: 'get_data_coverage', group: 'analyse', scopes: ['analytics.read'], readOnly: true, destructive: false, idempotent: true },
  { name: 'create_report_export', group: 'reports', scopes: ['reports.export'], readOnly: false, destructive: false, idempotent: true },
  { name: 'get_job_status', group: 'reports', scopes: ['reports.export', 'social.read'], readOnly: true, destructive: false, idempotent: true },
];

/** Stable, safe error codes returned in tool results (structuredContent.error.code). */
export const MCP_ERROR_CODES = [
  'not_found', 'forbidden', 'insufficient_scope', 'consent_required', 'client_revoked', 'mfa_required', 'validation_failed',
  'version_conflict', 'conflict', 'invalid_state', 'idempotency_conflict', 'in_progress', 'rate_limited', 'budget_exhausted',
  'approval_required', 'needs_choice', 'intent_stale', 'intent_expired', 'confirmation_required', 'unsupported_principal',
  'source_connections_unavailable', 'result_too_large', 'cancelled', 'internal',
] as const;
export type McpErrorCode = (typeof MCP_ERROR_CODES)[number];

// ------------------------------------------------------------------ Settings → Developer → MCP views

export type McpClientStatus = 'pending' | 'active' | 'revoked';

export interface McpClientView {
  id: string;
  kind: 'oauth' | 'api_key';
  client_id: string;
  name: string;
  owner: { user_id: string; email: string; name: string | null };
  status: McpClientStatus;
  requested_scopes: McpScope[];
  granted_scopes: McpScope[];
  brands: Array<{ id: string; name: string }> | null; // null = all brands the owner can access
  created_at: string;
  consented_at: string | null;
  last_activity_at: string | null;
  last_tool: string | null;
  revoked_at: string | null;
  is_mine: boolean;
  can_revoke: boolean;
}

export interface McpAuditView {
  id: string;
  created_at: string;
  tool: string;
  result: 'ok' | 'error' | 'denied' | 'cancelled';
  error_code: string | null;
  client: { id: string | null; name: string | null; client_id: string | null };
  actor: { user_id: string | null; email: string | null; service_account_id: string | null };
  resource_ids: Record<string, string>;
  correlation_id: string;
  latency_ms: number;
}

export interface McpPolicyGrantView {
  id: string;
  client_row_id: string;
  client_name: string;
  actor: { user_id: string; email: string };
  brand: { id: string; name: string };
  connection_ids: string[] | null;
  allow_immediate: boolean;
  valid_from: string;
  valid_until: string;
  max_days_ahead: number;
  local_start_hour: number;
  local_end_hour: number;
  max_per_day: number;
  max_text_length: number | null;
  allow_links: boolean;
  allow_media: boolean;
  note: string | null;
  created_at: string;
  created_by_email: string | null;
  revoked_at: string | null;
  status: 'active' | 'expired' | 'revoked' | 'scheduled';
}

export interface McpSetupInfo {
  endpoint: string;
  resource: string;
  protected_resource_metadata: string;
  authorization_server: string | null;
  protocol_version: string;
  sdk_version: string;
  scopes: Array<{ scope: McpScope; label: string }>;
  default_scopes: McpScope[];
  preregistered_client_id: string | null;
  dynamic_client_registration: boolean;
  tools: McpToolInfo[];
  /** Generated from the actual routing/config — never hand-written. */
  examples: Array<{ id: string; label: string; language: 'json' | 'shell' | 'text'; body: string }>;
  tested_clients: Array<{ client: string; status: 'tested' | 'not_tested' | 'unsupported'; protocol: string | null; notes: string }>;
}

export interface McpOverview {
  setup: McpSetupInfo;
  clients: McpClientView[];
  can_manage: boolean;
}

export interface McpIntentView {
  id: string;
  status: 'prepared' | 'confirmed' | 'committed' | 'invalidated' | 'expired' | 'failed';
  stale_reason: string | null;
  client: { name: string; client_id: string };
  brand: { id: string; name: string; timezone: string; publishing_paused: boolean };
  post: { id: string; title: string | null; text: string; link: string | null; media_count: number; version: number };
  destinations: Array<{ connection_id: string; provider: string; display_name: string; is_mock: boolean }>;
  mode: 'scheduled' | 'immediate';
  due_at: string | null;
  local_time: string | null;
  timezone: string;
  expires_at: string;
  confirmed_at: string | null;
  can_confirm: boolean;
  cannot_confirm_reason: string | null;
}
