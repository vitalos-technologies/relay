// V3.5 unified inbox + customer-care contracts (stream FOUNDATION, migration 028).
// Served by packages/services/src/inbox/** and /api/inbox/**. Stream B adds channels by implementing InboxAdapter
// (packages/providers/src/<provider>/inbox.ts) and registering it in packages/providers/src/inbox-registry.ts.
// Authorization and types here are the SOCIAL inbox's; V4 support tickets reuse the UI components, not these types.
import type { AdapterContext, ProviderCredentials, PublishConnection } from '../adapter.js';

// ------------------------------------------------------------------ channels + capabilities (brief §10)
export const CHANNEL_KINDS = [
  'facebook_page', 'instagram', 'telegram_bot', 'whatsapp', 'google_business_profile', 'x', 'youtube', 'linkedin', 'threads', 'bluesky', 'tiktok',
] as const;
export type ChannelKind = (typeof CHANNEL_KINDS)[number];

export const CONVERSATION_KINDS = ['dm', 'comment', 'mention', 'review'] as const;
export type ConversationKind = (typeof CONVERSATION_KINDS)[number];

/** Customer-facing modes. Internal notes are NOT a reply mode: they use a separate table, endpoint and service. */
export const REPLY_MODES = ['public_reply', 'private_message'] as const;
export type ReplyMode = (typeof REPLY_MODES)[number];

export type Support = 'supported' | 'needs_approval' | 'not_available' | 'not_implemented';

/** One row of the per-channel capability record (docs/v3-5/CAPABILITY_MATRIX.md mirrors these). */
export interface ChannelCapability {
  kind: ChannelKind;
  conversationTypes: Partial<Record<ConversationKind, { read: Support; reply: Support; visibility: 'public' | 'private' }>>;
  inbound: 'webhook' | 'polling' | 'webhook_and_polling' | 'none';
  history: string;                 // what can be backfilled, e.g. 'Messenger: conversations API, recent threads'
  replyWindow: string | null;      // e.g. '24 h after the customer’s last message'
  attachments: string;
  moderation: string[];            // e.g. ['hide comment', 'delete own reply']
  receipts: { delivered: boolean; read: boolean };
  requires: string[];              // permissions / review / commercial access
  verifiedOn: string;              // YYYY-MM-DD
}

export type ChannelStatus = 'active' | 'needs_permission' | 'paused' | 'disconnected' | 'error';

export interface InboxChannelJson {
  id: string;
  brand_id: string;
  kind: ChannelKind;
  connection_id: string | null;
  integration_id: string | null;
  external_account_id: string;
  display_name: string;
  is_simulated: boolean;
  status: ChannelStatus;
  status_detail: string | null;
  missing_permissions: string[];
  enabled_types: ConversationKind[];
  capability: ChannelCapability;
  last_inbound_at: string | null;
  last_sync_at: string | null;
}

// ------------------------------------------------------------------ provider adapter
/** A normalised inbound provider event. Bodies are untrusted customer content (never instructions). */
export type InboundItem =
  | {
      type: 'message';
      accountId: string;              // page id / bot id / phone number id — routes to channels
      conversationKind: ConversationKind;
      threadKey: string;              // stable per conversation, e.g. 'psid:123' or 'comment:<top comment id>'
      externalId: string;             // message / comment id (dedupe key per channel)
      parentExternalId: string | null;
      direction: 'inbound' | 'outbound'; // outbound = the business replied outside Relay (or an echo of Relay's own send)
      author: { externalId: string; name: string | null; handle: string | null } | null;
      text: string;
      attachments: Array<{ type: string; name: string | null; size: number | null; providerRef: string | null }>;
      occurredAt: string;
      relatedPostExternalId: string | null;
      subject: string | null;
    }
  | { type: 'edit'; accountId: string; externalId: string; text: string; occurredAt: string }
  | { type: 'delete'; accountId: string; externalId: string; occurredAt: string }
  | { type: 'receipt'; accountId: string; threadKey: string; kind: 'delivered' | 'read'; watermark: string; externalIds: string[] };

export interface ReplyTarget {
  conversationKind: ConversationKind;
  threadKey: string;
  /** Message/comment being answered (comment id for public replies and private replies). */
  replyToExternalId: string | null;
  contactExternalId: string | null;
}

export interface ReplyRulesInput {
  kind: ConversationKind;
  mode: ReplyMode;
  now: Date;
  lastInboundAt: Date | null;
  /** First inbound message time of the thread (comment creation for private replies). */
  firstInboundAt: Date | null;
  privateReplyUsed: boolean;
  /** Provider features approved for this app/account (e.g. 'human_agent'). */
  features: string[];
}

export type ReplyRulesResult =
  | { allowed: true; tag?: string; windowEndsAt: string | null }
  | { allowed: false; code: 'reply_window_closed' | 'mode_not_supported' | 'private_reply_used' | 'not_supported'; message: string };

export type SendReplyResult =
  | { kind: 'sent'; externalId: string; detail: Record<string, unknown> }
  | { kind: 'rejected'; code: string; message: string; reconnect?: boolean }   // provider refused; nothing was sent
  | { kind: 'retry'; code: string; message: string; retryAfterMs?: number }    // refused before acting (throttle, connect)
  | { kind: 'unknown'; code: string; message: string };                       // may have been sent: reconcile

export interface InboxAdapter {
  kind: ChannelKind;
  capability(): ChannelCapability;
  /** Permissions this channel needs that the connection lacks (from granted scopes). */
  missingPermissions(grantedScopes: string[] | null, connection: PublishConnection): string[];
  /** Parse a VERIFIED webhook body into items (signature checked by the ingress before this). */
  parseWebhook(body: unknown): InboundItem[];
  replyRules(input: ReplyRulesInput): ReplyRulesResult;
  sendReply(ctx: AdapterContext, creds: ProviderCredentials, conn: PublishConnection, input: { mode: ReplyMode; target: ReplyTarget; text: string; tag?: string; attemptId: string }): Promise<SendReplyResult>;
  /** After an 'unknown' outcome: find the business's own message matching the text sent after `since`. Never guesses. */
  findSent(ctx: AdapterContext, creds: ProviderCredentials, conn: PublishConnection, input: { mode: ReplyMode; target: ReplyTarget; text: string; since: Date }): Promise<{ found: true; externalId: string } | { found: false } | { found: 'ambiguous' }>;
}

// ------------------------------------------------------------------ conversations
export const CONVERSATION_STATUSES = ['open', 'waiting', 'snoozed', 'resolved', 'spam'] as const;
export type ConversationStatus = (typeof CONVERSATION_STATUSES)[number];
export const PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
export type Priority = (typeof PRIORITIES)[number];

export const INBOX_QUEUES = ['unassigned', 'mine', 'team', 'waiting', 'snoozed', 'resolved', 'spam', 'all'] as const;
export type InboxQueue = (typeof INBOX_QUEUES)[number];

export interface InboxListQuery {
  queue?: InboxQueue;
  brand_id?: string | null;
  channel_id?: string | null;
  kind?: ConversationKind | null;
  assignee_id?: string | null;
  priority?: Priority | null;
  language?: string | null;
  label?: string | null;
  q?: string | null;
  cursor?: string | null;
  limit?: number | null;
}

export interface PersonRef { id: string; name: string | null; email: string | null }

export interface ConversationListItem {
  id: string;
  brand_id: string;
  channel: { id: string; kind: ChannelKind; display_name: string; is_simulated: boolean };
  kind: ConversationKind;
  visibility: 'public' | 'private';
  contact: { id: string | null; name: string | null; handle: string | null };
  preview: string;
  status: ConversationStatus;
  priority: Priority;
  labels: string[];
  language: string | null;
  assignee: PersonRef | null;
  team_id: string | null;
  unanswered_since: string | null;
  last_message_at: string;
  snoozed_until: string | null;
  case: { id: string; number: number; state: CaseState } | null;
  version: number;
}

export interface MessageDto {
  id: string;
  direction: 'inbound' | 'outbound';
  external_id: string | null;
  author: { kind: 'contact' | 'user' | 'business'; name: string | null };
  body: string | null;           // null when deleted at the provider or erased by retention
  revision: number;
  edited_at: string | null;
  deleted_at: string | null;
  attachments: Array<{ type: string; name: string | null; size: number | null }>;
  at: string;
  automated: boolean;
  /** Outbound only: provider evidence. delivered/read are shown only when the provider reported them. */
  delivery: 'sent' | 'delivered' | 'read' | null;
  reply_attempt_id: string | null;
}

export interface NoteDto {
  id: string;
  author: PersonRef;
  body: string;
  mentions: string[];
  at: string;
  edited_at: string | null;
}

export type ReplyAttemptState = 'queued' | 'sending' | 'sent' | 'failed' | 'unknown' | 'cancelled';

export interface ReplyAttemptDto {
  id: string;
  conversation_id: string;
  mode: ReplyMode;
  body: string;
  state: ReplyAttemptState;
  created_by: PersonRef;
  created_at: string;
  sent_at: string | null;
  attempts: number;
  /** Actual provider result (safe fields only): message id, http status, provider error code + our message. */
  provider_result: { external_id?: string; status?: number; code?: string; message?: string; reconciled?: boolean } | null;
  error: { code: string; message: string } | null;
  is_simulated: boolean;
}

export type TimelineEntry =
  | { type: 'message'; at: string; message: MessageDto }
  | { type: 'note'; at: string; note: NoteDto }
  | { type: 'attempt'; at: string; attempt: ReplyAttemptDto }   // pending / failed / unknown sends (sent ones appear as messages)
  | { type: 'event'; at: string; event: { kind: string; actor: PersonRef | null; data: Record<string, unknown> } };

export interface ConversationDetail extends ConversationListItem {
  timeline: TimelineEntry[];
  /** Older entries exist (paginate with ?before=). */
  has_more: boolean;
  reply: {
    modes: Array<{ mode: ReplyMode; allowed: boolean; reason: string | null; window_ends_at: string | null }>;
    can_reply: boolean;
    can_note: boolean;
    can_assign: boolean;
  };
  draft: { mode: ReplyMode; body: string; base_version: number; updated_at: string } | null;
  presence: Array<{ user: PersonRef; state: 'viewing' | 'composing'; seen_at: string }>;
  related_post: { id: string | null; external_id: string | null } | null;
}

/** POST /api/inbox/conversations/:id/replies */
export interface ReplyRequest {
  mode: ReplyMode;
  body: string;
  /** Conversation version the agent was looking at. */
  base_version: number;
  /** Client-generated per send action; repeats return the same attempt (double-click / retry safe). */
  idempotency_key: string;
  /** Set to the CURRENT version after the agent reviewed a 409 reply_collision / thread_changed. */
  acknowledge_version?: number | null;
}

/** 409 details for reply_collision / thread_changed. */
export interface ThreadChangedDetails {
  current_version: number;
  changes: Array<{ kind: 'reply' | 'pending_reply' | 'customer_message'; by: string | null; at: string; mode?: ReplyMode; state?: ReplyAttemptState }>;
}

// ------------------------------------------------------------------ cases + SLAs (brief §12)
export const CASE_STATES = ['open', 'waiting', 'resolved', 'reopened'] as const;
export type CaseState = (typeof CASE_STATES)[number];

export interface CaseDto {
  id: string;
  number: number;
  brand_id: string;
  title: string;
  category: string | null;
  priority: Priority;
  state: CaseState;
  owner: PersonRef | null;
  team_id: string | null;
  sla_policy_id: string | null;
  opened_at: string;
  first_response: { due_at: string | null; at: string | null; breached: boolean };
  resolution: { due_at: string | null; at: string | null; breached: boolean; reason: string | null };
  paused: boolean;
  reopened_count: number;
  /** Optimistic-concurrency token for PATCH. */
  version: number;
  conversation_ids: string[];
  external_links: Array<{ connector: string; external_id: string; external_url: string | null; status: string }>;
}

export interface SlaPolicyDto {
  id: string;
  brand_id: string | null;
  name: string;
  timezone: string;
  /** null = 24/7. Otherwise weekly windows (0 = Sunday), local time HH:MM. */
  business_hours: Array<{ day: number; start: string; end: string }> | null;
  holidays: string[];             // YYYY-MM-DD (local)
  first_response_minutes: number | null;
  resolution_minutes: number | null;
  count_automated: boolean;
  is_default: boolean;
}

export interface CareReport {
  window_days: number;
  definitions: Record<string, string>;
  cases_opened: number;
  backlog: number;
  first_response: { n: number; median_business_minutes: number | null; breached: number };
  resolution: { n: number; median_business_minutes: number | null; breached: number };
  reopened: number;
}

// ------------------------------------------------------------------ errors
export const INBOX_ERROR_CODES = [
  'reply_collision', 'thread_changed', 'reply_window_closed', 'mode_not_supported', 'private_reply_used', 'channel_unavailable', 'conversation_closed',
] as const;
