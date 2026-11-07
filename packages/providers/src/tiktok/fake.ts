// In-process simulation of the TikTok Content Posting API endpoints the adapter/connector use.
// Serves ONLY simulated (mock_) destinations via MockTransport and test transports. Honours FakeEnv.scenario:
//  success · processing (status PROCESSING_UPLOAD twice, then complete) · fail_permanent (status FAILED /
//  photo init 400) · fail_transient_once (final send refused pre-connect once) · rate_limited_once (init 429 once)
//  · timeout_after_send (final chunk accepted, response lost) · revoked (401 access_token_invalid, refresh fails)
//  · missing_permission (401 scope_not_authorized).
import { TransportError, type HttpRequest, type HttpResponse } from '@social-lite/core';
import { json, lostResponse, type FakeEnv, type FakeHandler } from '../transport/mock.js';
import { parseJson } from '../shared/http.js';

const UPLOAD_HOST = 'open-upload.tiktokapis.com';
const err = (status: number, code: string, message: string) => json(status, { error: { code, message, log_id: 'mock_log' } });
const ok = (data: unknown) => json(200, { data, error: { code: 'ok', message: '', log_id: 'mock_log' } });
const once = async (env: FakeEnv, key: string) => (await env.store.incr(`tiktok:${env.accountId}:${env.scenario}:${key}`)) === 1;
const bodyText = (req: HttpRequest) => (typeof req.body === 'string' ? req.body : '');

export const tiktokFake: FakeHandler = async (req: HttpRequest, env: FakeEnv): Promise<HttpResponse> => {
  const url = new URL(req.url);
  const path = url.pathname;

  if (req.method === 'POST' && path === '/v2/oauth/token/') {
    const f = new URLSearchParams(bodyText(req));
    if (!f.get('client_key') || !f.get('client_secret')) return json(400, { error: 'invalid_client', error_description: 'client_key / client_secret required', log_id: 'mock' });
    const grant = f.get('grant_type');
    if ((grant === 'refresh_token' && (env.scenario === 'revoked' || !f.get('refresh_token'))) || (grant === 'authorization_code' && !f.get('code'))) {
      return json(400, { error: 'invalid_grant', error_description: 'Refresh token is invalid or expired.', log_id: 'mock' });
    }
    return json(200, {
      access_token: env.newId('mock_act_'), expires_in: 7200, refresh_token: env.newId('mock_rft_'), refresh_expires_in: 15_552_000,
      open_id: env.accountId, scope: 'user.info.basic,video.publish,video.upload,video.list', token_type: 'Bearer',
    });
  }
  if (req.method === 'POST' && path === '/v2/oauth/revoke/') return { status: 200, headers: {}, body: '' };

  if (env.scenario === 'revoked') return err(401, 'access_token_invalid', 'The access token is invalid or not found in the request.');
  if (env.scenario === 'missing_permission' && url.hostname !== UPLOAD_HOST) return err(401, 'scope_not_authorized', 'The user did not authorize the scope required for completing this request.');

  if (req.method === 'GET' && path === '/v2/user/info/') {
    return ok({ user: { open_id: env.accountId, union_id: 'mock_union', avatar_url: 'https://p16.tiktokcdn.invalid/a.jpeg', display_name: 'Simulated TikTok creator' } });
  }
  if (req.method === 'POST' && path === '/v2/post/publish/creator_info/query/') {
    return ok({ creator_avatar_url: 'https://p16.tiktokcdn.invalid/a.jpeg', creator_username: 'social_lite_sim', creator_nickname: 'Simulated TikTok creator',
      privacy_level_options: ['PUBLIC_TO_EVERYONE', 'MUTUAL_FOLLOW_FRIENDS', 'SELF_ONLY'], comment_disabled: false, duet_disabled: false, stitch_disabled: true, max_video_post_duration_sec: 600 });
  }

  const initPath = path === '/v2/post/publish/video/init/' ? 'direct' : path === '/v2/post/publish/inbox/video/init/' ? 'inbox' : null;
  if (req.method === 'POST' && initPath) {
    const b = parseJson(bodyText(req)) as { post_info?: { privacy_level?: string }; source_info?: { source?: string; video_size?: number; chunk_size?: number; total_chunk_count?: number } };
    const si = b.source_info ?? {};
    if (initPath === 'direct' && !b.post_info?.privacy_level) return err(403, 'privacy_level_option_mismatch', 'privacy_level is required');
    if (si.source !== 'FILE_UPLOAD' || !si.video_size || !si.chunk_size || !si.total_chunk_count) return err(400, 'invalid_param', 'source_info is invalid');
    if (si.total_chunk_count !== Math.max(1, Math.floor(si.video_size / si.chunk_size))) return err(400, 'invalid_param', 'total_chunk_count does not match video_size / chunk_size');
    if (env.scenario === 'rate_limited_once' && await once(env, 'init')) return err(429, 'rate_limit_exceeded', 'Rate limit exceeded');
    const id = env.newId('mock_v_pub_file~v2.'); // stored ids must start with mock_
    await env.store.put({ provider: 'tiktok', accountId: env.accountId, objectId: id, kind: 'publish', createdAt: env.now().toISOString(),
      data: { mode: initPath, size: si.video_size, chunkSize: si.chunk_size, total: si.total_chunk_count, received: 0, chunks: 0, state: 'init' } });
    return ok({ publish_id: id, upload_url: `https://${UPLOAD_HOST}/video/?upload_id=${encodeURIComponent(id)}&upload_token=mock` });
  }

  if (req.method === 'PUT' && url.hostname === UPLOAD_HOST) {
    const id = url.searchParams.get('upload_id') ?? '';
    const obj = await env.store.get('tiktok', id);
    if (!obj) return { status: 404, headers: {}, body: '' };
    const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(req.headers?.['content-range'] ?? '');
    const len = req.body instanceof Uint8Array ? req.body.byteLength : -1;
    const d = obj.data as { size: number; chunkSize: number; total: number; received: number; chunks: number; state: string };
    if (!range || Number(range[3]) !== d.size || len !== Number(range[2]) - Number(range[1]) + 1 || Number(req.headers?.['content-length']) !== len) return { status: 400, headers: {}, body: '' };
    if (Number(range[1]) !== d.received) return { status: 416, headers: {}, body: '' };
    const isLast = d.chunks === d.total - 1;
    if (isLast && Number(range[2]) !== d.size - 1) return { status: 400, headers: {}, body: '' };
    if (isLast && env.scenario === 'fail_transient_once' && await once(env, 'final')) throw new TransportError('simulated: connection refused before sending', 'connect', false);
    const next = { ...d, received: Number(range[2]) + 1, chunks: d.chunks + 1, state: isLast ? 'uploaded' : 'uploading' };
    await env.store.put({ ...obj, data: next });
    if (isLast && env.scenario === 'timeout_after_send') lostResponse();
    return { status: isLast ? 201 : 206, headers: {}, body: '' };
  }

  if (req.method === 'POST' && path === '/v2/post/publish/content/init/') {
    const b = parseJson(bodyText(req)) as { post_mode?: string; media_type?: string; post_info?: { privacy_level?: string }; source_info?: { source?: string; photo_images?: string[] } };
    if (b.media_type !== 'PHOTO' || b.source_info?.source !== 'PULL_FROM_URL' || !b.source_info.photo_images?.length) return err(400, 'invalid_param', 'invalid photo request');
    if (b.post_mode === 'DIRECT_POST' && !b.post_info?.privacy_level) return err(403, 'privacy_level_option_mismatch', 'privacy_level is required');
    if (env.scenario === 'fail_permanent') return err(400, 'invalid_param', 'photo_images could not be fetched');
    if (env.scenario === 'rate_limited_once' && await once(env, 'init')) return err(429, 'rate_limit_exceeded', 'Rate limit exceeded');
    if (env.scenario === 'fail_transient_once' && await once(env, 'final')) throw new TransportError('simulated: connection refused before sending', 'connect', false);
    const id = env.newId('mock_p_pub_url~v2.');
    await env.store.put({ provider: 'tiktok', accountId: env.accountId, objectId: id, kind: 'publish', createdAt: env.now().toISOString(),
      data: { mode: b.post_mode === 'DIRECT_POST' ? 'direct' : 'inbox', state: 'uploaded' } });
    if (env.scenario === 'timeout_after_send') lostResponse();
    return ok({ publish_id: id });
  }

  if (req.method === 'POST' && path === '/v2/post/publish/status/fetch/') {
    const id = String((parseJson(bodyText(req)) as { publish_id?: unknown }).publish_id ?? '');
    const obj = await env.store.get('tiktok', id);
    if (!obj) return err(400, 'invalid_publish_id', 'publish_id does not exist');
    const d = obj.data as { mode: string; state: string; size?: number; received?: number; postId?: string };
    if (d.state !== 'uploaded') return ok({ status: 'PROCESSING_UPLOAD', uploaded_bytes: d.received ?? 0 });
    const polls = await env.store.incr(`tiktok:status:${id}`);
    if (env.scenario === 'processing' && polls <= 2) return ok({ status: 'PROCESSING_UPLOAD', uploaded_bytes: d.size ?? 0 });
    if (env.scenario === 'fail_permanent') return ok({ status: 'FAILED', fail_reason: 'file_format_check_failed' });
    if (d.mode === 'inbox') return ok({ status: 'SEND_TO_USER_INBOX' });
    const postId = d.postId ?? String(7_000_000_000_000_000_000n + BigInt(Math.floor(Math.random() * 1e9)));
    if (!d.postId) await env.store.put({ ...obj, data: { ...d, postId } });
    return ok({ status: 'PUBLISH_COMPLETE', publicaly_available_post_id: [postId] });
  }

  if (req.method === 'POST' && path === '/v2/video/query/') {
    const ids = ((parseJson(bodyText(req)) as { filters?: { video_ids?: string[] } }).filters?.video_ids ?? []).map(String);
    return ok({ videos: ids.map((id) => ({ id, view_count: 1200, like_count: 80, comment_count: 7, share_count: 3 })), cursor: 0, has_more: false });
  }

  return err(404, 'not_found', `No route for ${req.method} ${path}`);
};
