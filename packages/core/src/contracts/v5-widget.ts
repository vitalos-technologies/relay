// V5 marketing support widget contracts (stream WID; brief docs/queue/03h_V5_PROMPT.md §9–10). Types + constants only.
// The widget is a thin client of the V4 support service: a widget conversation IS a support ticket (source 'widget').
// Widget DTOs carry only customer-visible data: public messages, customer-audience status. Never internal notes,
// staff-only history, assignee identity, other participants' emails or workspace metadata.
import type { SupportAttachmentDto, SupportTicketCategory, SupportTicketStatus } from './v4-support.js';

/** Visitor session: absolute lifetime and idle timeout (HttpOnly cookie; server-side record). */
export const WIDGET_SESSION_TTL_DAYS = 30;
export const WIDGET_SESSION_IDLE_DAYS = 7;
/** One-time verification code / link lifetime and attempt limit. */
export const WIDGET_VERIFY_TTL_MINUTES = 15;
export const WIDGET_VERIFY_MAX_ATTEMPTS = 5;
/** One-time link inside a "Relay replied" email. */
export const WIDGET_REPLY_LINK_TTL_HOURS = 72;
/** Visitor message size cap (members keep the V4 cap of 10 000). */
export const WIDGET_MESSAGE_MAX = 4000;
/** A form submitted faster than this after the form token was issued is treated as automated (time trap). */
export const WIDGET_MIN_FILL_MS = 1500;
/** Form tokens expire (the widget fetches a fresh one when the session is loaded). */
export const WIDGET_FORM_TOKEN_TTL_MS = 6 * 60 * 60 * 1000;
/** Polling cadence while the panel is open and visible (ms); backs off when hidden or failing. */
export const WIDGET_POLL_MS = 5000;

/** Topics a visitor/customer may pick; maps onto the V4 ticket categories. */
export const WIDGET_TOPICS: ReadonlyArray<{ value: SupportTicketCategory; label: string }> = [
  { value: 'general', label: 'General question' },
  { value: 'billing', label: 'Plans and billing' },
  { value: 'account_access', label: 'Signing in' },
  { value: 'technical', label: 'Something isn’t working' },
];

export type WidgetMode = 'visitor' | 'member';

export interface WidgetAvailability {
  /** True only when staffed live chat is explicitly configured (Platform → Marketing). Default false. */
  staffed: boolean;
  /** "Send us a message" unless staffed. Never an invented online status or response time. */
  title: string;
  /** Whether reply emails can actually be sent (SMTP configured). Copy only promises email when true. */
  email_replies: boolean;
}

export interface WidgetConversationSummary {
  reference: string;
  subject: string;
  status: SupportTicketStatus;
  /** 'visitor' = started in this browser (or a verified email); 'member' = a request in the signed-in workspace. */
  kind: WidgetMode;
  workspace: { id: string; name: string } | null;
  updated_at: string;
  unread: boolean;
}

export interface WidgetMessage {
  id: string;
  author: { kind: 'member' | 'visitor' | 'staff'; name: string; mine: boolean };
  body: string;
  created_at: string;
  attachments: SupportAttachmentDto[];
}

export interface WidgetConversation {
  reference: string;
  subject: string;
  status: SupportTicketStatus;
  kind: WidgetMode;
  workspace: { id: string; name: string } | null;
  /** Full list when `after` was 0, otherwise only messages published after the cursor (missed-message recovery). */
  messages: WidgetMessage[];
  /** Customer-audience change-feed cursor (support_activity.id). Poll with ?after=<cursor>. */
  cursor: number;
  /** True when `messages` is a delta (after > 0). */
  delta: boolean;
  can_reply: boolean;
  /** Shown when replies are not possible (archived, blocked). */
  notice: string | null;
}

export interface WidgetSessionInfo {
  mode: WidgetMode;
  availability: WidgetAvailability;
  /**
   * CSRF tokens for the identities this browser holds. Mutations send `member` as X-CSRF-Token and `visitor` as
   * X-Widget-CSRF; an identity whose token is missing or wrong is ignored for that request. `visitor` is null until a
   * visitor session exists (the first message creates it; Origin + X-Relay-Widget header are checked instead).
   */
  csrf: { member: string | null; visitor: string | null };
  /** Server-signed form token (time trap); send with the first message. */
  form_token: string;
  visitor: { name: string | null; email: string | null; verified_email: string | null; expires_at: string } | null;
  member: { name: string; email: string; workspaces: Array<{ id: string; name: string }>; default_workspace_id: string | null } | null;
  conversations: WidgetConversationSummary[];
  limits: { message_max: number; attachments_per_message: number; attachment_max_bytes: number; attachment_types: readonly string[] };
  privacy_url: string | null;
}

export interface WidgetVerifyResult {
  /** Conversations now visible to this browser. */
  conversations: WidgetConversationSummary[];
  verified_email: string;
}
