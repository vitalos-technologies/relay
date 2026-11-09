// V3.5 stream B — remaining inbox networks on their SIMULATED transports, through the real policy path (v2Ctx) and
// real Postgres: Instagram, WhatsApp (templates, 24 h window, charges), Google Business Profile reviews (AT4),
// YouTube / Bluesky / Threads polling + cursors, Telegram webhook ownership, moderation, attachments, identity linking,
// CSAT, revocation (AT12) and provider outages (AT13).
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectMock } from '@social-lite/services/connections/index';
import { createSimulatedIntegration, ingestIntegrationWebhook, processIntegrationEvent } from '@social-lite/services/connectors/index';
import { createHmac } from 'node:crypto';
import {
  checkTelegramWebhook, claimTelegramWebhook, csatReport, csatState, customerProfile, dispatchReply, enableChannel, enableIntegrationChannel, getConversation,
  ingestWhatsAppPayload, integrationAccounts, registerInboxMoreHandlers, linkIdentity, listConversations, listTemplates, moderateMessage, openAttachment, pollChannel, processInboundEvents,
  receiveTelegramUpdate, reconcileUnknownReplies, releaseTelegramWebhook, requestCsat, requestReply, resolveUnknownReply, setCsatEnabled, simulateInbound, unlinkIdentity,
} from '@social-lite/services/inbox/index';
import { DbMockStore } from '@social-lite/services/mock-store';
import { ensureBucket } from '@social-lite/services/storage';
import { decryptSecret, settingAad } from '@social-lite/services/crypto';
import { recordSimulatedTelegramWebhook, simulatedTelegramSent } from '@social-lite/providers/telegram/inbox-fake';
import { simulatedWhatsAppSent } from '@social-lite/providers/whatsapp/inbox-fake';
import { simulatedReview } from '@social-lite/providers/google-business/inbox-fake';
import type { Ctx } from '@social-lite/services';
import { addMember, closeTestPool, createBrand, createUser, createWorkspace, grant, testPool, v2Ctx } from './helpers.js';

afterAll(async () => { await closeTestPool(); });
beforeAll(async () => { testPool(); await ensureBucket().catch(() => undefined); });

const key = () => randomUUID().replace(/-/g, '');
const store = () => new DbMockStore(testPool());

async function member(ws: string, role: string, brandId?: string, name = 'Member') {
  const u = await createUser(undefined, name);
  await testPool().query(`INSERT INTO memberships(workspace_id, user_id, role) VALUES ($1,$2,'viewer')`, [ws, u.id]);
  await grant(ws, u.id, role, brandId);
  return u;
}

interface World { ws: string; brand: string; brandB: string; owner: Ctx; agent: Ctx; agentId: string; viewer: Ctx; outsider: Ctx }
async function world(): Promise<World> {
  const ws = await createWorkspace('Inbox B');
  const brand = await createBrand(ws, 'Care brand');
  const brandB = await createBrand(ws, 'Other brand');
  const o = await createUser(undefined, 'Olive Owner');
  await addMember(ws, o.id, 'owner');
  const a = await member(ws, 'care_agent', brand, 'Ann Agent');
  const v = await member(ws, 'viewer', brand, 'Vic Viewer');
  const x = await member(ws, 'care_agent', brandB, 'Otto Outsider');
  return { ws, brand, brandB, owner: await v2Ctx(o.id, ws), agent: await v2Ctx(a.id, ws), agentId: a.id, viewer: await v2Ctx(v.id, ws), outsider: await v2Ctx(x.id, ws) };
}

async function socialChannel(w: World, provider: 'instagram' | 'telegram' | 'youtube' | 'bluesky' | 'threads', scenario = 'success') {
  const conn = await connectMock(w.owner, w.brand, { provider, display_name: `Simulated ${provider}`, scenario });
  const ch = await enableChannel(w.owner, { connection_id: conn.id });
  return { conn, ch };
}

async function only(w: World, ctx: Ctx = w.agent, q: Record<string, string> = {}) {
  const l = await listConversations(ctx, { queue: 'all', ...q });
  return getConversation(ctx, l.items[0]!.id);
}

async function send(ctx: Ctx, convId: string, body: string, mode: 'public_reply' | 'private_message', extra: Record<string, unknown> = {}) {
  const c = await getConversation(ctx, convId);
  const r = await requestReply(ctx, convId, { mode, body, base_version: c.version, idempotency_key: key(), ...extra } as never);
  return { attempt: r.attempt, state: await dispatchReply(r.attempt.id, 'test') };
}

describe('V3.5 stream B — Instagram', () => {
  it('DMs, comments, private reply once, moderation; unknown send reconciled (AT1, AT13)', async () => {
    const w = await world();
    const { conn, ch } = await socialChannel(w, 'instagram');
    expect(ch.status).toBe('active');
    await simulateInbound(w.owner, ch.id, { kind: 'dm', text: 'Is the oat latte vegan?', name: 'Cara' });
    let c = await only(w);
    expect(c).toMatchObject({ kind: 'dm', visibility: 'private', channel: { kind: 'instagram', is_simulated: true }, contact: { name: 'Cara' } });
    const r = await send(w.agent, c.id, 'Yes, fully vegan.', 'private_message');
    expect(r.state).toBe('sent');
    const sent = (await store().list('instagram', conn.provider_account_id, 'ig_dm')).filter((o) => o.data.from === 'business');
    expect(sent.map((o) => o.data.text)).toEqual(['Yes, fully vegan.']);

    await simulateInbound(w.owner, ch.id, { kind: 'comment', text: 'Love this!', name: 'Dan' });
    c = await only(w, w.agent, { kind: 'comment' });
    expect(c.reply.modes.map((m) => [m.mode, m.allowed])).toEqual([['public_reply', true], ['private_message', true]]);
    expect((await send(w.agent, c.id, 'Thank you!', 'public_reply')).state).toBe('sent');
    expect((await send(w.agent, c.id, 'Sent you a code privately', 'private_message')).state).toBe('sent');
    const again = await getConversation(w.agent, c.id);
    expect(again.reply.modes.find((m) => m.mode === 'private_message')).toMatchObject({ allowed: false });

    // Moderation: hide the customer's comment; the agent's own reply can be deleted; an inbound comment cannot.
    const inbound = again.timeline.find((t) => t.type === 'message' && t.message.direction === 'inbound');
    const own = again.timeline.find((t) => t.type === 'message' && t.message.direction === 'outbound');
    if (inbound?.type !== 'message' || own?.type !== 'message') throw new Error('timeline');
    expect(inbound.message.moderation).toEqual(['hide']);
    expect(own.message.moderation).toEqual(['delete_own']);
    await expect(moderateMessage(w.viewer, inbound.message.id, 'hide')).rejects.toMatchObject({ code: 'not_found' });
    expect(await moderateMessage(w.agent, inbound.message.id, 'hide')).toEqual({ state: 'done', message: null });
    expect((await store().get('instagram', inbound.message.external_id!))?.data.hidden).toBe(true);
    await expect(moderateMessage(w.agent, inbound.message.id, 'delete_own')).rejects.toMatchObject({ code: 'invalid_state' });
    expect((await moderateMessage(w.agent, own.message.id, 'delete_own')).state).toBe('done');
    const after = await getConversation(w.agent, c.id);
    const m2 = after.timeline.find((t) => t.type === 'message' && t.message.id === inbound.message.id);
    expect(m2?.type === 'message' && m2.message).toMatchObject({ hidden: true, moderation: ['unhide'] });
  });

  it('AT13: a lost response becomes Unknown and is reconciled from the provider, never resent', async () => {
    const w = await world();
    const { conn, ch } = await socialChannel(w, 'instagram', 'timeout_after_send');
    await simulateInbound(w.owner, ch.id, { kind: 'dm', text: 'Hello?' });
    const c = await only(w);
    const r = await send(w.agent, c.id, 'Hi there', 'private_message');
    expect(r.state).toBe('unknown');
    await testPool().query(`UPDATE inbox_reply_attempts SET reconcile_after=now() WHERE id=$1`, [r.attempt.id]);
    expect((await reconcileUnknownReplies(10)).resolved).toBe(1);
    const sent = (await store().list('instagram', conn.provider_account_id, 'ig_dm')).filter((o) => o.data.from === 'business');
    expect(sent).toHaveLength(1);
    const a = await testPool().query(`SELECT state, provider_result FROM inbox_reply_attempts WHERE id=$1`, [r.attempt.id]);
    expect(a.rows[0]).toMatchObject({ state: 'sent', provider_result: { reconciled: true } });
  });
});

describe('V3.5 stream B — WhatsApp', () => {
  async function wa(w: World) {
    const i = await createSimulatedIntegration(w.owner, { connector: 'whatsapp', brand_id: w.brand });
    const acc = await integrationAccounts(w.owner, i.id);
    expect(acc.items).toHaveLength(1);
    const ch = await enableIntegrationChannel(w.owner, { integration_id: i.id, account_id: acc.items[0]!.account_id });
    await listTemplates(w.owner, ch.id, true);
    return { i, ch };
  }

  it('24 h window, templates with the charge shown before sending, statuses with pricing, receipts', async () => {
    const w = await world();
    const { i, ch } = await wa(w);
    expect(ch).toMatchObject({ kind: 'whatsapp', status: 'active', is_simulated: true });
    const tpl = await listTemplates(w.agent, ch.id);
    expect(tpl.items.map((t) => t.name)).toContain('order_update');

    // Customer wrote 25 h ago: free-form is refused, a template is required and its charge must be acknowledged.
    await simulateInbound(w.owner, ch.id, { kind: 'dm', text: 'Where is my order?', name: 'Wes', minutes_ago: 25 * 60 });
    let c = await only(w);
    expect(c.reply.modes.find((m) => m.mode === 'private_message')).toMatchObject({ allowed: false });
    await expect(requestReply(w.agent, c.id, { mode: 'private_message', body: 'Hi', base_version: c.version, idempotency_key: key() })).rejects.toMatchObject({ details: { reason: 'reply_window_closed' } });
    const template = { name: 'we_miss_you', language: 'en', params: ['Wes'] };
    await expect(requestReply(w.agent, c.id, { mode: 'private_message', body: 'template', base_version: c.version, idempotency_key: key(), template } as never))
      .rejects.toMatchObject({ details: { reason: 'charge_ack_required', charge: { billable: true, category: 'marketing' } } });
    await expect(requestReply(w.agent, c.id, { mode: 'private_message', body: 'template', base_version: c.version, idempotency_key: key(), template: { ...template, name: 'old_promo', params: [] }, acknowledge_charge: true } as never))
      .rejects.toMatchObject({ code: 'validation_failed' });
    const t = await send(w.agent, c.id, 'template', 'private_message', { template, acknowledge_charge: true });
    expect(t.state).toBe('sent');
    expect(t.attempt).toMatchObject({ body: 'Hi Wes, it has been a while. Reply to this message and we will help.', charge: { billable: true, category: 'marketing' }, template: { name: 'we_miss_you' } });
    const sent = await simulatedWhatsAppSent({ store: store() }, (await testPool().query(`SELECT external_account_id FROM integration_connections WHERE id=$1`, [i.id])).rows[0].external_account_id);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ template: 'we_miss_you', callback: `relay-attempt:${t.attempt.id}` });

    // Customer writes again → window open: free-form is within the free service tier; a utility template inside the
    // window is CHARGED since Meta's 2026-10-01 change (H2), so it needs the acknowledgement too.
    await simulateInbound(w.owner, ch.id, { kind: 'dm', text: 'Thanks', thread: sent[0]!.waId });
    c = await only(w);
    expect(c.reply.service_charge).toMatchObject({ billable: false, category: 'service' });
    const free = await send(w.agent, c.id, 'You are welcome!', 'private_message');
    expect(free.state).toBe('sent');
    expect(free.attempt.charge).toMatchObject({ billable: false, category: 'service' });
    const utility = { name: 'order_update', language: 'en', params: ['Wes', '#42'] };
    c = await getConversation(w.agent, c.id);
    await expect(requestReply(w.agent, c.id, { mode: 'private_message', body: 'template', base_version: c.version, idempotency_key: key(), template: utility } as never))
      .rejects.toMatchObject({ details: { reason: 'charge_ack_required', charge: { billable: true, category: 'utility' } } });
    const u = await send(w.agent, c.id, 'template', 'private_message', { template: utility, acknowledge_charge: true });
    expect(u.state).toBe('sent');
    expect(u.attempt.charge).toMatchObject({ billable: true, category: 'utility' });

    // Status webhook: delivered/read receipts + actual pricing from the provider.
    const phone = ch.external_account_id;
    const msgId = sent[0]!.id;
    await ingestWhatsAppPayload({ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: phone }, statuses: [
      { id: msgId, status: 'delivered', timestamp: '1', recipient_id: sent[0]!.waId, pricing: { billable: true, pricing_model: 'PMP', category: 'marketing', type: 'regular' } },
      { id: msgId, status: 'read', timestamp: '2', recipient_id: sent[0]!.waId },
    ] } }] }] }, true);
    const d = await getConversation(w.agent, c.id);
    const out = d.timeline.find((x) => x.type === 'message' && x.message.external_id === msgId);
    expect(out?.type === 'message' && out.message).toMatchObject({ delivery: 'read', pricing: { billable: true, category: 'marketing' } });
  });

  it('service replies are charged once the number has used its 1,000 free service messages this month (H2)', async () => {
    const w = await world();
    const { ch } = await wa(w);
    await simulateInbound(w.owner, ch.id, { kind: 'dm', text: 'Hello?', name: 'Ola' });
    let c = await only(w);
    const first = await send(w.agent, c.id, 'Hi Ola', 'private_message');
    expect(first.attempt.charge).toMatchObject({ billable: false, category: 'service' });
    // 998 more service messages sent through Relay this month on the same number → 999 used: one free message left.
    await testPool().query(
      `INSERT INTO inbox_reply_attempts SELECT (jsonb_populate_record(NULL::inbox_reply_attempts, to_jsonb(a) || jsonb_build_object('id', gen_random_uuid(),
         'idempotency_key', 'bulk-' || g, 'state', 'sent', 'provider_message_id', NULL))).* FROM inbox_reply_attempts a, generate_series(1, 998) g WHERE a.id=$1`, [first.attempt.id]);
    c = await getConversation(w.agent, c.id);
    expect(c.reply.service_charge).toMatchObject({ billable: false });
    expect((await send(w.agent, c.id, 'The 1,000th', 'private_message')).attempt.charge).toMatchObject({ billable: false });
    // Allowance used: the next one is charged and must be acknowledged before anything is queued.
    c = await getConversation(w.agent, c.id);
    expect(c.reply.service_charge).toMatchObject({ billable: true, category: 'service' });
    await expect(requestReply(w.agent, c.id, { mode: 'private_message', body: 'One more', base_version: c.version, idempotency_key: key() }))
      .rejects.toMatchObject({ details: { reason: 'charge_ack_required', charge: { billable: true, category: 'service' } } });
    const charged = await send(w.agent, c.id, 'One more', 'private_message', { acknowledge_charge: true });
    expect(charged.state).toBe('sent');
    expect(charged.attempt.charge).toMatchObject({ billable: true, category: 'service' });
  });

  it('a service message Meta already priced as billable this month means the free tier is used up, even if Relay counted fewer (H2)', async () => {
    const w = await world();
    const { i, ch } = await wa(w);
    await simulateInbound(w.owner, ch.id, { kind: 'dm', text: 'Hello?', name: 'Pia' });
    const c = await only(w);
    const r = await send(w.agent, c.id, 'Hi Pia', 'private_message');
    const sent = await simulatedWhatsAppSent({ store: store() }, (await testPool().query(`SELECT external_account_id FROM integration_connections WHERE id=$1`, [i.id])).rows[0].external_account_id);
    const mine = sent.find((x) => x.callback === `relay-attempt:${r.attempt.id}`)!;
    await ingestWhatsAppPayload({ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: ch.external_account_id }, statuses: [
      { id: mine.id, status: 'delivered', timestamp: '1', recipient_id: mine.waId, pricing: { billable: true, pricing_model: 'PMP', category: 'service', type: 'regular' } },
    ] } }] }] }, true);
    const d = await getConversation(w.agent, c.id);
    expect(d.reply.service_charge).toMatchObject({ billable: true, category: 'service' });
    await expect(requestReply(w.agent, c.id, { mode: 'private_message', body: 'Again', base_version: d.version, idempotency_key: key() }))
      .rejects.toMatchObject({ details: { reason: 'charge_ack_required' } });
  });

  it('AT13: lost send response confirmed by the status webhook marker; attachments fetched safely on request', async () => {
    const w = await world();
    const { i, ch } = await wa(w);
    await testPool().query(`UPDATE inbox_channels SET settings = settings || '{"mock_scenario":"timeout_after_send"}'::jsonb WHERE id=$1`, [ch.id]);
    await simulateInbound(w.owner, ch.id, { kind: 'dm', text: 'Photo of the damage', attachment: true });
    const c = await only(w);
    const r = await send(w.agent, c.id, 'Sorry! Refund on its way.', 'private_message');
    expect(r.state).toBe('unknown');
    await testPool().query(`UPDATE inbox_reply_attempts SET reconcile_after=now() WHERE id=$1`, [r.attempt.id]);
    expect((await reconcileUnknownReplies(10)).resolved).toBe(0);      // no list API: never guessed
    const sent = await simulatedWhatsAppSent({ store: store() }, (await testPool().query(`SELECT external_account_id FROM integration_connections WHERE id=$1`, [i.id])).rows[0].external_account_id);
    expect(sent).toHaveLength(1);
    await ingestWhatsAppPayload({ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: ch.external_account_id }, statuses: [
      { id: sent[0]!.id, status: 'sent', timestamp: '1', recipient_id: sent[0]!.waId, biz_opaque_callback_data: `relay-attempt:${r.attempt.id}` },
    ] } }] }] }, true);
    expect((await testPool().query(`SELECT state, provider_message_id FROM inbox_reply_attempts WHERE id=$1`, [r.attempt.id])).rows[0]).toEqual({ state: 'sent', provider_message_id: sent[0]!.id });

    const msg = (await getConversation(w.agent, c.id)).timeline.find((x) => x.type === 'message' && x.message.direction === 'inbound');
    if (msg?.type !== 'message') throw new Error('no message');
    expect(msg.message.attachment_state).toEqual(['available']);
    await expect(openAttachment(w.outsider, msg.message.id, 0)).rejects.toMatchObject({ code: 'not_found' });
    const f = await openAttachment(w.agent, msg.message.id, 0);
    expect(f.mime).toBe('image/png');
    expect(f.bytes.subarray(1, 4).toString()).toBe('PNG');
    const again = await openAttachment(w.agent, msg.message.id, 0);   // second open: from private storage
    expect(again.bytes.equals(f.bytes)).toBe(true);
    expect((await testPool().query(`SELECT state, mime FROM inbox_attachments WHERE message_id=$1`, [msg.message.id])).rows[0]).toEqual({ state: 'stored', mime: 'image/png' });
  });
});

describe('V3.5 stream B — Google Business Profile reviews (AT4)', () => {
  it('a review becomes an inbox item and an authorized owner reply reaches the correct location only', async () => {
    const w = await world();
    const i = await createSimulatedIntegration(w.owner, { connector: 'google_business_profile', brand_id: w.brand });
    const acc = await integrationAccounts(w.owner, i.id);
    expect(acc.items).toHaveLength(2);
    const [l1, l2] = acc.items;
    const ch1 = await enableIntegrationChannel(w.owner, { integration_id: i.id, account_id: l1!.account_id });
    const ch2 = await enableIntegrationChannel(w.owner, { integration_id: i.id, account_id: l2!.account_id });
    await simulateInbound(w.owner, ch1.id, { kind: 'review', text: 'Great coffee, slow service.', rating: 3, name: 'Rita' });
    await simulateInbound(w.owner, ch2.id, { kind: 'review', text: 'Perfect!', rating: 5, name: 'Sol' });
    const list = await listConversations(w.agent, { queue: 'all', kind: 'review' });
    expect(list.items).toHaveLength(2);
    const conv = await getConversation(w.agent, list.items.find((x) => x.channel.id === ch1.id)!.id);
    const rev = conv.timeline.find((t) => t.type === 'message');
    expect(rev?.type === 'message' && rev.message).toMatchObject({ body: 'Great coffee, slow service.', rating: 3, moderation: [] });
    expect(conv.reply.modes).toEqual([
      { mode: 'public_reply', allowed: true, reason: null, window_ends_at: null },
      expect.objectContaining({ mode: 'private_message', allowed: false }),
    ]);
    // Not authorized: viewer (no inbox access) and another brand's agent.
    await expect(requestReply(w.viewer, conv.id, { mode: 'public_reply', body: 'x', base_version: conv.version, idempotency_key: key() })).rejects.toMatchObject({ code: 'not_found' });
    await expect(requestReply(w.outsider, conv.id, { mode: 'public_reply', body: 'x', base_version: conv.version, idempotency_key: key() })).rejects.toMatchObject({ code: 'not_found' });
    const r = await send(w.agent, conv.id, 'Thanks Rita — we are adding a second barista at peak times.', 'public_reply');
    expect(r.state).toBe('sent');
    const reviewId = rev?.type === 'message' ? rev.message.external_id!.slice('review:'.length) : '';
    const at1 = await simulatedReview({ store: store() }, reviewId);
    expect(at1).toMatchObject({ location: l1!.account_id, reply: { comment: 'Thanks Rita — we are adding a second barista at peak times.' } });
    const other = (await store().list('youtube', (await testPool().query(`SELECT external_account_id FROM integration_connections WHERE id=$1`, [i.id])).rows[0].external_account_id, 'gbp_review')).filter((o) => o.data.location === l2!.account_id);
    expect(other.every((o) => o.data.reply === null)).toBe(true);
    // The next poll sees the owner reply as the same message (no duplicate).
    await pollChannel(ch1.id);
    const after = await getConversation(w.agent, conv.id);
    expect(after.timeline.filter((t) => t.type === 'message' && t.message.direction === 'outbound')).toHaveLength(1);
    // Update the owner reply (a new version), then delete it: only the OWNER reply; the review stays.
    expect((await send(w.agent, conv.id, 'Update: second barista starts Monday.', 'public_reply')).state).toBe('sent');
    expect((await simulatedReview({ store: store() }, reviewId))?.reply?.comment).toBe('Update: second barista starts Monday.');
    const latest = (await getConversation(w.agent, conv.id)).timeline.filter((t) => t.type === 'message' && t.message.direction === 'outbound').pop();
    if (latest?.type !== 'message') throw new Error('no reply');
    expect(latest.message.moderation).toEqual(['delete_own']);
    expect((await moderateMessage(w.agent, latest.message.id, 'delete_own')).state).toBe('done');
    expect((await simulatedReview({ store: store() }, reviewId))).toMatchObject({ reply: null, location: l1!.account_id });
    const cur = await testPool().query(`SELECT cursor, last_success_at FROM integration_cursors WHERE channel_id=$1 AND scope='inbox:poll'`, [ch1.id]);
    expect(cur.rows[0].cursor).toBeTruthy();
  });
});

describe('V3.5 stream B — polling networks', () => {
  it('YouTube: comments by polling with a cursor, replies counted once, hide/unhide', async () => {
    const w = await world();
    const { conn, ch } = await socialChannel(w, 'youtube');
    await simulateInbound(w.owner, ch.id, { kind: 'comment', text: 'Which grinder is that?', name: 'Gus' });
    const c = await only(w);
    expect(c).toMatchObject({ kind: 'comment', channel: { kind: 'youtube' } });
    expect((await send(w.agent, c.id, 'A conical burr grinder.', 'public_reply')).state).toBe('sent');
    const p = await pollChannel(ch.id);
    expect(p).toMatchObject({ state: 'ok', result: { messages: 0 } });
    const d = await getConversation(w.agent, c.id);
    expect(d.timeline.filter((t) => t.type === 'message')).toHaveLength(2);
    const inbound = d.timeline.find((t) => t.type === 'message' && t.message.direction === 'inbound');
    if (inbound?.type !== 'message') throw new Error('no inbound');
    expect((await moderateMessage(w.agent, inbound.message.id, 'hide')).state).toBe('done');
    expect((await store().get('youtube', inbound.message.external_id!))?.data.status).toBe('heldForReview');
    void conn;
  });

  it('Bluesky: replies, mentions and DMs; Threads: replies + hide', async () => {
    const w = await world();
    const { ch } = await socialChannel(w, 'bluesky');
    await simulateInbound(w.owner, ch.id, { kind: 'comment', text: '@relay are you open Sunday?' });
    await simulateInbound(w.owner, ch.id, { kind: 'mention', text: 'Best flat white in town @relay' });
    await simulateInbound(w.owner, ch.id, { kind: 'dm', text: 'Can I book the back room?' });
    const l = await listConversations(w.agent, { queue: 'all' });
    expect(l.items.map((x) => x.kind).sort()).toEqual(['comment', 'dm', 'mention']);
    for (const it of l.items) {
      const r = await send(w.agent, it.id, it.kind === 'dm' ? 'Yes — DM us a date.' : 'Thanks!', it.kind === 'dm' ? 'private_message' : 'public_reply');
      expect(r.state).toBe('sent');
    }
    const replies = await store().list('bluesky', (await testPool().query(`SELECT provider_account_id FROM connections WHERE id=(SELECT connection_id FROM inbox_channels WHERE id=$1)`, [ch.id])).rows[0].provider_account_id, 'bsky_reply');
    expect(replies.every((o) => (o.data.value as { reply?: unknown }).reply)).toBe(true);
    expect(replies).toHaveLength(2);

    const th = await socialChannel(w, 'threads');
    await simulateInbound(w.owner, th.ch.id, { kind: 'comment', text: 'Price of the beans?' });
    const tc = (await listConversations(w.agent, { queue: 'all', channel_id: th.ch.id })).items[0]!;
    expect((await send(w.agent, tc.id, '£12 per bag.', 'public_reply')).state).toBe('sent');
    const inbound = (await getConversation(w.agent, tc.id)).timeline.find((t) => t.type === 'message' && t.message.direction === 'inbound');
    if (inbound?.type !== 'message') throw new Error('no inbound');
    expect((await moderateMessage(w.agent, inbound.message.id, 'hide')).state).toBe('done');
    await pollChannel(th.ch.id);
    expect((await getConversation(w.agent, tc.id)).timeline.filter((t) => t.type === 'message')).toHaveLength(2);
  });
});

describe('V3.5 stream B — Telegram webhook ownership', () => {
  it('never overwrites an existing webhook; claims only after an explicit confirmation; verified, deduplicated updates', async () => {
    const w = await world();
    const { conn, ch } = await socialChannel(w, 'telegram');
    expect(ch).toMatchObject({ status: 'needs_permission', missing_permissions: ['telegram_updates'] });
    const bot = conn.provider_account_id;

    // Another app owns the bot's webhook ⇒ Relay refuses and changes nothing.
    await recordSimulatedTelegramWebhook({ store: store() }, bot, 'https://other-app.example/hook');
    const chk = await checkTelegramWebhook(w.owner, ch.id);
    expect(chk.webhook).toMatchObject({ owner: 'external', external_host: 'other-app.example' });
    await expect(claimTelegramWebhook(w.owner, ch.id, { confirm_no_other_consumer: true })).rejects.toMatchObject({ code: 'conflict', details: { reason: 'webhook_in_use' } });
    expect((await store().get('telegram', `mock_webhook_${bot.replace(/^mock_/, '')}`))?.data.url).toBe('https://other-app.example/hook');
    await expect(claimTelegramWebhook(w.agent, ch.id, { confirm_no_other_consumer: true })).rejects.toMatchObject({ code: 'forbidden' });

    // Free bot (nobody's webhook): claim with the explicit confirmation; Relay re-checks right before setWebhook.
    await recordSimulatedTelegramWebhook({ store: store() }, bot, '');
    const claimed = await claimTelegramWebhook(w.owner, ch.id, { confirm_no_other_consumer: true });
    expect(claimed.channel).toMatchObject({ status: 'active', options: { telegram: { owner: 'relay' } } });
    expect(String((await store().get('telegram', `mock_webhook_${bot.replace(/^mock_/, '')}`))?.data.url)).toBe(`http://localhost:3000/api/inbox/telegram/${ch.id}`);

    // Receiver: wrong secret refused; right secret persisted + deduplicated, then processed.
    const enc = (await testPool().query(`SELECT secret_enc FROM inbox_channels WHERE id=$1`, [ch.id])).rows[0].secret_enc;
    const secret = decryptSecret<string>(enc, settingAad(`inbox-channel:${ch.id}:webhook`));
    const update = { update_id: 900001, message: { message_id: 11, date: Math.floor(Date.now() / 1000), chat: { id: 5551234, type: 'private' }, from: { id: 5551234, is_bot: false, first_name: 'Tia' }, text: 'Do you deliver?' } };
    expect((await receiveTelegramUpdate(ch.id, JSON.stringify(update), 'wrong')).status).toBe(401);
    expect(await receiveTelegramUpdate(ch.id, JSON.stringify(update), secret)).toEqual({ status: 200, body: { ok: true, duplicate: false } });
    expect(await receiveTelegramUpdate(ch.id, JSON.stringify(update), secret)).toEqual({ status: 200, body: { ok: true, duplicate: true } });
    await processInboundEvents(ch.id);
    const c = await only(w);
    expect(c).toMatchObject({ kind: 'dm', contact: { name: 'Tia' } });
    // The simulated chat must exist for the fake to accept a send.
    const { recordSimulatedTelegramChat } = await import('@social-lite/providers/telegram/inbox-fake');
    await recordSimulatedTelegramChat({ store: store() }, bot, { chatId: 5551234, type: 'private' });
    expect((await send(w.agent, c.id, 'Yes, within 3 miles.', 'private_message')).state).toBe('sent');
    expect((await simulatedTelegramSent({ store: store() }, bot)).map((m) => m.text)).toEqual(['Yes, within 3 miles.']);

    // Release removes ONLY Relay's webhook.
    const rel = await releaseTelegramWebhook(w.owner, ch.id);
    expect(rel.channel).toMatchObject({ status: 'needs_permission' });
    expect((await store().get('telegram', `mock_webhook_${bot.replace(/^mock_/, '')}`))?.data.url).toBe('');
  });

  it('Telegram: an unconfirmed send is left for a person (no lookup API exists)', async () => {
    const w = await world();
    const { ch } = await socialChannel(w, 'telegram', 'timeout_after_send');
    await checkTelegramWebhook(w.owner, ch.id);
    await claimTelegramWebhook(w.owner, ch.id, { confirm_no_other_consumer: true });
    await simulateInbound(w.owner, ch.id, { kind: 'dm', text: 'Open late?' });
    const c = await only(w);
    const r = await send(w.agent, c.id, 'Until 8pm.', 'private_message');
    expect(r.state).toBe('unknown');
    await testPool().query(`UPDATE inbox_reply_attempts SET reconcile_after=now() WHERE id=$1`, [r.attempt.id]);
    await reconcileUnknownReplies(10);
    expect((await testPool().query(`SELECT state FROM inbox_reply_attempts WHERE id=$1`, [r.attempt.id])).rows[0].state).toBe('unknown');
    expect((await resolveUnknownReply(w.agent, r.attempt.id, 'sent')).state).toBe('sent');
  });
});

describe('V3.5 stream B — CSAT, identity linking, revocation (AT12)', () => {
  it('CSAT only when enabled, only explicit 1–5 answers count, report shows denominators', async () => {
    const w = await world();
    const { ch } = await socialChannel(w, 'instagram');
    await simulateInbound(w.owner, ch.id, { kind: 'dm', text: 'Thanks for the help', name: 'Kim' });
    const c = await only(w);
    expect((await csatState(w.agent, c.id)).available).toBe(false);
    await expect(requestCsat(w.agent, c.id, { idempotency_key: key() })).rejects.toMatchObject({ code: 'invalid_state' });
    await expect(setCsatEnabled(w.agent, ch.id, true)).rejects.toMatchObject({ code: 'forbidden' });
    await setCsatEnabled(w.owner, ch.id, true);
    const s = await requestCsat(w.agent, c.id, { idempotency_key: key() });
    expect(s.request?.state).toBe('sending');
    await expect(requestCsat(w.agent, c.id, { idempotency_key: key() })).rejects.toMatchObject({ code: 'conflict' });
    const att = (await testPool().query(`SELECT id FROM inbox_reply_attempts WHERE conversation_id=$1 AND purpose='csat'`, [c.id])).rows[0].id;
    expect(await dispatchReply(att, 't')).toBe('sent');
    const thread = (await getConversation(w.agent, c.id)).timeline.find((t) => t.type === 'message' && t.message.direction === 'inbound');
    void thread;
    const igsid = (await testPool().query(`SELECT external_thread_id FROM inbox_conversations WHERE id=$1`, [c.id])).rows[0].external_thread_id.slice('igsid:'.length);
    await simulateInbound(w.owner, ch.id, { kind: 'dm', text: 'You were great', thread: igsid });
    expect((await csatState(w.agent, c.id)).request?.state).toBe('open');      // not a score
    await simulateInbound(w.owner, ch.id, { kind: 'dm', text: '5', thread: igsid });
    expect((await csatState(w.agent, c.id)).request).toMatchObject({ state: 'answered', score: 5 });
    const rep = await csatReport(w.owner, { days: 30 });
    expect(rep).toMatchObject({ sent: 1, responses: 1, response_rate: 1, average: 5, distribution: { 5: 1 } });
    expect((await csatReport(w.outsider, { days: 30 })).sent).toBe(0);
  });

  it('identity linking is explicit, reversible and audited; history kept', async () => {
    const w = await world();
    const { ch } = await socialChannel(w, 'instagram');
    await simulateInbound(w.owner, ch.id, { kind: 'dm', text: 'Hi', name: 'Same Name' });
    await simulateInbound(w.owner, ch.id, { kind: 'comment', text: 'Hi again', name: 'Same Name' });
    const [a, b] = (await listConversations(w.agent, { queue: 'all' })).items;
    let p = await customerProfile(w.agent, a!.id);
    expect(p).toMatchObject({ customer: null, can_link: true });   // same name ⇒ nothing linked automatically
    await expect(linkIdentity(w.viewer, a!.id, { new_customer_name: 'X', reason: 'test' })).rejects.toBeTruthy();
    p = await linkIdentity(w.agent, a!.id, { new_customer_name: 'Sam N.', reason: 'Confirmed order number in DM' });
    expect(p.customer?.name).toBe('Sam N.');
    await expect(linkIdentity(w.agent, a!.id, { new_customer_name: 'Again', reason: 'dup' })).rejects.toMatchObject({ code: 'conflict' });
    const p2 = await linkIdentity(w.agent, b!.id, { customer_id: p.customer!.id, reason: 'Same person confirmed in comment' });
    expect(p2.identities).toHaveLength(2);
    expect(p2.conversations.map((c) => c.id)).toContain(a!.id);
    const un = await unlinkIdentity(w.agent, b!.id, { reason: 'Wrong person' });
    expect(un.customer).toBeNull();
    expect(un.history.map((h) => [h.action, h.reason])).toEqual([['unlinked', 'Wrong person'], ['linked', 'Same person confirmed in comment']]);
    const aud = await testPool().query(`SELECT action FROM audit_events WHERE workspace_id=$1 AND action LIKE 'inbox.identity_%' ORDER BY id`, [w.ws]);
    expect(aud.rows.map((r) => r.action)).toEqual(['inbox.identity_linked', 'inbox.identity_linked', 'inbox.identity_unlinked']);
  });

  it('AT12: membership revocation immediately blocks inbox reads, moderation, attachments and queued replies', async () => {
    const w = await world();
    const { ch } = await socialChannel(w, 'youtube');
    await simulateInbound(w.owner, ch.id, { kind: 'comment', text: 'Nice video' });
    const c = await only(w);
    const r = await requestReply(w.agent, c.id, { mode: 'public_reply', body: 'Thanks', base_version: c.version, idempotency_key: key() });
    await testPool().query(`UPDATE memberships SET status='removed', removed_at=now() WHERE workspace_id=$1 AND user_id=$2`, [w.ws, w.agentId]);
    await testPool().query(`UPDATE scoped_role_grants SET revoked_at=now() WHERE workspace_id=$1 AND user_id=$2`, [w.ws, w.agentId]);
    expect(await dispatchReply(r.attempt.id, 't')).toBe('cancelled');
    await expect(v2Ctx(w.agentId, w.ws)).rejects.toBeTruthy();
  });
});

describe('V3.5 stream B — WhatsApp verified webhook ingress (live channel, no provider calls)', () => {
  it('rejects bad signatures, persists + dedupes verified events, routes only to the live channel of that number', async () => {
    const w = await world();
    process.env.META_APP_SECRET = 'stream-b-test-app-secret';
    registerInboxMoreHandlers();
    const waba = `${Date.now()}`.slice(-10);
    const phone = `9${waba}`;
    const integ = (await testPool().query(`INSERT INTO integration_connections(workspace_id, brand_id, connector, external_account_id, display_name, status, granted_scopes) VALUES ($1,$2,'whatsapp',$3,'Live WABA','active','{whatsapp_business_messaging,whatsapp_business_management}') RETURNING id`, [w.ws, w.brand, waba])).rows[0].id;
    await testPool().query(`INSERT INTO inbox_channels(workspace_id, brand_id, kind, integration_id, external_account_id, display_name, status, enabled_types) VALUES ($1,$2,'whatsapp',$3,$4,'+44 live','active','{dm}')`, [w.ws, w.brand, integ, phone]);
    const body = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: waba, changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: phone }, contacts: [{ wa_id: '447700900555', profile: { name: 'Lia' } }], messages: [{ from: '447700900555', id: `wamid.${waba}`, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: 'Hi from WhatsApp' } }] } }] }] });
    const sig = (k: string) => `sha256=${createHmac('sha256', k).update(body).digest('hex')}`;
    const req = (s: string) => ({ rawBody: body, headers: { 'x-hub-signature-256': s, 'content-type': 'application/json' }, method: 'POST', uri: '/api/connectors/webhooks/whatsapp' });
    expect((await ingestIntegrationWebhook('whatsapp', req(sig('wrong')), new URLSearchParams())).status).toBe(401);
    const ok = await ingestIntegrationWebhook('whatsapp', req(sig('stream-b-test-app-secret')), new URLSearchParams());
    expect(ok.status).toBe(200);
    expect(JSON.parse((await ingestIntegrationWebhook('whatsapp', req(sig('stream-b-test-app-secret')), new URLSearchParams())).body)).toMatchObject({ duplicate: true });
    const ev = (await testPool().query(`SELECT id FROM integration_events WHERE connector='whatsapp' ORDER BY received_at DESC LIMIT 1`)).rows[0].id;
    expect(await processIntegrationEvent(ev)).toBe('processed');
    const c = await only(w);
    expect(c).toMatchObject({ channel: { kind: 'whatsapp', is_simulated: false }, contact: { name: 'Lia', handle: '+447700900555' }, preview: 'Hi from WhatsApp' });
    delete process.env.META_APP_SECRET;
  });
});

