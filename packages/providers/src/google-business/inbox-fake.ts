// Simulated Google Business Profile reviews API for SIMULATED GBP installations (V3.5 stream B). Served only through
// the inbox mock transport (inbox-registry.ts). Reviews live in the durable mock store (provider tag 'youtube' =
// Google) keyed by the installation's mock_ account id. A reply is accepted only for the review's own location.
import type { HttpRequest, HttpResponse } from '@social-lite/core';
import { json, lostResponse, type FakeEnv, type MockObject } from '../transport/mock.js';
import { parseJson } from '../shared/http.js';

const P = 'youtube' as const;
const STAR = ['', 'ONE', 'TWO', 'THREE', 'FOUR', 'FIVE'];
const gErr = (status: number, s: string, message: string) => json(status, { error: { code: status, message, status: s } });
const once = async (env: FakeEnv, k: string) => (await env.store.incr(`gbp:${env.accountId}:${k}:${env.scenario}`)) === 1;

/** The simulated account's locations (stable per installation). */
export function simulatedLocations(accountId: string): Array<{ name: string; title: string }> {
  const a = accountId.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 60);
  return [{ name: `accounts/${a}/locations/mock_loc_1`, title: 'Relay Coffee — High Street' }, { name: `accounts/${a}/locations/mock_loc_2`, title: 'Relay Coffee — Station' }];
}

function toReview(o: MockObject) {
  const d = o.data as { location: string; reviewer: string; rating: number; comment: string; create: string; update: string; reply: { comment: string; updateTime: string } | null };
  return { name: `${d.location}/reviews/${o.objectId}`, reviewId: o.objectId, reviewer: { displayName: d.reviewer, isAnonymous: false }, starRating: STAR[d.rating] ?? 'FIVE', comment: d.comment, createTime: d.create, updateTime: d.update, ...(d.reply ? { reviewReply: d.reply } : {}) };
}

export async function googleBusinessFake(req: HttpRequest, env: FakeEnv): Promise<HttpResponse | null> {
  const u = new URL(req.url);
  if (u.hostname !== 'mybusiness.googleapis.com') return null;
  if (!(req.headers?.authorization ?? '').startsWith('Bearer ')) return gErr(401, 'UNAUTHENTICATED', 'Request is missing required authentication credential.');
  if (env.scenario === 'revoked') return gErr(401, 'UNAUTHENTICATED', 'Request had invalid authentication credentials.');
  const locs = new Set(simulatedLocations(env.accountId).map((l) => l.name));
  const m = /^\/v4\/(accounts\/[^/]+\/locations\/[^/]+)\/reviews(?:\/([^/]+))?(\/reply)?$/.exec(u.pathname);
  if (!m) return null;
  const [, location, reviewId, reply] = m;
  if (!locs.has(location!)) return gErr(403, 'PERMISSION_DENIED', 'The caller does not have permission');
  if (env.scenario === 'missing_permission' && req.method !== 'GET') return gErr(403, 'PERMISSION_DENIED', 'The caller does not have permission');
  if (!reviewId && req.method === 'GET') {
    const all = (await env.store.list(P, env.accountId, 'gbp_review')).filter((o) => o.data.location === location)
      .sort((a, b) => String(b.data.update).localeCompare(String(a.data.update)));
    const size = Math.min(Number(u.searchParams.get('pageSize') ?? 50) || 50, 50);
    const start = Number(u.searchParams.get('pageToken') ?? 0) || 0;
    const page = all.slice(start, start + size);
    return json(200, { reviews: page.map(toReview), totalReviewCount: all.length, ...(start + size < all.length ? { nextPageToken: String(start + size) } : {}) });
  }
  const o = reviewId ? await env.store.get(P, reviewId) : null;
  if (!o || o.kind !== 'gbp_review' || o.accountId !== env.accountId) return gErr(404, 'NOT_FOUND', 'Requested entity was not found.');
  if (o.data.location !== location) return gErr(404, 'NOT_FOUND', 'Requested entity was not found.');   // wrong location never reaches the review
  if (!reply && req.method === 'GET') return json(200, toReview(o));
  if (reply && req.method === 'PUT') {
    const comment = String((parseJson(typeof req.body === 'string' ? req.body : '') as { comment?: string }).comment ?? '');
    if (!comment.trim()) return gErr(400, 'INVALID_ARGUMENT', 'comment is required');
    if (env.scenario === 'fail_permanent') return gErr(400, 'INVALID_ARGUMENT', 'Request contains an invalid argument.');
    if (env.scenario === 'rate_limited_once' && await once(env, 'rate')) return gErr(429, 'RESOURCE_EXHAUSTED', 'Quota exceeded');
    if (env.scenario === 'fail_transient_once' && await once(env, 'transient')) return gErr(503, 'UNAVAILABLE', 'The service is currently unavailable.');
    const r = { comment, updateTime: env.now().toISOString() };
    await env.store.put({ ...o, data: { ...o.data, reply: r, reply_location: location } });
    if (env.scenario === 'timeout_after_send' && await once(env, 'timeout')) lostResponse();
    return json(200, r);
  }
  if (reply && req.method === 'DELETE') {
    await env.store.put({ ...o, data: { ...o.data, reply: null } });
    return json(200, {});
  }
  return gErr(400, 'INVALID_ARGUMENT', 'Unsupported request');
}

/** Record a simulated customer review at one location (inbox simulator). */
export async function recordSimulatedReview(env: Pick<FakeEnv, 'store'>, accountId: string, r: { id: string; location: string; reviewer: string; rating: number; comment: string; at: string }): Promise<void> {
  if (!accountId.startsWith('mock_') || !r.id.startsWith('mock_')) throw new Error('simulated reviews are only for mock_ accounts');
  await env.store.put({ provider: P, accountId, objectId: r.id, kind: 'gbp_review', createdAt: r.at, data: { location: r.location, reviewer: r.reviewer, rating: r.rating, comment: r.comment, create: r.at, update: r.at, reply: null } });
}

export async function simulatedReview(env: Pick<FakeEnv, 'store'>, id: string): Promise<{ location: string; reply: { comment: string } | null } | null> {
  const o = await env.store.get(P, id);
  return o ? { location: String(o.data.location), reply: (o.data.reply as { comment: string } | null) ?? null } : null;
}
