// In-process simulation of the LinkedIn OAuth / userinfo / Images / Videos / Posts / analytics endpoints.
// Serves ONLY simulated (mock_) destinations and tests. /rest calls without `Linkedin-Version` or
// `X-Restli-Protocol-Version: 2.0.0` are rejected (like the real gateway). Scenarios: success · processing
// (media PROCESSING for 2 polls) · fail_permanent (post 422 / video PROCESSING_FAILED) · fail_transient_once ·
// rate_limited_once (post 429) · timeout_after_send (post stored, response lost) · revoked (401) ·
// missing_permission (403 ACCESS_DENIED on writes).
import { TransportError, type HttpRequest, type HttpResponse } from '@social-lite/core';
import { json, lostResponse, type FakeEnv, type FakeHandler } from '../transport/mock.js';
import { parseJson } from '../shared/http.js';

const liErr = (status: number, code: string, message: string) => json(status, { status, code, serviceErrorCode: 100, message });
const once = async (env: FakeEnv, key: string) => (await env.store.incr(`linkedin:${env.accountId}:${env.scenario}:${key}`)) === 1;
const PART = 4 * 1024 * 1024;
const memberSub = (accountId: string) => accountId.replace(/^urn:li:person:/, '');

export const linkedinFake: FakeHandler = async (req: HttpRequest, env: FakeEnv): Promise<HttpResponse> => {
  const url = new URL(req.url);
  const path = url.pathname;
  const body = typeof req.body === 'string' ? req.body : '';

  if (url.hostname === 'www.linkedin.com' && path === '/oauth/v2/accessToken') {
    const f = new URLSearchParams(body);
    if (!f.get('client_id') || !f.get('client_secret')) return json(400, { error: 'invalid_request', error_description: 'A required parameter "client_secret" is missing' });
    if (f.get('grant_type') === 'refresh_token' && env.scenario === 'revoked') return json(400, { error: 'invalid_grant', error_description: 'refresh token revoked' });
    return json(200, { access_token: env.newId('mock_AQ'), expires_in: 5_184_000, scope: 'openid,profile,w_member_social,w_organization_social,r_organization_social,rw_organization_admin,r_member_postAnalytics' });
  }
  if (env.scenario === 'revoked') return liErr(401, 'EMPTY_ACCESS_TOKEN', 'Invalid access token');

  // Upload hosts (pre-signed): no version headers required.
  if (url.hostname === 'www.linkedin.com' && path.startsWith('/dms-uploads/') && req.method === 'PUT') {
    const id = decodeURIComponent(path.split('/')[2] ?? '');
    const obj = await env.store.get('linkedin', id);
    if (!obj || !(req.body instanceof Uint8Array)) return { status: 400, headers: {}, body: '' };
    if (obj.data.video) {
      const part = Number(url.searchParams.get('part'));
      const parts = { ...(obj.data.parts as Record<string, number>) };
      parts[String(part)] = req.body.byteLength;
      await env.store.put({ ...obj, data: { ...obj.data, parts } });
      return { status: 200, headers: { etag: `/ambry-video/signedId/${id}-${part}.bin` }, body: '' };
    }
    await env.store.put({ ...obj, data: { ...obj.data, uploaded: true } });
    return { status: 201, headers: {}, body: '' };
  }

  if (url.hostname === 'api.linkedin.com' && path === '/v2/userinfo') {
    return json(200, { sub: memberSub(env.accountId), name: 'Simulated LinkedIn member', picture: 'https://media.licdn.invalid/p.jpg' });
  }
  if (path.startsWith('/rest/')) {
    if (!/^\d{6}$/.test(req.headers?.['linkedin-version'] ?? '')) return liErr(400, 'VERSION_MISSING', 'A version must be present. Please specify a version by adding the LinkedIn-Version header.');
    if (req.headers?.['x-restli-protocol-version'] !== '2.0.0') return liErr(400, 'PROTOCOL_VERSION', 'X-Restli-Protocol-Version 2.0.0 required');
  }
  const write = req.method !== 'GET';
  if (env.scenario === 'missing_permission' && write) return liErr(403, 'ACCESS_DENIED', 'Not enough permissions to access: partnerApiPostsExternal.CREATE.20261001');

  if (path === '/rest/organizationAcls' && req.method === 'GET') {
    return json(200, { elements: [{ role: 'ADMINISTRATOR', state: 'APPROVED', organization: 'urn:li:organization:mock_2414183', roleAssignee: `urn:li:person:${memberSub(env.accountId)}` }], paging: { count: 10, start: 0, links: [] } });
  }
  if (path.startsWith('/rest/organizations/') && req.method === 'GET') return json(200, { id: path.split('/').pop(), localizedName: 'Simulated Company Page' });

  if ((path === '/rest/images' || path === '/rest/videos') && req.method === 'POST' && url.searchParams.get('action') === 'initializeUpload') {
    const r = (parseJson(body).initializeUploadRequest ?? {}) as { owner?: string; fileSizeBytes?: number };
    if (!r.owner) return liErr(400, 'MISSING_FIELD', 'owner is required');
    const video = path === '/rest/videos';
    const id = env.newId('mock_C4E');
    const urn = `urn:li:${video ? 'video' : 'image'}:${id}`;
    if (video) {
      const size = Number(r.fileSizeBytes);
      if (!size || size <= 0) return liErr(400, 'MISSING_FIELD', 'fileSizeBytes is required');
      const n = Math.ceil(size / PART);
      await env.store.put({ provider: 'linkedin', accountId: env.accountId, objectId: id, kind: 'media', createdAt: env.now().toISOString(), data: { urn, video: true, size, parts: {}, status: 'WAITING_UPLOAD' } });
      return json(200, { value: { video: urn, uploadToken: '', uploadUrlsExpireAt: env.now().getTime() + 30 * 86_400_000,
        uploadInstructions: Array.from({ length: n }, (_, i) => ({ uploadUrl: `https://www.linkedin.com/dms-uploads/${id}/uploadedVideo?part=${i}`, firstByte: i * PART, lastByte: Math.min(size, (i + 1) * PART) - 1 })) } });
    }
    await env.store.put({ provider: 'linkedin', accountId: env.accountId, objectId: id, kind: 'media', createdAt: env.now().toISOString(), data: { urn, video: false, uploaded: false } });
    return json(200, { value: { image: urn, uploadUrl: `https://www.linkedin.com/dms-uploads/${id}/uploaded-image/0?ut=mock`, uploadUrlExpiresAt: env.now().getTime() + 86_400_000 } });
  }
  if (path === '/rest/videos' && req.method === 'POST' && url.searchParams.get('action') === 'finalizeUpload') {
    const r = (parseJson(body).finalizeUploadRequest ?? {}) as { video?: string; uploadedPartIds?: string[] };
    const id = (r.video ?? '').split(':').pop() ?? '';
    const obj = await env.store.get('linkedin', id);
    if (!obj) return liErr(400, 'INVALID_VIDEO_ID', 'This Video ID is invalid');
    const parts = obj.data.parts as Record<string, number>;
    const n = Math.ceil(Number(obj.data.size) / PART);
    if ((r.uploadedPartIds ?? []).length !== n || Object.keys(parts).length !== n) return liErr(400, 'MEDIA_ASSET_WAITING_UPLOAD', 'Media asset is waiting upload');
    await env.store.put({ ...obj, data: { ...obj.data, status: 'PROCESSING' } });
    return json(200, {});
  }
  const mediaGet = /^\/rest\/(images|videos)\/(.+)$/.exec(path);
  if (mediaGet && req.method === 'GET') {
    const urn = decodeURIComponent(mediaGet[2]!);
    const obj = await env.store.get('linkedin', urn.split(':').pop() ?? '');
    if (!obj) return liErr(404, 'NOT_FOUND', 'Could not find entity');
    const polls = await env.store.incr(`linkedin:media:${urn}`);
    const status = obj.data.video && env.scenario === 'fail_permanent' ? 'PROCESSING_FAILED' : env.scenario === 'processing' && polls <= 2 ? 'PROCESSING' : 'AVAILABLE';
    return json(200, { id: urn, owner: env.accountId, status });
  }

  if (path === '/rest/posts' && req.method === 'POST') {
    const b = parseJson(body) as { author?: string; commentary?: string; visibility?: string; lifecycleState?: string; distribution?: unknown; content?: unknown };
    if (!b.author || b.commentary === undefined || !b.visibility || !b.lifecycleState || !b.distribution) return liErr(400, 'MISSING_FIELD', 'author, commentary, visibility, distribution and lifecycleState are required');
    if (env.scenario === 'fail_permanent') return liErr(422, 'UNPROCESSABLE_ENTITY', 'commentary could not be processed');
    if (env.scenario === 'fail_transient_once' && await once(env, 'post')) throw new TransportError('simulated: connection refused before sending', 'connect', false);
    if (env.scenario === 'rate_limited_once' && await once(env, 'post')) return liErr(429, 'TOO_MANY_REQUESTS', 'Resource level throttle limit reached');
    const existing = await env.store.list('linkedin', env.accountId, 'post');
    if (existing.some((o) => o.data.commentary === b.commentary && JSON.stringify(o.data.content ?? null) === JSON.stringify(b.content ?? null))) return liErr(422, 'DUPLICATE_POST', 'Content is a duplicate of an existing post');
    const id = env.newId('mock_');
    const urn = `urn:li:share:${id}`;
    await env.store.put({ provider: 'linkedin', accountId: env.accountId, objectId: id, kind: 'post', createdAt: env.now().toISOString(), data: { urn, author: b.author, commentary: b.commentary, content: b.content ?? null, createdAt: env.now().getTime() } });
    if (env.scenario === 'timeout_after_send') lostResponse();
    return { status: 201, headers: { 'x-restli-id': urn }, body: '' };
  }
  if (path === '/rest/posts' && req.method === 'GET' && url.searchParams.get('q') === 'author') {
    const posts = await env.store.list('linkedin', env.accountId, 'post');
    return json(200, { elements: posts.map((o) => ({ id: o.data.urn, author: o.data.author, commentary: o.data.commentary, createdAt: o.data.createdAt, lifecycleState: 'PUBLISHED' })), paging: { start: 0, count: 20, links: [] } });
  }
  if (path === '/rest/organizationalEntityShareStatistics') {
    const m = /(shares|ugcPosts)=List\(([^)]+)\)/.exec(url.search);
    const urn = m ? decodeURIComponent(m[2]!) : '';
    return json(200, { elements: [{ organizationalEntity: url.searchParams.get('organizationalEntity'), [m?.[1] === 'shares' ? 'share' : 'ugcPost']: urn,
      totalShareStatistics: { impressionCount: 5287, uniqueImpressionsCount: 3100, clickCount: 78, likeCount: 14, commentCount: 24, shareCount: 5, engagement: 0.0228 } }], paging: { count: 10, start: 0 } });
  }
  if (path === '/rest/memberCreatorPostAnalytics') {
    const q = url.searchParams.get('queryType') ?? '';
    return json(200, { elements: [{ count: { IMPRESSION: 900, MEMBERS_REACHED: 610, REACTION: 31, COMMENT: 4, RESHARE: 2 }[q] ?? 0, metricType: q }], paging: { count: 10, start: 0, links: [] } });
  }
  return liErr(404, 'NOT_FOUND', `No route for ${req.method} ${path}`);
};
