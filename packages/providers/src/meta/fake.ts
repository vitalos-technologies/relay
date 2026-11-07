// In-process simulation of the Meta Graph endpoints used by the Facebook Page and Instagram adapters.
// Serves ONLY mock_ destinations via MockTransport. All created object ids begin with "mock_" (Facebook
// post ids are "<page-id>_<n>", and simulated page ids begin with "mock_"). Objects persist in
// env.store so reconciliation works after worker restarts; "once" scenarios use env.store.incr.
//
// Simulation choices (not provider facts): throttling is answered like Graph does (HTTP 400 +
// code 80001/80002 + X-Business-Use-Case-Usage), not with HTTP 429; re-publishing an already
// published container answers code 24 / subcode 2207008.
//
// V1.1 media: IG carousel items (is_carousel_item), CAROUSEL parents and REELS containers; Facebook
// unpublished photos (published=false) + /feed attached_media, and /videos (file_url) with an async
// video status (processing for PROCESSING_POLLS polls under the `processing` scenario).
import type { HttpRequest, HttpResponse } from '@social-lite/core';
import { json, lostResponse, type FakeEnv, type FakeHandler, type MockObject } from '../transport/mock.js';

const CONTAINER_TTL_MS = 24 * 60 * 60_000;
const PROCESSING_POLLS = 2;
const IG_QUOTA_TOTAL = 50;

function gerr(status: number, code: number, message: string, extra: { subcode?: number; transient?: boolean; type?: string } = {}, headers: Record<string, string> = {}): HttpResponse {
  return json(status, {
    error: {
      message, type: extra.type ?? 'OAuthException', code,
      ...(extra.subcode !== undefined ? { error_subcode: extra.subcode } : {}),
      ...(extra.transient !== undefined ? { is_transient: extra.transient } : {}),
      fbtrace_id: 'mock_trace',
    },
  }, headers);
}

const invalidParam = (msg: string, subcode?: number) => gerr(400, 100, `(#100) ${msg}`, { subcode });
const revoked = () => gerr(400, 190, 'Error validating access token: The session has been invalidated because the user changed their password or Facebook has changed the session for security reasons.', { subcode: 460 });

function fbTime(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, '+0000');
}

/** Graph-style field projection: top-level names from `fields`, nested {..} selections ignored. */
function pick(obj: Record<string, unknown>, fields: string | null): Record<string, unknown> {
  if (!fields) return { id: obj.id };
  const names: string[] = [];
  let depth = 0; let cur = '';
  for (const ch of fields) {
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    else if (ch === ',' && depth === 0) { names.push(cur.trim()); cur = ''; }
    else if (depth === 0) cur += ch;
  }
  if (cur.trim()) names.push(cur.trim());
  const out: Record<string, unknown> = { id: obj.id };
  for (const n of names) if (obj[n] !== undefined && obj[n] !== null) out[n] = obj[n];
  return out;
}

interface Parsed { method: string; segments: string[]; params: URLSearchParams; token: string | null }

function parse(req: HttpRequest): Parsed | HttpResponse {
  const u = new URL(req.url);
  const m = /^\/(v\d+\.\d+)\/(.+)$/.exec(u.pathname);
  if (!m) return invalidParam('Unknown path components: an API version is required');
  const params = new URLSearchParams(u.search);
  if (req.method === 'POST' && typeof req.body === 'string') {
    for (const [k, v] of new URLSearchParams(req.body)) params.append(k, v);
  }
  const auth = req.headers?.authorization ?? req.headers?.Authorization;
  const token = params.get('access_token') ?? (auth?.replace(/^(Bearer|OAuth)\s+/i, '') || null);
  return { method: req.method, segments: m[2]!.split('/').filter(Boolean).map(decodeURIComponent), params, token };
}

async function once(env: FakeEnv, op: string): Promise<boolean> {
  return (await env.store.incr(`meta:${env.provider}:${env.accountId}:${op}:${env.scenario}`)) === 1;
}

function ids(env: FakeEnv) {
  const isIg = env.provider === 'instagram';
  return {
    isIg,
    pageId: isIg ? `${env.accountId}_page` : env.accountId,
    igUserId: isIg ? env.accountId : null,
  };
}

function pageNode(env: FakeEnv): Record<string, unknown> {
  const { pageId, igUserId } = ids(env);
  return {
    id: pageId, name: 'Simulated Page', access_token: `mock_page_token_${pageId}`,
    tasks: ['ANALYZE', 'ADVERTISE', 'MODERATE', 'CREATE_CONTENT', 'MANAGE'],
    ...(igUserId ? { instagram_business_account: { id: igUserId, username: 'simulated.account', name: 'Simulated Instagram' } } : {}),
  };
}

function extraPages(env: FakeEnv): Array<Record<string, unknown>> {
  const { pageId, isIg } = ids(env);
  return isIg
    ? [{ id: `${pageId}_nolink`, name: 'Page without Instagram', access_token: `mock_page_token_${pageId}_nolink`, tasks: ['CREATE_CONTENT', 'MANAGE'] }]
    : [{ id: `${pageId}_readonly`, name: 'Read-only Page', access_token: `mock_page_token_${pageId}_ro`, tasks: ['ANALYZE'] }];
}

function igAccount(env: FakeEnv): Record<string, unknown> {
  return { id: env.accountId, username: 'simulated.account', name: 'Simulated Instagram' };
}

async function put(env: FakeEnv, objectId: string, kind: string, data: Record<string, unknown>, createdAt?: string): Promise<MockObject> {
  const o: MockObject = { provider: env.provider, accountId: env.accountId, objectId, kind, data, createdAt: createdAt ?? env.now().toISOString() };
  await env.store.put(o);
  return o;
}

/** Publish-call scenario gates shared by /feed, /photos and /media_publish. */
async function publishGate(env: FakeEnv, op: string): Promise<HttpResponse | 'lose_response' | null> {
  switch (env.scenario) {
    case 'missing_permission':
      return env.provider === 'instagram'
        ? gerr(403, 10, 'Application does not have permission for this action')
        : gerr(403, 200, '(#200) The user hasn\'t authorized the application to perform this action');
    case 'fail_transient_once':
      if (await once(env, op)) return gerr(500, 2, 'An unexpected error has occurred. Please retry your request later.', { transient: true });
      return null;
    case 'rate_limited_once':
      if (await once(env, op)) {
        const igOrPages = env.provider === 'instagram' ? 'instagram' : 'pages';
        const header = JSON.stringify({ [env.accountId]: [{ type: igOrPages, call_count: 100, total_cputime: 20, total_time: 30, estimated_time_to_regain_access: 2 }] });
        return gerr(400, env.provider === 'instagram' ? 80002 : 80001, 'There have been too many calls to this account. Wait a bit and try again.', {}, { 'x-business-use-case-usage': header });
      }
      return null;
    case 'timeout_after_send':
      return (await once(env, op)) ? 'lose_response' : null;
    default:
      return null;
  }
}

function containerStatus(c: MockObject, env: FakeEnv, polls: number): string {
  if (c.data.published) return 'PUBLISHED';
  if (env.now().getTime() - Date.parse(c.createdAt) >= CONTAINER_TTL_MS) return 'EXPIRED';
  if (c.data.processing && polls <= PROCESSING_POLLS) return 'IN_PROGRESS';
  return 'FINISHED';
}

function isHttpsUrl(v: string | null): boolean {
  if (!v) return false;
  try { const u = new URL(v); return u.protocol === 'https:' || u.protocol === 'http:'; } catch { return false; }
}

export const metaFake: FakeHandler = async (req, env) => {
  const p = parse(req);
  if ('status' in p) return p;
  const { segments, params } = p;
  const [first, edge] = segments;
  const { pageId, igUserId, isIg } = ids(env);
  const now = env.now();

  // ---------------------------------------------------------------- OAuth (client_secret authenticated)
  if (first === 'oauth' && edge === 'access_token' && p.method === 'GET') {
    if (!params.get('client_id') || !params.get('client_secret')) return invalidParam('Missing client_id or client_secret');
    if (params.get('grant_type') === 'fb_exchange_token') {
      if (!params.get('fb_exchange_token')) return invalidParam('Missing fb_exchange_token');
      return json(200, { access_token: `mock_long_user_token_${env.newId('')}`, token_type: 'bearer', expires_in: 5_183_944 });
    }
    if (!params.get('code') || !params.get('redirect_uri')) return invalidParam('Missing code or redirect_uri');
    return json(200, { access_token: `mock_short_user_token_${env.newId('')}`, token_type: 'bearer', expires_in: 5_400 });
  }

  if (!p.token) return gerr(400, 104, 'An access token is required to request this resource.');
  if (env.scenario === 'revoked') return revoked();

  // ---------------------------------------------------------------- user-level
  if (first === 'me' && edge === 'permissions' && p.method === 'GET') {
    const base = ['public_profile', 'pages_show_list', 'pages_read_engagement'];
    const publish = isIg ? ['instagram_basic', 'instagram_content_publish'] : ['pages_manage_posts'];
    const data = [...base, ...publish].map((permission) => ({
      permission,
      status: env.scenario === 'missing_permission' && (permission === 'pages_manage_posts' || permission === 'instagram_content_publish') ? 'declined' : 'granted',
    }));
    return json(200, { data });
  }
  if (first === 'me' && edge === 'accounts' && p.method === 'GET') {
    const fields = params.get('fields');
    const data = [pageNode(env), ...extraPages(env)].map((n) => pick(n, fields));
    return json(200, { data, paging: { cursors: { before: 'mock_b', after: 'mock_a' } } });
  }
  if (first === 'me' && !edge && p.method === 'GET') return json(200, { id: 'mock_user', name: 'Simulated User' });

  // ---------------------------------------------------------------- Facebook Page
  if (!isIg && first === pageId) {
    if (!edge && p.method === 'GET') return json(200, pick(pageNode(env), params.get('fields')));
    if (edge === 'feed' && p.method === 'POST') {
      const message = params.get('message');
      const link = params.get('link');
      const attached: string[] = [];
      for (let i = 0; params.has(`attached_media[${i}]`); i++) {
        let fbid: unknown;
        try { fbid = (JSON.parse(params.get(`attached_media[${i}]`)!) as { media_fbid?: unknown }).media_fbid; } catch { fbid = null; }
        if (typeof fbid !== 'string') return invalidParam(`attached_media[${i}] must be {"media_fbid":"<id>"}`);
        const photo = await env.store.get(env.provider, fbid);
        if (!photo || photo.kind !== 'photo' || photo.accountId !== env.accountId || photo.data.used) {
          return invalidParam(`Unsupported post request. Object with ID '${fbid}' does not exist, cannot be loaded due to missing permissions, or does not support this operation.`, 33);
        }
        attached.push(fbid);
      }
      if (!message && !link && !attached.length) return invalidParam('Either message or link must be provided');
      if (env.scenario === 'fail_permanent') return invalidParam('Invalid parameter');
      const gate = await publishGate(env, 'feed');
      if (gate && gate !== 'lose_response') return gate;
      const id = `${pageId}_${env.newId('')}`;
      await put(env, id, 'post', { message, link, created_time: fbTime(now), ...(attached.length ? { attached_media: attached } : {}) });
      for (const fbid of attached) {
        const photo = (await env.store.get(env.provider, fbid))!;
        await put(env, fbid, 'photo', { ...photo.data, used: true, post_id: id }, photo.createdAt);
      }
      if (gate === 'lose_response') lostResponse();
      return json(200, { id });
    }
    if (edge === 'videos' && p.method === 'POST') {
      const fileUrl = params.get('file_url');
      if (!isHttpsUrl(fileUrl)) return gerr(400, 389, 'Unable to fetch video file from URL.');
      if (env.scenario === 'fail_permanent') return gerr(400, 389, 'Unable to fetch video file from URL.');
      const gate = await publishGate(env, 'videos');
      if (gate && gate !== 'lose_response') return gate;
      const videoId = env.newId();
      const postId = `${pageId}_${videoId.slice('mock_'.length)}`;
      await put(env, videoId, 'video', { description: params.get('description') ?? '', post_id: postId, processing: env.scenario === 'processing', polls: 0, created_time: fbTime(now) });
      await put(env, postId, 'post', { message: params.get('description') ?? '', video_id: videoId, created_time: fbTime(now) });
      if (gate === 'lose_response') lostResponse();
      return json(200, { id: videoId });
    }
    if (edge === 'photos' && p.method === 'POST') {
      const url = params.get('url');
      if (!isHttpsUrl(url)) return gerr(400, 324, '(#324) Requires upload file');
      if (env.scenario === 'fail_permanent') return invalidParam('Invalid parameter');
      if (params.get('published') === 'false') {
        // Unpublished (staged) photo for a multi-photo post: invisible, no post_id.
        if (env.scenario === 'missing_permission') return gerr(403, 200, '(#200) The user hasn\'t authorized the application to perform this action');
        const photoId = env.newId();
        await put(env, photoId, 'photo', { published: false, used: false });
        return json(200, { id: photoId });
      }
      const gate = await publishGate(env, 'photos');
      if (gate && gate !== 'lose_response') return gate;
      const photoId = env.newId();
      const postId = `${pageId}_${photoId.slice('mock_'.length)}`;
      await put(env, postId, 'post', { message: params.get('caption') ?? '', photo_id: photoId, created_time: fbTime(now) });
      if (gate === 'lose_response') lostResponse();
      return json(200, { id: photoId, post_id: postId });
    }
    if ((edge === 'published_posts' || edge === 'feed') && p.method === 'GET') {
      const since = Number(params.get('since') ?? 0) * 1000;
      const posts = (await env.store.list(env.provider, env.accountId, 'post'))
        .filter((o) => Date.parse(o.createdAt) >= since)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, Number(params.get('limit') ?? 25))
        .map((o) => pick({ id: o.objectId, ...o.data, permalink_url: `https://www.facebook.com/${o.objectId}` }, params.get('fields')));
      return json(200, { data: posts });
    }
  }

  // ---------------------------------------------------------------- Instagram user
  if (isIg && first === pageId && !edge && p.method === 'GET') return json(200, pick(pageNode(env), params.get('fields')));
  if (isIg && first === igUserId) {
    if (!edge && p.method === 'GET') return json(200, pick(igAccount(env), params.get('fields')));
    if (edge === 'media' && p.method === 'POST') {
      if (env.scenario === 'missing_permission') return gerr(403, 10, 'Application does not have permission for this action');
      const mediaType = params.get('media_type');
      const isItem = params.get('is_carousel_item') === 'true';
      const caption = params.get('caption') ?? '';
      if ([...caption].length > 2200) return gerr(400, 36004, 'The caption is too long.', { subcode: 2207010 });
      if (mediaType === 'CAROUSEL') {
        const children = (params.get('children') ?? '').split(',').map((x) => x.trim()).filter(Boolean);
        if (children.length < 2 || children.length > 20) return invalidParam('The parameter children must contain between 2 and 20 container IDs');
        for (const cid of children) {
          const c = await env.store.get(env.provider, cid);
          if (!c || c.kind !== 'container' || c.accountId !== env.accountId || !c.data.carousel_item) return gerr(400, 24, 'The media container does not exist.', { subcode: 2207006 });
          if (containerStatus(c, env, Number(c.data.polls ?? 0)) !== 'FINISHED') return gerr(400, 9007, 'Media ID is not available', { subcode: 2207027 });
        }
        const id = env.newId();
        await put(env, id, 'container', { caption, media_type: 'CAROUSEL', children, processing: false, published: false });
        return json(200, { id });
      }
      if (isItem) {
        if (params.has('caption')) return invalidParam('The parameter caption is not supported on carousel items');
        const video = mediaType === 'VIDEO';
        const src = video ? params.get('video_url') : params.get('image_url');
        if (!src) return invalidParam(video ? 'The parameter video_url is required' : 'The parameter image_url is required');
        if (!isHttpsUrl(src)) return gerr(400, 9004, 'Only photo or video can be accepted as media type.', { subcode: 2207052 });
        if (env.scenario === 'fail_permanent') return gerr(400, 36003, 'The submitted image with aspect ratio is not supported.', { subcode: 2207009 });
        const id = env.newId();
        await put(env, id, 'container', { carousel_item: true, media_type: video ? 'VIDEO' : 'IMAGE', processing: env.scenario === 'processing', published: false });
        return json(200, { id });
      }
      if (mediaType === 'REELS') {
        const videoUrl = params.get('video_url');
        if (!videoUrl) return invalidParam('The parameter video_url is required');
        if (!isHttpsUrl(videoUrl)) return gerr(400, 9004, 'Only photo or video can be accepted as media type.', { subcode: 2207052 });
        if (env.scenario === 'fail_permanent') return invalidParam('The video format is not supported.', 2207026);
        const id = env.newId();
        await put(env, id, 'container', { caption, media_type: 'REELS', share_to_feed: params.get('share_to_feed'), processing: env.scenario === 'processing', published: false });
        return json(200, { id });
      }
      const imageUrl = params.get('image_url');
      if (!imageUrl) return invalidParam('The parameter image_url is required');
      if (!isHttpsUrl(imageUrl)) return gerr(400, 9004, 'Only photo or video can be accepted as media type.', { subcode: 2207052 });
      if (env.scenario === 'fail_permanent') return gerr(400, 36003, 'The submitted image with aspect ratio is not supported.', { subcode: 2207009 });
      const id = env.newId();
      await put(env, id, 'container', { caption, image_url_present: true, processing: env.scenario === 'processing', published: false });
      return json(200, { id });
    }
    if (edge === 'media' && p.method === 'GET') {
      const media = (await env.store.list(env.provider, env.accountId, 'media'))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, Number(params.get('limit') ?? 25))
        .map((o) => pick({ id: o.objectId, ...o.data }, params.get('fields')));
      return json(200, { data: media });
    }
    if (edge === 'content_publishing_limit' && p.method === 'GET') {
      const dayAgo = now.getTime() - 86_400_000;
      const used = (await env.store.list(env.provider, env.accountId, 'media')).filter((o) => Date.parse(o.createdAt) >= dayAgo).length;
      return json(200, { data: [{ quota_usage: used, config: { quota_total: IG_QUOTA_TOTAL, quota_duration: 86_400 } }] });
    }
    if (edge === 'media_publish' && p.method === 'POST') {
      const creationId = params.get('creation_id');
      if (!creationId) return invalidParam('The parameter creation_id is required');
      const c = await env.store.get(env.provider, creationId);
      if (!c || c.kind !== 'container' || c.accountId !== env.accountId) return gerr(400, 24, 'The media container does not exist.', { subcode: 2207008 });
      const polls = Number(c.data.polls ?? 0);
      const status = containerStatus(c, env, polls);
      if (status === 'EXPIRED' || status === 'PUBLISHED') return gerr(400, 24, 'The media container does not exist or has expired.', { subcode: 2207008 });
      if (status === 'IN_PROGRESS') return gerr(400, 9007, 'Media ID is not available', { subcode: 2207027 });
      if (c.data.carousel_item) return invalidParam('A carousel item cannot be published on its own; publish the CAROUSEL container');
      const gate = await publishGate(env, 'media_publish');
      if (gate && gate !== 'lose_response') return gate;
      const mediaId = env.newId();
      const kind = c.data.media_type === 'CAROUSEL' ? { media_type: 'CAROUSEL_ALBUM', children: c.data.children }
        : c.data.media_type === 'REELS' ? { media_type: 'VIDEO', media_product_type: 'REELS' } : { media_type: 'IMAGE' };
      await put(env, mediaId, 'media', {
        caption: c.data.caption, timestamp: fbTime(now), permalink: `https://www.instagram.com/${c.data.media_type === 'REELS' ? 'reel' : 'p'}/${mediaId}/`, container_id: creationId, ...kind,
      });
      await put(env, c.objectId, 'container', { ...c.data, published: true, media_id: mediaId }, c.createdAt);
      if (gate === 'lose_response') lostResponse();
      return json(200, { id: mediaId });
    }
  }

  // ---------------------------------------------------------------- object lookups by id
  if (first && !edge && p.method === 'GET') {
    const o = await env.store.get(env.provider, first);
    if (o && o.accountId === env.accountId) {
      if (o.kind === 'container') {
        const polls = Number(o.data.polls ?? 0) + 1;
        await put(env, o.objectId, 'container', { ...o.data, polls }, o.createdAt);
        const status = containerStatus(o, env, polls);
        return json(200, pick({ id: o.objectId, status_code: status, status: status === 'ERROR' ? 'Error: 2207001' : status }, params.get('fields')));
      }
      if (o.kind === 'media') return json(200, pick({ id: o.objectId, ...o.data }, params.get('fields')));
      if (o.kind === 'video') {
        const polls = Number(o.data.polls ?? 0) + 1;
        await put(env, o.objectId, 'video', { ...o.data, polls }, o.createdAt);
        const status = o.data.processing && polls <= PROCESSING_POLLS ? 'processing' : 'ready';
        return json(200, pick({
          id: o.objectId, status: { video_status: status, processing_progress: status === 'ready' ? 100 : 50 },
          permalink_url: `/${pageId}/videos/${o.objectId}/`, created_time: o.data.created_time, description: o.data.description,
        }, params.get('fields')));
      }
      if (o.kind === 'post') return json(200, pick({ id: o.objectId, ...o.data, permalink_url: `https://www.facebook.com/${o.objectId}` }, params.get('fields')));
    }
  }
  return invalidParam(`Unsupported ${p.method.toLowerCase()} request. Object with ID '${first ?? ''}' does not exist, cannot be loaded due to missing permissions, or does not support this operation.`, 33);
};
