// Simulated Threads reply endpoints for SIMULATED (mock_) accounts — V3.5 stream B. Reached through the inbox mock
// transport before the publishing fake (requests it does not recognise fall through).
import type { HttpRequest, HttpResponse } from '@social-lite/core';
import { json, lostResponse, type FakeEnv } from '../transport/mock.js';

const P = 'threads' as const;
const tErr = (status: number, code: number, message: string) => json(status, { error: { message, type: 'THApiException', code, fbtrace_id: 'mock' } });
const once = async (env: FakeEnv, k: string) => (await env.store.incr(`th-inbox:${env.accountId}:${k}:${env.scenario}`)) === 1;

export async function threadsInboxFake(req: HttpRequest, env: FakeEnv): Promise<HttpResponse | null> {
  const u = new URL(req.url);
  const m = /^\/v1\.0\/(.+)$/.exec(u.pathname);
  if (!m || !['graph.threads.com', 'graph.threads.net'].includes(u.hostname)) return null;
  const params = new URLSearchParams(u.search);
  if (req.method === 'POST' && typeof req.body === 'string') for (const [k, v] of new URLSearchParams(req.body)) params.set(k, v);
  if (env.scenario === 'revoked') return tErr(401, 190, 'Error validating access token');
  const [a, b] = m[1]!.split('/');
  const replies = () => env.store.list(P, env.accountId, 'th_reply');

  if (a === 'me' && b === 'threads' && req.method === 'GET' && params.get('fields') === 'id,timestamp') {
    const posts = await env.store.list(P, env.accountId, 'th_root');
    return json(200, { data: posts.slice(0, Number(params.get('limit') ?? 10)).map((o) => ({ id: o.objectId, timestamp: o.createdAt })) });
  }
  if (a?.startsWith('mock_') && b === 'conversation' && req.method === 'GET') {
    const all = await replies();
    const under = (id: string): typeof all => all.filter((r) => r.data.replied_to === id).flatMap((r) => [r, ...under(r.objectId)]);
    return json(200, { data: under(a).map((r) => ({ id: r.objectId, text: r.data.text, username: r.data.username, timestamp: r.data.at, replied_to: { id: r.data.replied_to }, root_post: { id: r.data.root }, is_reply_owned_by_me: r.data.mine === true, hide_status: r.data.hidden ? 'HIDDEN' : 'NOT_HUSHED' })) });
  }
  if (a === 'me' && b === 'threads' && req.method === 'POST' && params.get('reply_to_id')) {
    const parent = await env.store.get(P, params.get('reply_to_id')!);
    if (!parent || parent.accountId !== env.accountId) return tErr(400, 100, 'reply_to_id does not exist');
    if (env.scenario === 'missing_permission') return tErr(403, 10, 'Application does not have permission threads_manage_replies');
    if (env.scenario === 'fail_permanent') return tErr(400, 100, 'Invalid parameter');
    const id = env.newId('mock_thc_');
    await env.store.put({ provider: P, accountId: env.accountId, objectId: id, kind: 'th_reply_container', createdAt: env.now().toISOString(), data: { text: params.get('text'), reply_to: parent.objectId, root: parent.kind === 'th_root' ? parent.objectId : parent.data.root } });
    return json(200, { id });
  }
  if (a === 'me' && b === 'threads_publish' && req.method === 'POST') {
    const c = await env.store.get(P, params.get('creation_id') ?? '');
    if (!c || c.kind !== 'th_reply_container') return null;
    if (env.scenario === 'rate_limited_once' && await once(env, 'rate')) return tErr(429, 4, 'Application request limit reached');
    if (env.scenario === 'fail_transient_once' && await once(env, 'transient')) return tErr(500, 2, 'Service temporarily unavailable');
    if (c.data.published) return json(200, { id: c.data.published });
    const id = env.newId('mock_thr_');
    await env.store.put({ provider: P, accountId: env.accountId, objectId: id, kind: 'th_reply', createdAt: env.now().toISOString(), data: { text: c.data.text, username: 'simulated.account', at: env.now().toISOString(), replied_to: c.data.reply_to, root: c.data.root, mine: true } });
    await env.store.put({ ...c, data: { ...c.data, published: id } });
    if (env.scenario === 'timeout_after_send' && await once(env, 'timeout')) lostResponse();
    return json(200, { id });
  }
  if (a?.startsWith('mock_') && b === 'manage_reply' && req.method === 'POST') {
    const r = await env.store.get(P, a);
    if (!r || r.kind !== 'th_reply') return tErr(400, 100, 'Object does not exist');
    if (env.scenario === 'missing_permission') return tErr(403, 10, 'Application does not have permission threads_manage_replies');
    await env.store.put({ ...r, data: { ...r.data, hidden: params.get('hide') === 'true' } });
    return json(200, { success: true });
  }
  return null;
}

/** Simulated root post (once) + a reply from another user under it, or under `parentId`. */
export async function recordSimulatedThreadsReply(env: Pick<FakeEnv, 'store'>, account: string, r: { id: string; parentId: string | null; username: string; text: string; at: string }): Promise<{ root: string }> {
  if (!account.startsWith('mock_')) throw new Error('simulated replies are only for mock_ accounts');
  const root = `mock_throot_${account.slice(5, 30)}`;
  if (!(await env.store.get(P, root))) await env.store.put({ provider: P, accountId: account, objectId: root, kind: 'th_root', createdAt: new Date(Date.now() - 3600_000).toISOString(), data: { text: 'Simulated post' } });
  await env.store.put({ provider: P, accountId: account, objectId: r.id, kind: 'th_reply', createdAt: r.at, data: { text: r.text, username: r.username, at: r.at, replied_to: r.parentId ?? root, root, mine: false } });
  return { root };
}
