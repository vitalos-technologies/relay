// V5 marketing support widget (stream WID) against REAL PostgreSQL + REAL S3-compatible storage, through the real V4
// support service, the real outbox → worker notification handler and the real staff inbox. Covers brief §18 items
// 9 (visitor messages reach Platform support), 10 (staff replies return to the right widget conversation),
// 11 (another visitor cannot access it) and 12 (internal notes never appear publicly: API, polling deltas, session
// list, emails, attachments), plus §10 reliability (dedupe, missed-message recovery, rate limits, abuse controls,
// session expiry, cross-device verification) and the signed-in path (server-validated workspace).
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PlatformCtx } from '@social-lite/services/admin/platform';
import { handleEvent } from '@social-lite/services/engine/notify';
import { ensureBucket } from '@social-lite/services/storage';
import type { MailMessage } from '@social-lite/services/email';
import { getStaffTicket, listStaffTickets, staffNote, staffReply, updateTicket } from '@social-lite/services/support/staff';
import { getTicket, listTickets } from '@social-lite/services/support/tickets';
import { staffUploadIntent, completeStaffUpload } from '@social-lite/services/support/attachments';
import {
  createConversation, getConversation, openWidgetAttachment, sendMessage, setVisitorBlocked, widgetCompleteUpload, widgetSessionInfo, widgetUploadIntent,
  type MemberIdentity, type WidgetCaller,
} from '@social-lite/services/support/widget';
import { confirmVerification, requestVerification, setWidgetMailTransportForTests } from '@social-lite/services/support/widget-verify';
import { checkFormToken, issueFormToken, resolveWidgetSession, revokeWidgetSession, type WidgetSession } from '@social-lite/services/support/widget-session';
import { sweepWidget } from '@social-lite/services/support/widget-sweeps';
import { addMember, closeTestPool, createUser, createWorkspace, testPool } from './helpers.js';

const db = () => testPool();
const sent: MailMessage[] = [];
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
const SECRET_NOTE = 'INTERNAL: refund approved by finance, do not tell customer yet';

beforeAll(async () => {
  testPool(); await ensureBucket();
  setWidgetMailTransportForTests(async (m) => { sent.push(m); return true; });
  await setConfig({ widget_enabled: true });
});
afterAll(async () => { setWidgetMailTransportForTests(null); await closeTestPool(); });
beforeEach(async () => { await drain(); sent.length = 0; });

async function setConfig(v: Record<string, unknown>) {
  await db().query(`INSERT INTO system_flags(key, value, updated_by) VALUES ('marketing_config', $1::jsonb, 'test') ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`, [JSON.stringify(v)]);
}

async function drain(): Promise<number> {
  const rows = (await db().query<{ id: string; event_type: string; workspace_id: string | null; aggregate_id: string; payload: Record<string, unknown> }>(
    `SELECT id::text, event_type, workspace_id, aggregate_id, payload FROM outbox WHERE dispatch_state='pending' AND event_type LIKE 'support.%' ORDER BY id`)).rows;
  for (const e of rows) await handleEvent({ event_type: e.event_type, workspace_id: e.workspace_id, aggregate_id: e.aggregate_id, payload: e.payload });
  if (rows.length) await db().query(`UPDATE outbox SET dispatch_state='dispatched', dispatched_at=now() WHERE id = ANY($1::bigint[])`, [rows.map((r) => r.id)]);
  return rows.length;
}

async function staff(): Promise<PlatformCtx> {
  const u = await createUser(`staff-${randomUUID().slice(0, 8)}@relay.test`, 'Sam Support');
  await db().query(`INSERT INTO platform_operators(user_id, role, granted_via) VALUES ($1,'support','seed')`, [u.id]);
  return { actor: { userId: u.id, email: u.email, name: 'Sam Support', sessionId: randomUUID() }, role: 'support', assurance: { mfaVerified: true, authTime: new Date() }, correlationId: randomUUID() };
}

let ipSeq = 0;
const anon = (): WidgetCaller => ({ visitor: null, member: null, ip: `198.51.100.${++ipSeq % 250}-${randomUUID().slice(0, 6)}`, browser: 'firefox' });
const as = (c: WidgetCaller, visitor: WidgetSession | null): WidgetCaller => ({ ...c, visitor });
const oldToken = () => issueFormToken(Date.now() - 5000);

async function visitorStart(over: Record<string, unknown> = {}, caller = anon()) {
  const r = await createConversation(caller, {
    client_id: randomUUID(), name: 'Vera Visitor', email: `vera-${randomUUID().slice(0, 6)}@example.test`, message: 'Do you support Bluesky scheduling?',
    form_token: oldToken(), website: '', diagnostics: { route: '/?utm_source=x#pricing' }, ...over,
  });
  const session = r.newSession?.session ?? caller.visitor!;
  return { conv: r.conversation, caller: as(caller, session), token: r.newSession?.token ?? null, session };
}

async function memberOf(wsName = 'Acme') {
  const ws = await createWorkspace(wsName);
  const u = await createUser(undefined, 'Mia Member');
  await addMember(ws, u.id, 'editor');
  const member: MemberIdentity = { actor: { userId: u.id, email: u.email, name: 'Mia Member', sessionId: randomUUID() }, assurance: { mfaVerified: true, authTime: new Date().toISOString() },
    activeWorkspaceId: ws, csrfToken: 'x'.repeat(32) };
  return { ws, u, caller: { ...anon(), member } as WidgetCaller };
}

// ====================================================================== §18.9
describe('visitor messages reach Platform → Support (§18.9)', () => {
  it('creates a widget ticket with visitor identity, source, safe diagnostics, and notifies staff', async () => {
    const s = await staff();
    const { conv, session, token } = await visitorStart();
    expect(token).toBeTruthy(); // HttpOnly cookie value (route layer sets it)
    expect(conv.reference).toMatch(/^RLY-\d{6}$/);
    expect(conv.kind).toBe('visitor');
    expect(conv.messages.map((m) => [m.author.kind, m.author.mine, m.body])).toEqual([['visitor', true, 'Do you support Bluesky scheduling?']]);
    const list = await listStaffTickets(s, { q: conv.reference });
    expect(list.items).toHaveLength(1);
    const row = list.items[0]!;
    expect(row).toMatchObject({ source: 'widget', requester_kind: 'visitor', workspace: null, category: 'general', status: 'new', assignee: null });
    expect(row.requester).toMatchObject({ id: null, name: 'Vera Visitor', email: session.visitor.email });
    // Staff can find it by the visitor's contact email too.
    expect((await listStaffTickets(s, { q: session.visitor.email! })).items.map((i) => i.reference)).toContain(conv.reference);
    const d = await getStaffTicket(s, conv.reference);
    expect(d.diagnostics).toEqual({ route: '/', browser_family: 'firefox', occurred_at: expect.any(String) }); // no query, no fragment, nothing else
    expect(d.visitor).toEqual({ email_verified: false, blocked: false, sessions: 1, last_seen_at: expect.any(String), other_conversations: 0 });
    const msgs = d.timeline.filter((i) => i.type === 'message');
    expect(msgs.map((i) => i.type === 'message' ? [i.author.kind, i.author.name] : null)).toEqual([['visitor', 'Vera Visitor']]);
    await drain();
    const n = (await db().query(`SELECT kind, scope, link_path FROM notifications WHERE user_id=$1`, [s.actor.userId])).rows;
    expect(n).toEqual([{ kind: 'support.new', scope: 'platform', link_path: `/admin/platform/support/${conv.reference}` }]);
  });

  it('is "Send us a message" unless staffed chat is configured; turning the widget off stops new conversations', async () => {
    const info = await widgetSessionInfo(anon());
    expect(info.availability).toMatchObject({ staffed: false, title: 'Send us a message' });
    expect(info.mode).toBe('visitor');
    expect(info.csrf).toEqual({ member: null, visitor: null });
    await setConfig({ widget_enabled: true, widget_staffed: true });
    expect((await widgetSessionInfo(anon())).availability).toMatchObject({ staffed: true, title: 'Chat with Relay support' });
    await setConfig({ widget_enabled: false, widget_staffed: true });
    expect((await widgetSessionInfo(anon())).availability.staffed).toBe(false);
    await expect(visitorStart()).rejects.toMatchObject({ code: 'invalid_state' });
    await setConfig({ widget_enabled: true });
  });
});

// ====================================================================== §18.10 + missed-message recovery
describe('staff replies return to the correct widget conversation (§18.10)', () => {
  it('reply shows in that conversation (full + delta), status follows, contact email gets a content-free one-time link', async () => {
    const s = await staff();
    const a = await visitorStart();
    const b = await visitorStart();
    const cursor0 = a.conv.cursor;
    await staffReply(s, a.conv.reference, { body: 'Yes — Bluesky scheduling is supported.' }, randomUUID());
    await drain();
    const delta = await getConversation(a.caller, a.conv.reference, cursor0);
    expect(delta.delta).toBe(true);
    expect(delta.messages.map((m) => [m.author.kind, m.author.name, m.body])).toEqual([['staff', 'Sam · Relay', 'Yes — Bluesky scheduling is supported.']]);
    expect(delta.status).toBe('waiting_on_customer');
    expect(delta.cursor).toBeGreaterThan(cursor0);
    // Visitor B's conversation is untouched.
    expect((await getConversation(b.caller, b.conv.reference, 0)).messages.map((m) => m.author.kind)).toEqual(['visitor']);
    // Email to A's contact address only, without the reply text.
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe(a.session.visitor.email);
    expect(sent[0]!.subject).toContain(a.conv.reference);
    expect(sent[0]!.text).not.toContain('Bluesky scheduling is supported');
    expect(sent[0]!.text).toMatch(/#support-verify=[A-Za-z0-9_-]{30,}/);
    // Staff see the delivery outcome under the reply; redelivery of the event does not send twice.
    const d = await getStaffTicket(s, a.conv.reference);
    const reply = d.timeline.find((i) => i.type === 'message' && i.author.kind === 'staff');
    expect(reply && reply.type === 'message' ? reply.delivery : null).toEqual({ recipients: 1, email: { sent: 1 } });
    const evt = (await db().query(`SELECT event_type, workspace_id, aggregate_id, payload FROM outbox WHERE aggregate_id=$1 AND event_type='support.message_created' ORDER BY id DESC LIMIT 1`, [d.id])).rows[0];
    await handleEvent(evt);
    expect(sent).toHaveLength(1);
  });

  it('the emailed link opens that conversation on another device once (fresh session, verified email)', async () => {
    const s = await staff();
    const a = await visitorStart();
    await staffReply(s, a.conv.reference, { body: 'Here is the answer.' }, randomUUID());
    await drain();
    const token = /#support-verify=([A-Za-z0-9_-]+)/.exec(sent[0]!.text)![1]!;
    const phone = anon();
    const r = await confirmVerification(phone, { token });
    expect(r.open_reference).toBe(a.conv.reference);
    expect(r.newSession).toBeTruthy();
    expect(r.conversations.map((c) => c.reference)).toEqual([a.conv.reference]);
    const seen = await getConversation(as(phone, r.newSession!.session), a.conv.reference, 0);
    expect(seen.messages.map((m) => m.body)).toEqual(['Do you support Bluesky scheduling?', 'Here is the answer.']);
    await expect(confirmVerification(anon(), { token })).rejects.toMatchObject({ code: 'invalid_state' }); // one-time
  });

  it('reconnect: messages missed while offline come back in order from the last cursor, without duplicates', async () => {
    const s = await staff();
    const a = await visitorStart();
    const before = a.conv.cursor;
    await staffReply(s, a.conv.reference, { body: 'First' }, randomUUID());
    await staffNote(s, a.conv.reference, { body: SECRET_NOTE }, randomUUID());
    await updateTicket(s, a.conv.reference, { priority: 'high' });
    await staffReply(s, a.conv.reference, { body: 'Second' }, randomUUID());
    const delta = await getConversation(a.caller, a.conv.reference, before);
    expect(delta.messages.map((m) => m.body)).toEqual(['First', 'Second']);
    expect((await getConversation(a.caller, a.conv.reference, delta.cursor)).messages).toEqual([]); // nothing missed, nothing repeated
    const full = await getConversation(a.caller, a.conv.reference, 0);
    expect(full.messages.map((m) => m.body)).toEqual(['Do you support Bluesky scheduling?', 'First', 'Second']);
    expect(full.cursor).toBe(delta.cursor);
  });

  it('visitor replies reach staff (assignee notified), reopen a resolved conversation, and are deduplicated', async () => {
    const s = await staff();
    const a = await visitorStart();
    await staffReply(s, a.conv.reference, { body: 'Answered.', resolve: 'answered' }, randomUUID());
    await drain();
    expect((await getConversation(a.caller, a.conv.reference, 0)).notice).toBe('Resolved. Reply to reopen it.');
    const client_id = randomUUID();
    const r1 = await sendMessage(a.caller, a.conv.reference, { client_id, body: 'One more question' });
    const r2 = await sendMessage(a.caller, a.conv.reference, { client_id, body: 'One more question' });
    expect(r1.messages.filter((m) => m.body === 'One more question')).toHaveLength(1);
    expect(r2.messages.filter((m) => m.body === 'One more question')).toHaveLength(1);
    expect(r1.status).toBe('waiting_on_relay');
    await expect(sendMessage(a.caller, a.conv.reference, { client_id, body: 'Different' })).rejects.toMatchObject({ code: 'idempotency_conflict' });
    await drain();
    const n = (await db().query(`SELECT kind FROM notifications WHERE user_id=$1 AND kind='support.customer_reply'`, [s.actor.userId])).rows;
    expect(n).toHaveLength(1); // assignee (auto-assigned on first reply)
  });
});

// ====================================================================== §18.11
describe('another visitor cannot access the conversation (§18.11)', () => {
  it('a different browser — even one that types the same email — gets 404 for read, reply and files', async () => {
    const a = await visitorStart();
    const intent = await widgetUploadIntent(a.caller, { filename: 'shot.png', content_type: 'image/png', size: PNG.length });
    expect(await upload(intent, PNG)).toBe(204);
    const ready = await widgetCompleteUpload(a.caller, intent.attachment.id);
    expect(ready.state).toBe('ready');
    const withFile = await sendMessage(a.caller, a.conv.reference, { client_id: randomUUID(), body: 'Screenshot attached', attachment_ids: [ready.id] });
    expect(withFile.messages.at(-1)!.attachments.map((f) => f.url)).toEqual([`/api/widget/attachments/${ready.id}`]);
    expect((await openWidgetAttachment(a.caller, ready.id)).bytes.equals(PNG)).toBe(true);

    const mallory = await visitorStart({ email: a.session.visitor.email, name: 'Mallory' }); // same email typed, different identity
    for (const c of [mallory.caller, anon()]) {
      await expect(getConversation(c, a.conv.reference, 0)).rejects.toMatchObject({ code: 'not_found' });
      await expect(sendMessage(c, a.conv.reference, { client_id: randomUUID(), body: 'let me in' })).rejects.toMatchObject({ code: 'not_found' });
      await expect(openWidgetAttachment(c, ready.id)).rejects.toMatchObject({ code: 'not_found' });
      await expect(widgetCompleteUpload(c, ready.id)).rejects.toMatchObject({ code: 'not_found' });
    }
    // Mallory's list only holds her own conversation; she can't attach A's file to her message either.
    expect((await widgetSessionInfo(mallory.caller)).conversations.map((x) => x.reference)).toEqual([mallory.conv.reference]);
    await expect(sendMessage(mallory.caller, mallory.conv.reference, { client_id: randomUUID(), body: 'x', attachment_ids: [ready.id] })).rejects.toMatchObject({ code: 'validation_failed' });
    // Unguessable references don't help a signed-in member either (visitor tickets are never member-visible).
    const m = await memberOf();
    await expect(getConversation(m.caller, a.conv.reference, 0)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('cross-device access only after the one-time code; wrong codes lock; unknown emails get the same answer and no email', async () => {
    const a = await visitorStart();
    const laptop = anon();
    const req = await requestVerification(laptop, { email: a.session.visitor.email });
    expect(req).toMatchObject({ ok: true, expires_in_minutes: 15 });
    const lap = as(laptop, req.newSession!.session);
    await drain();
    expect(sent).toHaveLength(1);
    const code = /Your code: (\d{6})/.exec(sent[0]!.text)![1]!;
    expect(sent[0]!.to).toBe(a.session.visitor.email);
    // Before verifying: nothing visible.
    await expect(getConversation(lap, a.conv.reference, 0)).rejects.toMatchObject({ code: 'not_found' });
    const wrong = code === '000000' ? '111111' : '000000';
    await expect(confirmVerification(lap, { code: wrong })).rejects.toMatchObject({ code: 'validation_failed' });
    const ok = await confirmVerification(lap, { code });
    expect(ok.conversations.map((c) => c.reference)).toEqual([a.conv.reference]);
    const verified = (await resolveWidgetSession(req.newSession!.token))!;
    expect(verified.verifiedEmail?.toLowerCase()).toBe(a.session.visitor.email!.toLowerCase());
    expect((await getConversation(as(laptop, verified), a.conv.reference, 0)).messages).toHaveLength(1);
    // The code is single-use.
    await expect(confirmVerification(as(laptop, verified), { code })).rejects.toMatchObject({ code: 'invalid_state' });

    // Lockout after 5 wrong tries, even with the right code afterwards.
    const b = await visitorStart();
    const dev = anon();
    const r2 = await requestVerification(dev, { email: b.session.visitor.email });
    await drain();
    const code2 = /Your code: (\d{6})/.exec(sent.at(-1)!.text)![1]!;
    const bad = code2 === '123456' ? '654321' : '123456';
    const dv = as(dev, r2.newSession!.session);
    for (let i = 0; i < 5; i++) await expect(confirmVerification(dv, { code: bad })).rejects.toMatchObject({ code: 'validation_failed' });
    await expect(confirmVerification(dv, { code: code2 })).rejects.toMatchObject({ code: 'invalid_state' });

    // Unknown email: identical response, nothing sent (the widget can't be used to mail arbitrary inboxes).
    sent.length = 0;
    const unknown = await requestVerification(anon(), { email: `nobody-${randomUUID().slice(0, 6)}@example.test` });
    expect(unknown).toMatchObject({ ok: true, expires_in_minutes: 15 });
    await drain();
    expect(sent).toHaveLength(0);
  });

  it('typing an email never merges into a user account; members and visitors stay separate', async () => {
    const m = await memberOf();
    const v = await visitorStart({ email: m.u.email });
    // The member's conversations do not include the visitor conversation that typed their email.
    const info = await widgetSessionInfo(m.caller);
    expect(info.mode).toBe('member');
    expect(info.conversations.map((c) => c.reference)).not.toContain(v.conv.reference);
    const t = (await db().query(`SELECT requester_kind, requester_user_id, workspace_id FROM support_tickets WHERE reference=$1`, [v.conv.reference])).rows[0];
    expect(t).toEqual({ requester_kind: 'visitor', requester_user_id: null, workspace_id: null });
  });
});

// ====================================================================== §18.12
describe('internal support notes never appear publicly (§18.12)', () => {
  it('not in conversation reads, polling deltas, session lists, visitor emails or file downloads', async () => {
    const s = await staff();
    const a = await visitorStart();
    const c0 = a.conv.cursor;
    const noteFile = await staffUploadIntent(s, { filename: 'internal.png', content_type: 'image/png', size: PNG.length });
    expect(await upload(noteFile, PNG)).toBe(204);
    await completeStaffUpload(s, noteFile.attachment.id);
    await staffNote(s, a.conv.reference, { body: SECRET_NOTE, attachment_ids: [noteFile.attachment.id] }, randomUUID());
    await staffReply(s, a.conv.reference, { body: 'Public answer' }, randomUUID());
    await drain();
    const payloads = [
      await getConversation(a.caller, a.conv.reference, 0),
      await getConversation(a.caller, a.conv.reference, c0),
      await widgetSessionInfo(a.caller),
      await sendMessage(a.caller, a.conv.reference, { client_id: randomUUID(), body: 'thanks', after: c0 }),
    ];
    for (const p of payloads) {
      const json = JSON.stringify(p);
      expect(json).not.toContain('refund approved');
      expect(json).not.toContain(noteFile.attachment.id);
      expect(json).not.toContain('Sam Support'); // full staff names stay staff-side ("Sam · Relay")
      expect(json).not.toMatch(/"priority"|"assignee"|note\.created/);
    }
    expect(JSON.stringify(sent)).not.toContain('refund approved');
    await expect(openWidgetAttachment(a.caller, noteFile.attachment.id)).rejects.toMatchObject({ code: 'not_found' });
    // Staff still see the note.
    expect((await getStaffTicket(s, a.conv.reference)).timeline.some((i) => i.type === 'note' && i.body === SECRET_NOTE)).toBe(true);
  });

  it('member widget conversations hide notes as well', async () => {
    const s = await staff();
    const m = await memberOf();
    const conv = (await createConversation(m.caller, { client_id: randomUUID(), message: 'Billing question', topic: 'billing' })).conversation;
    await staffNote(s, conv.reference, { body: SECRET_NOTE }, randomUUID());
    const view = await getConversation(m.caller, conv.reference, 0);
    expect(JSON.stringify(view)).not.toContain('refund approved');
    expect(JSON.stringify(await getConversation(m.caller, conv.reference, conv.cursor))).not.toContain('refund approved');
  });
});

// ====================================================================== signed-in customers
describe('signed-in customers use trusted account + workspace context', () => {
  it('creates a member ticket in a server-validated workspace; foreign workspace ids are refused', async () => {
    const s = await staff();
    const m = await memberOf('Acme');
    const other = await createWorkspace('Other Co');
    const ws2 = await createWorkspace('Second Co');
    await addMember(ws2, m.u.id, 'viewer');
    const info = await widgetSessionInfo(m.caller);
    expect(info.member?.workspaces.map((w) => w.name).sort()).toEqual(['Acme', 'Second Co']);
    expect(info.member?.default_workspace_id).toBe(m.ws);
    expect(info.csrf.member).toBe(m.caller.member!.csrfToken);
    await expect(createConversation(m.caller, { client_id: randomUUID(), message: 'hi', workspace_id: other })).rejects.toMatchObject({ code: 'forbidden' });
    const conv = (await createConversation(m.caller, { client_id: randomUUID(), message: 'Need help with seats', workspace_id: ws2, diagnostics: { route: '/pricing?x=1' } })).conversation;
    expect(conv).toMatchObject({ kind: 'member', workspace: { id: ws2, name: 'Second Co' } });
    const row = (await listStaffTickets(s, { q: conv.reference })).items[0]!;
    expect(row).toMatchObject({ source: 'widget', requester_kind: 'member', workspace: { id: ws2, name: 'Second Co' }, requester: { id: m.u.id } });
    // Same ticket in Help → My requests (one support system).
    const { v2Ctx } = await import('./helpers.js');
    const mine = await listTickets(await v2Ctx(m.u.id, ws2), { scope: 'mine' });
    expect(mine.items.map((i) => i.reference)).toContain(conv.reference);
    // Staff reply → member's in-app notification links to Help → My requests; widget shows it.
    await staffReply(s, conv.reference, { body: 'Seats are per active member.' }, randomUUID());
    await drain();
    expect((await getConversation(m.caller, conv.reference, conv.cursor)).messages.map((x) => x.body)).toEqual(['Seats are per active member.']);
    expect((await db().query(`SELECT link_path FROM notifications WHERE user_id=$1 AND kind='support.reply'`, [m.u.id])).rows).toEqual([{ link_path: `/help/requests/${conv.reference}` }]);
    // Another workspace member without support.workspace can't read it; a visitor can't either.
    const peer = await createUser(undefined, 'Pat Peer'); await addMember(ws2, peer.id, 'editor');
    const peerCaller: WidgetCaller = { ...anon(), member: { ...m.caller.member!, actor: { userId: peer.id, email: peer.email, name: 'Pat', sessionId: randomUUID() }, activeWorkspaceId: ws2 } };
    await expect(getConversation(peerCaller, conv.reference, 0)).rejects.toMatchObject({ code: 'not_found' });
    const v = await visitorStart();
    await expect(getConversation(v.caller, conv.reference, 0)).rejects.toMatchObject({ code: 'not_found' });
    expect((await getTicket(await v2Ctx(m.u.id, ws2), conv.reference)).source).toBe('widget');
  });
});

// ====================================================================== abuse controls + session lifecycle
describe('rate limits, abuse controls and session expiry (§10)', () => {
  it('honeypot, time trap and forged form tokens are refused', async () => {
    await expect(visitorStart({ website: 'http://spam.example' })).rejects.toMatchObject({ code: 'validation_failed' });
    await expect(visitorStart({ form_token: issueFormToken() })).rejects.toMatchObject({ code: 'validation_failed', fieldErrors: { form_token: 'too_fast' } });
    await expect(visitorStart({ form_token: `${Date.now() - 5000}.forged` })).rejects.toMatchObject({ code: 'validation_failed', fieldErrors: { form_token: 'invalid' } });
    expect(() => checkFormToken(issueFormToken(Date.now() - 7 * 3600_000))).toThrow(/expired/);
    // Schema errors surface as 422 validation_failed through the route layer.
    await expect(visitorStart({ message: 'x'.repeat(4001) })).rejects.toMatchObject({ name: 'ZodError' });
    await expect(visitorStart({ email: 'not-an-email' })).rejects.toMatchObject({ name: 'ZodError' });
  });

  it('new conversations are rate-limited per IP; duplicate submits never create a second ticket', async () => {
    const c = anon();
    const client_id = randomUUID();
    const body = { client_id, name: 'Rae', email: 'rae@example.test', message: 'hello', form_token: oldToken() };
    const first = await createConversation(c, body);
    const again = await createConversation(as(c, first.newSession!.session), body);
    expect(again.conversation.reference).toBe(first.conversation.reference);
    // Lost response (no cookie): same client id + same body → same conversation, fresh session for the same identity.
    const lost = await createConversation(c, body);
    expect(lost.conversation.reference).toBe(first.conversation.reference);
    expect(lost.newSession!.session.visitorId).toBe(first.newSession!.session.visitorId);
    await expect(createConversation(c, { ...body, message: 'changed' })).rejects.toMatchObject({ code: 'idempotency_conflict' });
    const n = (await db().query(`SELECT count(*)::int n FROM support_tickets WHERE visitor_id=$1`, [first.newSession!.session.visitorId])).rows[0].n;
    expect(n).toBe(1);
    let limited = false;
    for (let i = 0; i < 12 && !limited; i++) {
      try { await createConversation(c, { ...body, client_id: randomUUID(), email: `r${i}@example.test` }); } catch (e) { limited = (e as { code?: string }).code === 'rate_limited'; }
    }
    expect(limited).toBe(true);
  });

  it('blocked visitors cannot send; their sessions end', async () => {
    const s = await staff();
    const a = await visitorStart();
    const info = await setVisitorBlocked(s, a.conv.reference, { blocked: true });
    expect(info.blocked).toBe(true);
    expect(await resolveWidgetSession(a.token)).toBeNull();
    const d = await getStaffTicket(s, a.conv.reference);
    expect(d.visitor?.blocked).toBe(true);
    expect(d.timeline.some((i) => i.type === 'activity' && i.kind === 'visitor.blocked' && i.audience === 'staff')).toBe(true);
    // Even a still-held session object can't send.
    const blockedCaller = as(a.caller, { ...a.session, visitor: { ...a.session.visitor, blocked: true } });
    await expect(sendMessage(blockedCaller, a.conv.reference, { client_id: randomUUID(), body: 'spam' })).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('sessions expire (idle + absolute), can be ended by the visitor, and are swept', async () => {
    const a = await visitorStart();
    expect(await resolveWidgetSession(a.token)).toBeTruthy();
    await db().query(`UPDATE widget_sessions SET last_seen_at = now() - interval '8 days' WHERE id=$1`, [a.session.id]);
    expect(await resolveWidgetSession(a.token)).toBeNull(); // idle timeout (7 days) revokes
    const b = await visitorStart();
    await db().query(`UPDATE widget_sessions SET expires_at = now() - interval '1 minute' WHERE id=$1`, [b.session.id]);
    expect(await resolveWidgetSession(b.token)).toBeNull();
    const c = await visitorStart();
    await revokeWidgetSession(db(), c.session.id);
    expect(await resolveWidgetSession(c.token)).toBeNull();
    expect(await resolveWidgetSession('x'.repeat(43))).toBeNull();
    // Sweep: old ended sessions go; tickets (and the visitor identity they reference) stay.
    await db().query(`UPDATE widget_sessions SET revoked_at = now() - interval '31 days' WHERE id=$1`, [c.session.id]);
    await sweepWidget(db());
    expect((await db().query(`SELECT count(*)::int n FROM widget_sessions WHERE id=$1`, [c.session.id])).rows[0].n).toBe(0);
    expect((await db().query(`SELECT count(*)::int n FROM widget_visitors WHERE id=$1`, [c.session.visitorId])).rows[0].n).toBe(1);
  });

  it('without SMTP, reply emails are recorded as not configured (never reported as sent)', async () => {
    setWidgetMailTransportForTests(null);
    const prev = process.env.SMTP_URL;
    delete process.env.SMTP_URL;
    const { resetConfigCache } = await import('@social-lite/services');
    resetConfigCache();
    try {
      const s = await staff();
      const a = await visitorStart();
      expect((await widgetSessionInfo(a.caller)).availability.email_replies).toBe(false);
      await staffReply(s, a.conv.reference, { body: 'Reply' }, randomUUID());
      await drain();
      const d = await getStaffTicket(s, a.conv.reference);
      const reply = d.timeline.find((i) => i.type === 'message' && i.author.kind === 'staff');
      expect(reply && reply.type === 'message' ? reply.delivery : null).toEqual({ recipients: 1, email: { not_configured: 1 } });
      expect((await getConversation(a.caller, a.conv.reference, 0)).messages.map((m) => m.body)).toContain('Reply'); // still in the widget
    } finally {
      process.env.SMTP_URL = prev; resetConfigCache();
      setWidgetMailTransportForTests(async (m) => { sent.push(m); return true; });
    }
  });
});

async function upload(intent: { upload: { url: string; fields: Record<string, string> } }, body: Buffer): Promise<number> {
  const fd = new FormData();
  for (const [k, v] of Object.entries(intent.upload.fields)) fd.append(k, v);
  fd.append('file', new Blob([new Uint8Array(body)]));
  const res = await fetch(intent.upload.url, { method: 'POST', body: fd });
  await res.arrayBuffer();
  return res.status;
}
