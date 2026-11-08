// V4 Relay support contracts (stream SUP; brief docs/queue/03g_V4_PROMPT.md §3–8, §16). Types + const enums only.
// Customer DTOs never carry internal notes, staff-only activity or assignee identity; staff DTOs do.

export const SUPPORT_TICKET_CATEGORIES = ['account_access', 'billing', 'publishing', 'connections', 'analytics', 'technical', 'feature_request', 'security'] as const;
export type SupportTicketCategory = (typeof SUPPORT_TICKET_CATEGORIES)[number];
/** Restricted: visible to the requester and explicit participants only (never to workspace owners by policy). */
export const RESTRICTED_SUPPORT_CATEGORIES: readonly SupportTicketCategory[] = ['security'];
export const SUPPORT_CATEGORY_LABEL: Record<SupportTicketCategory, string> = {
  account_access: 'Account access', billing: 'Billing', publishing: 'Publishing', connections: 'Connections', analytics: 'Analytics',
  technical: 'Technical problem', feature_request: 'Feature request', security: 'Security or private account matter',
};

export const SUPPORT_TICKET_STATUSES = ['new', 'waiting_on_relay', 'waiting_on_customer', 'resolved', 'archived'] as const;
export type SupportTicketStatus = (typeof SUPPORT_TICKET_STATUSES)[number];
export const SUPPORT_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
export type SupportPriority = (typeof SUPPORT_PRIORITIES)[number];
export const SUPPORT_SOURCES = ['app', 'problem_report', 'widget', 'staff'] as const;
export type SupportSource = (typeof SUPPORT_SOURCES)[number];
export const SUPPORT_REQUESTER_KINDS = ['member', 'visitor'] as const;
export type SupportRequesterKind = (typeof SUPPORT_REQUESTER_KINDS)[number];
export const SUPPORT_RESOLUTION_REASONS = ['answered', 'fixed', 'duplicate', 'not_reproducible', 'wont_fix', 'customer_resolved', 'no_response', 'other'] as const;
export type SupportResolutionReason = (typeof SUPPORT_RESOLUTION_REASONS)[number];
/** Staff inbox queues (views over status + assignee). */
export const SUPPORT_QUEUES = ['unassigned', 'mine', 'waiting_on_relay', 'waiting_on_customer', 'resolved', 'archived', 'open'] as const;
export type SupportQueue = (typeof SUPPORT_QUEUES)[number];

/** Customers may reopen a resolved request for this many days; archived requests need a new request. */
export const SUPPORT_REOPEN_WINDOW_DAYS = 30;
/** Resolved requests are archived automatically after this many days. */
export const SUPPORT_AUTO_ARCHIVE_DAYS = 30;
/** Archived requests (messages, notes, attachments) are purged after this many days. */
export const SUPPORT_RETENTION_DAYS_AFTER_ARCHIVE = 730;

export const SUPPORT_ATTACHMENT_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf', 'text/plain'] as const;
export type SupportAttachmentType = (typeof SUPPORT_ATTACHMENT_TYPES)[number];
export const SUPPORT_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
export const SUPPORT_ATTACHMENTS_PER_MESSAGE = 5;

export const BROWSER_FAMILIES = ['chrome', 'edge', 'firefox', 'safari', 'opera', 'samsung', 'other'] as const;
export type BrowserFamily = (typeof BROWSER_FAMILIES)[number];

/** Safe technical context (brief §6). Nothing else is ever captured automatically. */
export interface SupportDiagnostics {
  app_version?: string | null;
  route?: string | null;
  occurred_at?: string | null;
  browser_family?: BrowserFamily | null;
  correlation_ids?: string[];
  error_code?: string | null;
}

export interface SupportAttachmentDto {
  id: string; filename: string; mime: string | null; size: number | null; state: 'pending' | 'ready' | 'rejected' | 'deleted'; error: string | null;
  /** Authorized download path (re-checked per request). */
  url: string | null;
}

export interface SupportUploadIntent {
  attachment: SupportAttachmentDto;
  upload: { url: string; method: 'POST'; fields: Record<string, string> };
}

// ------------------------------------------------------------------ customer side
export interface CustomerTicketSummary {
  id: string; reference: string; subject: string; category: SupportTicketCategory; restricted: boolean; status: SupportTicketStatus;
  requester: { id: string | null; name: string | null; mine: boolean };
  created_at: string; updated_at: string; last_staff_reply_at: string | null;
  /** Staff replied after the caller last opened the ticket. */
  unread: boolean;
}

export interface CustomerMessageDto {
  id: string; author: { kind: 'member' | 'visitor' | 'staff'; name: string; mine: boolean }; body: string; created_at: string; attachments: SupportAttachmentDto[];
}

export interface CustomerActivityDto { id: number; kind: string; at: string; text: string }

export interface CustomerTicketDetail extends CustomerTicketSummary {
  source: SupportSource; resolution_reason: SupportResolutionReason | null; resolved_at: string | null;
  diagnostics: SupportDiagnostics;
  messages: CustomerMessageDto[];
  activity: CustomerActivityDto[];
  participants: Array<{ id: string; name: string | null; email: string }>;
  problem_report: { id: string; created_at: string } | null;
  support_access: Array<{ id: string; status: string; reason: string; duration_minutes: number; requested_at: string; expires_at: string | null; request_expires_at: string; operator: string }>;
  can: { reply: boolean; resolve: boolean; reopen: boolean; add_participants: boolean; decide_access: boolean };
  /** Latest change-feed id the caller may see (poll /events?after=). */
  cursor: number;
}

export interface CustomerTicketsResponse { items: CustomerTicketSummary[]; next_cursor: string | null; can_see_workspace: boolean }

// ------------------------------------------------------------------ staff side
export interface StaffTicketSummary {
  id: string; reference: string; subject: string; category: SupportTicketCategory; restricted: boolean; status: SupportTicketStatus; priority: SupportPriority;
  source: SupportSource; requester_kind: SupportRequesterKind;
  requester: { id: string | null; name: string | null; email: string | null };
  workspace: { id: string; name: string } | null;
  assignee: { id: string; name: string | null; email: string } | null;
  created_at: string; updated_at: string; last_customer_at: string | null; last_staff_reply_at: string | null;
  duplicate_of: string | null;
}

export type StaffTimelineItem =
  | { type: 'message'; id: string; author: { kind: 'member' | 'visitor' | 'staff'; name: string; id: string | null }; body: string; created_at: string; attachments: SupportAttachmentDto[];
      /** Staff replies: customer notification outcome (separate from the message, which is saved either way). */
      delivery?: { recipients: number; email: Record<string, number> } }
  | { type: 'note'; id: string; author: { name: string; id: string | null }; body: string; created_at: string; attachments: SupportAttachmentDto[] }
  | { type: 'activity'; id: number; kind: string; audience: 'customer' | 'staff'; text: string; created_at: string };

export interface WorkspaceSupportContext {
  workspace: { id: string; name: string; state: string; created_at: string; is_demo: boolean; members: number; suspended_reason: string | null } | null;
  /** From the billing service when available (metadata only). */
  commercial: { plan: string | null; status: string | null; access: string | null; trial_ends_at: string | null; renews_at: string | null } | null;
  connections: { total: number; healthy: number; problems: Array<{ provider: string; status: string; count: number }> };
  recent_failures: { window_days: number; failed: number; unknown: number; codes: Array<{ code: string; count: number }> };
  problem_reports: { open: number; shared: number };
  support_access: Array<{ id: string; status: string; operator: string; expires_at: string | null; request_expires_at: string; support_ticket_id: string | null }>;
  other_open_tickets: Array<{ id: string; reference: string; subject: string; status: SupportTicketStatus }>;
}

export interface StaffTicketDetail extends StaffTicketSummary {
  diagnostics: SupportDiagnostics; resolution_reason: SupportResolutionReason | null; resolved_at: string | null; archived_at: string | null; reopen_count: number;
  timeline: StaffTimelineItem[];
  participants: Array<{ id: string; name: string | null; email: string }>;
  problem_reports: Array<{ id: string; category: string; summary: string; created_at: string; shared_at: string | null }>;
  duplicates: Array<{ id: string; reference: string; subject: string; status: SupportTicketStatus }>;
  context: WorkspaceSupportContext;
  cursor: number;
}

export interface StaffTicketsResponse {
  items: StaffTicketSummary[]; next_cursor: string | null;
  counts: Record<SupportQueue, number>;
}

export interface SavedReplyDto { id: string; title: string; body: string; category: SupportTicketCategory | null; updated_at: string }

export interface SupportStaffDto { id: string; name: string | null; email: string; role: string }

export const SUPPORT_AI_TASKS = ['summarize', 'draft_reply', 'suggest_category', 'related'] as const;
export type SupportAiTask = (typeof SUPPORT_AI_TASKS)[number];
export interface SupportAiDraftDto {
  id: string; task: SupportAiTask; state: 'succeeded' | 'not_configured' | 'failed' | 'blocked'; created_at: string; message: string | null;
  summary: string | null; draft: string | null; category: SupportTicketCategory | null;
  related: Array<{ id: string; reference: string; subject: string; status: SupportTicketStatus }>;
  knowledge: Array<{ id: string; title: string }>;
  /** Drafts are never sent automatically. */
  draft_only: true;
}

export interface PlatformNotificationDto { id: string; kind: string; title: string; url: string | null; created_at: string; read_at: string | null }

// ------------------------------------------------------------------ problem report → Relay support
export interface ProblemReportSharePreview {
  report: { id: string; category: string; summary: string; created_at: string; redactions: number };
  /** Each item is opt-in; nothing beyond these is ever sent. */
  diagnostics: Array<{ key: keyof SupportDiagnostics; label: string; value: string; default_selected: boolean }>;
  draft_excerpt_available: boolean;
  already_shared: { ticket_id: string; reference: string } | null;
  open_tickets: Array<{ id: string; reference: string; subject: string }>;
}
