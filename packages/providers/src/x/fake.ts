// In-process simulation of the X API v2 endpoints the adapter and connector use. Serves ONLY simulated
// (mock_) destinations via MockTransport, and test transports. Honours FakeEnv.scenario.
import { createHash } from 'node:crypto';
import { TransportError, type HttpRequest, type HttpResponse } from '@social-lite/core';
import { json, lostResponse, type FakeEnv, type FakeHandler } from '../transport/mock.js';

const problem = (status: number, title: string, detail: string, type = 'about:blank', headers: Record<string, string> = {}) =>
  json(status, { title, detail, type, status }, headers);

const FULL_SCOPE = 'tweet.read tweet.write users.read offline.access media.write';
const hash = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16);

async function onceGate(env: FakeEnv, key: string): Promise<boolean> {
  return (await env.store.incr(`${env.provider}:${env.accountId}:${env.scenario}:${key}`)) === 1;
}

function tokens(env: FakeEnv) {
  return { token_type: 'bearer', expires_in: 7200, access_token: env.newId('mock_at_'), refresh_token: env.newId('mock_rt_'), scope: FULL_SCOPE };
}

export const xFake: FakeHandler = async (req: HttpRequest, env: FakeEnv): Promise<HttpResponse> => {
  const url = new URL(req.url);
  const path = url.pathname;

  // ---- OAuth token endpoint
  if (req.method === 'POST' && path === '/2/oauth2/token') {
    const form = new URLSearchParams(typeof req.body === 'string' ? req.body : '');
    const grant = form.get('grant_type');
    if (grant === 'authorization_code') {
      if (!form.get('code') || !form.get('code_verifier')) return json(400, { error: 'invalid_request', error_description: 'Missing required parameter' });
      return json(200, tokens(env));
    }
    if (grant === 'refresh_token') {
      if (env.scenario === 'revoked' || !form.get('refresh_token')) return json(400, { error: 'invalid_request', error_description: 'Value passed for the token was invalid.' });
      return json(200, tokens(env));
    }
    return json(400, { error: 'unsupported_grant_type', error_description: 'unsupported grant' });
  }

  if (env.scenario === 'revoked') return problem(401, 'Unauthorized', 'Unauthorized', 'about:blank');

  // ---- users/me
  if (req.method === 'GET' && path === '/2/users/me') {
    if (env.scenario === 'missing_permission') {
      return json(403, {
        client_id: 'mock', required_enrollment: 'Appropriate Level of API Access', registration_url: 'https://developer.x.com',
        title: 'Client Forbidden', detail: 'This request must be made using an approved developer account that is enrolled in the requested endpoint.',
        reason: 'client-not-enrolled', type: 'https://api.x.com/2/problems/client-forbidden',
      });
    }
    return json(200, { data: { id: env.accountId, name: 'Simulated X account', username: 'social_lite_sim' } });
  }

  // ---- media upload (simple, images)
  if (req.method === 'POST' && path === '/2/media/upload') {
    if (!(typeof FormData !== 'undefined' && req.body instanceof FormData)) return problem(400, 'Invalid Request', 'media is required', 'https://api.x.com/2/problems/invalid-request');
    const media = req.body.get('media');
    const category = req.body.get('media_category');
    if (!media || typeof media === 'string' || category !== 'tweet_image') return problem(400, 'Invalid Request', 'media and media_category are required', 'https://api.x.com/2/problems/invalid-request');
    const id = env.newId('mock_');
    const processing = env.scenario === 'processing';
    await env.store.put({
      provider: 'x', accountId: env.accountId, objectId: id, kind: 'media', createdAt: env.now().toISOString(),
      data: { size: media.size, state: processing ? 'pending' : 'succeeded' },
    });
    return json(200, {
      data: {
        id, media_key: `3_${id}`, size: media.size, expires_after_secs: 86400,
        ...(processing ? { processing_info: { state: 'pending', check_after_secs: 1 } } : {}),
      },
    });
  }

  if (req.method === 'GET' && path === '/2/media/upload' && url.searchParams.get('command') === 'STATUS') {
    const id = url.searchParams.get('media_id') ?? '';
    const obj = await env.store.get('x', id);
    if (!obj) return problem(400, 'Invalid Request', 'media_id not found', 'https://api.x.com/2/problems/invalid-request');
    const polls = await env.store.incr(`x:media-status:${id}`);
    const done = polls >= 2;
    if (done && obj.data.state !== 'succeeded') await env.store.put({ ...obj, data: { ...obj.data, state: 'succeeded' } });
    return json(200, {
      data: { id, media_key: `3_${id}`, expires_after_secs: 86000, processing_info: done ? { state: 'succeeded', progress_percent: 100 } : { state: 'in_progress', check_after_secs: 1, progress_percent: 50 } },
    });
  }

  // ---- create post
  if (req.method === 'POST' && path === '/2/tweets') {
    const body = JSON.parse(typeof req.body === 'string' ? req.body : '{}') as { text?: string; media?: { media_ids?: string[] } };
    const text = body.text ?? '';
    const mediaIds = body.media?.media_ids ?? [];
    for (const m of mediaIds) {
      const obj = await env.store.get('x', m);
      if (!obj || obj.kind !== 'media') return problem(400, 'Invalid Request', 'One or more parameters to your request was invalid: media_ids', 'https://api.x.com/2/problems/invalid-request');
      if (obj.data.state !== 'succeeded') return problem(400, 'Invalid Request', 'Your media IDs are invalid: media still processing', 'https://api.x.com/2/problems/invalid-request');
    }
    if (!text && !mediaIds.length) return problem(400, 'Invalid Request', 'text or media is required', 'https://api.x.com/2/problems/invalid-request');
    const key = hash(`${text}|${mediaIds.join(',')}`);
    switch (env.scenario) {
      case 'missing_permission':
        return problem(403, 'Forbidden', 'You are not permitted to perform this action.');
      case 'fail_permanent':
        return problem(400, 'Invalid Request', 'One or more parameters to your request was invalid: text is too long', 'https://api.x.com/2/problems/invalid-request');
      case 'fail_transient_once':
        if (await onceGate(env, key)) throw new TransportError('simulated: connection refused before sending', 'connect', false);
        break;
      case 'rate_limited_once':
        if (await onceGate(env, key)) {
          const reset = Math.floor(env.now().getTime() / 1000) + 5;
          return problem(429, 'Too Many Requests', 'Too Many Requests', 'about:blank', { 'x-rate-limit-limit': '100', 'x-rate-limit-remaining': '0', 'x-rate-limit-reset': String(reset) });
        }
        break;
      default:
        break;
    }
    const existing = await env.store.list('x', env.accountId, 'post');
    if (existing.some((o) => o.data.text === text && JSON.stringify(o.data.media_ids ?? []) === JSON.stringify(mediaIds))) {
      return problem(403, 'Forbidden', 'You are not allowed to create a Tweet with duplicate content.');
    }
    const id = env.newId('mock_');
    const createdAt = env.now().toISOString();
    await env.store.put({ provider: 'x', accountId: env.accountId, objectId: id, kind: 'post', createdAt, data: { text, media_ids: mediaIds, created_at: createdAt } });
    if (env.scenario === 'timeout_after_send') lostResponse();
    return json(201, { data: { id, text, edit_history_post_ids: [id] } });
  }

  // ---- user timeline (reconciliation)
  const tl = path.match(/^\/2\/users\/([^/]+)\/tweets$/);
  if (req.method === 'GET' && tl) {
    const userId = decodeURIComponent(tl[1]!);
    const start = url.searchParams.get('start_time');
    const startMs = start ? Date.parse(start) : 0;
    const posts = (await env.store.list('x', userId, 'post'))
      .filter((o) => Date.parse(o.createdAt) >= startMs)
      .slice(0, Number(url.searchParams.get('max_results') ?? 10));
    if (!posts.length) return json(200, { meta: { result_count: 0 } });
    return json(200, {
      data: posts.map((o) => ({ id: o.objectId, text: String(o.data.text ?? ''), created_at: o.createdAt, edit_history_post_ids: [o.objectId] })),
      meta: { result_count: posts.length, newest_id: posts[0]!.objectId, oldest_id: posts[posts.length - 1]!.objectId },
    });
  }

  return problem(404, 'Not Found Error', `No route for ${req.method} ${path}`, 'https://api.x.com/2/problems/resource-not-found');
};
