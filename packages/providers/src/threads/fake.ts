// In-process simulation of the Threads API endpoints the adapter/connector use. Serves ONLY simulated (mock_)
// destinations and tests. Scenarios: success · processing (containers IN_PROGRESS for 2 polls) · fail_permanent
// (container ERROR: FAILED_PROCESSING_VIDEO / publish 400) · fail_transient_once (publish refused pre-connect once) ·
// rate_limited_once (publish code 4 once) · timeout_after_send (published, response lost) · revoked (190) ·
// missing_permission (code 10 on writes).
import { TransportError, type HttpRequest, type HttpResponse } from '@social-lite/core';
import { json, lostResponse, type FakeEnv, type FakeHandler } from '../transport/mock.js';

const gErr = (status: number, code: number, message: string, type = 'OAuthException') => json(status, { error: { message, type, code, fbtrace_id: 'mock' } });
const once = async (env: FakeEnv, key: string) => (await env.store.incr(`threads:${env.accountId}:${env.scenario}:${key}`)) === 1;

export const threadsFake: FakeHandler = async (req: HttpRequest, env: FakeEnv): Promise<HttpResponse> => {
  const url = new URL(req.url);
  const path = url.pathname;
  const p = req.method === 'GET' ? url.searchParams : new URLSearchParams(typeof req.body === 'string' ? req.body : '');

  if (path === '/oauth/access_token' && req.method === 'POST') {
    if (!p.get('client_id') || !p.get('client_secret') || !p.get('code')) return gErr(400, 100, 'Missing parameter');
    return json(200, { access_token: env.newId('mock_THs'), user_id: env.accountId });
  }
  if (path === '/access_token' || path === '/refresh_access_token') {
    if (env.scenario === 'revoked') return gErr(400, 190, 'Error validating access token: The session has been invalidated');
    if (!p.get('access_token') || (path === '/access_token' && (p.get('grant_type') !== 'th_exchange_token' || !p.get('client_secret'))) || (path === '/refresh_access_token' && p.get('grant_type') !== 'th_refresh_token')) return gErr(400, 100, 'Invalid parameter');
    return json(200, { access_token: env.newId('mock_THL'), token_type: 'bearer', expires_in: 5_183_944 });
  }
  if (!p.get('access_token')) return gErr(400, 190, 'An active access token must be used');
  if (env.scenario === 'revoked') return gErr(400, 190, 'Error validating access token: The user has not authorized application.');
  if (env.scenario === 'missing_permission' && req.method === 'POST') return gErr(403, 10, 'Application does not have permission for this action');

  const m = /^\/v1\.0\/([^/]+)(?:\/(threads|threads_publish|insights))?$/.exec(path);
  if (!m) return gErr(404, 100, `Unsupported request ${req.method} ${path}`, 'GraphMethodException');
  const [, node, edge] = m;

  if (req.method === 'GET' && node === 'me' && !edge) return json(200, { id: env.accountId, username: 'social_lite_sim', name: 'Simulated Threads profile', threads_profile_picture_url: 'https://scontent.invalid/p.jpg' });

  if (req.method === 'POST' && edge === 'threads') {
    const type = p.get('media_type');
    if (!['TEXT', 'IMAGE', 'VIDEO', 'CAROUSEL'].includes(type ?? '')) return gErr(400, 100, 'Invalid media_type');
    if (type === 'TEXT' && !p.get('text')) return gErr(400, 100, 'text is required for TEXT posts');
    if (type === 'IMAGE' && !p.get('image_url')) return gErr(400, 100, 'image_url is required');
    if (type === 'VIDEO' && !p.get('video_url')) return gErr(400, 100, 'video_url is required');
    if (p.get('link_attachment') && type !== 'TEXT') return gErr(400, 100, 'link_attachment is only supported for text posts');
    let children: string[] = [];
    if (type === 'CAROUSEL') {
      children = (p.get('children') ?? '').split(',').filter(Boolean);
      if (children.length < 2 || children.length > 20) return gErr(400, 100, 'A carousel needs 2 to 20 children');
      for (const c of children) {
        const o = await env.store.get('threads', c);
        if (!o || !o.data.carouselItem || o.data.status !== 'FINISHED') return gErr(400, 100, 'Carousel children must be finished carousel items');
      }
    }
    const id = env.newId('mock_');
    await env.store.put({ provider: 'threads', accountId: env.accountId, objectId: id, kind: 'container', createdAt: env.now().toISOString(),
      data: { type, text: p.get('text') ?? '', carouselItem: p.get('is_carousel_item') === 'true', children, status: 'IN_PROGRESS', video: type === 'VIDEO' } });
    return json(200, { id });
  }

  if (req.method === 'POST' && edge === 'threads_publish') {
    const cid = p.get('creation_id') ?? '';
    const o = await env.store.get('threads', cid);
    if (!o || o.kind !== 'container' || o.data.carouselItem) return gErr(400, 100, 'Invalid creation_id');
    if (o.data.status === 'PUBLISHED') return gErr(400, 100, 'This container has already been published');
    if (o.data.status !== 'FINISHED') return gErr(400, 9007, 'Media is not ready for publishing, please wait for a moment');
    if (env.scenario === 'fail_permanent') return gErr(400, 100, 'The post could not be published');
    if (env.scenario === 'fail_transient_once' && await once(env, 'publish')) throw new TransportError('simulated: connection refused before sending', 'connect', false);
    if (env.scenario === 'rate_limited_once' && await once(env, 'publish')) return gErr(400, 4, 'Application request limit reached');
    const mediaId = env.newId('mock_');
    await env.store.put({ ...o, data: { ...o.data, status: 'PUBLISHED', mediaId } });
    await env.store.put({ provider: 'threads', accountId: env.accountId, objectId: mediaId, kind: 'post', createdAt: env.now().toISOString(), data: { text: o.data.text, container: cid } });
    if (env.scenario === 'timeout_after_send') lostResponse();
    return json(200, { id: mediaId });
  }

  if (req.method === 'GET' && edge === 'threads') {
    const since = Number(url.searchParams.get('since') ?? 0) * 1000;
    const posts = (await env.store.list('threads', node === 'me' ? env.accountId : node!, 'post')).filter((o) => Date.parse(o.createdAt) >= since);
    return json(200, { data: posts.map((o) => ({ id: o.objectId, text: o.data.text, timestamp: o.createdAt, permalink: `https://www.threads.com/@social_lite_sim/post/${o.objectId}` })) });
  }

  if (req.method === 'GET' && edge === 'insights') {
    const metrics = (url.searchParams.get('metric') ?? '').split(',').filter(Boolean);
    return json(200, { data: metrics.map((name, i) => ({ name, period: 'lifetime', values: [{ value: 50 - i * 5 }], title: name, id: `${node}/insights/${name}/lifetime` })) });
  }

  if (req.method === 'GET' && !edge) {
    const o = await env.store.get('threads', node!);
    if (!o) return gErr(400, 100, 'Object does not exist', 'GraphMethodException');
    if (url.searchParams.get('fields')?.includes('permalink')) return json(200, { id: node, permalink: `https://www.threads.com/@social_lite_sim/post/${node}` });
    if (o.data.status === 'IN_PROGRESS') {
      const polls = await env.store.incr(`threads:status:${node}`);
      const failed = env.scenario === 'fail_permanent' && o.data.video;
      const done = env.scenario === 'processing' ? polls >= 3 : true;
      const status = failed ? 'ERROR' : done ? 'FINISHED' : 'IN_PROGRESS';
      if (status !== 'IN_PROGRESS') await env.store.put({ ...o, data: { ...o.data, status } });
      return json(200, { id: node, status, ...(failed ? { error_message: 'FAILED_PROCESSING_VIDEO' } : {}) });
    }
    return json(200, { id: node, status: o.data.status });
  }
  return gErr(404, 100, `Unsupported request ${req.method} ${path}`, 'GraphMethodException');
};
