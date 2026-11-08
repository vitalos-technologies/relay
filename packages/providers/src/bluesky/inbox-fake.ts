// Simulated Bluesky notifications, reply posts and chat for SIMULATED (mock_) accounts — V3.5 stream B. Reached through
// the inbox mock transport before the publishing fake. Objects in the durable mock store (provider 'bluesky').
import { createHash } from 'node:crypto';
import type { HttpRequest, HttpResponse } from '@social-lite/core';
import { json, lostResponse, type FakeEnv, type MockObject } from '../transport/mock.js';
import { parseJson } from '../shared/http.js';

const xErr = (status: number, error: string, message: string) => json(status, { error, message });
const once = async (env: FakeEnv, k: string) => (await env.store.incr(`bsky-inbox:${env.accountId}:${k}:${env.scenario}`)) === 1;
const cidOf = (s: string) => `bafyrei${createHash('sha256').update(s).digest('hex').slice(0, 40)}`;

export async function blueskyInboxFake(req: HttpRequest, env: FakeEnv): Promise<HttpResponse | null> {
  const u = new URL(req.url);
  const nsid = u.pathname.replace(/^\/xrpc\//, '');
  const body = parseJson(typeof req.body === 'string' ? req.body : '');
  const did = env.accountId;
  const chatCall = nsid.startsWith('chat.bsky.convo.');
  if (chatCall && req.headers?.['atproto-proxy'] !== 'did:web:api.bsky.chat#bsky_chat') return xErr(400, 'InvalidRequest', 'chat requests need the atproto-proxy header');
  if (env.scenario === 'revoked') return xErr(401, 'ExpiredToken', 'Token has been revoked');
  if (chatCall && env.scenario === 'missing_permission') return xErr(401, 'AuthMissing', 'Bad token scope');

  if (nsid === 'app.bsky.notification.listNotifications' && req.method === 'GET') {
    const rows = (await env.store.list('bluesky', did, 'bsky_notif')).sort((a, b) => String(b.data.indexedAt).localeCompare(String(a.data.indexedAt)));
    return json(200, { notifications: rows.slice(0, 50).map((o) => o.data.view), cursor: undefined });
  }
  if (nsid === 'com.atproto.repo.createRecord' && (body.record as { reply?: unknown } | undefined)?.reply) {
    const rec = body.record as { text?: string; createdAt?: string; reply?: { parent?: { uri?: string } } };
    if (!rec.text || [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(rec.text)].length > 300) return xErr(400, 'InvalidRequest', 'Record/text must not be longer than 300 graphemes');
    if (env.scenario === 'fail_permanent') return xErr(400, 'InvalidRequest', 'Invalid app.bsky.feed.post record');
    if (env.scenario === 'rate_limited_once' && await once(env, 'rate')) return json(429, { error: 'RateLimitExceeded', message: 'Rate Limit Exceeded' }, { 'ratelimit-reset': String(Math.floor(env.now().getTime() / 1000) + 30) });
    const rkey = env.newId('mock_').slice(5, 18).padEnd(13, 'a');
    const uri = `at://${did}/app.bsky.feed.post/${rkey}`;
    const o: MockObject = { provider: 'bluesky', accountId: did, objectId: `mock_reply_${rkey}`, kind: 'bsky_reply', createdAt: env.now().toISOString(), data: { uri, cid: cidOf(uri), value: { ...rec, $type: 'app.bsky.feed.post' } } };
    await env.store.put(o);
    if (env.scenario === 'timeout_after_send' && await once(env, 'timeout')) lostResponse();
    return json(200, { uri, cid: o.data.cid });
  }
  if (nsid === 'com.atproto.repo.listRecords' && req.method === 'GET') {
    const rows = (await env.store.list('bluesky', did, 'bsky_reply')).filter((o) => !o.data.deleted);
    return json(200, { records: rows.map((o) => ({ uri: o.data.uri, cid: o.data.cid, value: o.data.value })) });
  }
  if (nsid === 'com.atproto.repo.deleteRecord' && req.method === 'POST') {
    const rows = await env.store.list('bluesky', did, 'bsky_reply');
    const hit = rows.find((o) => String(o.data.uri).endsWith(`/${String(body.rkey)}`));
    if (hit) await env.store.put({ ...hit, data: { ...hit.data, deleted: true } });
    return json(200, {});
  }
  if (nsid === 'chat.bsky.convo.getLog' && req.method === 'GET') {
    const after = u.searchParams.get('cursor') ?? '';
    const rows = (await env.store.list('bluesky', did, 'bsky_chat')).sort((a, b) => String(a.data.rev).localeCompare(String(b.data.rev))).filter((o) => String(o.data.rev) > after);
    const logs = rows.map((o) => ({ $type: 'chat.bsky.convo.defs#logCreateMessage', convoId: o.data.convoId, rev: o.data.rev, message: { id: o.objectId, text: o.data.text, sender: { did: o.data.sender }, sentAt: o.data.sentAt } }));
    return json(200, { logs, cursor: logs.length ? logs[logs.length - 1]!.rev : (after || undefined) });
  }
  if (nsid === 'chat.bsky.convo.getMessages' && req.method === 'GET') {
    const rows = (await env.store.list('bluesky', did, 'bsky_chat')).filter((o) => o.data.convoId === u.searchParams.get('convoId'));
    return json(200, { messages: rows.map((o) => ({ id: o.objectId, text: o.data.text, sender: { did: o.data.sender }, sentAt: o.data.sentAt })) });
  }
  if (nsid === 'chat.bsky.convo.sendMessage' && req.method === 'POST') {
    const convo = String(body.convoId ?? '');
    const known = (await env.store.list('bluesky', did, 'bsky_chat')).some((o) => o.data.convoId === convo);
    if (!known) return xErr(400, 'InvalidConvo', 'Convo not found');
    if (env.scenario === 'fail_permanent') return xErr(400, 'InvalidRequest', 'Message rejected');
    const id = env.newId('mock_bmsg_');
    const at = env.now().toISOString();
    await env.store.put({ provider: 'bluesky', accountId: did, objectId: id, kind: 'bsky_chat', createdAt: at, data: { convoId: convo, text: String((body.message as { text?: string } | undefined)?.text ?? ''), sender: did, sentAt: at, rev: `${Date.now().toString(36).padStart(10, '0')}${id.slice(-4)}` } });
    if (env.scenario === 'timeout_after_send' && await once(env, 'timeout')) lostResponse();
    return json(200, { id, rev: '0', text: '', sender: { did }, sentAt: at });
  }
  return null;
}

/** Simulated reply / mention from another account, or a DM in a chat (simulator only). */
export async function recordSimulatedBluesky(env: Pick<FakeEnv, 'store'>, did: string, item:
  | { kind: 'reply' | 'mention'; id: string; authorDid: string; handle: string; name: string; text: string; at: string; rootUri?: string | null }
  | { kind: 'dm'; id: string; convoId: string; authorDid: string; text: string; at: string }): Promise<void> {
  if (!did.startsWith('mock_')) throw new Error('simulated inbound is only for mock_ accounts');
  if (item.kind === 'dm') {
    await env.store.put({ provider: 'bluesky', accountId: did, objectId: item.id, kind: 'bsky_chat', createdAt: item.at, data: { convoId: item.convoId, text: item.text, sender: item.authorDid, sentAt: item.at, rev: `${Date.now().toString(36).padStart(10, '0')}${item.id.slice(-4)}` } });
    return;
  }
  const uri = `at://${item.authorDid}/app.bsky.feed.post/${item.id.slice(5, 18)}`;
  const rootUri = item.rootUri ?? `at://${did}/app.bsky.feed.post/mockrootpost1`;
  const view = {
    uri, cid: cidOf(uri), reason: item.kind, indexedAt: item.at, author: { did: item.authorDid, handle: item.handle, displayName: item.name },
    record: { $type: 'app.bsky.feed.post', text: item.text, createdAt: item.at, ...(item.kind === 'reply' ? { reply: { root: { uri: rootUri, cid: cidOf(rootUri) }, parent: { uri: rootUri, cid: cidOf(rootUri) } } } : {}) },
  };
  await env.store.put({ provider: 'bluesky', accountId: did, objectId: item.id, kind: 'bsky_notif', createdAt: item.at, data: { indexedAt: item.at, view } });
}
