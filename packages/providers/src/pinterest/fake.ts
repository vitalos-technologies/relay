// In-process simulation of the Pinterest API v5 endpoints the adapter/connector use (incl. the S3 media
// upload form POST). Serves ONLY simulated (mock_) destinations and tests. Scenarios: success · processing (media
// 'processing' for 2 polls) · fail_permanent (Pin 400 / media failed) · fail_transient_once · rate_limited_once
// (Pin 429) · timeout_after_send (Pin stored, response lost) · revoked (401) · missing_permission (403 on writes).
import { TransportError, type HttpRequest, type HttpResponse } from '@social-lite/core';
import { json, lostResponse, type FakeEnv, type FakeHandler } from '../transport/mock.js';
import { parseJson } from '../shared/http.js';

const S3 = 'pinterest-media-upload.s3-accelerate.amazonaws.com';
const pErr = (status: number, code: number, message: string) => json(status, { code, message });
const once = async (env: FakeEnv, key: string) => (await env.store.incr(`pinterest:${env.accountId}:${env.scenario}:${key}`)) === 1;

export const pinterestFake: FakeHandler = async (req: HttpRequest, env: FakeEnv): Promise<HttpResponse> => {
  const url = new URL(req.url);
  const path = url.pathname;
  const body = typeof req.body === 'string' ? req.body : '';

  if (path === '/v5/oauth/token' && req.method === 'POST') {
    if (!/^Basic /.test(req.headers?.authorization ?? '')) return pErr(401, 2, 'Authentication failed.');
    const f = new URLSearchParams(body);
    if (f.get('grant_type') === 'refresh_token' && env.scenario === 'revoked') return json(400, { error: 'invalid_grant', error_description: 'Refresh token expired or revoked' });
    return json(200, { access_token: env.newId('mock_pina_'), refresh_token: env.newId('mock_pinr_'), token_type: 'bearer', expires_in: 2_592_000,
      refresh_token_expires_in: 5_184_000, refresh_token_expires_at: Math.floor(env.now().getTime() / 1000) + 5_184_000, scope: 'boards:read,pins:read,pins:write,user_accounts:read' });
  }

  if (url.hostname === S3 && req.method === 'POST') {
    if (!(req.body instanceof FormData)) return { status: 400, headers: {}, body: '' };
    const key = String(req.body.get('key') ?? '');
    const file = req.body.get('file');
    if (!key || !file || typeof file === 'string') return { status: 400, headers: {}, body: '' };
    const id = key.split(':').pop() ?? '';
    const obj = await env.store.get('pinterest', id);
    if (!obj) return { status: 403, headers: {}, body: '' };
    await env.store.put({ ...obj, data: { ...obj.data, uploaded: true, size: file.size } });
    return { status: 204, headers: {}, body: '' };
  }

  if (env.scenario === 'revoked') return pErr(401, 2, 'Authentication failed.');
  if (env.scenario === 'missing_permission' && req.method === 'POST') return pErr(403, 29, 'You are not permitted to access that resource.');

  if (path === '/v5/user_account' && req.method === 'GET') return json(200, { id: 'mock_user_1', username: 'social_lite_sim', account_type: 'BUSINESS', profile_image: 'https://i.pinimg.invalid/p.jpg', business_name: 'Simulated Pinterest' });
  if (path === '/v5/boards' && req.method === 'GET') {
    return json(200, { items: [{ id: env.accountId, name: 'Simulated board', privacy: 'PUBLIC' }, { id: `${env.accountId}_secret`, name: 'Secret ideas', privacy: 'SECRET' }], bookmark: null });
  }
  const boardGet = /^\/v5\/boards\/([^/]+)$/.exec(path);
  if (boardGet && req.method === 'GET') return decodeURIComponent(boardGet[1]!) === env.accountId ? json(200, { id: env.accountId, name: 'Simulated board', privacy: 'PUBLIC' }) : pErr(404, 40, 'Board not found.');

  if (path === '/v5/media' && req.method === 'POST') {
    if ((parseJson(body) as { media_type?: string }).media_type !== 'video') return pErr(400, 1, 'media_type must be video');
    const id = env.newId('mock_');
    await env.store.put({ provider: 'pinterest', accountId: env.accountId, objectId: id, kind: 'media', createdAt: env.now().toISOString(), data: { uploaded: false } });
    return json(201, { media_id: id, media_type: 'video', upload_url: `https://${S3}/`,
      upload_parameters: { 'x-amz-date': '20261107T120000Z', 'x-amz-signature': 'mock', 'x-amz-security-token': 'mock', 'x-amz-algorithm': 'AWS4-HMAC-SHA256', key: `uploads/mock/video:${id}`, policy: 'mock', 'x-amz-credential': 'mock', 'Content-Type': 'multipart/form-data' } });
  }
  const mediaGet = /^\/v5\/media\/([^/]+)$/.exec(path);
  if (mediaGet && req.method === 'GET') {
    const id = decodeURIComponent(mediaGet[1]!);
    const obj = await env.store.get('pinterest', id);
    if (!obj) return pErr(404, 4, 'Media not found');
    if (!obj.data.uploaded) return json(200, { media_id: id, media_type: 'video', status: 'registered' });
    const polls = await env.store.incr(`pinterest:media:${id}`);
    const status = env.scenario === 'fail_permanent' ? 'failed' : env.scenario === 'processing' && polls <= 2 ? 'processing' : 'succeeded';
    return json(200, { media_id: id, media_type: 'video', status });
  }

  if (path === '/v5/pins' && req.method === 'POST') {
    const b = parseJson(body) as { board_id?: string; description?: string; link?: string; title?: string; media_source?: { source_type?: string; media_id?: string; url?: string; items?: unknown[] } };
    if (!b.board_id || !b.media_source?.source_type) return pErr(400, 1, 'board_id and media_source are required');
    if (b.board_id !== env.accountId) return pErr(404, 40, 'Board not found.');
    if (b.media_source.source_type === 'video_id') {
      const m = await env.store.get('pinterest', b.media_source.media_id ?? '');
      if (!m?.data.uploaded) return pErr(400, 1, 'media_id is not ready');
    }
    if (env.scenario === 'fail_permanent') return pErr(400, 1, 'Invalid Pin media');
    if (env.scenario === 'fail_transient_once' && await once(env, 'pin')) throw new TransportError('simulated: connection refused before sending', 'connect', false);
    if (env.scenario === 'rate_limited_once' && await once(env, 'pin')) return pErr(429, 8, 'You have exceeded your rate limit. Try again later.');
    const id = env.newId('mock_');
    await env.store.put({ provider: 'pinterest', accountId: env.accountId, objectId: id, kind: 'pin', createdAt: env.now().toISOString(), data: { description: b.description ?? null, link: b.link ?? null, title: b.title ?? null } });
    if (env.scenario === 'timeout_after_send') lostResponse();
    return json(201, { id, board_id: b.board_id, description: b.description ?? null, link: b.link ?? null, created_at: env.now().toISOString() });
  }
  const boardPins = /^\/v5\/boards\/([^/]+)\/pins$/.exec(path);
  if (boardPins && req.method === 'GET') {
    const pins = await env.store.list('pinterest', env.accountId, 'pin');
    return json(200, { items: pins.map((o) => ({ id: o.objectId, description: o.data.description, link: o.data.link, created_at: o.createdAt })), bookmark: null });
  }
  const analytics = /^\/v5\/pins\/([^/]+)\/analytics$/.exec(path);
  if (analytics && req.method === 'GET') {
    const types = (url.searchParams.get('metric_types') ?? '').split(',').filter(Boolean);
    return json(200, { ALL: { summary_metrics: Object.fromEntries(types.map((t, i) => [t, 240 - i * 30])), daily_metrics: [], lifetime_metrics: {} } });
  }
  return pErr(404, 4, `No route for ${req.method} ${path}`);
};
