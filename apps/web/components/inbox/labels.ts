// Inbox copy + small helpers (social inbox only; V4 support tickets bring their own).
import type { Provider } from '@social-lite/core';
import type { CaseState, ChannelKind, ConversationKind, ConversationStatus, InboxQueue, Priority, ReplyAttemptState, ReplyMode } from '@social-lite/core/contracts/v35-inbox';

export const QUEUE_LABEL: Record<InboxQueue, string> = {
  unassigned: 'Unassigned', mine: 'Mine', team: 'Team', waiting: 'Waiting', snoozed: 'Snoozed', resolved: 'Resolved', spam: 'Spam', all: 'All',
};
export const QUEUES: InboxQueue[] = ['unassigned', 'mine', 'team', 'waiting', 'snoozed', 'resolved', 'spam', 'all'];

export const STATUS_LABEL: Record<ConversationStatus, string> = { open: 'Open', waiting: 'Waiting', snoozed: 'Snoozed', resolved: 'Resolved', spam: 'Spam' };
export const KIND_LABEL: Record<ConversationKind, string> = { dm: 'Message', comment: 'Comment', mention: 'Mention', review: 'Review' };
export const MODE_LABEL: Record<ReplyMode, string> = { public_reply: 'Public reply', private_message: 'Private message' };
export const PRIORITY_LABEL: Record<Priority, string> = { low: 'Low', normal: 'Normal', high: 'High', urgent: 'Urgent' };
export const CASE_STATE_LABEL: Record<CaseState, string> = { open: 'Open', waiting: 'Waiting on customer', resolved: 'Resolved', reopened: 'Reopened' };
export const CHANNEL_LABEL: Record<ChannelKind, string> = {
  facebook_page: 'Facebook', instagram: 'Instagram', telegram_bot: 'Telegram', whatsapp: 'WhatsApp', google_business_profile: 'Google Business Profile',
  x: 'X', youtube: 'YouTube', linkedin: 'LinkedIn', threads: 'Threads', bluesky: 'Bluesky', tiktok: 'TikTok',
};
/** Network icon for a channel (PlatformIcon); null where Relay has no social provider for it. */
export const CHANNEL_PROVIDER: Partial<Record<ChannelKind, Provider>> = {
  facebook_page: 'facebook', instagram: 'instagram', telegram_bot: 'telegram', x: 'x', youtube: 'youtube', linkedin: 'linkedin', threads: 'threads', bluesky: 'bluesky', tiktok: 'tiktok',
};

export const ATTEMPT_LABEL: Record<ReplyAttemptState, string> = {
  queued: 'Sending…', sending: 'Sending…', sent: 'Sent', failed: 'Not sent', unknown: 'Not confirmed', cancelled: 'Not sent',
};

export function shortAgo(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '';
  const m = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));
  if (m < 1) return 'now';
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

export function dueLabel(iso: string | null, now = Date.now()): string {
  if (!iso) return '—';
  const m = Math.round((Date.parse(iso) - now) / 60_000);
  if (m < 0) return `${shortAgo(iso, now)} overdue`;
  if (m < 60) return `in ${m}m`;
  if (m < 60 * 24) return `in ${Math.round(m / 60)}h`;
  return `in ${Math.round(m / 1440)}d`;
}

export const newKey = () => (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}${Math.random()}`).replace(/[^A-Za-z0-9]/g, '').slice(0, 40);
