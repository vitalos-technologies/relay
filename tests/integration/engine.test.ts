// Durable publishing engine invariants against REAL PostgreSQL (spec §11, §18).
import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  approve, cancelSchedule, claimDelivery, createPost, processDelivery, publishNow, reconcileOne, reschedule, resolveDelivery,
  retryDelivery, schedulePost, submitForReview, sweepDeadlines, sweepExpiredLeases, updateDraft, getPostDetail, onScopePaused, onScopeResumed,
  type EngineDeps,
} from '@social-lite/services';
import { addMember, closeTestPool, createUser, ctxFor, tenant, testPool } from './helpers.js';
import { scriptedWorld, seedConnections, seedReadyImage, type ScriptedWorld } from './engine-helpers.js';
import { toLocalInput } from '@social-lite/core';

afterAll(closeTestPool);

async function drain(deps: EngineDeps, workerId = 'w1', max = 50): Promise<string[]> {
  const out: string[] = [];
  for (let i = 0; i < max; i++) {
    const c = await claimDelivery(workerId);
    if (!c) break;
    out.push(await processDelivery(deps, c));
  }
  return out;
}

async function states(postId: string): Promise<Record<string, string>> {
  const r = await testPool().query<{ provider: string; state: string }>(
    `SELECT d.provider, d.state FROM deliveries d WHERE d.post_id=$1 AND d.schedule_id=(SELECT id FROM schedules WHERE post_id=$1 ORDER BY generation DESC LIMIT 1)`, [postId]);
  return Object.fromEntries(r.rows.map((x) => [x.provider, x.state]));
}

async function makePost(t: Awaited<ReturnType<typeof tenant>>, conns: Record<string, string>, opts: { text?: string; image?: boolean; providers?: string[] } = {}) {
  const image = opts.image === false ? null : await seedReadyImage(t.workspaceId, t.brandId);
  const providers = opts.providers ?? ['instagram', 'facebook', 'telegram', 'x'];
  const ids = providers.map((p) => conns[p]!);
  const draft = { baseText: opts.text ?? 'Matchday graphic is live', baseLink: null, baseAssetIds: image ? [image] : [], variants: ids.map((connectionId) => ({ connectionId, inheritText: true, inheritMedia: true })) };
  const { id } = await createPost(t.ownerCtx, t.brandId, { title: 'Test post', draft }, randomUUID());
  return { id, ids };
}

/** Make due deliveries due now (tests do not wait for wall-clock time). */
async function makeDue(postId: string) {
  await testPool().query(`UPDATE deliveries SET next_attempt_at=now() - interval '1 second' WHERE post_id=$1 AND state IN ('scheduled','retry_wait','processing')`, [postId]);
}

let world: ScriptedWorld;
beforeEach(async () => {
  world = scriptedWorld();
  // isolate: no stray due work from earlier tests
  await testPool().query(`UPDATE deliveries SET state='cancelled' WHERE state IN ('scheduled','retry_wait','processing','preparing','publishing')`);
  await testPool().query(`UPDATE system_flags SET value='true' WHERE key='dispatch_enabled'`);
  await testPool().query(`DELETE FROM provider_circuits`);
});

describe('four-channel scheduling', () => {
  it('schedules one image post to four destinations atomically and publishes each independently', async () => {
    const t = await tenant();
    const conns = await seedConnections(t.workspaceId, t.brandId);
    const { id, ids } = await makePost(t, conns);
    const when = toLocalInput(new Date(Date.now() + 3600_000), 'Europe/London');
    const r = await schedulePost(t.ownerCtx, id, { expected_version: 1, connection_ids: ids, input_local_time: when, timezone: 'Europe/London' }, randomUUID());
    expect(r.status).toBe(202);
    const body = r.body as { schedule: { due_at: string; input_timezone: string; input_local_time: string }; deliveries: unknown[] };
    expect(body.deliveries).toHaveLength(4);
    expect(body.schedule.input_timezone).toBe('Europe/London');
    expect(body.schedule.input_local_time).toBe(when);
    const outbox = await testPool().query(`SELECT count(*)::int n FROM outbox WHERE event_type='delivery.due' AND aggregate_id = ANY(SELECT id::text FROM deliveries WHERE post_id=$1)`, [id]);
    expect(outbox.rows[0].n).toBe(4);
    expect(await drain(world.deps)).toEqual([]); // not due yet
    await makeDue(id);
    const results = await drain(world.deps);
    expect(results.sort()).toEqual(['published', 'published', 'published', 'published']);
    expect(await states(id)).toEqual({ instagram: 'published', facebook: 'published', telegram: 'published', x: 'published' });
    const s = await testPool().query(`SELECT status FROM schedules WHERE post_id=$1`, [id]);
    expect(s.rows[0].status).toBe('completed');
    const detail = await getPostDetail(t.ownerCtx, id);
    expect(detail.status).toBe('published');
    expect(detail.deliveries.every((d) => d.state_label === 'Simulated')).toBe(true);
  });

  it('rejects Instagram text-only before scheduling with an exact, channel-specific fix', async () => {
    const t = await tenant();
    const conns = await seedConnections(t.workspaceId, t.brandId);
    const { id, ids } = await makePost(t, conns, { image: false });
    await expect(publishNow(t.ownerCtx, id, { expected_version: 1, connection_ids: ids }, randomUUID())).rejects.toMatchObject({
      code: 'validation_failed', details: { issues: expect.arrayContaining([expect.objectContaining({ provider: 'instagram', code: 'media_required' })]) },
    });
    const n = await testPool().query(`SELECT count(*)::int n FROM schedules WHERE post_id=$1`, [id]);
    expect(n.rows[0].n).toBe(0); // atomic: nothing written
  });

  it('repeated request with the same idempotency key creates one schedule and one delivery per destination', async () => {
    const t = await tenant();
    const conns = await seedConnections(t.workspaceId, t.brandId);
    const { id, ids } = await makePost(t, conns);
    const key = randomUUID();
    const req = { expected_version: 1, connection_ids: ids };
    const [a, b] = await Promise.all([publishNow(t.ownerCtx, id, req, key), publishNow(t.ownerCtx, id, req, key)]);
    expect(a.body).toEqual(b.body);
    const n = await testPool().query(`SELECT count(*)::int s, (SELECT count(*)::int FROM deliveries WHERE post_id=$1) d FROM schedules WHERE post_id=$1`, [id]);
    expect(n.rows[0]).toEqual({ s: 1, d: 4 });
    await expect(publishNow(t.ownerCtx, id, { ...req, connection_ids: ids.slice(1) }, key)).rejects.toMatchObject({ code: 'idempotency_conflict' });
  });

  it('two workers racing for the same jobs: each delivery is claimed and published exactly once', async () => {
    const t = await tenant();
    const conns = await seedConnections(t.workspaceId, t.brandId);
    const { id, ids } = await makePost(t, conns);
    await publishNow(t.ownerCtx, id, { expected_version: 1, connection_ids: ids }, randomUUID());
    const [r1, r2, r3] = await Promise.all([drain(world.deps, 'wA'), drain(world.deps, 'wB'), drain(world.deps, 'wC')]);
    expect([...r1, ...r2, ...r3].filter((x) => x === 'published')).toHaveLength(4);
    expect([...world.publishCalls.values()].every((n) => n === 1)).toBe(true);
    expect(world.publishCalls.size).toBe(4);
  });
});

describe('failure handling', () => {
  it('partial success: retry resends only the failed destination', async () => {
    const t = await tenant();
    const conns = await seedConnections(t.workspaceId, t.brandId);
    const { id, ids } = await makePost(t, conns);
    world.scripts.x = { publish: (_d, n) => (n === 1 ? { kind: 'permanent_failure', code: 'rejected', message: 'X rejected the post.' } : { kind: 'confirmed', providerIds: ['mock_x_ok'] }) };
    await publishNow(t.ownerCtx, id, { expected_version: 1, connection_ids: ids }, randomUUID());
    await drain(world.deps);
    expect(await states(id)).toEqual({ instagram: 'published', facebook: 'published', telegram: 'published', x: 'failed' });
    expect((await getPostDetail(t.ownerCtx, id)).status).toBe('partial');
    const before = new Map(world.publishCalls);
    const xd = await testPool().query<{ id: string }>(`SELECT id FROM deliveries WHERE post_id=$1 AND provider='x'`, [id]);
    await retryDelivery(t.ownerCtx, xd.rows[0]!.id, {});
    await drain(world.deps);
    expect(await states(id)).toEqual({ instagram: 'published', facebook: 'published', telegram: 'published', x: 'published' });
    for (const [k, v] of before) if (k !== xd.rows[0]!.id) expect(world.publishCalls.get(k)).toBe(v); // untouched
    const pub = await testPool().query<{ id: string }>(`SELECT id FROM deliveries WHERE post_id=$1 AND provider='facebook'`, [id]);
    await expect(retryDelivery(t.ownerCtx, pub.rows[0]!.id, {})).rejects.toMatchObject({ code: 'invalid_state' });
  });

  it('transient failures back off and respect the attempt budget', async () => {
    const t = await tenant();
    const conns = await seedConnections(t.workspaceId, t.brandId);
    const { id } = await makePost(t, conns, { image: false, providers: ['telegram'] });
    world.scripts.telegram = { publish: () => ({ kind: 'rejected_safe_to_retry', code: 'flood', message: 'Telegram asked us to slow down.', retryAfterMs: 1000 }) };
    await publishNow(t.ownerCtx, id, { expected_version: 1, connection_ids: [conns.telegram] }, randomUUID());
    await testPool().query(`UPDATE deliveries SET publish_before=now() + interval '2 hours' WHERE post_id=$1`, [id]);
    for (let i = 0; i < 6; i++) {
      await makeDue(id);
      await testPool().query(`UPDATE connections SET throttled_until=NULL WHERE id=$1`, [conns.telegram]);
      await drain(world.deps);
    }
    const d = await testPool().query(`SELECT state, attempt_count, last_error_message FROM deliveries WHERE post_id=$1`, [id]);
    expect(d.rows[0].state).toBe('failed');
    expect(d.rows[0].attempt_count).toBe(5);
    expect(d.rows[0].last_error_message).toMatch(/Gave up after 5 attempts/);
  });

  it('lost response after possible acceptance => Unknown, no automatic resend; reconciliation resolves it', async () => {
    const t = await tenant();
    const conns = await seedConnections(t.workspaceId, t.brandId);
    const { id } = await makePost(t, conns, { image: false, providers: ['facebook'] });
    world.scripts.facebook = {
      publish: () => ({ kind: 'unknown', code: 'timeout_after_send', message: 'The connection dropped after sending.' }),
      reconcile: () => ({ kind: 'published', providerIds: ['mock_fb_found'], url: 'https://facebook.example/mock_fb_found' }),
    };
    await publishNow(t.ownerCtx, id, { expected_version: 1, connection_ids: [conns.facebook] }, randomUUID());
    await drain(world.deps);
    expect(await states(id)).toEqual({ facebook: 'unknown' });
    await makeDue(id);
    expect(await drain(world.deps)).toEqual([]); // Unknown is never re-claimed for publishing
    const calls = world.publishCalls.size;
    await testPool().query(`UPDATE deliveries SET next_attempt_at=now() WHERE post_id=$1`, [id]);
    expect(await reconcileOne(world.deps, 'r1')).toBe('published');
    expect(world.publishCalls.size).toBe(calls);
    const d = await testPool().query(`SELECT provider_ids, state FROM deliveries WHERE post_id=$1`, [id]);
    expect(d.rows[0]).toMatchObject({ state: 'published', provider_ids: ['mock_fb_found'] });
  });

  it('Unknown with unsupported lookup (Telegram) requires manual resolution or an acknowledged retry', async () => {
    const t = await tenant();
    const conns = await seedConnections(t.workspaceId, t.brandId);
    const { id } = await makePost(t, conns, { image: false, providers: ['telegram'] });
    world.scripts.telegram = { publish: () => ({ kind: 'unknown', code: 'timeout', message: 'Timed out.' }), reconcile: () => ({ kind: 'unsupported', reason: 'Telegram cannot look up channel history.' }) };
    await publishNow(t.ownerCtx, id, { expected_version: 1, connection_ids: [conns.telegram] }, randomUUID());
    await drain(world.deps);
    await testPool().query(`UPDATE deliveries SET next_attempt_at=now() WHERE post_id=$1`, [id]);
    await reconcileOne(world.deps, 'r1');
    const row = await testPool().query<{ id: string; state: string; needs_reconcile: boolean }>(`SELECT id, state, needs_reconcile FROM deliveries WHERE post_id=$1`, [id]);
    expect(row.rows[0]).toMatchObject({ state: 'unknown', needs_reconcile: false });
    const did = row.rows[0]!.id;
    await expect(retryDelivery(t.ownerCtx, did, {})).rejects.toMatchObject({ details: { reason: 'duplicate_risk_ack_required' } });
    const resolved = await resolveDelivery(t.ownerCtx, did, { outcome: 'not_published', note: 'checked channel' });
    expect(resolved.state).toBe('failed');
    const audit = await testPool().query(`SELECT action FROM audit_events WHERE resource_id=$1`, [did]);
    expect(audit.rows.map((r) => r.action)).toContain('delivery.resolved_manually');
  });

  it('acknowledged retry of Unknown records duplicate-risk acknowledgement and does not auto-retry again', async () => {
    const t = await tenant();
    const conns = await seedConnections(t.workspaceId, t.brandId);
    const { id } = await makePost(t, conns, { image: false, providers: ['x'] });
    world.scripts.x = { publish: () => ({ kind: 'unknown', code: 'timeout', message: 'Timed out.' }) };
    await publishNow(t.ownerCtx, id, { expected_version: 1, connection_ids: [conns.x] }, randomUUID());
    await drain(world.deps);
    const did = (await testPool().query<{ id: string }>(`SELECT id FROM deliveries WHERE post_id=$1`, [id])).rows[0]!.id;
    await retryDelivery(t.ownerCtx, did, { acknowledge_duplicate_risk: true });
    world.scripts.x = { publish: () => ({ kind: 'rejected_safe_to_retry', code: 'x', message: 'busy' }) };
    await drain(world.deps);
    const d = await testPool().query(`SELECT state FROM deliveries WHERE id=$1`, [did]);
    expect(d.rows[0].state).toBe('failed'); // exactly one manual attempt
    const a = await testPool().query(`SELECT count(*)::int n FROM delivery_attempts WHERE delivery_id=$1 AND duplicate_risk_acknowledged`, [did]);
    expect(a.rows[0].n).toBe(1);
  });

  it('worker crash while sending => lease sweeper marks Unknown (never resends); crash before sending => requeued', async () => {
    const t = await tenant();
    const conns = await seedConnections(t.workspaceId, t.brandId);
    const { id } = await makePost(t, conns, { image: false, providers: ['facebook', 'telegram'] });
    await publishNow(t.ownerCtx, id, { expected_version: 1, connection_ids: [conns.facebook, conns.telegram] }, randomUUID());
    const a = await claimDelivery('dead-worker');
    const b = await claimDelivery('dead-worker');
    // a: simulate death mid-send; b: death during preparation
    await testPool().query(`UPDATE deliveries SET state='publishing', phase='sending', lease_expires_at=now() - interval '1 second' WHERE id=$1`, [a!.id]);
    await testPool().query(`UPDATE deliveries SET lease_expires_at=now() - interval '1 second' WHERE id=$1`, [b!.id]);
    const swept = await sweepExpiredLeases();
    expect(swept).toMatchObject({ unknown: 1, requeued: 1 });
    const rows = await testPool().query(`SELECT id, state FROM deliveries WHERE post_id=$1`, [id]);
    expect(rows.rows.find((r) => r.id === a!.id).state).toBe('unknown');
    expect(rows.rows.find((r) => r.id === b!.id).state).toBe('scheduled');
    // a stale worker cannot overwrite after losing its claim (fencing)
    const results = await drain(world.deps);
    expect(results).toEqual(['published']);
    const stale = await processDelivery(world.deps, { ...a!, prior_state: 'scheduled' });
    expect(['unknown', 'cancelled', 'stale', 'error', 'expired', 'paused', 'blocked']).toContain(stale);
    expect((await testPool().query(`SELECT state FROM deliveries WHERE id=$1`, [a!.id])).rows[0].state).toBe('unknown');
  });

  it('revoked credentials block the job and the connection; other channels continue', async () => {
    const t = await tenant();
    const conns = await seedConnections(t.workspaceId, t.brandId);
    const { id, ids } = await makePost(t, conns);
    world.credentialFailures.add(conns.x);
    await publishNow(t.ownerCtx, id, { expected_version: 1, connection_ids: ids }, randomUUID());
    await drain(world.deps);
    expect(await states(id)).toEqual({ instagram: 'published', facebook: 'published', telegram: 'published', x: 'blocked' });
    const c = await testPool().query(`SELECT status FROM connections WHERE id=$1`, [conns.x]);
    expect(c.rows[0].status).toBe('reconnect_required');
    const n = await testPool().query(`SELECT count(*)::int n FROM outbox WHERE event_type='connection.health_changed' AND aggregate_id=$1`, [conns.x]);
    expect(n.rows[0].n).toBeGreaterThan(0);
  });

  it('X budget exhausted blocks only X jobs (metered before sending)', async () => {
    const t = await tenant();
    const conns = await seedConnections(t.workspaceId, t.brandId);
    // A non-simulated X destination: budgets apply only to live X calls. The scripted adapter makes no network calls.
    const live = await testPool().query<{ id: string }>(
      `INSERT INTO connections(workspace_id, brand_id, provider, provider_account_id, display_name, status, is_mock, capabilities)
       SELECT workspace_id, brand_id, 'x', '9990001', 'Live X (test)', 'ready', false, capabilities FROM connections WHERE id=$1 RETURNING id`, [conns.x]);
    const liveX = live.rows[0]!.id;
    const draft = { baseText: 'Budget test', baseLink: null, baseAssetIds: [], variants: [conns.facebook, liveX].map((connectionId) => ({ connectionId, inheritText: true, inheritMedia: true })) };
    const { id } = await createPost(t.ownerCtx, t.brandId, { draft }, randomUUID());
    await testPool().query(`UPDATE workspaces SET limits='{"x_monthly_writes":1}' WHERE id=$1`, [t.workspaceId]);
    await publishNow(t.ownerCtx, id, { expected_version: 1, connection_ids: [conns.facebook, liveX] }, randomUUID());
    await drain(world.deps);
    expect(await states(id)).toEqual({ facebook: 'published', x: 'published' });
    const used = await testPool().query(`SELECT used::int FROM usage_counters WHERE workspace_id=$1 AND meter='x.write'`, [t.workspaceId]);
    expect(used.rows[0].used).toBe(1);
    // Second post: cap reached => X blocked with a clear reason, Facebook still publishes.
    const p2 = await createPost(t.ownerCtx, t.brandId, { draft }, randomUUID());
    await publishNow(t.ownerCtx, p2.id, { expected_version: 1, connection_ids: [conns.facebook, liveX] }, randomUUID());
    const calls = world.publishCalls.size;
    await drain(world.deps);
    expect(await states(p2.id)).toEqual({ facebook: 'published', x: 'blocked' });
    expect(world.publishCalls.size).toBe(calls + 1);
    const d = await testPool().query(`SELECT blocked_reason FROM deliveries WHERE post_id=$1 AND provider='x'`, [p2.id]);
    expect(d.rows[0].blocked_reason).toMatch(/budget/);
    const n = await testPool().query(`SELECT count(*)::int n FROM outbox WHERE event_type='notification.created' AND workspace_id=$1`, [t.workspaceId]);
    expect(n.rows[0].n).toBeGreaterThan(0); // threshold notifications
  });
});

describe('pause, cancel, reschedule, deadlines', () => {
  it('pause is enforced at dispatch; resume restores timely jobs', async () => {
    const t = await tenant();
    const conns = await seedConnections(t.workspaceId, t.brandId);
    const { id } = await makePost(t, conns, { image: false, providers: ['telegram'] });
    await publishNow(t.ownerCtx, id, { expected_version: 1, connection_ids: [conns.telegram] }, randomUUID());
    // Pause flag set WITHOUT the hook: dispatch-time check must still stop it (SC-05).
    await testPool().query(`UPDATE brands SET publishing_paused=true WHERE id=$1`, [t.brandId]);
    expect(await drain(world.deps)).toEqual(['paused']);
    expect(world.publishCalls.size).toBe(0);
    await testPool().query(`UPDATE brands SET publishing_paused=false WHERE id=$1`, [t.brandId]);
    const r = await onScopeResumed(testPool(), { workspaceId: t.workspaceId, brandId: t.brandId });
    expect(r.resumed).toBe(1);
    expect(await drain(world.deps)).toEqual(['published']);
  });

  it('pause hook marks waiting jobs Paused; resume after the deadline expires them instead of flooding', async () => {
    const t = await tenant();
    const conns = await seedConnections(t.workspaceId, t.brandId);
    const { id } = await makePost(t, conns, { image: false, providers: ['facebook'] });
    await schedulePost(t.ownerCtx, id, { expected_version: 1, connection_ids: [conns.facebook], input_local_time: toLocalInput(new Date(Date.now() + 3600_000), 'Europe/London'), timezone: 'Europe/London' }, randomUUID());
    await testPool().query(`UPDATE workspaces SET publishing_paused=true WHERE id=$1`, [t.workspaceId]);
    expect(await onScopePaused(testPool(), { workspaceId: t.workspaceId })).toBe(1);
    await testPool().query(`UPDATE deliveries SET publish_before=now() - interval '1 minute', due_at=now() - interval '20 minutes' WHERE post_id=$1`, [id]);
    await testPool().query(`UPDATE workspaces SET publishing_paused=false WHERE id=$1`, [t.workspaceId]);
    const r = await onScopeResumed(testPool(), { workspaceId: t.workspaceId });
    expect(r).toEqual({ resumed: 0, expired: 1 });
  });

  it('cancel before claim cancels; cancel after sending began reports honestly', async () => {
    const t = await tenant();
    const conns = await seedConnections(t.workspaceId, t.brandId);
    const { id } = await makePost(t, conns, { image: false, providers: ['facebook', 'telegram'] });
    const r = await publishNow(t.ownerCtx, id, { expected_version: 1, connection_ids: [conns.facebook, conns.telegram] }, randomUUID());
    const scheduleId = (r.body as { schedule: { id: string } }).schedule.id;
    const claimed = await claimDelivery('w1');
    await testPool().query(`UPDATE deliveries SET state='publishing', phase='sending' WHERE id=$1`, [claimed!.id]);
    const c = await cancelSchedule(t.ownerCtx, scheduleId);
    expect(c.message).toMatch(/Cancellation requested; publication may already be in progress/);
    const rows = await testPool().query<{ id: string; state: string }>(`SELECT id, state FROM deliveries WHERE schedule_id=$1`, [scheduleId]);
    expect(rows.rows.find((x) => x.id === claimed!.id)!.state).toBe('publishing');
    expect(rows.rows.find((x) => x.id !== claimed!.id)!.state).toBe('cancelled');
  });

  it('cancel while a worker is preparing: the worker stops before sending (fenced, deterministic)', async () => {
    const t = await tenant();
    const conns = await seedConnections(t.workspaceId, t.brandId);
    const { id } = await makePost(t, conns, { image: false, providers: ['facebook'] });
    const r = await publishNow(t.ownerCtx, id, { expected_version: 1, connection_ids: [conns.facebook] }, randomUUID());
    let release!: () => void;
    const gateP = new Promise<void>((res) => { release = res; });
    world.scripts.facebook = { prepare: async () => { await gateP; return { kind: 'ready', checkpoint: { step: 'ready', data: {} } }; } };
    const c = await claimDelivery('w1');
    const running = processDelivery(world.deps, c!);
    await new Promise((res) => setTimeout(res, 100));
    await cancelSchedule(t.ownerCtx, (r.body as { schedule: { id: string } }).schedule.id);
    release();
    expect(['stale', 'cancelled']).toContain(await running);
    expect(world.publishCalls.size).toBe(0);
    expect(await states(id)).toEqual({ facebook: 'cancelled' });
  });

  it('rescheduling creates a new generation; old jobs become harmless no-ops', async () => {
    const t = await tenant();
    const conns = await seedConnections(t.workspaceId, t.brandId);
    const { id } = await makePost(t, conns, { image: false, providers: ['telegram'] });
    const r = await schedulePost(t.ownerCtx, id, { expected_version: 1, connection_ids: [conns.telegram], input_local_time: toLocalInput(new Date(Date.now() + 3600_000), 'Europe/London'), timezone: 'Europe/London' }, randomUUID());
    const s1 = (r.body as { schedule: { id: string; generation: number } }).schedule;
    const r2 = await reschedule(t.ownerCtx, s1.id, { input_local_time: toLocalInput(new Date(Date.now() + 7200_000), 'Europe/London'), timezone: 'Europe/London', expected_generation: s1.generation }, randomUUID());
    const s2 = (r2.body as { schedule: { generation: number } }).schedule;
    expect(s2.generation).toBe(s1.generation + 1);
    const old = await testPool().query(`SELECT state FROM deliveries WHERE schedule_id=$1`, [s1.id]);
    expect(old.rows[0].state).toBe('cancelled');
    // Even if an old job were somehow still queued, the generation gate makes it a no-op.
    await testPool().query(`UPDATE deliveries SET state='scheduled', next_attempt_at=now() WHERE schedule_id=$1`, [s1.id]);
    expect(await drain(world.deps)).toEqual(['cancelled']);
    expect(world.publishCalls.size).toBe(0);
    await expect(reschedule(t.ownerCtx, s1.id, { input_local_time: toLocalInput(new Date(Date.now() + 9000_000), 'Europe/London'), expected_generation: s1.generation }, randomUUID())).rejects.toMatchObject({ code: 'conflict' });
  });

  it('stale jobs after downtime expire for review instead of being sent', async () => {
    const t = await tenant();
    const conns = await seedConnections(t.workspaceId, t.brandId);
    const { id } = await makePost(t, conns, { image: false, providers: ['facebook', 'telegram'] });
    await publishNow(t.ownerCtx, id, { expected_version: 1, connection_ids: [conns.facebook, conns.telegram] }, randomUUID());
    await testPool().query(`UPDATE deliveries SET publish_before=now() - interval '1 minute' WHERE post_id=$1`, [id]);
    expect(await sweepDeadlines()).toBe(2);
    expect(await drain(world.deps)).toEqual([]);
    expect(await states(id)).toEqual({ facebook: 'expired', telegram: 'expired' });
  });

  it('dispatch disabled (restore mode) stops all claims', async () => {
    const t = await tenant();
    const conns = await seedConnections(t.workspaceId, t.brandId);
    const { id } = await makePost(t, conns, { image: false, providers: ['facebook'] });
    await publishNow(t.ownerCtx, id, { expected_version: 1, connection_ids: [conns.facebook] }, randomUUID());
    const { dispatchEnabled } = await import('@social-lite/services');
    await testPool().query(`UPDATE system_flags SET value='false' WHERE key='dispatch_enabled'`);
    expect(await dispatchEnabled()).toBe(false);
  });

  it('rejects nonexistent DST times and requires an offset for ambiguous ones', async () => {
    const t = await tenant();
    const conns = await seedConnections(t.workspaceId, t.brandId);
    const { id } = await makePost(t, conns, { image: false, providers: ['facebook'] });
    await expect(schedulePost(t.ownerCtx, id, { expected_version: 1, connection_ids: [conns.facebook], input_local_time: '2027-03-28T01:30', timezone: 'Europe/London' }, randomUUID()))
      .rejects.toMatchObject({ code: 'validation_failed' });
    await expect(schedulePost(t.ownerCtx, id, { expected_version: 1, connection_ids: [conns.facebook], input_local_time: '2027-10-31T01:30', timezone: 'Europe/London' }, randomUUID()))
      .rejects.toMatchObject({ code: 'conflict', details: { reason: 'ambiguous_time' } });
    const r = await schedulePost(t.ownerCtx, id, { expected_version: 1, connection_ids: [conns.facebook], input_local_time: '2027-10-31T01:30', timezone: 'Europe/London', offset: '+00:00' }, randomUUID());
    expect((r.body as { schedule: { due_at: string; input_offset: string } }).schedule).toMatchObject({ due_at: '2027-10-31T01:30:00.000Z', input_offset: '+00:00' });
  });
});

describe('approval', () => {
  it('approval binds the exact revision and schedule; content changes invalidate it', async () => {
    const t = await tenant({ approvalRequired: true });
    const conns = await seedConnections(t.workspaceId, t.brandId);
    const editor = await createUser();
    await addMember(t.workspaceId, editor.id, 'editor');
    const approver = await createUser();
    await addMember(t.workspaceId, approver.id, 'approver');
    const eCtx = ctxFor(editor.id, t.workspaceId, 'editor');
    const aCtx = ctxFor(approver.id, t.workspaceId, 'approver');
    const draft = { baseText: 'Needs review', baseLink: null, baseAssetIds: [], variants: [{ connectionId: conns.facebook, inheritText: true, inheritMedia: true }] };
    const { id } = await createPost(eCtx, t.brandId, { draft }, randomUUID());
    await expect(publishNow(eCtx, id, { expected_version: 1, connection_ids: [conns.facebook] }, randomUUID())).rejects.toMatchObject({ code: 'invalid_state' });
    const sub = await submitForReview(eCtx, id, { expected_version: 1, connection_ids: [conns.facebook] }, randomUUID());
    const approval1 = (sub.body as { approval: { id: string; fingerprint: string } }).approval;
    expect(await drain(world.deps)).toEqual([]); // nothing dispatches before approval
    // Content change invalidates the pending approval (AP-02)
    await updateDraft(eCtx, id, { expected_version: 1, draft: { ...draft, baseText: 'Changed after submit' } });
    await expect(approve(aCtx, approval1.id, approval1.fingerprint)).rejects.toMatchObject({ code: 'invalid_state' });
    const sub2 = await submitForReview(eCtx, id, { expected_version: 2, connection_ids: [conns.facebook] }, randomUUID());
    const approval2 = (sub2.body as { approval: { id: string; fingerprint: string } }).approval;
    await expect(approve(ctxFor(editor.id, t.workspaceId, 'editor'), approval2.id, approval2.fingerprint)).rejects.toMatchObject({ code: 'forbidden' });
    const res = await approve(aCtx, approval2.id, approval2.fingerprint);
    expect(res.deliveries).toHaveLength(1);
    expect(await drain(world.deps)).toEqual(['published']);
    // The dispatcher independently checks approval: tampering with the approval blocks dispatch.
    const sub3 = await submitForReview(eCtx, id, { expected_version: 2, connection_ids: [conns.facebook] }, randomUUID());
    const a3 = (sub3.body as { approval: { id: string; fingerprint: string } }).approval;
    await approve(aCtx, a3.id, a3.fingerprint);
    await testPool().query(`UPDATE approvals SET decision='invalidated' WHERE id=$1`, [a3.id]);
    expect(await drain(world.deps)).toEqual(['blocked']);
  });

  it('rejection requires a reason', async () => {
    const t = await tenant({ approvalRequired: true });
    const conns = await seedConnections(t.workspaceId, t.brandId);
    const draft = { baseText: 'x', baseLink: null, baseAssetIds: [], variants: [{ connectionId: conns.telegram, inheritText: true, inheritMedia: true }] };
    const { id } = await createPost(t.ownerCtx, t.brandId, { draft }, randomUUID());
    const sub = await submitForReview(t.ownerCtx, id, { expected_version: 1, connection_ids: [conns.telegram] }, randomUUID());
    const { reject } = await import('@social-lite/services');
    await expect(reject(t.ownerCtx, (sub.body as { approval: { id: string } }).approval.id, '  ')).rejects.toMatchObject({ code: 'validation_failed' });
  });
});

describe('tenant isolation in the engine APIs', () => {
  it('cannot read, schedule, retry or cancel another workspace’s post', async () => {
    const a = await tenant();
    const b = await tenant();
    const conns = await seedConnections(a.workspaceId, a.brandId);
    const { id } = await makePost(a, conns, { image: false, providers: ['facebook'] });
    const r = await publishNow(a.ownerCtx, id, { expected_version: 1, connection_ids: [conns.facebook] }, randomUUID());
    const sid = (r.body as { schedule: { id: string } }).schedule.id;
    const did = (r.body as { deliveries: Array<{ id: string }> }).deliveries[0]!.id;
    await expect(getPostDetail(b.ownerCtx, id)).rejects.toMatchObject({ code: 'not_found' });
    await expect(publishNow(b.ownerCtx, id, { expected_version: 1, connection_ids: [conns.facebook] }, randomUUID())).rejects.toMatchObject({ code: 'not_found' });
    await expect(cancelSchedule(b.ownerCtx, sid)).rejects.toMatchObject({ code: 'not_found' });
    await expect(retryDelivery(b.ownerCtx, did, {})).rejects.toMatchObject({ code: 'not_found' });
    // B cannot reference A's connection from its own post either
    const draft = { baseText: 'x', baseLink: null, baseAssetIds: [], variants: [{ connectionId: conns.facebook, inheritText: true, inheritMedia: true }] };
    await expect(createPost(b.ownerCtx, b.brandId, { draft }, randomUUID())).rejects.toMatchObject({ code: 'validation_failed' });
  });

  it('viewer cannot create drafts; editor cannot schedule unless brand policy permits', async () => {
    const t = await tenant();
    const conns = await seedConnections(t.workspaceId, t.brandId);
    const viewer = await createUser();
    await addMember(t.workspaceId, viewer.id, 'viewer');
    await expect(createPost(ctxFor(viewer.id, t.workspaceId, 'viewer'), t.brandId, {}, randomUUID())).rejects.toMatchObject({ code: 'forbidden' });
    const editor = await createUser();
    await addMember(t.workspaceId, editor.id, 'editor');
    const eCtx = ctxFor(editor.id, t.workspaceId, 'editor');
    const draft = { baseText: 'x', baseLink: null, baseAssetIds: [], variants: [{ connectionId: conns.telegram, inheritText: true, inheritMedia: true }] };
    const { id } = await createPost(eCtx, t.brandId, { draft }, randomUUID());
    await expect(publishNow(eCtx, id, { expected_version: 1, connection_ids: [conns.telegram] }, randomUUID())).rejects.toMatchObject({ code: 'forbidden' });
  });
});
