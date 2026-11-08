// Simulated Messenger + Page comment endpoints for mock_ Facebook Pages (V3.5 inbox). Serves ONLY mock_ destinations via
// MockTransport (routed from fake.ts). Objects live in the durable mock store so reconciliation after a lost response is
// truthful. Simulation choices (not provider facts): window errors use code 10 / subcode 2018278 like Graph; a second
// private reply to the same comment answers code 10 / subcode 2018108.
import type { HttpResponse } from '@social-lite/core';
import { json, lostResponse, type FakeEnv, type MockObject } from '../transport/mock.js';

const DAY = 86_400_000;

function gerr(status: number, code: number, message: string, subcode?: number, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}): HttpResponse {
  return json(status, { error: { message, type: 'OAuthException', code, ...(subcode !== undefined ? { error_subcode: subcode } : {}), ...extra, fbtrace_id: 'mock_trace' } }, headers);
}

function fbTime(d: Date): string { return d.toISOString().replace(/\.\d{3}Z$/, '+0000'); }

async function onceFor(env: FakeEnv, key: string): Promise<boolean> {
  return (await env.store.incr(`meta-inbox:${env.accountId}:${key}:${env.scenario}`)) === 1;
}

/** Scenario gate for sends (same scenario names as publishing). */
async function gate(env: FakeEnv): Promise<HttpResponse | 'lose' | null> {
  switch (env.scenario) {
    case 'fail_permanent': return gerr(400, 100, '(#100) Invalid parameter');
    case 'missing_permission': return gerr(403, 10, '(#10) This endpoint requires the pages_messaging permission.');
    case 'fail_transient_once': return (await onceFor(env, 'transient')) ? gerr(500, 2, 'Service temporarily unavailable', undefined, { is_transient: true }) : null;
    case 'rate_limited_once': return (await onceFor(env, 'rate')) ? gerr(400, 80001, 'There have been too many calls to this Page account.', undefined, {}, { 'x-business-use-case-usage': JSON.stringify({ [env.accountId]: [{ type: 'pages', call_count: 100, estimated_time_to_regain_access: 1 }] }) }) : null;
    case 'timeout_after_send': return (await onceFor(env, 'timeout')) ? 'lose' : null;
    default: return null;
  }
}

async function put(env: FakeEnv, objectId: string, kind: string, data: Record<string, unknown>): Promise<MockObject> {
  const o: MockObject = { provider: env.provider, accountId: env.accountId, objectId, kind, data, createdAt: env.now().toISOString() };
  await env.store.put(o);
  return o;
}

/** Messenger/comment routes; returns null when the request is not an inbox route. */
export async function metaInboxFake(method: string, segments: string[], params: URLSearchParams, env: FakeEnv): Promise<HttpResponse | null> {
  if (env.provider !== 'facebook') return null;
  const pageId = env.accountId;
  const [first, edge] = segments;
  const now = env.now();

  // POST /{page-id}/messages — Send API (PSID) or private reply (comment_id)
  if (first === pageId && edge === 'messages' && method === 'POST') {
    let recipient: { id?: string; comment_id?: string; post_id?: string } = {};
    let message: { text?: string } = {};
    try { recipient = JSON.parse(params.get('recipient') ?? '{}'); message = JSON.parse(params.get('message') ?? '{}'); } catch { return gerr(400, 100, '(#100) Invalid parameter'); }
    const text = String(message.text ?? '');
    if (!text || text.length > 2000) return gerr(400, 100, '(#100) Message text is required and must be at most 2000 characters');
    const g = await gate(env);
    if (g && g !== 'lose') return g;
    if (recipient.id) {
      const inbound = (await env.store.list('facebook', pageId, 'inbox_dm')).filter((o) => o.data.psid === recipient.id && o.data.from === 'user');
      if (!inbound.length) return gerr(400, 100, '(#100) No matching user found', 2018001);
      const last = Math.max(...inbound.map((o) => Date.parse(String(o.data.at))));
      const tag = params.get('tag');
      if (now.getTime() - last > (tag === 'HUMAN_AGENT' ? 7 * DAY : DAY)) return gerr(400, 10, '(#10) This message is sent outside of allowed window.', 2018278);
      const mid = env.newId('mock_mid_');
      await put(env, mid, 'inbox_dm', { psid: recipient.id, text, from: 'page', at: now.toISOString() });
      if (g === 'lose') lostResponse();
      return json(200, { recipient_id: recipient.id, message_id: mid });
    }
    const cid = recipient.comment_id;
    if (cid) {
      const c = await env.store.get('facebook', cid);
      if (!c || c.kind !== 'inbox_comment' || c.accountId !== pageId) return gerr(400, 100, '(#100) Invalid comment_id');
      if (now.getTime() - Date.parse(String(c.data.at)) > 7 * DAY) return gerr(400, 10, '(#10) This message is sent outside of allowed window.', 2018278);
      if (c.data.private_reply_mid) return gerr(400, 10, '(#10) Only one private reply can be sent to a comment.', 2018108);
      const mid = env.newId('mock_mid_');
      await put(env, cid, 'inbox_comment', { ...c.data, private_reply_mid: mid });
      const psid = String(c.data.from_id);
      await put(env, mid, 'inbox_dm', { psid, text, from: 'page', at: now.toISOString(), private_reply_to: cid });
      if (g === 'lose') lostResponse();
      return json(200, { recipient_id: psid, message_id: mid });
    }
    return gerr(400, 100, '(#100) recipient is required');
  }

  // /{comment-id}/comments — reply to / list replies of a simulated comment
  if (first && first.startsWith('mock_c_') && edge === 'comments') {
    const c = await env.store.get('facebook', first);
    if (!c || c.kind !== 'inbox_comment' || c.accountId !== pageId) return gerr(400, 100, '(#100) Unsupported get request. Object does not exist', 33);
    if (method === 'POST') {
      const text = params.get('message') ?? '';
      if (!text || text.length > 8000) return gerr(400, 100, '(#100) message is required');
      const g = await gate(env);
      if (g && g !== 'lose') return g;
      const id = env.newId('mock_c_');
      await put(env, id, 'inbox_comment', { comment_id: id, parent_id: first, post_id: c.data.post_id, from_id: pageId, from_name: 'Page', text, at: now.toISOString() });
      if (g === 'lose') lostResponse();
      return json(200, { id });
    }
    const replies = (await env.store.list('facebook', pageId, 'inbox_comment')).filter((o) => o.data.parent_id === first)
      .map((o) => ({ id: o.objectId, message: o.data.text, created_time: fbTime(new Date(String(o.data.at))), from: { id: o.data.from_id, name: o.data.from_name } }));
    return json(200, { data: replies });
  }

  // GET /{page-id}/conversations?user_id=PSID — recent messages of one thread (reconciliation)
  if (first === pageId && edge === 'conversations' && method === 'GET') {
    const psid = params.get('user_id');
    const msgs = (await env.store.list('facebook', pageId, 'inbox_dm')).filter((o) => !psid || o.data.psid === psid)
      .map((o) => ({ id: o.objectId, message: o.data.text, created_time: fbTime(new Date(String(o.data.at))), from: { id: o.data.from === 'page' ? pageId : o.data.psid } }));
    return json(200, { data: msgs.length ? [{ id: `mock_t_${psid ?? 'all'}`, messages: { data: msgs.slice(0, 25) } }] : [] });
  }
  return null;
}

/** Record a simulated customer message / comment so the fake API knows it (used by the inbox simulator). */
export async function recordSimulatedInbound(env: Pick<FakeEnv, 'store'>, pageId: string, item: { kind: 'dm'; mid: string; psid: string; text: string; at: string } | { kind: 'comment'; commentId: string; parentId: string | null; postId: string; fromId: string; fromName: string; text: string; at: string }): Promise<void> {
  if (!pageId.startsWith('mock_')) throw new Error('simulated inbound is only for mock_ Pages');
  if (item.kind === 'dm') {
    await env.store.put({ provider: 'facebook', accountId: pageId, objectId: item.mid, kind: 'inbox_dm', data: { psid: item.psid, text: item.text, from: 'user', at: item.at }, createdAt: item.at });
  } else {
    await env.store.put({ provider: 'facebook', accountId: pageId, objectId: item.commentId, kind: 'inbox_comment', data: { comment_id: item.commentId, parent_id: item.parentId, post_id: item.postId, from_id: item.fromId, from_name: item.fromName, text: item.text, at: item.at }, createdAt: item.at });
  }
}
