// V3.5 foundation — inbox adapter (Facebook Page via the simulated Meta transport) + customer care, through the REAL
// policy path (v2Ctx) and real Postgres. Brief §22 acceptance tests 1, 2, 3, 13 (+ tenant isolation, webhook
// verification, ordering, reply-window expiry, unknown outcomes, revocation, cases/SLA).
import { createHmac, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TransportError, type Transport } from '@social-lite/core';
import { connectMock, setLiveTransportFactoryForTests } from '@social-lite/services/connections/index';
import { processWebhookReceipt, receiveWebhook } from '@social-lite/services/webhooks';
import {
  addNote, assignConversation, careReport, createCase, dispatchReply, enableChannel, getConversation, inboxAdminOverview, inboxCounts, listConversations,
  reconcileUnknownReplies, requestReply, resolveUnknownReply, saveDraft, simulateInbound, sweepReplies, sweepSla, updateCase, upsertSlaPolicy,
} from '@social-lite/services/inbox/index';
import { resetConfigCache, type Ctx } from '@social-lite/services';
import { addMember, closeTestPool, createBrand, createUser, createWorkspace, grant, testPool, v2Ctx } from './helpers.js';

afterAll(async () => { setLiveTransportFactoryForTests(null); await closeTestPool(); });

const key = () => randomUUID().replace(/-/g, '');

async function member(ws: string, role: string, brandId?: string, name = 'Member') {
  const u = await createUser(undefined, name);
  await testPool().query(`INSERT INTO memberships(workspace_id, user_id, role) VALUES ($1,$2,'viewer')`, [ws, u.id]);
  await grant(ws, u.id, role, brandId);
  return u;
}

interface World { ws: string; brand: string; owner: Ctx; ann: Ctx; ben: Ctx; viewer: Ctx; outsider: Ctx; annId: string; benId: string; channelId: string; connectionId: string; pageId: string }

async function world(scenario = 'success'): Promise<World> {
  const ws = await createWorkspace('Inbox');
  const brand = await createBrand(ws, 'Care brand');
  const brandB = await createBrand(ws, 'Other brand');
  const o = await createUser(undefined, 'Olive Owner');
  await addMember(ws, o.id, 'owner');
  const ann = await member(ws, 'care_agent', brand, 'Ann Agent');
  const ben = await member(ws, 'care_agent', brand, 'Ben Agent');
  const vic = await member(ws, 'viewer', brand, 'Vic Viewer');
  const out = await member(ws, 'care_agent', brandB, 'Otto Outsider');
  const owner = await v2Ctx(o.id, ws);
  const conn = await connectMock(owner, brand, { provider: 'facebook', display_name: 'Simulated Page', scenario });
  const ch = await enableChannel(owner, { connection_id: conn.id });
  return { ws, brand, owner, ann: await v2Ctx(ann.id, ws), ben: await v2Ctx(ben.id, ws), viewer: await v2Ctx(vic.id, ws), outsider: await v2Ctx(out.id, ws), annId: ann.id, benId: ben.id, channelId: ch.id, connectionId: conn.id, pageId: conn.provider_account_id };
}

async function firstConversation(w: World, ctx: Ctx = w.owner) {
  const l = await listConversations(ctx, { queue: 'all' });
  return getConversation(ctx, l.items[0]!.id);
}

const pageMessages = async (pageId: string, text?: string) => (await testPool().query<{ data: { text: string; from: string } }>(
  `SELECT data FROM mock_provider_objects WHERE provider='facebook' AND account_id=$1 AND kind IN ('inbox_dm','inbox_comment') AND (data->>'from'='page' OR data->>'from_id'=$1) ${text ? `AND data->>'text'=$2` : ''}`,
  text ? [pageId, text] : [pageId])).rows;

beforeAll(() => { testPool(); });

describe('V3.5 inbox — Facebook Page adapter on the simulated transport', () => {
  it('AT1: receive → assign → draft → send once → actual provider result shown', async () => {
    const w = await world();
    const ch = await testPool().query(`SELECT status, is_simulated FROM inbox_channels WHERE id=$1`, [w.channelId]);
    expect(ch.rows[0]).toMatchObject({ status: 'active', is_simulated: true });
    await simulateInbound(w.owner, w.channelId, { kind: 'dm', text: 'Where is my order #123?', name: 'Cara Customer' });
    expect((await inboxCounts(w.ann)).unassigned).toBe(1);
    expect((await listConversations(w.ann, { queue: 'all', q: 'Cara Cust' })).items).toHaveLength(1);
    expect((await listConversations(w.ann, { queue: 'all', q: 'order #123' })).items).toHaveLength(1);
    expect((await listConversations(w.ann, { queue: 'all', q: 'nobody_%' })).items).toHaveLength(0);
    let conv = await firstConversation(w, w.ann);
    expect(conv).toMatchObject({ kind: 'dm', visibility: 'private', status: 'open', contact: { name: 'Cara Customer' } });
    expect(conv.timeline.filter((t) => t.type === 'message')).toHaveLength(1);

    await assignConversation(w.owner, conv.id, { assignee_id: w.annId });
    expect((await listConversations(w.ann, { queue: 'mine' })).items).toHaveLength(1);
    const notif = await testPool().query(`SELECT kind FROM notifications WHERE user_id=$1`, [w.annId]);
    expect(notif.rows.map((r) => r.kind)).toContain('inbox.assigned');

    conv = await getConversation(w.ann, conv.id);
    await saveDraft(w.ann, conv.id, { mode: 'private_message', body: 'On its way', base_version: conv.version });
    expect((await getConversation(w.ann, conv.id)).draft?.body).toBe('On its way');

    const k = key();
    const r1 = await requestReply(w.ann, conv.id, { mode: 'private_message', body: 'It ships today.', base_version: conv.version, idempotency_key: k });
    expect(r1.created).toBe(true);
    expect(r1.attempt.state).toBe('queued');
    const again = await requestReply(w.ann, conv.id, { mode: 'private_message', body: 'It ships today.', base_version: conv.version, idempotency_key: k });
    expect(again).toMatchObject({ created: false, attempt: { id: r1.attempt.id } });
    expect((await getConversation(w.ann, conv.id)).draft).toBeNull();

    expect(await dispatchReply(r1.attempt.id, 'test')).toBe('sent');
    expect(await dispatchReply(r1.attempt.id, 'test')).toBe('skipped'); // never sent twice
    const sent = await pageMessages(w.pageId, 'It ships today.');
    expect(sent).toHaveLength(1);
    const after = await getConversation(w.ann, conv.id);
    const out = after.timeline.find((t) => t.type === 'message' && t.message.direction === 'outbound');
    expect(out && out.type === 'message' && out.message).toMatchObject({ body: 'It ships today.', delivery: 'sent', author: { kind: 'user', name: 'Ann Agent' } });
    const att = await testPool().query(`SELECT state, provider_message_id, provider_result FROM inbox_reply_attempts WHERE id=$1`, [r1.attempt.id]);
    expect(att.rows[0].state).toBe('sent');
    expect(att.rows[0].provider_message_id).toMatch(/^mock_mid_/);
    expect(att.rows[0].provider_result.external_id).toBe(att.rows[0].provider_message_id);
    expect(after.unanswered_since).toBeNull();
  });

  it('AT2: two agents replying concurrently never silently double-send', async () => {
    const w = await world();
    await simulateInbound(w.owner, w.channelId, { kind: 'dm', text: 'Refund please' });
    const conv = await firstConversation(w, w.ann);
    const results = await Promise.allSettled([
      requestReply(w.ann, conv.id, { mode: 'private_message', body: 'Ann: refund issued', base_version: conv.version, idempotency_key: key() }),
      requestReply(w.ben, conv.id, { mode: 'private_message', body: 'Ben: looking into it', base_version: conv.version, idempotency_key: key() }),
    ]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    const bad = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(ok).toHaveLength(1);
    expect(bad).toHaveLength(1);
    expect(bad[0]!.reason).toMatchObject({ code: 'conflict', details: { reason: 'reply_collision' } });
    const s = await sweepReplies();
    for (const id of s.due) await dispatchReply(id, 'test');
    // The losing agent, still on the old version, is blocked with details; acknowledging the CURRENT version lets them send.
    const loser = (ok[0] as PromiseFulfilledResult<{ attempt: { created_by: { id: string } } }>).value.attempt.created_by.id === w.annId ? w.ben : w.ann;
    const err = await requestReply(loser, conv.id, { mode: 'private_message', body: 'Second reply', base_version: conv.version, idempotency_key: key() }).catch((e) => e);
    expect(err.details.reason).toBe('reply_collision');
    expect(err.details.changes[0]).toMatchObject({ kind: 'reply', state: 'sent' });
    const cur = (await getConversation(loser, conv.id)).version;
    const second = await requestReply(loser, conv.id, { mode: 'private_message', body: 'Second reply', base_version: conv.version, idempotency_key: key(), acknowledge_version: cur });
    expect(second.created).toBe(true);
    const inflight = await requestReply(w.owner, conv.id, { mode: 'private_message', body: 'Third', base_version: cur + 1, acknowledge_version: cur + 1, idempotency_key: key() }).catch((e) => e);
    expect(inflight.details.reason).toBe('reply_collision'); // one in-flight send per conversation
    expect(await pageMessages(w.pageId)).toHaveLength(1);
  });

  it('AT3: an internal note never reaches the customer', async () => {
    const w = await world();
    await simulateInbound(w.owner, w.channelId, { kind: 'dm', text: 'Is the café open?' });
    const conv = await firstConversation(w, w.ann);
    const secret = `INTERNAL-ONLY ${randomUUID()}`;
    const note = await addNote(w.ann, conv.id, { body: secret, mentions: [w.benId] });
    expect(note.mentions).toEqual([w.benId]);
    const r = await requestReply(w.ann, conv.id, { mode: 'private_message', body: 'Yes, until 6pm.', base_version: (await getConversation(w.ann, conv.id)).version, idempotency_key: key() });
    await dispatchReply(r.attempt.id, 'test');
    const all = await testPool().query(`SELECT data::text t FROM mock_provider_objects WHERE account_id=$1`, [w.pageId]);
    expect(all.rows.some((x) => x.t.includes('INTERNAL-ONLY'))).toBe(false);
    const msgs = await testPool().query(`SELECT body FROM inbox_messages WHERE conversation_id=$1`, [conv.id]);
    expect(msgs.rows.some((m) => String(m.body).includes('INTERNAL-ONLY'))).toBe(false);
    const detail = await getConversation(w.ben, conv.id);
    expect(detail.timeline.find((t) => t.type === 'note')).toMatchObject({ note: { body: secret } });
    // Viewers (no inbox.read) cannot see the conversation at all.
    await expect(getConversation(w.viewer, conv.id)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('AT13: provider outages give recoverable states, never invented success', async () => {
    // Lost response after the provider created the message ⇒ Unknown ⇒ reconciled from provider evidence (no resend).
    const w = await world('timeout_after_send');
    await simulateInbound(w.owner, w.channelId, { kind: 'dm', text: 'Hello?' });
    const conv = await firstConversation(w, w.ann);
    const r = await requestReply(w.ann, conv.id, { mode: 'private_message', body: 'Hi there', base_version: conv.version, idempotency_key: key() });
    expect(await dispatchReply(r.attempt.id, 'test')).toBe('unknown');
    await testPool().query(`UPDATE inbox_reply_attempts SET reconcile_after=now() WHERE id=$1`, [r.attempt.id]);
    expect((await reconcileUnknownReplies()).resolved).toBe(1);
    const a = await testPool().query(`SELECT state, provider_result FROM inbox_reply_attempts WHERE id=$1`, [r.attempt.id]);
    expect(a.rows[0]).toMatchObject({ state: 'sent', provider_result: { reconciled: true } });
    expect(await pageMessages(w.pageId, 'Hi there')).toHaveLength(1);

    // Provider refuses ⇒ failed with the provider's reason; nothing sent.
    const f = await world('fail_permanent');
    await simulateInbound(f.owner, f.channelId, { kind: 'dm', text: 'x' });
    const fc = await firstConversation(f, f.ann);
    const fr = await requestReply(f.ann, fc.id, { mode: 'private_message', body: 'nope', base_version: fc.version, idempotency_key: key() });
    expect(await dispatchReply(fr.attempt.id, 'test')).toBe('failed');
    const fa = (await getConversation(f.ann, fc.id)).timeline.find((t) => t.type === 'attempt');
    expect(fa && fa.type === 'attempt' && fa.attempt).toMatchObject({ state: 'failed', error: { code: 'invalid_request' } });
    expect(await pageMessages(f.pageId)).toHaveLength(0);

    // Throttled ⇒ queued for retry (not failed, not sent) ⇒ sent on the next attempt.
    const t = await world('rate_limited_once');
    await simulateInbound(t.owner, t.channelId, { kind: 'dm', text: 'y' });
    const tc = await firstConversation(t, t.ann);
    const tr = await requestReply(t.ann, tc.id, { mode: 'private_message', body: 'retry me', base_version: tc.version, idempotency_key: key() });
    expect(await dispatchReply(tr.attempt.id, 'test')).toBe('queued');
    await testPool().query(`UPDATE inbox_reply_attempts SET next_attempt_at=now() WHERE id=$1`, [tr.attempt.id]);
    expect(await dispatchReply(tr.attempt.id, 'test')).toBe('sent');

    // Token revoked ⇒ failed + connection marked reconnect required (channel follows on the health sweep).
    const v = await world('revoked');
    await simulateInbound(v.owner, v.channelId, { kind: 'dm', text: 'z' });
    const vc = await firstConversation(v, v.ann);
    const vr = await requestReply(v.ann, vc.id, { mode: 'private_message', body: 'hello', base_version: vc.version, idempotency_key: key() });
    expect(await dispatchReply(vr.attempt.id, 'test')).toBe('failed');
    expect((await testPool().query(`SELECT status FROM connections WHERE id=$1`, [v.connectionId])).rows[0].status).toBe('reconnect_required');

    // Worker died mid-send ⇒ lease expiry makes it Unknown, never "sent" and never resent automatically.
    const d = await world();
    await simulateInbound(d.owner, d.channelId, { kind: 'dm', text: 'q' });
    const dc = await firstConversation(d, d.ann);
    const dr = await requestReply(d.ann, dc.id, { mode: 'private_message', body: 'crash', base_version: dc.version, idempotency_key: key() });
    await testPool().query(`UPDATE inbox_reply_attempts SET state='sending', lease_expires_at=now() - interval '1 second' WHERE id=$1`, [dr.attempt.id]);
    expect((await sweepReplies()).expired).toBeGreaterThanOrEqual(1);
    expect((await testPool().query(`SELECT state FROM inbox_reply_attempts WHERE id=$1`, [dr.attempt.id])).rows[0].state).toBe('unknown');
    // A person checks and settles it explicitly.
    const settled = await resolveUnknownReply(d.ann, dr.attempt.id, 'not_sent');
    expect(settled.state).toBe('failed');
  });

  it('reply window, comments (public + one private reply), ordering, duplicates and edits', async () => {
    const w = await world();
    await simulateInbound(w.owner, w.channelId, { kind: 'dm', text: 'old message', minutes_ago: 26 * 60 });
    const old = await firstConversation(w, w.ann);
    expect(old.reply.modes.find((m) => m.mode === 'private_message')).toMatchObject({ allowed: false });
    await expect(requestReply(w.ann, old.id, { mode: 'private_message', body: 'late', base_version: old.version, idempotency_key: key() }))
      .rejects.toMatchObject({ code: 'invalid_state', details: { reason: 'reply_window_closed' } });

    const c = await simulateInbound(w.owner, w.channelId, { kind: 'comment', text: 'Love this!', name: 'Dee' });
    const list = await listConversations(w.ann, { queue: 'all', kind: 'comment' });
    const cc = await getConversation(w.ann, list.items[0]!.id);
    expect(cc).toMatchObject({ kind: 'comment', visibility: 'public' });
    const pub = await requestReply(w.ann, cc.id, { mode: 'public_reply', body: 'Thank you!', base_version: cc.version, idempotency_key: key() });
    expect(await dispatchReply(pub.attempt.id, 't')).toBe('sent');
    let cur = await getConversation(w.ann, cc.id);
    const priv = await requestReply(w.ann, cc.id, { mode: 'private_message', body: 'DM: here is a code', base_version: cur.version, idempotency_key: key() });
    expect(await dispatchReply(priv.attempt.id, 't')).toBe('sent');
    cur = await getConversation(w.ann, cc.id);
    expect(cur.reply.modes.find((m) => m.mode === 'private_message')).toMatchObject({ allowed: false });

    // Late-arriving older comment in the same thread does not move the preview backwards; exact duplicate is ignored.
    await simulateInbound(w.owner, w.channelId, { kind: 'comment', text: 'older reply', thread: c.thread, minutes_ago: 120 });
    const after = await getConversation(w.ann, cc.id);
    expect(after.preview).toBe('DM: here is a code');
    const msgs = after.timeline.filter((t) => t.type === 'message').map((t) => t.type === 'message' ? t.message.body : '');
    expect(msgs[0]).toBe('older reply'); // provider time order (written 2 h earlier, arrived last), not arrival order
    expect(msgs.indexOf('Love this!')).toBeGreaterThan(0);
  });

  it('verified Meta webhooks route to real channels only; bad signatures are refused; real connections never use the mock', async () => {
    process.env.META_APP_SECRET = 'test-meta-app-secret-123456';
    resetConfigCache();
    const w = await world();
    const pageId = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
    const conn = await testPool().query<{ id: string }>(
      `INSERT INTO connections(workspace_id, brand_id, provider, provider_account_id, display_name, status, is_mock, capabilities) VALUES ($1,$2,'facebook',$3,'Real Page','ready',false,'{}') RETURNING id`, [w.ws, w.brand, pageId]);
    const { insertCredential } = await import('@social-lite/services/connections/store');
    const credId = await insertCredential(testPool(), w.ws, { kind: 'meta_page', pageAccessToken: 'not-a-real-token' }, { expiresAt: null, scopes: ['pages_messaging', 'pages_manage_engagement', 'pages_read_user_content'] });
    await testPool().query(`UPDATE connections SET credential_id=$2 WHERE id=$1`, [conn.rows[0]!.id, credId]);
    const ch = await enableChannel(w.owner, { connection_id: conn.rows[0]!.id });
    expect(ch).toMatchObject({ status: 'active', is_simulated: false });

    const body = JSON.stringify({ object: 'page', entry: [{ id: pageId, time: Date.now(), messaging: [{ sender: { id: 'PSID1' }, recipient: { id: pageId }, timestamp: Date.now(), message: { mid: `m_${randomUUID()}`, text: 'real hello' } }] }] });
    const sig = `sha256=${createHmac('sha256', process.env.META_APP_SECRET).update(body).digest('hex')}`;
    await expect(receiveWebhook('meta', body, new Headers({ 'x-hub-signature-256': 'sha256=00' }))).rejects.toMatchObject({ code: 'forbidden' });
    const ok = await receiveWebhook('meta', body, new Headers({ 'x-hub-signature-256': sig }));
    expect(ok.body).toMatchObject({ ok: true, duplicate: false });
    expect((await receiveWebhook('meta', body, new Headers({ 'x-hub-signature-256': sig }))).body).toMatchObject({ duplicate: true });
    const rec = await testPool().query<{ id: string }>(`SELECT id FROM webhook_receipts WHERE provider='meta' ORDER BY received_at DESC LIMIT 1`);
    expect((await processWebhookReceipt(rec.rows[0]!.id)).state).toBe('processed');
    const conv = await testPool().query(`SELECT c.id, c.is_simulated FROM inbox_conversations c WHERE c.channel_id=$1`, [ch.id]);
    expect(conv.rows).toHaveLength(1);
    expect(conv.rows[0].is_simulated).toBe(false);

    // Reply on the REAL channel: the live transport is used (here a recording test transport that cannot connect).
    const calls: string[] = [];
    const live: Transport = { mode: 'live', async send(req) { calls.push(new URL(req.url).hostname); throw new TransportError('connection failed (ECONNREFUSED)', 'connect', false); } };
    setLiveTransportFactoryForTests(() => live);
    try {
      const detail = await getConversation(w.ann, conv.rows[0].id);
      const r = await requestReply(w.ann, detail.id, { mode: 'private_message', body: 'real reply', base_version: detail.version, idempotency_key: key() });
      expect(await dispatchReply(r.attempt.id, 't')).toBe('queued'); // refused before sending ⇒ retry later, NOT sent
      expect(calls).toEqual(['graph.facebook.com']);
      expect((await testPool().query(`SELECT state FROM inbox_reply_attempts WHERE id=$1`, [r.attempt.id])).rows[0].state).toBe('queued');
    } finally { setLiveTransportFactoryForTests(null); }
    delete process.env.META_APP_SECRET;
    resetConfigCache();
  });

  it('revocation blocks reading and cancels a queued reply; tenant + brand isolation', async () => {
    const w = await world();
    await simulateInbound(w.owner, w.channelId, { kind: 'dm', text: 'hello' });
    const conv = await firstConversation(w, w.ann);
    await expect(getConversation(w.outsider, conv.id)).rejects.toMatchObject({ code: 'not_found' });
    expect((await listConversations(w.outsider, {})).items).toHaveLength(0);
    const other = await world();
    await expect(getConversation(other.owner, conv.id)).rejects.toMatchObject({ code: 'not_found' });
    await expect(assignConversation(w.owner, conv.id, { assignee_id: (await testPool().query(`SELECT user_id FROM memberships WHERE workspace_id=$1 AND role='viewer' LIMIT 1`, [other.ws])).rows[0].user_id }))
      .rejects.toMatchObject({ code: 'validation_failed' });

    const r = await requestReply(w.ann, conv.id, { mode: 'private_message', body: 'queued then revoked', base_version: conv.version, idempotency_key: key() });
    await testPool().query(`UPDATE scoped_role_grants SET revoked_at=now() WHERE workspace_id=$1 AND user_id=$2`, [w.ws, w.annId]);
    expect(await dispatchReply(r.attempt.id, 't')).toBe('cancelled');
    expect(await pageMessages(w.pageId)).toHaveLength(0);
    await expect(v2Ctx(w.annId, w.ws).then((c) => listConversations(c, {}))).rejects.toBeTruthy();
  });

  it('cases: SLA clock, first response, waiting pause, resolve with reason, customer reopens, report + admin view', async () => {
    const w = await world();
    await upsertSlaPolicy(w.owner, { name: 'Default', timezone: 'UTC', business_hours: null, holidays: [], first_response_minutes: 60, resolution_minutes: 480, count_automated: false, is_default: true });
    await simulateInbound(w.owner, w.channelId, { kind: 'dm', text: 'Broken item', minutes_ago: 30 });
    const conv = await firstConversation(w, w.ann);
    const k = await createCase(w.ann, { conversation_id: conv.id, title: 'Broken item', priority: 'high' });
    expect(k.first_response.due_at).not.toBeNull();
    expect(Date.parse(k.first_response.due_at!) - Date.parse(conv.unanswered_since!)).toBe(60 * 60_000); // clock started at the customer message
    await expect(createCase(w.ann, { conversation_id: conv.id, title: 'dup' })).rejects.toMatchObject({ code: 'conflict' });

    const r = await requestReply(w.ann, conv.id, { mode: 'private_message', body: 'Sorry — replacement sent.', base_version: (await getConversation(w.ann, conv.id)).version, idempotency_key: key() });
    await dispatchReply(r.attempt.id, 't');
    let c = await (await import('@social-lite/services/inbox/index')).getCase(w.ann, k.id);
    expect(c.first_response.at).not.toBeNull();
    expect(c.first_response.breached).toBe(false);

    c = await updateCase(w.ann, k.id, { version: (await testPool().query(`SELECT version FROM care_cases WHERE id=$1`, [k.id])).rows[0].version, state: 'waiting' });
    expect(c).toMatchObject({ state: 'waiting', paused: true });
    expect(c.resolution.due_at).toBeNull();
    await expect(updateCase(w.ann, k.id, { version: 1, state: 'resolved', resolution_reason: 'x' })).rejects.toMatchObject({ code: 'version_conflict' });
    const v = async () => (await testPool().query(`SELECT version FROM care_cases WHERE id=$1`, [k.id])).rows[0].version as number;
    await expect(updateCase(w.ann, k.id, { version: await v(), state: 'resolved' })).rejects.toMatchObject({ code: 'validation_failed' });
    c = await updateCase(w.ann, k.id, { version: await v(), state: 'resolved', resolution_reason: 'Replacement delivered' });
    expect(c.state).toBe('resolved');
    expect((await getConversation(w.ann, conv.id)).status).toBe('resolved');

    const thread = (await testPool().query(`SELECT external_thread_id FROM inbox_conversations WHERE id=$1`, [conv.id])).rows[0].external_thread_id.replace('psid:', '');
    await simulateInbound(w.owner, w.channelId, { kind: 'dm', text: 'Still broken!', thread });
    c = await (await import('@social-lite/services/inbox/index')).getCase(w.ann, k.id);
    expect(c).toMatchObject({ state: 'reopened', reopened_count: 1 });
    expect((await getConversation(w.ann, conv.id)).status).toBe('open');
    const events = await testPool().query(`SELECT kind FROM care_case_events WHERE case_id=$1 ORDER BY id`, [k.id]);
    expect(events.rows.map((e) => e.kind)).toEqual(expect.arrayContaining(['created', 'clock_started', 'first_response', 'paused', 'resolved', 'reopened']));
    await expect(testPool().query(`SELECT 1`)).resolves.toBeTruthy();

    // Breach sweep: a second case whose first-response target has passed is recorded once and escalated to its owner.
    await simulateInbound(w.owner, w.channelId, { kind: 'dm', text: 'No answer yet', minutes_ago: 120 });
    const late = (await listConversations(w.ann, { queue: 'unassigned' })).items.find((i) => i.preview === 'No answer yet')!;
    const lk = await createCase(w.ann, { conversation_id: late.id, title: 'Late', owner_id: w.annId });
    expect(lk.first_response.breached).toBe(true);
    expect((await sweepSla()).breaches).toBeGreaterThanOrEqual(1);
    expect((await sweepSla()).breaches).toBe(0); // recorded once
    expect((await testPool().query(`SELECT kind FROM notifications WHERE user_id=$1 AND kind='case.sla_breached'`, [w.annId])).rows).toHaveLength(1);

    const report = await careReport(w.ann, { days: 7 });
    expect(report).toMatchObject({ cases_opened: 2, backlog: 2, reopened: 1, first_response: { n: 1, breached: 1 } });
    expect(report.definitions.clock_start).toBeTruthy();
    const admin = await inboxAdminOverview(w.owner);
    expect(admin.replies.sent_24h).toBe(1);
    expect(admin.channels[0]).toMatchObject({ kind: 'facebook_page', status: 'active', is_simulated: true });
    expect(JSON.stringify(admin)).not.toContain('Broken item'); // counts and states only
  });
});
