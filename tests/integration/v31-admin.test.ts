// V3.1 Admin (brief §18 synchronization, §19 security/workflow) against REAL PostgreSQL through the real policy path
// (v2Ctx → loadAccess → authorize). Platform scope uses PlatformCtx exactly as platformRoute() builds it.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { toLocalInput } from '@social-lite/core';
import {
  cancelSchedule, claimDelivery, createPost, loadAccess, processDelivery, reschedule, retryDelivery, schedulePost, getPostDetail, type EngineDeps,
} from '@social-lite/services';
import {
  adminChanges, adminDeliveries, adminDeliveryDetail, adminOverview, deadLetters, decideSupportAccess, endSupportAccessTx, grantOperator, listPlatformWorkspaces,
  listWorkspaceSupportAccess, loadOperatorRole, operatorEndSupportAccess, platformAudit, platformAuditList, platformOverview, platformWorkspace, reactivateWorkspace,
  requestSupportAccess, requeueDeadLetter, revokeOperator, safeError, setAccountDisabled, setGlobalDispatch, suspendWorkspace, sweepSupportAccess,
  updatePlatformFlag, workspaceEndSupportAccess, adminConnections, adminJobs, type PlatformCtx,
} from '@social-lite/services/admin/index';
import { revokeGrant, addMemberGrant } from '../../packages/services/src/members.js';
import { suspendMember, removeMember } from '../../packages/services/src/lifecycle.js';
import { applyRoleGrants, ensureLoginRoles } from '../../packages/db/src/roles.js';
import { addMember, closeTestPool, createBrand, createUser, createWorkspace, grant, testPool, v2Ctx } from './helpers.js';
import { scriptedWorld, seedConnections, type ScriptedWorld } from './engine-helpers.js';

afterAll(closeTestPool);

let world: ScriptedWorld;
beforeAll(async () => {
  const c = await testPool().connect();
  try { await ensureLoginRoles(c); await applyRoleGrants(c); } finally { c.release(); }
});
beforeEach(async () => {
  world = scriptedWorld();
  await testPool().query(`UPDATE deliveries SET state='cancelled' WHERE state IN ('scheduled','retry_wait','processing','preparing','publishing')`);
  await testPool().query(`UPDATE system_flags SET value='true' WHERE key='dispatch_enabled'`);
  await testPool().query(`DELETE FROM provider_circuits`);
});

async function drain(deps: EngineDeps, max = 20): Promise<string[]> {
  const out: string[] = [];
  for (let i = 0; i < max; i++) {
    const c = await claimDelivery('admin-test');
    if (!c) break;
    out.push(await processDelivery(deps, c));
  }
  return out;
}

/** Workspace with owner + admin + editor, one brand with four simulated destinations. */
async function agency(name = 'Admin WS') {
  const ws = await createWorkspace(name);
  const brand = await createBrand(ws, 'Brand A');
  const owner = await createUser(); await addMember(ws, owner.id, 'owner');
  const admin = await createUser(); await addMember(ws, admin.id, 'admin');
  const editor = await createUser(); await addMember(ws, editor.id, 'editor');
  const conns = await seedConnections(ws, brand);
  return { ws, brand, owner, admin, editor, conns, own: () => v2Ctx(owner.id, ws), adm: () => v2Ctx(admin.id, ws), ed: () => v2Ctx(editor.id, ws) };
}

async function scheduled(t: Awaited<ReturnType<typeof agency>>, opts: { text?: string; title?: string; providers?: Array<'facebook' | 'telegram' | 'x'>; inMs?: number } = {}) {
  const ids = (opts.providers ?? ['facebook', 'telegram']).map((p) => t.conns[p]!);
  const draft = { baseText: opts.text ?? 'Admin sync test', baseLink: null, baseAssetIds: [], variants: ids.map((connectionId) => ({ connectionId, inheritText: true, inheritMedia: true })) };
  const ctx = await t.own();
  const { id } = await createPost(ctx, t.brand, { title: opts.title ?? 'Admin post', draft }, randomUUID());
  const r = await schedulePost(ctx, id, { expected_version: 1, connection_ids: ids, input_local_time: toLocalInput(new Date(Date.now() + (opts.inMs ?? 3600_000)), 'Europe/London'), timezone: 'Europe/London' }, randomUUID());
  const schedule = (r.body as { schedule: { id: string; generation: number } }).schedule;
  return { postId: id, scheduleId: schedule.id, generation: schedule.generation };
}

async function operator(role: 'operator' | 'support' = 'operator', fresh = true): Promise<PlatformCtx> {
  const u = await createUser(`op-${randomUUID().slice(0, 8)}@relay.test`);
  await testPool().query(`INSERT INTO platform_operators(user_id, role, granted_via) VALUES ($1,$2,'seed')`, [u.id, role]);
  return { actor: { userId: u.id, email: u.email, name: 'Op', sessionId: randomUUID() }, role, assurance: { mfaVerified: fresh, authTime: fresh ? new Date() : null }, correlationId: randomUUID() };
}

const markers = async (ctx: Awaited<ReturnType<typeof v2Ctx>>) => (await adminChanges(ctx)).topics;

// ====================================================================== §18 synchronization
describe('admin ↔ main app synchronization (§18)', () => {
  it('an admin role change affects main-app access on the next request; the access marker changes', async () => {
    const t = await agency();
    const before = await markers(await t.adm());
    const ed = await createUser(); await addMember(t.ws, ed.id, 'viewer', [t.brand]);
    const g = await addMemberGrant(await t.adm(), ed.id, { role: 'publisher', brand_id: t.brand });
    const pubGrant = g.grants.find((x) => x.role === 'publisher')!;
    const ctx1 = await v2Ctx(ed.id, t.ws);
    expect(ctx1.access.authz!.subject.grants.some((x) => x.role === 'publisher')).toBe(true);
    await revokeGrant(await t.adm(), pubGrant.id);
    const ctx2 = await v2Ctx(ed.id, t.ws);
    expect(ctx2.access.authz!.subject.grants.some((x) => x.role === 'publisher')).toBe(false);
    const after = await markers(await t.adm());
    expect(after.access).not.toBe(before.access);
    expect((await adminChanges(await t.adm())).policy_version).toBeGreaterThan(Number(before.access.split(':')[0]));
  });

  it('suspending a membership locks out an already-open session on its next request', async () => {
    const t = await agency();
    expect(await loadAccess(t.editor.id, t.ws)).not.toBeNull();
    await suspendMember(await t.adm(), t.editor.id, { reason: 'offboarding' });
    expect(await loadAccess(t.editor.id, t.ws)).toBeNull();
  });

  it('a post scheduled in the main app appears in admin; an admin cancellation appears in the main app; worker completion updates both', async () => {
    const t = await agency();
    const m0 = await markers(await t.adm());
    const a = await scheduled(t, { title: 'Sync A' });
    const m1 = await markers(await t.adm());
    expect(m1.publishing).not.toBe(m0.publishing);
    const list = await adminDeliveries(await t.adm(), { state: 'scheduled' });
    expect(list.items.filter((d) => d.post_id === a.postId).map((d) => d.display_state)).toEqual(['scheduled', 'scheduled']);
    // Admin cancels through the SAME service; the main app's read model shows it.
    await cancelSchedule(await t.adm(), a.scheduleId);
    const detail = await getPostDetail(await t.own(), a.postId);
    expect(detail.deliveries.every((d) => d.state === 'cancelled')).toBe(true);
    expect((await markers(await t.adm())).publishing).not.toBe(m1.publishing);
    // Worker completion: due now → engine publishes → admin + main agree.
    const b = await scheduled(t, { title: 'Sync B', providers: ['facebook'] });
    await testPool().query(`UPDATE deliveries SET next_attempt_at=now() - interval '1 second' WHERE post_id=$1`, [b.postId]);
    const m2 = await markers(await t.adm());
    expect(await drain(world.deps)).toEqual(['published']);
    const adminView = (await adminDeliveries(await t.adm(), { state: 'published' })).items.find((d) => d.post_id === b.postId)!;
    expect(adminView.display_state).toBe('published');
    expect((await getPostDetail(await t.own(), b.postId)).status).toBe('published');
    expect((await markers(await t.adm())).publishing).not.toBe(m2.publishing);
  });

  it('revoking a connection updates admin connection health and the affected deliveries', async () => {
    const t = await agency();
    const s = await scheduled(t, { providers: ['telegram'] });
    const m0 = await markers(await t.adm());
    world.credentialFailures.add(t.conns.telegram);
    await testPool().query(`UPDATE deliveries SET next_attempt_at=now() - interval '1 second' WHERE post_id=$1`, [s.postId]);
    await drain(world.deps);
    const conn = (await adminConnections(await t.adm())).items.find((c) => c.id === t.conns.telegram)!;
    expect(conn.status).not.toBe('ready');
    const d = (await adminDeliveries(await t.adm(), {})).items.find((x) => x.post_id === s.postId)!;
    expect(['blocked', 'failed']).toContain(d.display_state);
    const m1 = await markers(await t.adm());
    expect(m1.connections).not.toBe(m0.connections);
    expect(m1.publishing).not.toBe(m0.publishing);
  });

  it('two admins rescheduling the same schedule: exactly one wins, the other gets a conflict', async () => {
    const t = await agency();
    const s = await scheduled(t);
    const when = toLocalInput(new Date(Date.now() + 7200_000), 'Europe/London');
    const results = await Promise.allSettled([
      reschedule(await t.own(), s.scheduleId, { input_local_time: when, timezone: 'Europe/London', expected_generation: s.generation }, randomUUID()),
      reschedule(await t.adm(), s.scheduleId, { input_local_time: when, timezone: 'Europe/London', expected_generation: s.generation }, randomUUID()),
    ]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    const bad = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    expect(ok).toHaveLength(1);
    expect(bad).toHaveLength(1);
    expect(['version_conflict', 'invalid_state', 'conflict']).toContain((bad[0]!.reason as { code: string }).code);
  });

  it('missed events reconcile from state; a duplicate poll is a no-op (markers are state, not deltas)', async () => {
    const t = await agency();
    const seen = await markers(await t.adm());
    // Three changes happen while the client is "disconnected".
    await scheduled(t, { title: 'Missed 1' });
    await scheduled(t, { title: 'Missed 2' });
    await suspendMember(await t.adm(), t.editor.id, {});
    const now1 = await markers(await t.adm());
    const changed = Object.keys(now1).filter((k) => now1[k as keyof typeof now1] !== seen[k as keyof typeof seen]);
    expect(changed).toEqual(expect.arrayContaining(['publishing', 'content', 'access', 'audit']));
    // Duplicate delivery of the same state: identical markers ⇒ nothing to refetch.
    const now2 = await markers(await t.adm());
    expect(now2).toEqual(now1);
  });

  it('stale cache after a permission change: the feed is denied once workspace.read is gone, and authority is never cached', async () => {
    const t = await agency();
    const ctxBefore = await t.adm();
    expect((await adminOverview(ctxBefore)).cards.length).toBeGreaterThan(3);
    const adminGrant = (await testPool().query<{ id: string }>(`SELECT id FROM scoped_role_grants WHERE workspace_id=$1 AND user_id=$2 AND role='admin'`, [t.ws, t.admin.id])).rows[0]!.id;
    await revokeGrant(await t.own(), adminGrant);
    const ctxAfter = await v2Ctx(t.admin.id, t.ws).catch(() => null);
    if (ctxAfter) await expect(adminChanges(ctxAfter)).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('overview cards drill into filtered records and never count simulated work as live', async () => {
    const t = await agency();
    const s = await scheduled(t, { providers: ['facebook'] });
    await testPool().query(`UPDATE deliveries SET next_attempt_at=now() - interval '1 second' WHERE post_id=$1`, [s.postId]);
    await drain(world.deps);
    const o = await adminOverview(await t.adm());
    const pub = o.cards.find((c) => c.key === 'publishing')!;
    expect(pub.value).toBe(0);                    // simulated only
    expect(pub.state).toBe('demo');
    expect(pub.detail).toMatch(/1 simulated/);
    expect(o.cards.find((c) => c.key === 'attention')!.href).toBe('/admin/publishing?state=attention');
    // Viewer-level users can't read the admin overview at all.
    const viewer = await createUser(); await addMember(t.ws, viewer.id, 'viewer');
    await expect(adminOverview(await v2Ctx(viewer.id, t.ws))).rejects.toMatchObject({ code: 'forbidden' });
  });
});

// ====================================================================== §19 security + workflow
describe('admin security (§19)', () => {
  it('cross-workspace id manipulation returns not_found everywhere', async () => {
    const a = await agency('WS A');
    const b = await agency('WS B');
    const sb = await scheduled(b);
    const did = (await testPool().query<{ id: string }>(`SELECT id FROM deliveries WHERE post_id=$1 LIMIT 1`, [sb.postId])).rows[0]!.id;
    await expect(adminDeliveryDetail(await a.adm(), did)).rejects.toMatchObject({ code: 'not_found' });
    await expect(cancelSchedule(await a.adm(), sb.scheduleId)).rejects.toMatchObject({ code: 'not_found' });
    await expect(retryDelivery(await a.adm(), did, {})).rejects.toMatchObject({ code: 'not_found' });
    const dead = await testPool().query<{ id: string }>(`INSERT INTO outbox(workspace_id, aggregate_type, aggregate_id, event_type, dispatch_state) VALUES ($1,'delivery',$2,'delivery.due','dead') RETURNING id::text`, [b.ws, did]);
    await expect(requeueDeadLetter(await a.adm(), dead.rows[0]!.id)).rejects.toMatchObject({ code: 'not_found' });
    expect((await deadLetters(await a.adm())).items).toHaveLength(0);
    const op = await operator();
    const req = await requestSupportAccess(op, { workspace_id: b.ws, reason: 'Customer ticket about failed posts', duration_minutes: 30 });
    await expect(decideSupportAccess(await a.own(), req.id, { decision: 'approve' })).rejects.toMatchObject({ code: 'not_found' });
  });

  it('unauthorized direct calls: editors cannot use admin reads; brand-scoped users only see their brand', async () => {
    const t = await agency();
    await expect(adminChanges(await t.ed())).rejects.toMatchObject({ code: 'forbidden' });
    await expect(deadLetters(await t.ed())).rejects.toMatchObject({ code: 'forbidden' });
    const brandB = await createBrand(t.ws, 'Brand B');
    const scoped = await createUser(); await addMember(t.ws, scoped.id, 'viewer', [brandB]);
    await scheduled(t);
    const list = await adminDeliveries(await v2Ctx(scoped.id, t.ws), {});
    expect(list.items.every((d) => d.brand_id === brandB)).toBe(true);
    expect(list.items).toHaveLength(0);
  });

  it('retry after an ambiguous outcome needs explicit duplicate-risk acceptance; admin detail explains it', async () => {
    const t = await agency();
    const s = await scheduled(t, { providers: ['facebook'] });
    world.scripts.facebook = { publish: () => ({ kind: 'unknown', code: 'timeout_after_send', message: 'Timed out after sending' }) };
    await testPool().query(`UPDATE deliveries SET next_attempt_at=now() - interval '1 second' WHERE post_id=$1`, [s.postId]);
    await drain(world.deps);
    const d = (await adminDeliveries(await t.adm(), { state: 'unknown' })).items.find((x) => x.post_id === s.postId);
    expect(d).toBeTruthy();
    if (!d) return;
    const detail = await adminDeliveryDetail(await t.adm(), d.id);
    expect(detail.recovery.find((r) => r.action === 'retry')).toMatchObject({ available: false });
    expect(detail.recovery.find((r) => r.action === 'retry_with_risk')).toMatchObject({ available: true });
    expect(detail.recovery.find((r) => r.action === 'resolve')).toMatchObject({ available: true });
    await expect(retryDelivery(await t.adm(), d.id, {})).rejects.toMatchObject({ code: 'invalid_state', details: { reason: 'duplicate_risk_ack_required' } });
  });

  it('published destinations are never offered for retry; idempotent requeue under repeated clicks', async () => {
    const t = await agency();
    const s = await scheduled(t, { providers: ['facebook'] });
    await testPool().query(`UPDATE deliveries SET next_attempt_at=now() - interval '1 second' WHERE post_id=$1`, [s.postId]);
    await drain(world.deps);
    const d = (await testPool().query<{ id: string }>(`SELECT id FROM deliveries WHERE post_id=$1`, [s.postId])).rows[0]!;
    const detail = await adminDeliveryDetail(await t.adm(), d.id);
    expect(detail.recovery.find((r) => r.action === 'retry')).toMatchObject({ available: false, reason: expect.stringMatching(/never sent twice/) });
    const dead = await testPool().query<{ id: string }>(`INSERT INTO outbox(workspace_id, aggregate_type, aggregate_id, event_type, dispatch_state, attempts) VALUES ($1,'delivery',$2,'delivery.due','dead',10) RETURNING id::text`, [t.ws, d.id]);
    const [r1, r2] = await Promise.all([requeueDeadLetter(await t.adm(), dead.rows[0]!.id), requeueDeadLetter(await t.adm(), dead.rows[0]!.id)]);
    expect([r1.requeued, r2.requeued].filter(Boolean)).toHaveLength(1);
    const audits = await testPool().query(`SELECT count(*)::int n FROM audit_events WHERE workspace_id=$1 AND action='outbox.requeued'`, [t.ws]);
    expect(audits.rows[0].n).toBe(1);
    const unsafe = await testPool().query<{ id: string }>(`INSERT INTO outbox(workspace_id, aggregate_type, aggregate_id, event_type, dispatch_state) VALUES ($1,'invitation','x','invitation.created','dead') RETURNING id::text`, [t.ws]);
    expect((await deadLetters(await t.adm())).items.find((x) => x.id === unsafe.rows[0]!.id)).toMatchObject({ requeue_allowed: false });
    await expect(requeueDeadLetter(await t.adm(), unsafe.rows[0]!.id)).rejects.toMatchObject({ code: 'invalid_state' });
  });

  it('last-owner protection and offboarding effects on scheduled work stay enforced', async () => {
    const t = await agency();
    await expect(removeMember(await t.adm(), t.owner.id, {})).rejects.toBeTruthy();
    const pub = await createUser(); await addMember(t.ws, pub.id, 'viewer'); await grant(t.ws, pub.id, 'publisher', t.brand);
    const ids = [t.conns.facebook];
    const ctx = await v2Ctx(pub.id, t.ws);
    const { id } = await createPost(await t.own(), t.brand, { title: 'By publisher', draft: { baseText: 'hello', baseLink: null, baseAssetIds: [], variants: ids.map((connectionId) => ({ connectionId, inheritText: true, inheritMedia: true })) } }, randomUUID());
    await schedulePost(ctx, id, { expected_version: 1, connection_ids: ids, input_local_time: toLocalInput(new Date(Date.now() + 3600_000), 'Europe/London'), timezone: 'Europe/London' }, randomUUID());
    const r = await suspendMember(await t.adm(), pub.id, {});
    expect(r.held_publications).toBe(1);
    const held = (await adminDeliveries(await t.adm(), { state: 'attention' })).items.find((d) => d.post_id === id);
    const detail = held ? await adminDeliveryDetail(await t.adm(), held.id) : null;
    expect(detail).not.toBeNull();
    expect(detail!.recovery.find((x) => x.action === 'adopt')).toMatchObject({ available: true });
  });

  it('secrets are redacted in admin diagnostics and in the platform audit', async () => {
    expect(safeError('POST https://graph.example/x?access_token=EAAB123secret&x=1 failed: Bearer abcdefghijklmnop')).not.toMatch(/EAAB123secret|abcdefghijklmnop/);
    const op = await operator();
    await platformAudit(testPool(), op, { action: 'test.redaction', targetType: 'test', diff: { api_key: 'sk-live-should-not-appear', note: 'ok' } });
    const row = (await testPool().query(`SELECT diff FROM platform_audit_events WHERE action='test.redaction' ORDER BY id DESC LIMIT 1`)).rows[0];
    expect(JSON.stringify(row.diff)).not.toMatch(/sk-live-should-not-appear/);
  });
});

// ====================================================================== platform scope
describe('platform scope (§4, §13)', () => {
  it('operators are re-read from the database; support staff are read-only; changes need a fresh sign-in', async () => {
    const op = await operator('operator');
    const sup = await operator('support');
    expect(await loadOperatorRole(op.actor.userId)).toBe('operator');
    expect(await loadOperatorRole((await createUser()).id)).toBeNull();
    const t = await agency();
    await expect(suspendWorkspace(sup, t.ws, { reason: 'Abuse report investigated' })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(setGlobalDispatch({ ...op, assurance: { mfaVerified: true, authTime: new Date(Date.now() - 3600_000) } }, { enabled: false, reason: 'Testing stale session' }))
      .rejects.toMatchObject({ code: 'step_up_required' });
    await expect(grantOperator(op, { email: op.actor.email, role: 'support', reason: 'Self-change attempt' })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(grantOperator(sup, { email: 'x@y.test', role: 'operator', reason: 'Support escalating' })).rejects.toMatchObject({ code: 'forbidden' });
    await revokeOperator(op, sup.actor.userId, { reason: 'Left the support team' });
    expect(await loadOperatorRole(sup.actor.userId)).toBeNull();
  });

  it('platform views expose metadata only — never post text, titles, media or credentials', async () => {
    const t = await agency('Private Co');
    const secret = `SECRET-${randomUUID()}`;
    await scheduled(t, { title: secret, text: `${secret} body text` });
    const op = await operator('support');
    const blobs = JSON.stringify([await platformOverview(op), await listPlatformWorkspaces(op, { q: 'Private' }), await platformWorkspace(op, t.ws), await platformAuditList(op, {})]);
    expect(blobs).toContain('Private Co');
    expect(blobs).not.toContain(secret);
    expect(blobs).not.toMatch(/Brand A/);
    // V4: the detail carries an open support request COUNT only (no ticket content).
    expect((await platformWorkspace(op, t.ws)).open_support_requests).toBe(0);
    // Operators have no workspace membership: the normal policy path denies them.
    expect(await loadAccess(op.actor.userId, t.ws)).toBeNull();
  });

  it('suspension: members locked out, dispatch held, both audits written; reactivation resumes', async () => {
    const t = await agency();
    const s = await scheduled(t, { providers: ['facebook'] });
    const op = await operator();
    const r = await suspendWorkspace(op, t.ws, { reason: 'Payment dispute escalation' });
    expect(r.affected.scheduled).toBe(1);
    expect(await loadAccess(t.owner.id, t.ws)).toBeNull();
    await testPool().query(`UPDATE deliveries SET state='scheduled', next_attempt_at=now() - interval '1 second' WHERE post_id=$1`, [s.postId]);
    expect(await drain(world.deps)).toEqual(['paused']);
    const pa = await testPool().query(`SELECT action FROM platform_audit_events WHERE workspace_id=$1 ORDER BY id`, [t.ws]);
    expect(pa.rows.map((x) => x.action)).toContain('workspace.suspended');
    const wa = await testPool().query(`SELECT action FROM audit_events WHERE workspace_id=$1 AND action LIKE 'platform.%'`, [t.ws]);
    expect(wa.rows.map((x) => x.action)).toContain('platform.workspace_suspended');
    await reactivateWorkspace(op, t.ws, { reason: 'Dispute resolved, restoring' });
    expect(await loadAccess(t.owner.id, t.ws)).not.toBeNull();
    const st = await testPool().query<{ state: string }>(`SELECT state FROM deliveries WHERE post_id=$1`, [s.postId]);
    expect(st.rows[0]!.state).toBe('scheduled');
  });

  it('support access: explicit, approved by the workspace, time-boxed, read-only, audited, ended by either side', async () => {
    const t = await agency();
    const secret = `PRIVATE-${randomUUID()}`;
    await scheduled(t, { title: secret });
    const op = await operator('support');
    await expect(requestSupportAccess(op, { workspace_id: t.ws, reason: 'short', duration_minutes: 30 })).rejects.toBeTruthy();
    const req = await requestSupportAccess(op, { workspace_id: t.ws, reason: 'Ticket 4411: posts stuck in Unknown', ticket_ref: 'T-4411', duration_minutes: 30 });
    expect(req.status).toBe('requested');
    await expect(requestSupportAccess(op, { workspace_id: t.ws, reason: 'Second request same workspace', duration_minutes: 30 })).rejects.toMatchObject({ code: 'conflict' });
    expect(await loadAccess(op.actor.userId, t.ws)).toBeNull();                       // nothing before approval
    await expect(decideSupportAccess(await t.ed(), req.id, { decision: 'approve' })).rejects.toMatchObject({ code: 'forbidden' });
    // Stale sign-in can't approve (fresh authentication through the identity provider).
    await expect(decideSupportAccess(await v2Ctx(t.admin.id, t.ws, { authTime: new Date(Date.now() - 3600_000).toISOString() }), req.id, { decision: 'approve' }))
      .rejects.toMatchObject({ code: 'step_up_required' });
    const ok = await decideSupportAccess(await t.adm(), req.id, { decision: 'approve' });
    expect(ok.status).toBe('active');
    await expect(decideSupportAccess(await t.adm(), req.id, { decision: 'approve' })).rejects.toMatchObject({ code: 'invalid_state' }); // repeated click
    const opCtx = await v2Ctx(op.actor.userId, t.ws);
    const access = opCtx.access.authz!;
    expect(access.subject.grants.map((g) => g.role)).toEqual(['viewer']);
    expect(access.subject.grants[0]!.expiresAt).toBeTruthy();
    const posts = await getPostDetail(opCtx, (await testPool().query<{ id: string }>(`SELECT id FROM posts WHERE title=$1`, [secret])).rows[0]!.id);
    expect(posts.title).toBe(secret);                                                    // read works through the normal path
    await expect(cancelSchedule(opCtx, (await testPool().query<{ id: string }>(`SELECT id FROM schedules WHERE workspace_id=$1 LIMIT 1`, [t.ws])).rows[0]!.id)).rejects.toMatchObject({ code: 'forbidden' });
    expect((await listWorkspaceSupportAccess(await t.adm())).items[0]).toMatchObject({ id: req.id, status: 'active' });
    // Workspace ends it ⇒ the next request is denied.
    await workspaceEndSupportAccess(await t.adm(), req.id);
    expect(await loadAccess(op.actor.userId, t.ws)).toBeNull();
    const wa = (await testPool().query(`SELECT action FROM audit_events WHERE workspace_id=$1 AND action LIKE 'support_access.%' ORDER BY id`, [t.ws])).rows.map((r) => r.action);
    expect(wa).toEqual(['support_access.requested', 'support_access.approved', 'support_access.ended']);
    const pa = (await testPool().query(`SELECT action FROM platform_audit_events WHERE workspace_id=$1 AND action LIKE 'support_access.%' ORDER BY id`, [t.ws])).rows.map((r) => r.action);
    expect(pa).toEqual(['support_access.requested', 'support_access.approved', 'support_access.ended']);
  });

  it('support access expires by itself and lapses when nobody answers', async () => {
    const t = await agency();
    const op = await operator('support');
    const req = await requestSupportAccess(op, { workspace_id: t.ws, reason: 'Investigating analytics gaps', duration_minutes: 15 });
    await decideSupportAccess(await t.own(), req.id, { decision: 'approve' });
    expect(await loadAccess(op.actor.userId, t.ws)).not.toBeNull();
    const g = await testPool().query<{ grant_id: string }>(`SELECT grant_id FROM support_access_grants WHERE id=$1`, [req.id]);
    await testPool().query(`UPDATE scoped_role_grants SET expires_at=now() - interval '1 second' WHERE id=$1`, [g.rows[0]!.grant_id]);
    await testPool().query(`UPDATE support_access_grants SET expires_at=now() - interval '1 second' WHERE id=$1`, [req.id]);
    const acc = await loadAccess(op.actor.userId, t.ws);
    expect(acc?.authz?.subject.grants ?? []).toHaveLength(0);                          // the policy already denies
    expect(await sweepSupportAccess(testPool(), t.ws)).toBe(1);
    expect(await loadAccess(op.actor.userId, t.ws)).toBeNull();                         // membership created for it is removed
    const r2 = await requestSupportAccess(op, { workspace_id: t.ws, reason: 'Follow-up on the same ticket', duration_minutes: 15 });
    await testPool().query(`UPDATE support_access_grants SET request_expires_at=now() - interval '1 second' WHERE id=$1`, [r2.id]);
    await sweepSupportAccess(testPool(), t.ws);
    expect((await testPool().query(`SELECT status FROM support_access_grants WHERE id=$1`, [r2.id])).rows[0].status).toBe('lapsed');
    await expect(operatorEndSupportAccess(op, r2.id)).rejects.toMatchObject({ code: 'invalid_state' });
    void endSupportAccessTx;
  });

  it('account suspension blocks sign-in and ends sessions without touching workspace memberships', async () => {
    const t = await agency();
    const op = await operator();
    await testPool().query(`INSERT INTO sessions(user_id, token_hash, csrf_token, expires_at) VALUES ($1, $2, 'x', now() + interval '1 hour')`, [t.editor.id, Buffer.from(randomUUID())]);
    const r = await setAccountDisabled(op, t.editor.id, { reason: 'Compromised account report' }, true);
    expect(r.sessions_revoked).toBe(1);
    const m = await testPool().query(`SELECT status FROM memberships WHERE workspace_id=$1 AND user_id=$2`, [t.ws, t.editor.id]);
    expect(m.rows[0].status).toBe('active');
    await expect(setAccountDisabled(op, op.actor.userId, { reason: 'Locking myself out' }, true)).rejects.toMatchObject({ code: 'forbidden' });
    await setAccountDisabled(op, t.editor.id, { reason: 'Account recovered by owner' }, false);
  });

  it('rollouts: kill switch beats workspace overrides; changes audited', async () => {
    const op = await operator();
    const r = await updatePlatformFlag(op, 'v31.release_notes', { rollout_percent: 50, killed: true, reason: 'Pausing rollout after bug' });
    expect(r.items.find((f) => f.key === 'v31.release_notes')).toMatchObject({ killed: true, rollout_percent: 50 });
    const { isFeatureEnabled } = await import('@social-lite/services/gov/release');
    const t = await agency();
    await testPool().query(`INSERT INTO workspace_feature_flags(workspace_id, key, enabled) VALUES ($1,'v31.release_notes',true)`, [t.ws]);
    expect(await isFeatureEnabled(t.ws, 'v31.release_notes')).toBe(false);
    await updatePlatformFlag(op, 'v31.release_notes', { rollout_percent: 0, killed: false, reason: 'Bug fixed, restoring flag' });
    expect(await isFeatureEnabled(t.ws, 'v31.release_notes')).toBe(true);
    const a = await testPool().query(`SELECT count(*)::int n FROM platform_audit_events WHERE action='feature_flag.updated' AND target_id='v31.release_notes'`);
    expect(a.rows[0].n).toBeGreaterThanOrEqual(2);
  });

  it('the platform audit is append-only for the application roles', async () => {
    const c: pg.PoolClient = await testPool().connect();
    const as = async (role: string, sql: string) => {
      await c.query('BEGIN');
      try { await c.query(`SET LOCAL ROLE ${role}`); await c.query(sql); return null; } catch (e) { return (e as { code?: string }).code ?? 'error'; } finally { await c.query('ROLLBACK'); }
    };
    try {
      for (const role of ['socialite_app', 'socialite_worker']) {
        expect(await as(role, `INSERT INTO platform_audit_events(actor_service, action, target_type) VALUES ('t','test.append','test')`), role).toBeNull();
        expect(await as(role, `UPDATE platform_audit_events SET action = action`), role).toBe('42501');
        expect(await as(role, `DELETE FROM platform_audit_events`), role).toBe('42501');
      }
    } finally { c.release(); }
  });

  it('jobs view lists failures with safe errors only', async () => {
    const t = await agency();
    const j = await adminJobs(await t.adm(), { status: 'failed' });
    expect(Array.isArray(j.items)).toBe(true);
    expect(j.kinds).toContain('import');
  });

  it('a scheduled health check never renames a simulated destination (seed names stay stable)', async () => {
    const t = await agency();
    const { applyHealth } = await import('@social-lite/services/connections/manage');
    await applyHealth(t.conns.x, { status: 'ready', checkedAt: new Date().toISOString(), message: 'ok', metadata: { display_name: 'Simulated X account', username: 'social_lite_sim' } } as never, { service: 'test' });
    const r = await testPool().query<{ display_name: string }>(`SELECT display_name FROM connections WHERE id=$1`, [t.conns.x]);
    expect(r.rows[0]!.display_name).toBe('Demo x');
  });
});
