// Instagram inbox adapter (V3.5 stream B): Instagram DMs + comments on the professional account's media, through the
// Instagram API with Facebook Login (Relay's Instagram connection is a Page-linked professional account; Page token).
// Verified 2026-11-08 against developers.facebook.com:
//  - Send API: POST /{page-id}/messages {recipient:{id:IGSID}, message:{text}} (text ≤ 1,000 bytes). Needs
//    instagram_manage_messages + the MESSAGE task on the linked Page. Standard 24 h window; Human Agent tag 7 days.
//  - Private reply: POST /{page-id}/messages {recipient:{comment_id}} — within 7 days of the comment, one message.
//  - Comment reply: POST /{ig-comment-id}/replies?message= → {id}; replies attach to the top-level comment; hidden
//    comments cannot be replied to. Needs instagram_manage_comments.
//  - Moderation: POST /{ig-comment-id}?hide=true|false; DELETE /{ig-comment-id} (comments on own media / own replies).
//  - Webhooks object=instagram: entry[].messaging (messages, echoes, reads) and changes field=comments
//    {id, text, from{id,username}, media{id}, parent_id?}. Signature X-Hub-Signature-256 (services/webhooks.ts).
//  - Mentions arrive as ids only (field=mentions) and need extra lookups — not built in this release.
import { TransportError, type AdapterContext, type ProviderCredentials, type PublishConnection } from '@social-lite/core';
import type { ChannelCapability, InboundItem, InboxAdapter, ReplyRulesInput, ReplyRulesResult, SendReplyResult } from '@social-lite/core/contracts/v35-inbox';
import { graph, pageToken, str } from './graph.js';
import { classifyMetaReply, metaModerate, transportOutcome } from './inbox.js';
import { igUserIdOf } from './common.js';
import { clip, epochToIso, oneMatch, sameText } from '../shared/inbox.js';

export const INSTAGRAM_INBOX_SCOPES = ['instagram_manage_messages', 'instagram_manage_comments'] as const;
const DAY = 86_400_000;
const MAX_DM_BYTES = 1000;

export const INSTAGRAM_CAPABILITY: ChannelCapability = {
  kind: 'instagram',
  conversationTypes: {
    dm: { read: 'needs_approval', reply: 'needs_approval', visibility: 'private' },
    comment: { read: 'needs_approval', reply: 'needs_approval', visibility: 'public' },
    mention: { read: 'not_implemented', reply: 'not_implemented', visibility: 'public' },
  },
  inbound: 'webhook_and_polling',
  history: 'Webhooks for new DMs and comments; the Conversations API is used to confirm sends.',
  replyWindow: 'DMs: 24 h after the customer’s last message (Human Agent: 7 days, needs approval). Private reply to a comment: once, within 7 days.',
  attachments: 'Inbound attachment metadata; images can be fetched on request. Outbound text only (DM text ≤ 1,000 bytes).',
  moderation: ['Hide/unhide comments', 'Delete the account’s own replies'],
  receipts: { delivered: false, read: true },
  requires: ['Instagram professional account linked to a Facebook Page', 'Meta App Review: instagram_manage_messages, instagram_manage_comments (Advanced Access for accounts you do not own)', 'Page role with the MESSAGE task', 'A route to a human agent'],
  verifiedOn: '2026-11-08',
};

/** The Facebook Page linked to the Instagram account (Send API endpoint). Simulated accounts use "<ig id>_page". */
export function linkedPageId(conn: PublishConnection): string | null {
  const v = conn.metadata?.page_id;
  if (typeof v === 'string' && v) return v;
  return conn.isMock ? `${conn.providerAccountId}_page` : null;
}

interface IgMessaging {
  sender?: { id?: string }; recipient?: { id?: string }; timestamp?: number;
  message?: { mid?: string; text?: string; is_echo?: boolean; is_deleted?: boolean; attachments?: Array<{ type?: string; payload?: { url?: string } }> };
  read?: { mid?: string };
}
interface IgCommentValue { id?: string; text?: string; from?: { id?: string; username?: string }; media?: { id?: string }; parent_id?: string }

export function parseInstagramWebhook(body: unknown): InboundItem[] {
  const out: InboundItem[] = [];
  const b = (body && typeof body === 'object' ? body : {}) as { object?: string; entry?: Array<{ id?: string; time?: number; messaging?: IgMessaging[]; changes?: Array<{ field?: string; value?: IgCommentValue }> }> };
  if (b.object !== 'instagram' || !Array.isArray(b.entry)) return out;
  for (const e of b.entry) {
    const igId = str(e.id);
    if (!igId) continue;
    for (const m of e.messaging ?? []) {
      const at = epochToIso(m.timestamp ?? e.time);
      if (m.message?.mid) {
        const echo = m.message.is_echo === true;
        const igsid = str(echo ? m.recipient?.id : m.sender?.id);
        if (!igsid) continue;
        if (m.message.is_deleted) { out.push({ type: 'delete', accountId: igId, externalId: m.message.mid, occurredAt: at }); continue; }
        out.push({
          type: 'message', accountId: igId, conversationKind: 'dm', threadKey: `igsid:${igsid}`, externalId: m.message.mid, parentExternalId: null,
          direction: echo ? 'outbound' : 'inbound', author: echo ? null : { externalId: igsid, name: null, handle: null }, text: clip(m.message.text),
          attachments: (m.message.attachments ?? []).slice(0, 10).map((a) => ({ type: clip(a.type, 20) || 'file', name: null, size: null, providerRef: a.payload?.url ? `url:${a.payload.url.slice(0, 1500)}` : null })),
          occurredAt: at, relatedPostExternalId: null, subject: null,
        });
      } else if (m.read?.mid && m.sender?.id) {
        out.push({ type: 'receipt', accountId: igId, threadKey: `igsid:${m.sender.id}`, kind: 'read', watermark: at, externalIds: [m.read.mid] });
      }
    }
    for (const c of e.changes ?? []) {
      const v = c.value;
      if (c.field !== 'comments' || !v?.id) continue;
      const fromUs = v.from?.id === igId;
      const top = v.parent_id ?? null;
      out.push({
        type: 'message', accountId: igId, conversationKind: 'comment', threadKey: `comment:${top ?? v.id}`, externalId: v.id, parentExternalId: top,
        direction: fromUs ? 'outbound' : 'inbound', author: fromUs ? null : { externalId: str(v.from?.id) ?? 'unknown', name: null, handle: v.from?.username ? clip(v.from.username, 100) : null },
        text: clip(v.text), attachments: [], occurredAt: epochToIso(e.time), relatedPostExternalId: str(v.media?.id), subject: null,
      });
    }
  }
  return out;
}

export function instagramReplyRules(i: ReplyRulesInput): ReplyRulesResult {
  const now = i.now.getTime();
  if (i.kind === 'dm') {
    if (i.mode !== 'private_message') return { allowed: false, code: 'mode_not_supported', message: 'Instagram DMs are private. Use Private message.' };
    if (!i.lastInboundAt) return { allowed: false, code: 'reply_window_closed', message: 'Instagram only allows replies after the customer has messaged you.' };
    const last = i.lastInboundAt.getTime();
    if (now - last <= DAY) return { allowed: true, windowEndsAt: new Date(last + DAY).toISOString() };
    if (i.features.includes('human_agent') && now - last <= 7 * DAY) return { allowed: true, tag: 'HUMAN_AGENT', windowEndsAt: new Date(last + 7 * DAY).toISOString() };
    return { allowed: false, code: 'reply_window_closed', message: 'The 24-hour reply window has closed. Instagram allows a new message only after the customer writes again.' };
  }
  if (i.kind === 'comment') {
    if (i.mode === 'public_reply') return { allowed: true, windowEndsAt: null };
    if (i.privateReplyUsed) return { allowed: false, code: 'private_reply_used', message: 'Instagram allows one private reply per comment. It was already used.' };
    if (!i.lastInboundAt) return { allowed: false, code: 'reply_window_closed', message: 'There is no customer comment to reply to privately.' };
    const at = i.lastInboundAt.getTime();
    if (now - at <= 7 * DAY) return { allowed: true, windowEndsAt: new Date(at + 7 * DAY).toISOString() };
    return { allowed: false, code: 'reply_window_closed', message: 'Private replies are only allowed within 7 days of the comment.' };
  }
  return { allowed: false, code: 'not_supported', message: 'Replies to this conversation type are not supported.' };
}

const idOf = (threadKey: string, prefix: string) => (threadKey.startsWith(prefix) ? threadKey.slice(prefix.length) : null);

export const instagramInboxAdapter: InboxAdapter = {
  kind: 'instagram',
  capability: () => INSTAGRAM_CAPABILITY,
  missingPermissions(granted, connection) {
    if (connection.isMock) return [];
    const have = new Set(granted ?? []);
    return INSTAGRAM_INBOX_SCOPES.filter((s) => !have.has(s));
  },
  parseWebhook: parseInstagramWebhook,
  replyRules: instagramReplyRules,
  moderationActions: (kind, direction) => (kind !== 'comment' ? [] : direction === 'inbound' ? ['hide', 'unhide'] : ['delete_own']),

  async sendReply(ctx: AdapterContext, creds: ProviderCredentials, conn: PublishConnection, input): Promise<SendReplyResult> {
    const token = pageToken(creds);
    if (!token) return { kind: 'rejected', code: 'no_credentials', message: 'No access token is stored. Reconnect the Instagram account.', reconnect: true };
    try {
      if (input.mode === 'public_reply') {
        const top = idOf(input.target.threadKey, 'comment:');
        if (input.target.conversationKind !== 'comment' || !top) return { kind: 'rejected', code: 'mode_not_supported', message: 'Public replies are only possible on comments.' };
        const r = await graph<{ id?: string }>(ctx, { method: 'POST', path: `${top}/replies`, token, params: { message: input.text }, op: 'instagram.inbox.comment_reply', publishes: true });
        if (!r.ok) return classifyMetaReply(r);
        const id = str(r.data.id);
        return id ? { kind: 'sent', externalId: id, detail: { status: r.status } } : { kind: 'unknown', code: 'no_id', message: 'Instagram accepted the reply without returning an id. Checking.' };
      }
      if (Buffer.byteLength(input.text, 'utf8') > MAX_DM_BYTES) return { kind: 'rejected', code: 'too_long', message: 'Instagram messages are limited to 1,000 bytes. Shorten the reply.' };
      const pageId = linkedPageId(conn);
      if (!pageId) return { kind: 'rejected', code: 'no_page', message: 'This Instagram account has no linked Facebook Page. Reconnect it through the Page.', reconnect: true };
      let recipient: Record<string, string>;
      if (input.target.conversationKind === 'dm') {
        const igsid = idOf(input.target.threadKey, 'igsid:');
        if (!igsid) return { kind: 'rejected', code: 'mode_not_supported', message: 'Unknown recipient.' };
        recipient = { id: igsid };
      } else if (input.target.conversationKind === 'comment' && input.target.replyToExternalId) {
        recipient = { comment_id: input.target.replyToExternalId };
      } else return { kind: 'rejected', code: 'mode_not_supported', message: 'Private messages are not possible here.' };
      const r = await graph<{ message_id?: string; recipient_id?: string }>(ctx, {
        method: 'POST', path: `${pageId}/messages`, token, op: 'instagram.inbox.send', publishes: true,
        params: { recipient: JSON.stringify(recipient), message: JSON.stringify({ text: input.text }), ...(input.tag ? { messaging_type: 'MESSAGE_TAG', tag: input.tag } : {}) },
      });
      if (!r.ok) return classifyMetaReply(r);
      const id = str(r.data.message_id);
      return id ? { kind: 'sent', externalId: id, detail: { status: r.status } } : { kind: 'unknown', code: 'no_id', message: 'Instagram accepted the message without returning an id. Checking.' };
    } catch (err) {
      return transportOutcome(err);
    }
  },

  async findSent(ctx, creds, conn, input) {
    const token = pageToken(creds);
    if (!token) return { found: false };
    const since = input.since.getTime() - 60_000;
    type Item = { id?: string; text?: string; message?: string; timestamp?: string; created_time?: string; from?: { id?: string } };
    const me = igUserIdOf(conn);
    const pick = (items: Item[]) => items.filter((m) => m.id && m.from?.id === me && sameText(m.text ?? m.message, input.text) && Date.parse(m.timestamp ?? m.created_time ?? '') >= since).map((m) => ({ id: m.id! }));
    try {
      if (input.mode === 'public_reply') {
        const top = idOf(input.target.threadKey, 'comment:');
        if (!top) return { found: false };
        const r = await graph<{ data?: Item[] }>(ctx, { method: 'GET', path: `${top}/replies`, token, params: { fields: 'id,text,from,timestamp' }, op: 'instagram.inbox.find_reply' });
        return r.ok ? oneMatch(pick(r.data.data ?? [])) : { found: false };
      }
      const igsid = idOf(input.target.threadKey, 'igsid:');
      const pageId = linkedPageId(conn);
      if (!igsid || !pageId) return { found: false };
      const r = await graph<{ data?: Array<{ messages?: { data?: Item[] } }> }>(ctx, {
        method: 'GET', path: `${pageId}/conversations`, token, op: 'instagram.inbox.find_message',
        params: { platform: 'instagram', user_id: igsid, fields: 'messages.limit(25){id,message,from,created_time}' },
      });
      return r.ok ? oneMatch(pick((r.data.data ?? []).flatMap((c) => c.messages?.data ?? []))) : { found: false };
    } catch (err) {
      if (err instanceof TransportError) return { found: false };
      throw err;
    }
  },

  async moderate(ctx, creds, _conn, input) {
    const token = pageToken(creds);
    if (!token) return { ok: false, code: 'no_credentials', message: 'No access token is stored. Reconnect the account.', retryable: false, reconnect: true };
    return metaModerate(ctx, token, input, 'hide');
  },

  async resolveAttachment(_ctx, _creds, conn, input) {
    // Instagram attachment payload URLs are short-lived CDN links (lookaside.fbsbx.com / *.cdninstagram.com).
    if (!input.providerRef.startsWith('url:')) return { kind: 'error', code: 'no_reference', message: 'Instagram did not provide a download link for this attachment.' };
    const url = input.providerRef.slice(4);
    if (conn.isMock) return { kind: 'bytes', base64: Buffer.from('simulated instagram attachment').toString('base64'), mime: 'text/plain', name: 'attachment.txt' };
    return { kind: 'url', url, allowHosts: ['lookaside.fbsbx.com', 'scontent.cdninstagram.com', 'scontent.xx.fbcdn.net'], mime: null, name: null };
  },
};
