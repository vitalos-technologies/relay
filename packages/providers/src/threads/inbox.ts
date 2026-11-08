// Threads inbox adapter (V3.5 stream B): replies to the account's own posts, by polling. DMs: no API (not offered).
// Verified 2026-11-08 (developers.facebook.com/docs/threads/reply-management):
//  - GET /v1.0/me/threads?fields=id,timestamp — the account's recent posts.
//  - GET /v1.0/{media-id}/conversation?fields=id,text,username,timestamp,replied_to,root_post,is_reply_owned_by_me,hide_status
//    — all replies under a post (needs threads_read_replies).
//  - Reply: POST /v1.0/me/threads {media_type:TEXT, text, reply_to_id} → container id; POST /v1.0/me/threads_publish
//    {creation_id} → media id (needs threads_manage_replies). A lost publish response is reconciled by looking for the
//    account's own reply with the same text under the post (never re-published blindly).
//  - Hide/unhide: POST /v1.0/{reply-id}/manage_reply {hide:true|false} (threads_manage_replies).
//  - Mentions need threads_manage_mentions and are not built in this release.
import { TransportError } from '@social-lite/core';
import type { ChannelCapability, InboundItem, InboxAdapter, ReplyRulesInput, ReplyRulesResult, SendReplyResult } from '@social-lite/core/contracts/v35-inbox';
import { ProviderHttpError, oauthAccessToken } from '../shared/http.js';
import { clip, moderationFromError, oneMatch, replyFromClass, replyFromError, sameText, str } from '../shared/inbox.js';
import { THREADS_VERSION, classifyThreads, threadsCall, threadsTextLength } from './api.js';

export const THREADS_INBOX_SCOPES = ['threads_read_replies', 'threads_manage_replies'] as const;
const V = THREADS_VERSION;

export const THREADS_INBOX_CAPABILITY: ChannelCapability = {
  kind: 'threads',
  conversationTypes: {
    comment: { read: 'needs_approval', reply: 'needs_approval', visibility: 'public' },
    mention: { read: 'not_implemented', reply: 'not_implemented', visibility: 'public' },
    dm: { read: 'not_available', reply: 'not_available', visibility: 'private' },
  },
  inbound: 'polling',
  history: 'Replies under the account’s 10 most recent posts, re-read each cycle.',
  replyWindow: null,
  attachments: 'None in this release (text replies).',
  moderation: ['Hide/unhide replies'],
  receipts: { delivered: false, read: false },
  requires: ['Meta App Review: threads_read_replies, threads_manage_replies', 'No DM API for third parties'],
  verifiedOn: '2026-11-08',
};

interface TReply { id?: string; text?: string; username?: string; timestamp?: string; replied_to?: { id?: string }; root_post?: { id?: string }; is_reply_owned_by_me?: boolean; hide_status?: string }

/** Top-level reply under the root post for a nested reply (thread = one top-level reply and everything under it). */
function topOf(r: TReply, byId: Map<string, TReply>, root: string): string {
  let cur: TReply | undefined = r;
  for (let i = 0; i < 20 && cur; i++) {
    const parent = cur.replied_to?.id;
    if (!parent || parent === root) return cur.id!;
    cur = byId.get(parent);
  }
  return r.id!;
}

export function threadsReplyRules(i: ReplyRulesInput): ReplyRulesResult {
  if (i.kind !== 'comment') return { allowed: false, code: 'not_supported', message: 'Only replies are supported on Threads.' };
  if (i.mode !== 'public_reply') return { allowed: false, code: 'mode_not_supported', message: 'Threads has no private messages for apps. Use Public reply.' };
  return { allowed: true, windowEndsAt: null };
}

export const threadsInboxAdapter: InboxAdapter = {
  kind: 'threads',
  capability: () => THREADS_INBOX_CAPABILITY,
  missingPermissions(granted, connection) {
    if (connection.isMock) return [];
    const have = new Set(granted ?? []);
    return THREADS_INBOX_SCOPES.filter((s) => !have.has(s));
  },
  parseWebhook: () => [],
  replyRules: threadsReplyRules,
  pollIntervalMs: 5 * 60_000,
  moderationActions: (kind, direction) => (kind === 'comment' && direction === 'inbound' ? ['hide', 'unhide'] : []),

  async poll(ctx, creds, conn, input) {
    const since = input.cursor ? Date.parse(input.cursor) : 0;
    let newest = input.cursor;
    const items: InboundItem[] = [];
    try {
      const token = oauthAccessToken(creds as never, 'Threads');
      const posts = await threadsCall<{ data?: Array<{ id?: string }> }>(ctx, { method: 'GET', path: `/${V}/me/threads`, token, params: { fields: 'id,timestamp', limit: '10' }, op: 'threads.inbox.posts' });
      for (const p of posts.data.data ?? []) {
        if (!p.id) continue;
        const r = await threadsCall<{ data?: TReply[] }>(ctx, { method: 'GET', path: `/${V}/${p.id}/conversation`, token, params: { fields: 'id,text,username,timestamp,replied_to,root_post,is_reply_owned_by_me,hide_status', reverse: 'false' }, op: 'threads.inbox.conversation' });
        const all = (r.data.data ?? []).filter((x) => x.id && x.timestamp);
        const byId = new Map(all.map((x) => [x.id!, x]));
        for (const x of all) {
          const t = Date.parse(x.timestamp!);
          if (since && t <= since) continue;
          const top = topOf(x, byId, p.id);
          const mine = x.is_reply_owned_by_me === true;
          items.push({
            type: 'message', accountId: conn.providerAccountId, conversationKind: 'comment', threadKey: `reply:${top}`, externalId: x.id!, parentExternalId: x.replied_to?.id ?? null,
            direction: mine ? 'outbound' : 'inbound', author: mine ? null : { externalId: `user:${x.username ?? x.id}`, name: null, handle: x.username ? `@${clip(x.username, 100)}` : null },
            text: clip(x.text), attachments: [], occurredAt: new Date(t).toISOString(), relatedPostExternalId: p.id, subject: null, meta: { root_post: p.id, hidden: x.hide_status === 'HIDDEN' },
          });
          if (!newest || t > Date.parse(newest)) newest = new Date(t).toISOString();
        }
      }
      return { ok: true, items, cursor: newest ?? null, more: false };
    } catch (err) {
      if (err instanceof TransportError) return { ok: false, code: 'network', message: 'Threads could not be reached.' };
      if (err instanceof ProviderHttpError) {
        const c = classifyThreads(err, ctx.now().getTime());
        return { ok: false, code: c.code, message: c.message, reconnect: c.kind === 'reconnect', retryAfterMs: 'retryAfterMs' in c ? c.retryAfterMs : undefined };
      }
      throw err;
    }
  },

  async sendReply(ctx, creds, _conn, input): Promise<SendReplyResult> {
    const target = input.target.replyToExternalId ?? (input.target.threadKey.startsWith('reply:') ? input.target.threadKey.slice(6) : null);
    if (input.mode !== 'public_reply' || !target) return { kind: 'rejected', code: 'mode_not_supported', message: 'Only public replies are possible on Threads.' };
    if (threadsTextLength(input.text) > 500) return { kind: 'rejected', code: 'too_long', message: 'Threads replies are limited to 500 characters.' };
    let token: string;
    try { token = oauthAccessToken(creds as never, 'Threads'); } catch { return { kind: 'rejected', code: 'no_credentials', message: 'Reconnect the Threads account.', reconnect: true }; }
    let container: string | null;
    try {
      const c = await threadsCall<{ id?: string }>(ctx, { method: 'POST', path: `/${V}/me/threads`, token, params: { media_type: 'TEXT', text: input.text, reply_to_id: target }, op: 'threads.inbox.reply_container' });
      container = str(c.data.id);
    } catch (err) {
      // Creating a container publishes nothing: any failure here is safely retryable or a refusal.
      if (err instanceof TransportError) return { kind: 'retry', code: 'connect_failed', message: 'Threads could not be reached. The reply will be retried.' };
      if (err instanceof ProviderHttpError) { const c = classifyThreads(err, ctx.now().getTime()); return c.kind === 'server' ? { kind: 'retry', code: c.code, message: 'Threads reported a temporary error. The reply will be retried.' } : replyFromClass(c, 'Threads'); }
      throw err;
    }
    if (!container) return { kind: 'retry', code: 'no_container', message: 'Threads did not return a reply container. The reply will be retried.' };
    try {
      const r = await threadsCall<{ id?: string }>(ctx, { method: 'POST', path: `/${V}/me/threads_publish`, token, params: { creation_id: container }, op: 'threads.inbox.reply_publish', publishes: true });
      const id = str(r.data.id);
      return id ? { kind: 'sent', externalId: id, detail: { status: r.status } } : { kind: 'unknown', code: 'no_id', message: 'Threads published without returning an id. Checking.' };
    } catch (err) {
      return replyFromError(err, classifyThreads, 'Threads', ctx.now().getTime());
    }
  },

  async findSent(ctx, creds, _conn, input) {
    const top = input.target.threadKey.startsWith('reply:') ? input.target.threadKey.slice(6) : null;
    if (!top) return { found: false };
    try {
      const token = oauthAccessToken(creds as never, 'Threads');
      const r = await threadsCall<{ data?: TReply[] }>(ctx, { method: 'GET', path: `/${V}/${top}/conversation`, token, params: { fields: 'id,text,timestamp,is_reply_owned_by_me' }, op: 'threads.inbox.find_reply' });
      const since = input.since.getTime() - 60_000;
      return oneMatch((r.data.data ?? []).filter((x) => x.id && x.is_reply_owned_by_me && sameText(x.text, input.text) && Date.parse(x.timestamp ?? '') >= since).map((x) => ({ id: x.id! })));
    } catch (err) {
      if (err instanceof TransportError || err instanceof ProviderHttpError) return { found: false };
      throw err;
    }
  },

  async moderate(ctx, creds, _conn, input) {
    if (input.action === 'delete_own') return { ok: false, code: 'not_supported', message: 'Not available for Threads in this release.', retryable: false };
    try {
      const token = oauthAccessToken(creds as never, 'Threads');
      await threadsCall(ctx, { method: 'POST', path: `/${V}/${input.externalId}/manage_reply`, token, params: { hide: input.action === 'hide' ? 'true' : 'false' }, op: 'threads.inbox.manage_reply' });
      return { ok: true };
    } catch (err) {
      return moderationFromError(err, classifyThreads, 'Threads');
    }
  },
};
