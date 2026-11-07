// In-process simulation of the Google OAuth / YouTube Data API v3 / YouTube Analytics endpoints the adapter uses.
// Serves ONLY simulated (mock_) destinations and tests. Scenarios: success · processing (2 polls 'uploaded') ·
// fail_permanent (uploadStatus failed: codec) · fail_transient_once (final chunk refused pre-connect once) ·
// rate_limited_once (init 403 rateLimitExceeded once) · timeout_after_send (final chunk stored, response lost) ·
// revoked (401 authError; refresh invalid_grant) · missing_permission (403 insufficientPermissions).
import { TransportError, type HttpRequest, type HttpResponse } from '@social-lite/core';
import { json, lostResponse, type FakeEnv, type FakeHandler } from '../transport/mock.js';
import { parseJson } from '../shared/http.js';

const gErr = (status: number, reason: string, message: string) => json(status, { error: { code: status, message, errors: [{ reason, domain: 'youtube', message }] } });
const once = async (env: FakeEnv, key: string) => (await env.store.incr(`youtube:${env.accountId}:${env.scenario}:${key}`)) === 1;
const FULL = 'https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly https://www.googleapis.com/auth/yt-analytics.readonly https://www.googleapis.com/auth/youtube.force-ssl';

interface Upload { total: number; received: number; resource: { snippet?: Record<string, unknown>; status?: Record<string, unknown> }; videoId?: string }

export const youtubeFake: FakeHandler = async (req: HttpRequest, env: FakeEnv): Promise<HttpResponse> => {
  const url = new URL(req.url);
  const path = url.pathname;
  const body = typeof req.body === 'string' ? req.body : '';

  if (url.hostname === 'oauth2.googleapis.com') {
    if (path === '/revoke') return json(200, {});
    const f = new URLSearchParams(body);
    if (!f.get('client_id')) return json(400, { error: 'invalid_request', error_description: 'Missing client_id' });
    if (f.get('grant_type') === 'refresh_token' && (env.scenario === 'revoked' || !f.get('refresh_token'))) return json(400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' });
    return json(200, { access_token: env.newId('mock_ya29_'), expires_in: 3599, ...(f.get('grant_type') === 'authorization_code' ? { refresh_token: env.newId('mock_1//') } : {}), scope: FULL, token_type: 'Bearer' });
  }
  if (env.scenario === 'revoked') return gErr(401, 'authError', 'Invalid Credentials');
  if (env.scenario === 'missing_permission' && req.method !== 'GET') return gErr(403, 'insufficientPermissions', 'Request had insufficient authentication scopes.');

  if (req.method === 'GET' && path === '/youtube/v3/channels') {
    return json(200, { items: [{ id: env.accountId, snippet: { title: 'Simulated YouTube channel', customUrl: '@social_lite_sim', thumbnails: { default: { url: 'https://yt3.ggpht.invalid/c.jpg' } } }, status: { privacyStatus: 'public', longUploadsStatus: 'eligible' } }] });
  }

  if (path === '/upload/youtube/v3/videos' && req.method === 'POST' && url.searchParams.get('uploadType') === 'resumable') {
    const total = Number(req.headers?.['x-upload-content-length']);
    const resource = parseJson(body) as Upload['resource'];
    if (!Number.isFinite(total) || total <= 0 || !req.headers?.['x-upload-content-type']) return gErr(400, 'badRequest', 'X-Upload-Content-Length and X-Upload-Content-Type are required');
    if (!resource.snippet?.title) return gErr(400, 'invalidTitle', 'The request metadata specifies an invalid or empty video title.');
    if (!resource.status?.privacyStatus) return gErr(400, 'invalidVideoMetadata', 'privacyStatus missing (Social Lite always sends it)');
    if (resource.status.publishAt && resource.status.privacyStatus !== 'private') return gErr(400, 'invalidPublishAt', 'publishAt requires privacyStatus private');
    if (env.scenario === 'rate_limited_once' && await once(env, 'init')) return gErr(403, 'rateLimitExceeded', 'Rate limit exceeded');
    const id = env.newId('mock_up_');
    await env.store.put({ provider: 'youtube', accountId: env.accountId, objectId: id, kind: 'upload', createdAt: env.now().toISOString(), data: { total, received: 0, resource } as unknown as Record<string, unknown> });
    return { status: 200, headers: { location: `https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&upload_id=${id}` }, body: '' };
  }

  if (path === '/upload/youtube/v3/videos' && req.method === 'PUT') {
    const uid = url.searchParams.get('upload_id') ?? '';
    const obj = await env.store.get('youtube', uid);
    if (!obj) return gErr(404, 'notFound', 'Upload session not found');
    const u = obj.data as unknown as Upload;
    const range = req.headers?.['content-range'] ?? '';
    const done = async () => ({ status: 201, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: u.videoId, snippet: u.resource.snippet, status: (await env.store.get('youtube', u.videoId!))?.data.status }) });
    if (/^bytes \*\/\d+$/.test(range)) { // status query
      if (u.videoId) return done();
      return { status: 308, headers: u.received ? { range: `bytes=0-${u.received - 1}` } : {}, body: '' };
    }
    const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(range);
    const len = req.body instanceof Uint8Array ? req.body.byteLength : -1;
    if (!m || Number(m[3]) !== u.total || len !== Number(m[2]) - Number(m[1]) + 1) return gErr(400, 'badRequest', 'Bad Content-Range');
    if (Number(m[1]) !== u.received) return { status: 308, headers: u.received ? { range: `bytes=0-${u.received - 1}` } : {}, body: '' };
    const last = Number(m[2]) === u.total - 1;
    if (!last && len % (256 * 1024) !== 0) return gErr(400, 'badRequest', 'Chunk size must be a multiple of 256 KiB');
    if (last && env.scenario === 'fail_transient_once' && await once(env, 'final')) throw new TransportError('simulated: connection refused before sending', 'connect', false);
    const received = Number(m[2]) + 1;
    if (!last) {
      await env.store.put({ ...obj, data: { ...u, received } as unknown as Record<string, unknown> });
      return { status: 308, headers: { range: `bytes=0-${received - 1}` }, body: '' };
    }
    const videoId = env.newId('mock_v');
    await env.store.put({ provider: 'youtube', accountId: env.accountId, objectId: videoId, kind: 'video', createdAt: env.now().toISOString(),
      data: { status: { uploadStatus: 'uploaded', ...u.resource.status }, snippet: u.resource.snippet } });
    await env.store.put({ ...obj, data: { ...u, received, videoId } as unknown as Record<string, unknown> });
    u.videoId = videoId;
    if (env.scenario === 'timeout_after_send') lostResponse();
    return done();
  }

  if (path === '/youtube/v3/videos' && req.method === 'GET') {
    const id = url.searchParams.get('id') ?? '';
    const obj = await env.store.get('youtube', id);
    if (!obj || obj.kind !== 'video') return json(200, { items: [] });
    const polls = await env.store.incr(`youtube:videos:${id}`);
    const st = { ...(obj.data.status as Record<string, unknown>) };
    let processing = 'succeeded';
    if (env.scenario === 'fail_permanent') { st.uploadStatus = 'failed'; st.failureReason = 'codec'; processing = 'failed'; }
    else if (env.scenario === 'processing' && polls <= 2) processing = 'processing';
    else st.uploadStatus = 'processed';
    return json(200, { items: [{ id, status: st, processingDetails: { processingStatus: processing } }] });
  }

  if (path === '/youtube/v3/videos' && req.method === 'PUT' && url.searchParams.get('part') === 'status') {
    const b = parseJson(body) as { id?: string; status?: Record<string, unknown> };
    const obj = b.id ? await env.store.get('youtube', b.id) : null;
    if (!obj) return gErr(404, 'videoNotFound', 'Video not found');
    if (!b.status?.privacyStatus) return gErr(400, 'invalidVideoMetadata', 'privacyStatus required');
    // videos.update replaces the status part: omitted properties (publishAt) are removed.
    await env.store.put({ ...obj, data: { ...obj.data, status: { uploadStatus: (obj.data.status as Record<string, unknown>).uploadStatus, ...b.status } } });
    return json(200, { id: b.id, status: b.status });
  }

  if (path === '/upload/youtube/v3/thumbnails/set' && req.method === 'POST') {
    return url.searchParams.get('videoId') ? json(200, { items: [{ default: { url: 'https://i.ytimg.invalid/t.jpg' } }] }) : gErr(400, 'mediaBodyRequired', 'videoId required');
  }

  if (url.hostname === 'youtubeanalytics.googleapis.com' && path === '/v2/reports') {
    const metrics = (url.searchParams.get('metrics') ?? '').split(',').filter(Boolean);
    return json(200, { kind: 'youtubeAnalytics#resultTable', columnHeaders: metrics.map((name) => ({ name, columnType: 'METRIC', dataType: 'INTEGER' })), rows: [metrics.map((_, i) => 100 - i * 10)] });
  }

  return gErr(404, 'notFound', `No route for ${req.method} ${path}`);
};
