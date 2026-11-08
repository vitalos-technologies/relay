// Facebook Page inbox adapter (V3.5 foundation): Messenger conversations + Page post comments.
// Verified 2026-11-07 (docs/v3-5/CAPABILITY_MATRIX.md):
//  - Send API: POST /{page-id}/messages {recipient:{id:PSID}, messaging_type, message:{text}} → {recipient_id, message_id}.
//    Standard messaging window 24 h after the person's last message; HUMAN_AGENT tag allows a separate 7-day period
//    for human replies (feature approval). Needs pages_messaging + the MESSAGING task on the Page.
//  - Private replies: POST /{page-id}/messages {recipient:{comment_id}} — within 7 days of the comment, one message per
//    comment. Needs pages_messaging.
//  - Comment replies: POST /{comment-id}/comments {message} → {id}. Needs pages_manage_engagement (+ pages_read_user_content to read).
//  - Webhooks (object=page): messaging (messages, message_echoes, message_edits, message_deliveries, message_reads) and
//    feed changes (item=comment, verb add|edited|remove). Signature: X-Hub-Signature-256 (verified by services/webhooks.ts).
// No idempotency key exists on these endpoints: an ambiguous send is reconciled through findSent(), never retried blindly.
import { TransportError, type AdapterContext, type ProviderCredentials, type PublishConnection } from '@social-lite/core';
import type {
  ChannelCapability, InboundItem, InboxAdapter, ReplyRulesInput, ReplyRulesResult, SendReplyResult,
} from '@social-lite/core/contracts/v35-inbox';
import { normalizeGraphError } from './errors.js';
import { graph, pageToken, str, type GraphResult } from './graph.js';

export const FACEBOOK_INBOX_SCOPES = ['pages_messaging', 'pages_manage_engagement', 'pages_read_user_content'] as const;
const DAY = 86_400_000;

export const FACEBOOK_PAGE_CAPABILITY: ChannelCapability = {
  kind: 'facebook_page',
  conversationTypes: {
    dm: { read: 'needs_approval', reply: 'needs_approval', visibility: 'private' },
    comment: { read: 'needs_approval', reply: 'needs_approval', visibility: 'public' },
    mention: { read: 'not_implemented', reply: 'not_implemented', visibility: 'public' },
  },
  inbound: 'webhook_and_polling',
  history: 'Messenger conversations and Page post comments via the Graph API (recent threads); webhooks only for new events.',
  replyWindow: 'Messages: 24 h after the customer’s last message (Human Agent tag: 7 days, needs approval). Private reply to a comment: once, within 7 days.',
  attachments: 'Inbound attachment metadata only; outbound text only in this release.',
  moderation: ['Hide/unhide comment (not implemented yet)', 'Delete the Page’s own reply (not implemented yet)'],
  receipts: { delivered: true, read: true },
  requires: ['Meta App Review: pages_messaging, pages_manage_engagement, pages_read_user_content (Advanced Access for Pages you do not own)', 'Page role with the MESSAGING task', 'Webhook subscription: messages, message_echoes, message_edits, message_deliveries, message_reads, feed'],
  verifiedOn: '2026-11-07',
};

function epochToIso(v: unknown): string {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : NaN;
  if (!Number.isFinite(n)) return new Date().toISOString();
  return new Date(n > 1e12 ? n : n * 1000).toISOString();
}

const clip = (s: unknown, n = 4000) => (typeof s === 'string' ? s.slice(0, n) : '');

interface MessagingEvent {
  sender?: { id?: string }; recipient?: { id?: string }; timestamp?: number;
  message?: { mid?: string; text?: string; is_echo?: boolean; is_deleted?: boolean; attachments?: Array<{ type?: string; payload?: { title?: string } }> };
  message_edit?: { mid?: string; text?: string };
  delivery?: { mids?: string[]; watermark?: number };
  read?: { watermark?: number };
}

interface FeedValue {
  item?: string; verb?: string; comment_id?: string; post_id?: string; parent_id?: string; message?: string;
  from?: { id?: string; name?: string }; created_time?: number | string;
}

export function parseFacebookWebhook(body: unknown): InboundItem[] {
  const out: InboundItem[] = [];
  const b = (body && typeof body === 'object' ? body : {}) as { object?: string; entry?: Array<{ id?: string; time?: number; messaging?: MessagingEvent[]; changes?: Array<{ field?: string; value?: FeedValue }> }> };
  if (b.object !== 'page' || !Array.isArray(b.entry)) return out;
  for (const e of b.entry) {
    const pageId = str(e.id);
    if (!pageId) continue;
    for (const m of e.messaging ?? []) {
      const at = epochToIso(m.timestamp ?? e.time);
      if (m.message?.mid) {
        const echo = m.message.is_echo === true;
        const psid = str(echo ? m.recipient?.id : m.sender?.id);
        if (!psid) continue;
        if (m.message.is_deleted) { out.push({ type: 'delete', accountId: pageId, externalId: m.message.mid, occurredAt: at }); continue; }
        out.push({
          type: 'message', accountId: pageId, conversationKind: 'dm', threadKey: `psid:${psid}`, externalId: m.message.mid, parentExternalId: null,
          direction: echo ? 'outbound' : 'inbound', author: echo ? null : { externalId: psid, name: null, handle: null }, text: clip(m.message.text),
          attachments: (m.message.attachments ?? []).slice(0, 10).map((a) => ({ type: clip(a.type, 20) || 'file', name: a.payload?.title ? clip(a.payload.title, 200) : null, size: null, providerRef: null })),
          occurredAt: at, relatedPostExternalId: null, subject: null,
        });
      } else if (m.message_edit?.mid) {
        out.push({ type: 'edit', accountId: pageId, externalId: m.message_edit.mid, text: clip(m.message_edit.text), occurredAt: at });
      } else if (m.delivery?.watermark && m.recipient?.id === pageId && m.sender?.id) {
        out.push({ type: 'receipt', accountId: pageId, threadKey: `psid:${m.sender.id}`, kind: 'delivered', watermark: epochToIso(m.delivery.watermark), externalIds: (m.delivery.mids ?? []).slice(0, 50) });
      } else if (m.read?.watermark && m.sender?.id) {
        out.push({ type: 'receipt', accountId: pageId, threadKey: `psid:${m.sender.id}`, kind: 'read', watermark: epochToIso(m.read.watermark), externalIds: [] });
      }
    }
    for (const c of e.changes ?? []) {
      const v = c.value;
      if (c.field !== 'feed' || !v || v.item !== 'comment' || !v.comment_id) continue;
      const at = epochToIso(v.created_time ?? e.time);
      if (v.verb === 'remove') { out.push({ type: 'delete', accountId: pageId, externalId: v.comment_id, occurredAt: at }); continue; }
      if (v.verb === 'edited') { out.push({ type: 'edit', accountId: pageId, externalId: v.comment_id, text: clip(v.message), occurredAt: at }); continue; }
      if (v.verb !== 'add') continue;
      const topLevel = !v.parent_id || v.parent_id === v.post_id;
      const fromPage = v.from?.id === pageId;
      out.push({
        type: 'message', accountId: pageId, conversationKind: 'comment', threadKey: `comment:${topLevel ? v.comment_id : v.parent_id}`,
        externalId: v.comment_id, parentExternalId: topLevel ? null : (v.parent_id ?? null), direction: fromPage ? 'outbound' : 'inbound',
        author: fromPage ? null : { externalId: str(v.from?.id) ?? 'unknown', name: v.from?.name ? clip(v.from.name, 200) : null, handle: null },
        text: clip(v.message), attachments: [], occurredAt: at, relatedPostExternalId: str(v.post_id), subject: null,
      });
    }
  }
  return out;
}

export function facebookReplyRules(i: ReplyRulesInput): ReplyRulesResult {
  const now = i.now.getTime();
  if (i.kind === 'dm') {
    if (i.mode !== 'private_message') return { allowed: false, code: 'mode_not_supported', message: 'Messenger conversations are private. Use Private message.' };
    if (!i.lastInboundAt) return { allowed: false, code: 'reply_window_closed', message: 'Meta only allows replies after the customer has messaged the Page.' };
    const last = i.lastInboundAt.getTime();
    if (now - last <= DAY) return { allowed: true, windowEndsAt: new Date(last + DAY).toISOString() };
    if (i.features.includes('human_agent') && now - last <= 7 * DAY) return { allowed: true, tag: 'HUMAN_AGENT', windowEndsAt: new Date(last + 7 * DAY).toISOString() };
    return { allowed: false, code: 'reply_window_closed', message: 'The 24-hour reply window has closed. Meta allows a new message only after the customer writes again.' };
  }
  if (i.kind === 'comment') {
    if (i.mode === 'public_reply') return { allowed: true, windowEndsAt: null };
    if (i.privateReplyUsed) return { allowed: false, code: 'private_reply_used', message: 'Meta allows one private reply per comment. It was already used.' };
    if (!i.lastInboundAt) return { allowed: false, code: 'reply_window_closed', message: 'There is no customer comment to reply to privately.' };
    const at = i.lastInboundAt.getTime();
    if (now - at <= 7 * DAY) return { allowed: true, windowEndsAt: new Date(at + 7 * DAY).toISOString() };
    return { allowed: false, code: 'reply_window_closed', message: 'Private replies are only allowed within 7 days of the comment.' };
  }
  return { allowed: false, code: 'not_supported', message: 'Replies to this conversation type are not supported.' };
}

function classify<T>(r: Extract<GraphResult<T>, { ok: false }>): SendReplyResult {
  const sub = r.error.subcode;
  if (r.error.code === 10 && (sub === 2018278 || sub === 2534022)) return { kind: 'rejected', code: 'reply_window_closed', message: 'Meta refused the message: the reply window has closed.' };
  if (r.error.code === 551) return { kind: 'rejected', code: 'recipient_unavailable', message: 'Meta says this person is not available to receive messages.' };
  const n = normalizeGraphError(r.error, r.headers);
  switch (n.cls) {
    case 'rate_limit': return { kind: 'retry', code: n.code, message: 'Meta is rate-limiting this Page. The reply will be retried.', retryAfterMs: n.retryAfterMs };
    case 'transient': return { kind: 'retry', code: n.code, message: 'Meta reported a temporary error. The reply will be retried.', retryAfterMs: n.retryAfterMs };
    case 'server_error': case 'duplicate': return { kind: 'unknown', code: n.code, message: 'Meta did not confirm the reply. Checking whether it was sent before doing anything else.' };
    case 'reconnect': return { kind: 'rejected', code: n.code, message: 'Meta no longer accepts this connection. Reconnect the Page.', reconnect: true };
    case 'permission': return { kind: 'rejected', code: 'permission_denied', message: 'Meta refused the reply: a messaging or engagement permission is missing, or your Page role changed.' };
    default: return { kind: 'rejected', code: n.code, message: 'Meta rejected the reply. Check the text and try again.' };
  }
}

function transportOutcome(err: unknown): SendReplyResult {
  if (err instanceof TransportError) {
    if (!err.requestMayHaveBeenSent) return { kind: 'retry', code: 'connect_failed', message: 'Meta could not be reached. The reply will be retried.' };
    return { kind: 'unknown', code: 'response_lost', message: 'The connection to Meta dropped after sending. Checking whether the reply arrived.' };
  }
  throw err;
}

const idOf = (threadKey: string, prefix: string) => (threadKey.startsWith(prefix) ? threadKey.slice(prefix.length) : null);

export const facebookInboxAdapter: InboxAdapter = {
  kind: 'facebook_page',
  capability: () => FACEBOOK_PAGE_CAPABILITY,

  missingPermissions(granted, connection) {
    if (connection.isMock) return [];
    const have = new Set(granted ?? []);
    return FACEBOOK_INBOX_SCOPES.filter((s) => !have.has(s));
  },

  parseWebhook: parseFacebookWebhook,
  replyRules: facebookReplyRules,

  async sendReply(ctx: AdapterContext, creds: ProviderCredentials, conn: PublishConnection, input): Promise<SendReplyResult> {
    const token = pageToken(creds);
    if (!token) return { kind: 'rejected', code: 'no_credentials', message: 'No Page access token is stored. Reconnect the Page.', reconnect: true };
    const text = input.text;
    try {
      if (input.mode === 'public_reply') {
        const commentId = idOf(input.target.threadKey, 'comment:');
        if (input.target.conversationKind !== 'comment' || !commentId) return { kind: 'rejected', code: 'mode_not_supported', message: 'Public replies are only possible on comments.' };
        const r = await graph<{ id?: string }>(ctx, { method: 'POST', path: `${commentId}/comments`, token, params: { message: text }, op: 'facebook.inbox.comment_reply', publishes: true });
        if (!r.ok) return classify(r);
        const id = str(r.data.id);
        return id ? { kind: 'sent', externalId: id, detail: { status: r.status } } : { kind: 'unknown', code: 'no_id', message: 'Meta accepted the reply without returning an id. Checking.' };
      }
      let recipient: Record<string, string>;
      if (input.target.conversationKind === 'dm') {
        const psid = idOf(input.target.threadKey, 'psid:');
        if (!psid) return { kind: 'rejected', code: 'mode_not_supported', message: 'Unknown recipient.' };
        recipient = { id: psid };
      } else if (input.target.conversationKind === 'comment' && input.target.replyToExternalId) {
        recipient = { comment_id: input.target.replyToExternalId };
      } else {
        return { kind: 'rejected', code: 'mode_not_supported', message: 'Private messages are not possible here.' };
      }
      const r = await graph<{ message_id?: string; recipient_id?: string }>(ctx, {
        method: 'POST', path: `${conn.providerAccountId}/messages`, token, op: 'facebook.inbox.send', publishes: true,
        params: {
          recipient: JSON.stringify(recipient), message: JSON.stringify({ text }),
          messaging_type: input.tag ? 'MESSAGE_TAG' : 'RESPONSE', ...(input.tag ? { tag: input.tag } : {}),
        },
      });
      if (!r.ok) return classify(r);
      const id = str(r.data.message_id);
      return id ? { kind: 'sent', externalId: id, detail: { status: r.status, recipient_id: str(r.data.recipient_id) } } : { kind: 'unknown', code: 'no_id', message: 'Meta accepted the message without returning an id. Checking.' };
    } catch (err) {
      return transportOutcome(err);
    }
  },

  async findSent(ctx, creds, conn, input) {
    const token = pageToken(creds);
    if (!token) return { found: false };
    const since = input.since.getTime() - 60_000;
    const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
    const want = norm(input.text);
    type Item = { id?: string; message?: string; created_time?: string; from?: { id?: string } };
    const match = (items: Item[]) => items.filter((m) => m.from?.id === conn.providerAccountId && norm(m.message ?? '') === want && Date.parse(m.created_time ?? '') >= since);
    try {
      if (input.mode === 'public_reply') {
        const commentId = idOf(input.target.threadKey, 'comment:');
        if (!commentId) return { found: false };
        const r = await graph<{ data?: Item[] }>(ctx, { method: 'GET', path: `${commentId}/comments`, token, params: { fields: 'id,message,from,created_time', order: 'reverse_chronological', limit: 50 }, op: 'facebook.inbox.find_reply' });
        if (!r.ok) return { found: false };
        const m = match(r.data.data ?? []);
        return m.length === 1 ? { found: true, externalId: m[0]!.id! } : m.length > 1 ? { found: 'ambiguous' } : { found: false };
      }
      const psid = idOf(input.target.threadKey, 'psid:');
      if (!psid) return { found: false };   // private replies to comments cannot be looked up before the customer answers
      const r = await graph<{ data?: Array<{ messages?: { data?: Item[] } }> }>(ctx, {
        method: 'GET', path: `${conn.providerAccountId}/conversations`, token, op: 'facebook.inbox.find_message',
        params: { platform: 'messenger', user_id: psid, fields: 'messages.limit(25){id,message,from,created_time}' },
      });
      if (!r.ok) return { found: false };
      const m = match((r.data.data ?? []).flatMap((c) => c.messages?.data ?? []));
      return m.length === 1 ? { found: true, externalId: m[0]!.id! } : m.length > 1 ? { found: 'ambiguous' } : { found: false };
    } catch {
      return { found: false };
    }
  },
};
