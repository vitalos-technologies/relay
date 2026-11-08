// Bluesky inbox adapter (V3.5 stream B): replies + mentions (notifications) and direct messages (chat), by polling.
// Sources (AT Protocol lexicons; checked 2026-11-08, see docs/providers/bluesky.md):
//  - app.bsky.notification.listNotifications {limit, cursor} → notifications[{uri, cid, author, reason, record, indexedAt}]
//    reasons used: reply → comment thread, mention/quote → mention.
//  - Replies: com.atproto.repo.createRecord app.bsky.feed.post {text ≤ 300 graphemes, createdAt, reply:{root, parent}}.
//    Confirmation after a lost response: com.atproto.repo.listRecords on the account's own posts (exact text + parent).
//  - Delete own reply: com.atproto.repo.deleteRecord. Other people's replies cannot be deleted (thread gates only).
//  - DMs: chat.bsky.convo.getLog {cursor} (message events) and chat.bsky.convo.sendMessage {convoId, message:{text}},
//    via the PDS with header `atproto-proxy: did:web:api.bsky.chat#bsky_chat`. Needs an app password created with
//    "Allow access to your direct messages" (otherwise the chat service answers 401/403 → shown as missing permission).
import { TransportError, type AdapterContext } from '@social-lite/core';
import type { ChannelCapability, InboundItem, InboxAdapter, ReplyRulesInput, ReplyRulesResult, SendReplyResult } from '@social-lite/core/contracts/v35-inbox';
import { ProviderHttpError, call } from '../shared/http.js';
import { clip, moderationFromError, oneMatch, replyFromError, sameText, str } from '../shared/inbox.js';
import { POST_COLLECTION, classifyBluesky, parseXrpcError, withAccess, xrpc } from './api.js';

const CHAT_PROXY = 'did:web:api.bsky.chat#bsky_chat';

export const BLUESKY_INBOX_CAPABILITY: ChannelCapability = {
  kind: 'bluesky',
  conversationTypes: {
    comment: { read: 'supported', reply: 'supported', visibility: 'public' },
    mention: { read: 'supported', reply: 'supported', visibility: 'public' },
    dm: { read: 'supported', reply: 'supported', visibility: 'private' },
  },
  inbound: 'polling',
  history: 'Notifications (replies, mentions, quotes) and chat events from when the channel was added onwards.',
  replyWindow: null,
  attachments: 'Inbound images are listed; outbound text only (≤ 300 characters).',
  moderation: ['Delete the account’s own replies'],
  receipts: { delivered: false, read: false },
  requires: ['App password (no review)', 'For DMs: an app password created with direct-message access'],
  verifiedOn: '2026-11-08',
};

interface Ref { uri?: string; cid?: string }
interface Notification { uri?: string; cid?: string; reason?: string; indexedAt?: string; author?: { did?: string; handle?: string; displayName?: string }; record?: { text?: string; createdAt?: string; reply?: { root?: Ref; parent?: Ref }; embed?: { images?: unknown[] } } }
interface LogEvent { $type?: string; convoId?: string; rev?: string; message?: { id?: string; text?: string; sender?: { did?: string }; sentAt?: string } }

const graphemes = (s: string) => [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(s)].length;

export function bskyItems(did: string, n: Notification): InboundItem[] {
  if (!n.uri || !n.cid || !n.record || !n.author?.did || n.author.did === did) return [];
  const reason = n.reason;
  if (reason !== 'reply' && reason !== 'mention' && reason !== 'quote') return [];
  const root = n.record.reply?.root?.uri && n.record.reply.root.cid ? { uri: n.record.reply.root.uri, cid: n.record.reply.root.cid } : { uri: n.uri, cid: n.cid };
  const isReply = reason === 'reply';
  return [{
    type: 'message', accountId: did, conversationKind: isReply ? 'comment' : 'mention', threadKey: `post:${isReply ? root.uri : n.uri}`, externalId: n.uri,
    parentExternalId: n.record.reply?.parent?.uri ?? null, direction: 'inbound',
    author: { externalId: n.author.did, name: n.author.displayName ? clip(n.author.displayName, 200) : null, handle: n.author.handle ? `@${clip(n.author.handle, 100)}` : null },
    text: clip(n.record.text), occurredAt: new Date(n.record.createdAt ?? n.indexedAt ?? Date.now()).toISOString(), relatedPostExternalId: isReply ? root.uri : null, subject: null,
    attachments: (n.record.embed?.images ?? []).slice(0, 4).map(() => ({ type: 'image', name: null, size: null, providerRef: null })),
    meta: { uri: n.uri, cid: n.cid, root: isReply ? root : { uri: n.uri, cid: n.cid } },
  }];
}

export function blueskyReplyRules(i: ReplyRulesInput): ReplyRulesResult {
  if (i.kind === 'dm') return i.mode === 'private_message' ? { allowed: true, windowEndsAt: null } : { allowed: false, code: 'mode_not_supported', message: 'Bluesky chats are private. Use Private message.' };
  if (i.kind === 'comment' || i.kind === 'mention') return i.mode === 'public_reply' ? { allowed: true, windowEndsAt: null } : { allowed: false, code: 'mode_not_supported', message: 'Reply publicly, or wait for the person to message you.' };
  return { allowed: false, code: 'not_supported', message: 'Not supported on Bluesky.' };
}

interface Cursor { n: string | null; c: string | null; dm: boolean }
const readCursor = (s: string | null): Cursor => { try { const v = s ? JSON.parse(s) as Partial<Cursor> : {}; return { n: v.n ?? null, c: v.c ?? null, dm: v.dm !== false }; } catch { return { n: null, c: null, dm: true }; } };

function chat<T>(ctx: AdapterContext, a: { jwt: string; pdsUrl: string }, nsid: string, method: 'GET' | 'POST', q: { query?: Record<string, string | undefined>; json?: unknown; op: string; publishes?: boolean }) {
  const root = (ctx.config.baseUrls?.blueskyPds ?? a.pdsUrl).replace(/\/$/, '');
  return call<T>(ctx, { method, url: `${root}/xrpc/${nsid}`, query: q.query, json: q.json, bearer: a.jwt, headers: { 'atproto-proxy': CHAT_PROXY }, op: q.op, publishes: q.publishes }, parseXrpcError);
}

export const blueskyInboxAdapter: InboxAdapter = {
  kind: 'bluesky',
  capability: () => BLUESKY_INBOX_CAPABILITY,
  missingPermissions: () => [],   // app passwords carry no scopes; DM access is detected on first chat call
  parseWebhook: () => [],
  replyRules: blueskyReplyRules,
  pollIntervalMs: 60_000,
  moderationActions: (kind, direction) => (kind !== 'dm' && direction === 'outbound' ? ['delete_own'] : []),

  async poll(ctx, creds, conn, input) {
    const cur = readCursor(input.cursor);
    const items: InboundItem[] = [];
    try {
      return await withAccess(ctx, creds, conn.providerAccountId, async (a) => {
        let newest = cur.n;
        if (input.types.includes('comment') || input.types.includes('mention')) {
          let page: string | undefined;
          for (let i = 0; i < 3; i++) {
            const r = await xrpc<{ notifications?: Notification[]; cursor?: string }>(ctx, { service: a.pdsUrl, nsid: 'app.bsky.notification.listNotifications', method: 'GET', jwt: a.jwt, params: { limit: '50', cursor: page }, op: 'bluesky.inbox.notifications' });
            let older = false;
            for (const n of r.data.notifications ?? []) {
              if (cur.n && (n.indexedAt ?? '') <= cur.n) { older = true; continue; }
              for (const it of bskyItems(a.did, n)) if (it.type !== 'message' || input.types.includes(it.conversationKind)) items.push(it);
              if (n.indexedAt && (!newest || n.indexedAt > newest)) newest = n.indexedAt;
            }
            page = r.data.cursor;
            if (!page || older || !cur.n) break;   // first run: newest page only (no history import)
          }
        }
        let chatCursor = cur.c;
        let dmOk = cur.dm;
        if (input.types.includes('dm')) {
          try {
            const r = await chat<{ logs?: LogEvent[]; cursor?: string }>(ctx, a, 'chat.bsky.convo.getLog', 'GET', { query: { cursor: chatCursor ?? undefined }, op: 'bluesky.inbox.chat_log' });
            for (const l of r.data.logs ?? []) {
              const m = l.message;
              if (l.$type !== 'chat.bsky.convo.defs#logCreateMessage' || !m?.id || !l.convoId || !m.sender?.did) continue;
              const mine = m.sender.did === a.did;
              items.push({
                type: 'message', accountId: a.did, conversationKind: 'dm', threadKey: `convo:${l.convoId}`, externalId: `chat:${m.id}`, parentExternalId: null,
                direction: mine ? 'outbound' : 'inbound', author: mine ? null : { externalId: m.sender.did, name: null, handle: null },
                text: clip(m.text), attachments: [], occurredAt: new Date(m.sentAt ?? Date.now()).toISOString(), relatedPostExternalId: null, subject: null, meta: { convo_id: l.convoId },
              });
            }
            chatCursor = r.data.cursor ?? chatCursor;
            dmOk = true;
          } catch (err) {
            if (!(err instanceof ProviderHttpError) || (err.status !== 401 && err.status !== 403)) throw err;
            dmOk = false;   // app password without DM access: replies/mentions keep working
          }
        }
        return { ok: true as const, items, cursor: JSON.stringify({ n: newest, c: chatCursor, dm: dmOk }), more: false };
      });
    } catch (err) {
      if (err instanceof TransportError) return { ok: false, code: 'network', message: 'Bluesky could not be reached.' };
      if (err instanceof ProviderHttpError) {
        const c = classifyBluesky(err, ctx.now().getTime());
        return { ok: false, code: c.code, message: c.message, reconnect: c.kind === 'reconnect', retryAfterMs: 'retryAfterMs' in c ? c.retryAfterMs : undefined };
      }
      throw err;
    }
  },

  async sendReply(ctx, creds, conn, input): Promise<SendReplyResult> {
    if (graphemes(input.text) > (input.mode === 'private_message' ? 1000 : 300)) return { kind: 'rejected', code: 'too_long', message: input.mode === 'private_message' ? 'Bluesky messages are limited to 1,000 characters.' : 'Bluesky posts are limited to 300 characters.' };
    try {
      return await withAccess(ctx, creds, conn.providerAccountId, async (a): Promise<SendReplyResult> => {
        if (input.mode === 'private_message') {
          const convo = input.target.threadKey.startsWith('convo:') ? input.target.threadKey.slice(6) : null;
          if (!convo) return { kind: 'rejected', code: 'mode_not_supported', message: 'Private messages are only possible in an existing Bluesky chat.' };
          const r = await chat<{ id?: string }>(ctx, a, 'chat.bsky.convo.sendMessage', 'POST', { json: { convoId: convo, message: { text: input.text } }, op: 'bluesky.inbox.send_dm', publishes: true });
          const id = str(r.data.id);
          return id ? { kind: 'sent', externalId: `chat:${id}`, detail: { status: r.status } } : { kind: 'unknown', code: 'no_id', message: 'Bluesky accepted the message without an id. Checking.' };
        }
        const m = input.target.replyToMeta as { uri?: string; cid?: string; root?: Ref } | null | undefined;
        if (!m?.uri || !m.cid || !m.root?.uri || !m.root.cid) return { kind: 'rejected', code: 'no_reference', message: 'The post being answered is missing its Bluesky reference.' };
        const r = await xrpc<{ uri?: string; cid?: string }>(ctx, { service: a.pdsUrl, nsid: 'com.atproto.repo.createRecord', method: 'POST', jwt: a.jwt, op: 'bluesky.inbox.reply', publishes: true,
          json: { repo: a.did, collection: POST_COLLECTION, record: { $type: POST_COLLECTION, text: input.text, createdAt: ctx.now().toISOString(), reply: { root: { uri: m.root.uri, cid: m.root.cid }, parent: { uri: m.uri, cid: m.cid } } } } });
        const uri = str(r.data.uri);
        return uri ? { kind: 'sent', externalId: uri, detail: { status: r.status, cid: str(r.data.cid) } } : { kind: 'unknown', code: 'no_id', message: 'Bluesky accepted the reply without a record id. Checking.' };
      });
    } catch (err) {
      return replyFromError(err, classifyBluesky, 'Bluesky', ctx.now().getTime());
    }
  },

  async findSent(ctx, creds, conn, input) {
    const since = input.since.getTime() - 60_000;
    try {
      return await withAccess(ctx, creds, conn.providerAccountId, async (a) => {
        if (input.mode === 'private_message') {
          const convo = input.target.threadKey.startsWith('convo:') ? input.target.threadKey.slice(6) : null;
          if (!convo) return { found: false } as const;
          const r = await chat<{ messages?: Array<{ id?: string; text?: string; sender?: { did?: string }; sentAt?: string }> }>(ctx, a, 'chat.bsky.convo.getMessages', 'GET', { query: { convoId: convo, limit: '50' }, op: 'bluesky.inbox.find_dm' });
          return oneMatch((r.data.messages ?? []).filter((x) => x.id && x.sender?.did === a.did && sameText(x.text, input.text) && Date.parse(x.sentAt ?? '') >= since).map((x) => ({ id: `chat:${x.id}` })));
        }
        const parent = (input.target.replyToMeta as { uri?: string } | null | undefined)?.uri;
        const r = await xrpc<{ records?: Array<{ uri?: string; value?: { text?: string; createdAt?: string; reply?: { parent?: Ref } } }> }>(ctx, { service: a.pdsUrl, nsid: 'com.atproto.repo.listRecords', method: 'GET', jwt: a.jwt, params: { repo: a.did, collection: POST_COLLECTION, limit: '50' }, op: 'bluesky.inbox.find_reply' });
        return oneMatch((r.data.records ?? []).filter((x) => x.uri && x.value?.reply?.parent?.uri === parent && sameText(x.value?.text, input.text) && Date.parse(x.value?.createdAt ?? '') >= since).map((x) => ({ id: x.uri! })));
      });
    } catch (err) {
      if (err instanceof TransportError || err instanceof ProviderHttpError) return { found: false };
      throw err;
    }
  },

  async moderate(ctx, creds, conn, input) {
    if (input.action !== 'delete_own') return { ok: false, code: 'not_supported', message: 'Bluesky only lets you delete your own posts.', retryable: false };
    const m = /^at:\/\/([^/]+)\/app\.bsky\.feed\.post\/([^/]+)$/.exec(input.externalId);
    if (!m) return { ok: false, code: 'not_supported', message: 'Only your own replies can be deleted.', retryable: false };
    try {
      return await withAccess(ctx, creds, conn.providerAccountId, async (a) => {
        if (m[1] !== a.did) return { ok: false as const, code: 'not_own', message: 'Only your own replies can be deleted.', retryable: false };
        await xrpc(ctx, { service: a.pdsUrl, nsid: 'com.atproto.repo.deleteRecord', method: 'POST', jwt: a.jwt, json: { repo: a.did, collection: POST_COLLECTION, rkey: m[2] }, op: 'bluesky.inbox.delete' });
        return { ok: true as const };
      });
    } catch (err) {
      return moderationFromError(err, classifyBluesky, 'Bluesky');
    }
  },
};
