// Google Business Profile reviews as inbox items (V3.5 stream B). The GBP connection (OAuth, location selection,
// local posts, Pub/Sub notifications) is stream C's integration; this adapter covers reviews + the OWNER reply only.
// Verified 2026-11-08 (developers.google.com/my-business/reference/rest/v4/accounts.locations.reviews):
//  - list:        GET  https://mybusiness.googleapis.com/v4/{accounts/*/locations/*}/reviews?pageSize&pageToken&orderBy
//  - get:         GET  .../v4/{accounts/*/locations/*/reviews/*}
//  - updateReply: PUT  .../v4/{accounts/*/locations/*/reviews/*}/reply {comment} → ReviewReply — creates or updates
//                 the owner reply; verified locations only.
//  - deleteReply: DELETE .../v4/{…/reviews/*}/reply — removes the OWNER reply. Customers' reviews cannot be deleted
//                 or edited through the API (Relay offers no such action).
//  - Scope https://www.googleapis.com/auth/business.manage; API access needs Google approval (quota 0 until then).
//  - Chat was discontinued on 2024-07-31 and is not offered.
// Every reply is addressed by the full review name, which contains the location: a reply can only reach the location
// the review belongs to (acceptance test 4).
import { TransportError, type PublishConnection } from '@social-lite/core';
import type { ChannelCapability, InboundItem, InboxAdapter, ReplyRulesInput, ReplyRulesResult, SendReplyResult } from '@social-lite/core/contracts/v35-inbox';
import { ProviderHttpError, call, oauthAccessToken } from '../shared/http.js';
import type { ErrorClass } from '../shared/classify.js';
import { clip, moderationFromError, replyFromError, sameText, str } from '../shared/inbox.js';
import { parseGoogleError } from '../youtube/api.js';

export const GBP_HOST = 'https://mybusiness.googleapis.com';
export const GBP_SCOPE = 'https://www.googleapis.com/auth/business.manage';
const STARS: Record<string, number> = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 };
const LOCATION_RE = /^accounts\/[A-Za-z0-9_-]{1,80}\/locations\/[A-Za-z0-9_-]{1,80}$/;

export const GBP_REVIEWS_CAPABILITY: ChannelCapability = {
  kind: 'google_business_profile',
  conversationTypes: { review: { read: 'needs_approval', reply: 'needs_approval', visibility: 'public' } },
  inbound: 'webhook_and_polling',
  history: 'All reviews of each selected location (paginated list; Relay polls with a checkpoint).',
  replyWindow: null,
  attachments: 'None.',
  moderation: ['Update or delete the owner reply (never the customer’s review)'],
  receipts: { delivered: false, read: false },
  requires: ['Business Profile API access approval (quota 0 until approved)', 'Google Business Profile connected in Integrations with the location selected', 'Verified location', 'Chat was discontinued in July 2024 (not offered)'],
  verifiedOn: '2026-11-08',
};

export const gbpLocation = (conn: PublishConnection): string | null => {
  const v = conn.metadata.location;
  return typeof v === 'string' && LOCATION_RE.test(v) ? v : null;
};

export function classifyGoogleBusiness(e: ProviderHttpError, nowMs: number): ErrorClass {
  if (e.status === 401) return { kind: 'reconnect', code: 'gbp_auth', message: 'Google rejected the authorization. Reconnect Google Business Profile.' };
  if (e.status === 403) return { kind: 'permission', code: 'gbp_permission', message: 'Google refused: the account no longer manages this location, or API access is not approved.' };
  if (e.status === 429) return { kind: 'rate_limited', code: 'rate_limited', message: 'Google Business Profile quota reached.', retryAfterMs: e.retryAtMs ? Math.max(1000, e.retryAtMs - nowMs) : 60_000 };
  if (e.status === 404) return { kind: 'not_found', code: 'review_not_found', message: 'The review no longer exists at Google.' };
  if (e.status >= 500) return { kind: 'server', code: 'server_error', message: 'Google reported a temporary error.' };
  return { kind: 'invalid', code: e.code ?? 'rejected', message: 'Google rejected the reply (check length and content).' };
}

interface Review { name?: string; reviewId?: string; reviewer?: { displayName?: string; isAnonymous?: boolean }; starRating?: string; comment?: string; createTime?: string; updateTime?: string; reviewReply?: { comment?: string; updateTime?: string } | null }

const replyId = (reviewId: string, updateTime: string) => `reply:${reviewId}@${Date.parse(updateTime) || 0}`;

/** Normalise one review (+ its owner reply) into inbox items. Exported for the Pub/Sub notification path (stream C). */
export function reviewItems(location: string, r: Review): InboundItem[] {
  const id = str(r.reviewId) ?? (r.name ? r.name.split('/').pop() ?? null : null);
  if (!id || !r.createTime) return [];
  const thread = `review:${id}`;
  const rating = STARS[String(r.starRating)] ?? null;
  const text = clip(r.comment ?? '');
  const items: InboundItem[] = [{
    type: 'message', accountId: location, conversationKind: 'review', threadKey: thread, externalId: thread, parentExternalId: null, direction: 'inbound',
    author: { externalId: `reviewer:${id}`, name: r.reviewer?.isAnonymous ? 'Anonymous' : (r.reviewer?.displayName ? clip(r.reviewer.displayName, 200) : null), handle: null },
    text, attachments: [], occurredAt: new Date(r.createTime).toISOString(), relatedPostExternalId: null, subject: rating ? `${rating}★ review` : 'Review',
    meta: { rating, review_name: r.name ?? `${location}/reviews/${id}` },
  }];
  // A review the customer edited later: same message, new text (revision kept by ingest).
  if (r.updateTime && r.updateTime !== r.createTime) items.push({ type: 'edit', accountId: location, externalId: thread, text, occurredAt: new Date(r.updateTime).toISOString() });
  if (r.reviewReply?.comment && r.reviewReply.updateTime) {
    items.push({
      type: 'message', accountId: location, conversationKind: 'review', threadKey: thread, externalId: replyId(id, r.reviewReply.updateTime), parentExternalId: thread,
      direction: 'outbound', author: null, text: clip(r.reviewReply.comment), attachments: [], occurredAt: new Date(r.reviewReply.updateTime).toISOString(),
      relatedPostExternalId: null, subject: null, meta: { owner_reply: true },
    });
  }
  return items;
}

export function gbpReplyRules(i: ReplyRulesInput): ReplyRulesResult {
  if (i.kind !== 'review') return { allowed: false, code: 'not_supported', message: 'Only reviews are supported for Google Business Profile.' };
  if (i.mode !== 'public_reply') return { allowed: false, code: 'mode_not_supported', message: 'Google only allows a public owner reply to a review.' };
  return { allowed: true, windowEndsAt: null };
}

const reviewName = (conn: PublishConnection, threadKey: string): string | null => {
  const loc = gbpLocation(conn);
  const id = threadKey.startsWith('review:') ? threadKey.slice(7) : null;
  return loc && id && /^[A-Za-z0-9_-]{1,200}$/.test(id) ? `${loc}/reviews/${id}` : null;
};

export const googleBusinessInboxAdapter: InboxAdapter = {
  kind: 'google_business_profile',
  capability: () => GBP_REVIEWS_CAPABILITY,
  missingPermissions(granted, connection) {
    if (connection.isMock) return [];
    return (granted ?? []).includes(GBP_SCOPE) ? [] : [GBP_SCOPE];
  },
  // Pub/Sub notifications carry the review name only; stream C's verified handler calls the poller for that location.
  parseWebhook: () => [],
  replyRules: gbpReplyRules,
  pollIntervalMs: 10 * 60_000,
  moderationActions: (kind, direction) => (kind === 'review' && direction === 'outbound' ? ['delete_own'] : []),

  async poll(ctx, creds, conn, input) {
    const loc = gbpLocation(conn);
    if (!loc) return { ok: false, code: 'no_location', message: 'No location is selected for this channel.' };
    const since = input.cursor ? Date.parse(input.cursor) : 0;
    const items: InboundItem[] = [];
    let newest = input.cursor;
    let pageToken: string | undefined;
    try {
      const token = oauthAccessToken(creds as never, 'Google Business Profile');
      for (let page = 0; page < 3; page++) {
        const r = await call<{ reviews?: Review[]; nextPageToken?: string }>(ctx, { method: 'GET', url: `${GBP_HOST}/v4/${loc}/reviews`, bearer: token, query: { pageSize: '50', orderBy: 'updateTime desc', pageToken }, op: 'gbp.reviews.list' }, parseGoogleError);
        let older = false;
        for (const rv of r.data.reviews ?? []) {
          const upd = Date.parse(rv.reviewReply?.updateTime && rv.reviewReply.updateTime > (rv.updateTime ?? '') ? rv.reviewReply.updateTime : rv.updateTime ?? rv.createTime ?? '');
          if (since && upd <= since) { older = true; continue; }
          items.push(...reviewItems(loc, rv));
          if (!newest || upd > Date.parse(newest)) newest = new Date(upd).toISOString();
        }
        pageToken = r.data.nextPageToken;
        if (!pageToken || older) break;
      }
      return { ok: true, items, cursor: newest ?? null, more: !!pageToken };
    } catch (err) {
      if (err instanceof TransportError) return { ok: false, code: 'network', message: 'Google could not be reached.' };
      if (err instanceof ProviderHttpError) {
        const c = classifyGoogleBusiness(err, ctx.now().getTime());
        return { ok: false, code: c.code, message: c.message, reconnect: c.kind === 'reconnect', retryAfterMs: c.kind === 'rate_limited' ? c.retryAfterMs : undefined };
      }
      throw err;
    }
  },

  async sendReply(ctx, creds, conn, input): Promise<SendReplyResult> {
    if (input.mode !== 'public_reply') return { kind: 'rejected', code: 'mode_not_supported', message: 'Google only allows a public owner reply.' };
    const name = reviewName(conn, input.target.threadKey);
    if (!name) return { kind: 'rejected', code: 'no_location', message: 'This review is not linked to a selected location.' };
    if (input.text.length > 4096) return { kind: 'rejected', code: 'too_long', message: 'Owner replies are limited to 4,096 characters.' };
    try {
      const token = oauthAccessToken(creds as never, 'Google Business Profile');
      const r = await call<{ comment?: string; updateTime?: string }>(ctx, { method: 'PUT', url: `${GBP_HOST}/v4/${name}/reply`, bearer: token, json: { comment: input.text }, op: 'gbp.reviews.update_reply', publishes: true }, parseGoogleError);
      const at = str(r.data.updateTime);
      return at ? { kind: 'sent', externalId: replyId(name.split('/').pop()!, at), detail: { status: r.status, location: gbpLocation(conn) } } : { kind: 'unknown', code: 'no_time', message: 'Google accepted the reply without confirming it. Checking.' };
    } catch (err) {
      return replyFromError(err, classifyGoogleBusiness, 'Google', ctx.now().getTime());
    }
  },

  async findSent(ctx, creds, conn, input) {
    const name = reviewName(conn, input.target.threadKey);
    if (!name) return { found: false };
    try {
      const token = oauthAccessToken(creds as never, 'Google Business Profile');
      const r = await call<Review>(ctx, { method: 'GET', url: `${GBP_HOST}/v4/${name}`, bearer: token, op: 'gbp.reviews.get' }, parseGoogleError);
      const rr = r.data.reviewReply;
      if (rr?.comment && rr.updateTime && sameText(rr.comment, input.text) && Date.parse(rr.updateTime) >= input.since.getTime() - 60_000) return { found: true, externalId: replyId(name.split('/').pop()!, rr.updateTime) };
      return { found: false };
    } catch (err) {
      if (err instanceof TransportError || err instanceof ProviderHttpError) return { found: false };
      throw err;
    }
  },

  async moderate(ctx, creds, conn, input) {
    if (input.action !== 'delete_own') return { ok: false, code: 'not_supported', message: 'Google allows only deleting the owner reply.', retryable: false };
    const name = reviewName(conn, input.threadKey);
    if (!name) return { ok: false, code: 'no_location', message: 'This review is not linked to a selected location.', retryable: false };
    try {
      const token = oauthAccessToken(creds as never, 'Google Business Profile');
      await call(ctx, { method: 'DELETE', url: `${GBP_HOST}/v4/${name}/reply`, bearer: token, op: 'gbp.reviews.delete_reply' }, parseGoogleError);
      return { ok: true };
    } catch (err) {
      return moderationFromError(err, classifyGoogleBusiness, 'Google');
    }
  },
};

export const isLocationName = (s: string) => LOCATION_RE.test(s);
