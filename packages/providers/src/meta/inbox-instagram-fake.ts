// Simulated Instagram messaging + comment endpoints for mock_ Instagram accounts (V3.5 stream B). Reached through the
// Meta fake (fake.ts → inbox-fake.ts) for provider 'instagram' only. Objects live in the durable mock store so
// reconciliation after a lost response is truthful. Simulation choices (not provider facts): window errors use code 10
// / subcode 2018278 like Messenger; a second private reply answers subcode 2018108; DM text > 1,000 bytes → code 100.
import type { HttpResponse } from '@social-lite/core';
import { json, lostResponse, type FakeEnv, type MockObject } from '../transport/mock.js';

const DAY = 86_400_000;
const igTime = (iso: string) => iso.replace(/\.\d{3}Z$/, '+0000');

function gerr(status: number, code: number, message: string, subcode?: number): HttpResponse {
  return json(status, { error: { message, type: 'OAuthException', code, ...(subcode !== undefined ? { error_subcode: subcode } : {}), fbtrace_id: 'mock_trace' } });
}

async function once(env: FakeEnv, key: string): Promise<boolean> {
  return (await env.store.incr(`ig-inbox:${env.accountId}:${key}:${env.scenario}`)) === 1;
}

async function gate(env: FakeEnv): Promise<HttpResponse | 'lose' | null> {
  switch (env.scenario) {
    case 'fail_permanent': return gerr(400, 100, '(#100) Invalid parameter');
    case 'missing_permission': return gerr(403, 10, '(#10) Application does not have permission for this action');
    case 'fail_transient_once': return (await once(env, 'transient')) ? json(500, { error: { message: 'Service temporarily unavailable', code: 2, is_transient: true } }) : null;
    case 'rate_limited_once': return (await once(env, 'rate')) ? gerr(400, 80002, 'There have been too many calls to this Instagram account.') : null;
    case 'timeout_after_send': return (await once(env, 'timeout')) ? 'lose' : null;
    default: return null;
  }
}

async function put(env: FakeEnv, objectId: string, kind: string, data: Record<string, unknown>): Promise<MockObject> {
  const o: MockObject = { provider: 'instagram', accountId: env.accountId, objectId, kind, data, createdAt: env.now().toISOString() };
  await env.store.put(o);
  return o;
}

export async function instagramInboxFake(method: string, segments: string[], params: URLSearchParams, env: FakeEnv): Promise<HttpResponse | null> {
  const ig = env.accountId;
  const page = `${ig}_page`;
  const [first, edge] = segments;
  const now = env.now();

  if (first === page && edge === 'messages' && method === 'POST') {
    let recipient: { id?: string; comment_id?: string } = {};
    let message: { text?: string } = {};
    try { recipient = JSON.parse(params.get('recipient') ?? '{}'); message = JSON.parse(params.get('message') ?? '{}'); } catch { return gerr(400, 100, '(#100) Invalid parameter'); }
    const text = String(message.text ?? '');
    if (!text || Buffer.byteLength(text, 'utf8') > 1000) return gerr(400, 100, '(#100) Message text must be 1-1000 bytes');
    const g = await gate(env);
    if (g && g !== 'lose') return g;
    if (recipient.id) {
      const inbound = (await env.store.list('instagram', ig, 'ig_dm')).filter((o) => o.data.igsid === recipient.id && o.data.from === 'user');
      if (!inbound.length) return gerr(400, 100, '(#100) No matching user found', 2018001);
      const last = Math.max(...inbound.map((o) => Date.parse(String(o.data.at))));
      if (now.getTime() - last > (params.get('tag') === 'HUMAN_AGENT' ? 7 * DAY : DAY)) return gerr(400, 10, '(#10) This message is sent outside of allowed window.', 2018278);
      const mid = env.newId('mock_igm_');
      await put(env, mid, 'ig_dm', { igsid: recipient.id, text, from: 'business', at: now.toISOString() });
      if (g === 'lose') lostResponse();
      return json(200, { recipient_id: recipient.id, message_id: mid });
    }
    if (recipient.comment_id) {
      const c = await env.store.get('instagram', recipient.comment_id);
      if (!c || c.kind !== 'ig_comment' || c.accountId !== ig) return gerr(400, 100, '(#100) Invalid comment_id');
      if (now.getTime() - Date.parse(String(c.data.at)) > 7 * DAY) return gerr(400, 10, '(#10) This message is sent outside of allowed window.', 2018278);
      if (c.data.private_reply_mid) return gerr(400, 10, '(#10) Only one private reply can be sent to a comment.', 2018108);
      const mid = env.newId('mock_igm_');
      await put(env, recipient.comment_id, 'ig_comment', { ...c.data, private_reply_mid: mid });
      await put(env, mid, 'ig_dm', { igsid: String(c.data.from_id), text, from: 'business', at: now.toISOString(), private_reply_to: recipient.comment_id });
      if (g === 'lose') lostResponse();
      return json(200, { recipient_id: String(c.data.from_id), message_id: mid });
    }
    return gerr(400, 100, '(#100) recipient is required');
  }

  if (first === page && edge === 'conversations' && method === 'GET') {
    const who = params.get('user_id');
    const msgs = (await env.store.list('instagram', ig, 'ig_dm')).filter((o) => !who || o.data.igsid === who)
      .map((o) => ({ id: o.objectId, message: o.data.text, created_time: igTime(String(o.data.at)), from: { id: o.data.from === 'business' ? ig : o.data.igsid } }));
    return json(200, { data: msgs.length ? [{ id: `mock_igt_${who ?? 'all'}`, messages: { data: msgs.slice(0, 25) } }] : [] });
  }

  if (first && first.startsWith('mock_igc_')) {
    const c = await env.store.get('instagram', first);
    if (!c || c.kind !== 'ig_comment' || c.accountId !== ig) return gerr(400, 100, '(#100) Object does not exist', 33);
    if (edge === 'replies' && method === 'POST') {
      const text = params.get('message') ?? '';
      if (!text) return gerr(400, 100, '(#100) message is required');
      if (c.data.hidden) return gerr(400, 100, '(#100) Cannot reply to a hidden comment');
      const g = await gate(env);
      if (g && g !== 'lose') return g;
      const id = env.newId('mock_igc_');
      await put(env, id, 'ig_comment', { parent_id: first, media_id: c.data.media_id, from_id: ig, from_username: 'simulated.account', text, at: now.toISOString() });
      if (g === 'lose') lostResponse();
      return json(200, { id });
    }
    if (edge === 'replies' && method === 'GET') {
      const rows = (await env.store.list('instagram', ig, 'ig_comment')).filter((o) => o.data.parent_id === first && !o.data.deleted)
        .map((o) => ({ id: o.objectId, text: o.data.text, timestamp: igTime(String(o.data.at)), from: { id: o.data.from_id, username: o.data.from_username } }));
      return json(200, { data: rows });
    }
    if (!edge && (method === 'POST' || method === 'DELETE')) {
      if (env.scenario === 'missing_permission') return gerr(403, 10, '(#10) Requires instagram_manage_comments');
      if (method === 'DELETE') { await put(env, first, 'ig_comment', { ...c.data, deleted: true }); return json(200, { success: true }); }
      await put(env, first, 'ig_comment', { ...c.data, hidden: params.get('hide') === 'true' });
      return json(200, { success: true });
    }
  }
  return null;
}

/** Record a simulated customer DM / comment so the fake API knows it (inbox simulator only). */
export async function recordSimulatedInstagram(env: Pick<FakeEnv, 'store'>, igId: string, item: { kind: 'dm'; mid: string; igsid: string; text: string; at: string } | { kind: 'comment'; id: string; parentId: string | null; mediaId: string; fromId: string; username: string; text: string; at: string }): Promise<void> {
  if (!igId.startsWith('mock_')) throw new Error('simulated inbound is only for mock_ accounts');
  if (item.kind === 'dm') {
    await env.store.put({ provider: 'instagram', accountId: igId, objectId: item.mid, kind: 'ig_dm', data: { igsid: item.igsid, text: item.text, from: 'user', at: item.at }, createdAt: item.at });
  } else {
    await env.store.put({ provider: 'instagram', accountId: igId, objectId: item.id, kind: 'ig_comment', data: { parent_id: item.parentId, media_id: item.mediaId, from_id: item.fromId, from_username: item.username, text: item.text, at: item.at }, createdAt: item.at });
  }
}
