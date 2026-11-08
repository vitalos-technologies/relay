// YouTube comments inbox adapter (V3.5 stream B). Polling only (YouTube has no comment webhooks).
// Verified 2026-11-08 (developers.google.com/youtube/v3/docs):
//  - commentThreads.list part=snippet,replies&allThreadsRelatedToChannelId=<channel>&order=time (1 quota unit/page)
//  - comments.insert part=snippet {snippet:{parentId, textOriginal}} — replies only (top-level comments use
//    commentThreads.insert); 50 quota units of the default 10,000/day; scope youtube.force-ssl.
//  - comments.list part=snippet&parentId=<top comment> — used to confirm an unconfirmed reply (never resent blindly).
//  - comments.setModerationStatus id&moderationStatus=heldForReview|published|rejected (channel owner) — Relay's
//    "Hide" = heldForReview, "Unhide" = published (rejected is not offered: it is not reversible in Studio).
//  - comments.delete id — the channel's own replies.
// Limitation (documented in the capability record): new replies under an OLD thread surface when the thread is
// listed again; the poller re-reads the most recent threads each cycle.
import { TransportError } from '@social-lite/core';
import type { ChannelCapability, InboundItem, InboxAdapter, ReplyRulesInput, ReplyRulesResult, SendReplyResult } from '@social-lite/core/contracts/v35-inbox';
import { ProviderHttpError, oauthAccessToken } from '../shared/http.js';
import { clip, moderationFromError, oneMatch, replyFromError, sameText, str } from '../shared/inbox.js';
import { classifyYouTube, ytCall } from './api.js';
import { YT_SCOPE_FORCE_SSL } from './oauth.js';

export const YOUTUBE_INBOX_CAPABILITY: ChannelCapability = {
  kind: 'youtube',
  conversationTypes: { comment: { read: 'supported', reply: 'supported', visibility: 'public' } },
  inbound: 'polling',
  history: 'Comment threads on the channel’s videos (most recent first). New replies under old threads appear when the thread is listed again.',
  replyWindow: null,
  attachments: 'None.',
  moderation: ['Hold for review / publish comments (channel owner)', 'Delete the channel’s own replies'],
  receipts: { delivered: false, read: false },
  requires: ['youtube.force-ssl scope (reconnect YouTube if it was not granted)', 'Quota: each reply costs 50 of the default 10,000 units/day; each poll page costs 1'],
  verifiedOn: '2026-11-08',
};

interface YtComment { id?: string; snippet?: { parentId?: string; videoId?: string; authorDisplayName?: string; authorChannelId?: { value?: string }; textOriginal?: string; textDisplay?: string; publishedAt?: string; updatedAt?: string } }
interface YtThread { id?: string; snippet?: { videoId?: string; topLevelComment?: YtComment; totalReplyCount?: number }; replies?: { comments?: YtComment[] } }

function commentItem(channelId: string, top: string, videoId: string | null, c: YtComment): InboundItem[] {
  const s = c.snippet ?? {};
  if (!c.id || !s.publishedAt) return [];
  const mine = s.authorChannelId?.value === channelId;
  const text = clip(s.textOriginal ?? s.textDisplay ?? '');
  const out: InboundItem[] = [{
    type: 'message', accountId: channelId, conversationKind: 'comment', threadKey: `comment:${top}`, externalId: c.id, parentExternalId: c.id === top ? null : top,
    direction: mine ? 'outbound' : 'inbound', author: mine ? null : { externalId: s.authorChannelId?.value ?? `name:${s.authorDisplayName ?? 'unknown'}`, name: s.authorDisplayName ? clip(s.authorDisplayName, 200) : null, handle: null },
    text, attachments: [], occurredAt: new Date(s.publishedAt).toISOString(), relatedPostExternalId: videoId, subject: null, meta: { video_id: videoId },
  }];
  if (s.updatedAt && s.updatedAt !== s.publishedAt) out.push({ type: 'edit', accountId: channelId, externalId: c.id, text, occurredAt: new Date(s.updatedAt).toISOString() });
  return out;
}

export function youtubeReplyRules(i: ReplyRulesInput): ReplyRulesResult {
  if (i.kind !== 'comment') return { allowed: false, code: 'not_supported', message: 'Only comments are supported on YouTube.' };
  if (i.mode !== 'public_reply') return { allowed: false, code: 'mode_not_supported', message: 'YouTube has no private messages. Use Public reply.' };
  return { allowed: true, windowEndsAt: null };
}

const topOf = (threadKey: string) => (threadKey.startsWith('comment:') ? threadKey.slice(8) : null);

export const youtubeInboxAdapter: InboxAdapter = {
  kind: 'youtube',
  capability: () => YOUTUBE_INBOX_CAPABILITY,
  missingPermissions(granted, connection) {
    if (connection.isMock) return [];
    return (granted ?? []).includes(YT_SCOPE_FORCE_SSL) ? [] : [YT_SCOPE_FORCE_SSL];
  },
  parseWebhook: () => [],
  replyRules: youtubeReplyRules,
  pollIntervalMs: 5 * 60_000,
  moderationActions: (kind, direction) => (kind !== 'comment' ? [] : direction === 'inbound' ? ['hide', 'unhide'] : ['delete_own']),

  async poll(ctx, creds, conn, input) {
    const channelId = conn.providerAccountId;
    const since = input.cursor ? Date.parse(input.cursor) : 0;
    const items: InboundItem[] = [];
    let newest = input.cursor;
    let pageToken: string | undefined;
    try {
      const token = oauthAccessToken(creds as never, 'YouTube');
      for (let page = 0; page < 2; page++) {
        const r = await ytCall<{ items?: YtThread[]; nextPageToken?: string }>(ctx, { method: 'GET', path: '/youtube/v3/commentThreads', bearer: token, op: 'youtube.inbox.threads',
          query: { part: 'snippet,replies', allThreadsRelatedToChannelId: channelId, maxResults: '50', order: 'time', textFormat: 'plainText', pageToken } });
        let older = false;
        for (const t of r.data.items ?? []) {
          const top = t.snippet?.topLevelComment;
          const topId = str(top?.id) ?? str(t.id);
          if (!topId || !top) continue;
          const all = [top, ...(t.replies?.comments ?? [])];
          const latest = Math.max(...all.map((c) => Date.parse(c.snippet?.updatedAt ?? c.snippet?.publishedAt ?? '') || 0));
          if (since && latest <= since) { older = true; continue; }
          for (const c of all) items.push(...commentItem(channelId, topId, str(t.snippet?.videoId), c));
          if (!newest || latest > Date.parse(newest)) newest = new Date(latest).toISOString();
        }
        pageToken = r.data.nextPageToken;
        if (!pageToken || older) break;
      }
      return { ok: true, items, cursor: newest ?? null, more: false };
    } catch (err) {
      if (err instanceof TransportError) return { ok: false, code: 'network', message: 'YouTube could not be reached.' };
      if (err instanceof ProviderHttpError) {
        const c = classifyYouTube(err, ctx.now().getTime());
        return { ok: false, code: c.code, message: c.message, reconnect: c.kind === 'reconnect', retryAfterMs: 'retryAfterMs' in c ? c.retryAfterMs : undefined };
      }
      throw err;
    }
  },

  async sendReply(ctx, creds, _conn, input): Promise<SendReplyResult> {
    const top = topOf(input.target.threadKey);
    if (input.mode !== 'public_reply' || !top) return { kind: 'rejected', code: 'mode_not_supported', message: 'Only public replies to comments are possible on YouTube.' };
    if (input.text.length > 10_000) return { kind: 'rejected', code: 'too_long', message: 'YouTube comments are limited to 10,000 characters.' };
    try {
      const token = oauthAccessToken(creds as never, 'YouTube');
      const r = await ytCall<{ id?: string }>(ctx, { method: 'POST', path: '/youtube/v3/comments', bearer: token, query: { part: 'snippet' }, json: { snippet: { parentId: top, textOriginal: input.text } }, op: 'youtube.inbox.reply', publishes: true });
      const id = str(r.data.id);
      return id ? { kind: 'sent', externalId: id, detail: { status: r.status, quota_units: 50 } } : { kind: 'unknown', code: 'no_id', message: 'YouTube accepted the reply without an id. Checking.' };
    } catch (err) {
      return replyFromError(err, classifyYouTube, 'YouTube', ctx.now().getTime());
    }
  },

  async findSent(ctx, creds, conn, input) {
    const top = topOf(input.target.threadKey);
    if (!top) return { found: false };
    try {
      const token = oauthAccessToken(creds as never, 'YouTube');
      const r = await ytCall<{ items?: YtComment[] }>(ctx, { method: 'GET', path: '/youtube/v3/comments', bearer: token, query: { part: 'snippet', parentId: top, maxResults: '100', textFormat: 'plainText' }, op: 'youtube.inbox.find_reply' });
      const since = input.since.getTime() - 60_000;
      return oneMatch((r.data.items ?? []).filter((c) => c.id && c.snippet?.authorChannelId?.value === conn.providerAccountId && sameText(c.snippet?.textOriginal ?? c.snippet?.textDisplay, input.text) && Date.parse(c.snippet?.publishedAt ?? '') >= since).map((c) => ({ id: c.id! })));
    } catch (err) {
      if (err instanceof TransportError || err instanceof ProviderHttpError) return { found: false };
      throw err;
    }
  },

  async moderate(ctx, creds, _conn, input) {
    try {
      const token = oauthAccessToken(creds as never, 'YouTube');
      if (input.action === 'delete_own') await ytCall(ctx, { method: 'DELETE', path: '/youtube/v3/comments', bearer: token, query: { id: input.externalId }, op: 'youtube.inbox.delete' });
      else await ytCall(ctx, { method: 'POST', path: '/youtube/v3/comments/setModerationStatus', bearer: token, query: { id: input.externalId, moderationStatus: input.action === 'hide' ? 'heldForReview' : 'published' }, op: 'youtube.inbox.moderate' });
      return { ok: true };
    } catch (err) {
      return moderationFromError(err, classifyYouTube, 'YouTube');
    }
  },
};
