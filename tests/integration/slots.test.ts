// Posting slots & "Add to queue" (V1.1, SC-03) against REAL PostgreSQL.
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import type { AppError } from '@social-lite/core';
import { cancelSchedule, createPost, updateDraft } from '@social-lite/services';
import { createSlot, deleteSlot, listSlots, occurrencesAfter, queuePost, queueView, updateSlot } from '@social-lite/services/slots/index';
import { updateBrand } from '@social-lite/services/brands';
import { addMember, closeTestPool, createUser, ctxFor, grant, tenant, testPool, v2Ctx } from './helpers.js';
import { seedConnections } from './engine-helpers.js';

afterAll(closeTestPool);

type Tenant = Awaited<ReturnType<typeof tenant>>;
type QueueBody = { schedule: { id: string; due_at: string; input_local_time: string; input_offset: string | null; status: string; input_timezone: string }; approval?: { decision: string };
  queue: { occurrence: { local: string; at: string; offset: string; fold: boolean }; skipped: Array<{ local: string; kind: string }>; mode: string } };

async function textPost(t: Tenant, conn: string, ctx = t.ownerCtx) {
  const draft = { baseText: `Queued ${randomUUID().slice(0, 6)}`, baseLink: null, baseAssetIds: [], variants: [{ connectionId: conn, inheritText: true, inheritMedia: true }] };
  return (await createPost(ctx, t.brandId, { title: 'Q', draft }, randomUUID())).id;
}

async function setup(opts: { approvalRequired?: boolean; editorsCanPublish?: boolean } = {}) {
  const t = await tenant(opts);
  const conns = await seedConnections(t.workspaceId, t.brandId);
  return { t, conns };
}

describe('recurrence (explicit wall clock)', () => {
  it('skips a DST gap occurrence and reports it', () => {
    // Europe/London springs forward 2027-03-28 01:00 GMT -> 02:00 BST: 01:30 does not exist.
    const occ = occurrencesAfter({ weekdays: [7], localTime: '01:30', timezone: 'Europe/London' }, new Date('2027-03-20T12:00:00Z'), 21);
    expect(occ.map((o) => [o.kind, o.local])).toEqual([
      ['ok', '2027-03-21T01:30'], ['gap', '2027-03-28T01:30'], ['ok', '2027-04-04T01:30'],
    ]);
    const after = occ[2] as Extract<typeof occ[number], { kind: 'ok' }>;
    expect(after.offset).toBe('+01:00');
    expect(after.instant.toISOString()).toBe('2027-04-04T00:30:00.000Z');
  });

  it('uses the earlier instant (pre-transition offset) in a DST fold, once', () => {
    // Europe/London falls back 2027-10-31 02:00 BST -> 01:00 GMT: 01:30 happens twice.
    const occ = occurrencesAfter({ weekdays: [7], localTime: '01:30', timezone: 'Europe/London' }, new Date('2027-10-30T12:00:00Z'), 7);
    expect(occ).toHaveLength(1); // one occurrence, not two
    const fold = occ[0] as Extract<typeof occ[number], { kind: 'ok' }>;
    expect(fold).toMatchObject({ kind: 'ok', local: '2027-10-31T01:30', offset: '+01:00', fold: true });
    expect(fold.instant.toISOString()).toBe('2027-10-31T00:30:00.000Z');
  });

  it('weekday and wall time are evaluated in the slot zone, not UTC', () => {
    // 23:30 Monday in Los Angeles is Tuesday 07:30 UTC.
    const occ = occurrencesAfter({ weekdays: [1], localTime: '23:30', timezone: 'America/Los_Angeles' }, new Date('2026-11-09T00:00:00Z'), 7);
    expect(occ[0]).toMatchObject({ kind: 'ok', local: '2026-11-09T23:30' });
    expect((occ[0] as { instant: Date }).instant.toISOString()).toBe('2026-11-10T07:30:00.000Z');
  });
});

describe('slot management', () => {
  it('owner/admin manage slots; editors and viewers cannot; cross-tenant is 404; edits are audited', async () => {
    const { t, conns } = await setup();
    const editor = await createUser();
    await addMember(t.workspaceId, editor.id, 'editor');
    const eCtx = ctxFor(editor.id, t.workspaceId, 'editor');
    await expect(createSlot(eCtx, t.brandId, { weekdays: [1], local_time: '09:00', connection_ids: [conns.x] })).rejects.toMatchObject({ code: 'forbidden' });
    const s = await createSlot(t.ownerCtx, t.brandId, { weekdays: [1, 3], local_time: '09:00', connection_ids: [conns.x, conns.facebook] });
    expect(s.timezone).toBe('Europe/London'); // brand default, stored explicitly on the slot
    const listed = await listSlots(eCtx, t.brandId);
    expect(listed.items[0]!.next.length).toBeGreaterThan(0);
    const other = await tenant();
    await expect(listSlots(other.ownerCtx, t.brandId)).rejects.toMatchObject({ code: 'not_found' });
    await expect(updateSlot(other.ownerCtx, s.id, { local_time: '10:00' })).rejects.toMatchObject({ code: 'not_found' });
    await expect(createSlot(t.ownerCtx, t.brandId, { weekdays: [1], local_time: '09:00', connection_ids: [(await seedConnections(other.workspaceId, other.brandId)).x] }))
      .rejects.toMatchObject({ code: 'validation_failed' });
    await expect(createSlot(t.ownerCtx, t.brandId, { weekdays: [8], local_time: '25:00', connection_ids: [conns.x] })).rejects.toThrow();
    const u = await updateSlot(t.ownerCtx, s.id, { local_time: '10:15' });
    expect(u.local_time).toBe('10:15');
    await deleteSlot(t.ownerCtx, s.id);
    expect((await listSlots(t.ownerCtx, t.brandId)).items).toHaveLength(0);
    const a = await testPool().query(`SELECT action FROM audit_events WHERE workspace_id=$1 AND resource_type='posting_slot' ORDER BY id`, [t.workspaceId]);
    expect(a.rows.map((r) => r.action)).toEqual(['slot.created', 'slot.updated', 'slot.deleted']);
  });
});

describe('add to queue', () => {
  it('schedules into the next free occurrence with the slot zone and destinations; next post gets the next one', async () => {
    const { t, conns } = await setup();
    await createSlot(t.ownerCtx, t.brandId, { weekdays: [1, 2, 3, 4, 5, 6, 7], local_time: '09:00', timezone: 'America/New_York', connection_ids: [conns.x, conns.telegram] });
    const p1 = await textPost(t, conns.x);
    const p2 = await textPost(t, conns.x);
    const r1 = await queuePost(t.ownerCtx, { post_id: p1, expected_version: 1 }, randomUUID());
    const r2 = await queuePost(t.ownerCtx, { post_id: p2, expected_version: 1 }, randomUUID());
    const b1 = r1.body as QueueBody; const b2 = r2.body as QueueBody;
    expect(r1.status).toBe(202);
    expect(b1.schedule.input_timezone).toBe('America/New_York');
    expect(b1.schedule.input_local_time.endsWith('T09:00')).toBe(true);
    expect(new Date(b2.schedule.due_at).getTime() - new Date(b1.schedule.due_at).getTime()).toBeGreaterThanOrEqual(23 * 3600_000);
    const d = await testPool().query(`SELECT connection_id FROM deliveries WHERE schedule_id=$1 ORDER BY connection_id`, [b1.schedule.id]);
    expect(d.rows.map((r) => r.connection_id).sort()).toEqual([conns.x, conns.telegram].sort());
    const view = await queueView(t.ownerCtx, t.brandId, 3);
    expect(view.items.filter((i) => i.taken_by).map((i) => i.taken_by!.post_id).sort()).toEqual([p1, p2].sort());
  });

  it('idempotent: replaying the same key returns the original response and takes no second slot', async () => {
    const { t, conns } = await setup();
    await createSlot(t.ownerCtx, t.brandId, { weekdays: [1, 2, 3, 4, 5, 6, 7], local_time: '12:00', connection_ids: [conns.facebook] });
    const p = await textPost(t, conns.facebook);
    const key = randomUUID();
    const a = await queuePost(t.ownerCtx, { post_id: p, expected_version: 1 }, key);
    const b = await queuePost(t.ownerCtx, { post_id: p, expected_version: 1 }, key);
    expect((b.body as QueueBody).schedule.id).toBe((a.body as QueueBody).schedule.id);
    const n = await testPool().query(`SELECT count(*)::int n FROM slot_reservations WHERE post_id=$1`, [p]);
    expect(n.rows[0].n).toBe(1);
  });

  it('two users queueing simultaneously never take the same occurrence', async () => {
    // V2: scheduling comes from a publisher grant (editors_can_publish no longer grants anything).
    const { t, conns } = await setup();
    const editor = await createUser();
    await addMember(t.workspaceId, editor.id, 'editor');
    await grant(t.workspaceId, editor.id, 'publisher');
    const eCtx = await v2Ctx(editor.id, t.workspaceId);
    const slot = await createSlot(t.ownerCtx, t.brandId, { weekdays: [1, 2, 3, 4, 5, 6, 7], local_time: '08:00', connection_ids: [conns.facebook] });
    const posts = await Promise.all(Array.from({ length: 6 }, (_, i) => textPost(t, conns.facebook, i % 2 ? eCtx : t.ownerCtx)));
    const results = await Promise.all(posts.map((p, i) => queuePost(i % 2 ? eCtx : t.ownerCtx, { post_id: p, expected_version: 1 }, randomUUID())));
    const dues = results.map((r) => (r.body as QueueBody).schedule.due_at);
    expect(new Set(dues).size).toBe(6);
    const res = await testPool().query(`SELECT occurrence_at FROM slot_reservations WHERE slot_id=$1 AND released_at IS NULL`, [slot.id]);
    expect(res.rows).toHaveLength(6);
    // The unique index is the backstop.
    const r0 = await testPool().query(`SELECT * FROM slot_reservations WHERE slot_id=$1 LIMIT 1`, [slot.id]);
    const row = r0.rows[0];
    await expect(testPool().query(
      `INSERT INTO slot_reservations(workspace_id, brand_id, slot_id, occurrence_at, local_time, utc_offset, post_id) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [row.workspace_id, row.brand_id, row.slot_id, row.occurrence_at, row.local_time, row.utc_offset, posts[0]])).rejects.toMatchObject({ code: '23505' });
  });

  it('DST gap occurrence is skipped (reported); fold uses the earlier offset', async () => {
    const { t, conns } = await setup();
    await createSlot(t.ownerCtx, t.brandId, { weekdays: [7], local_time: '01:30', timezone: 'Europe/London', connection_ids: [conns.facebook] });
    const p = await textPost(t, conns.facebook);
    const gap = await queuePost(t.ownerCtx, { post_id: p, expected_version: 1 }, randomUUID(), { now: new Date('2027-03-27T12:00:00Z') });
    const g = gap.body as QueueBody;
    expect(g.queue.skipped.map((s) => s.local)).toEqual(['2027-03-28T01:30']);
    expect(g.schedule.input_local_time).toBe('2027-04-04T01:30');
    expect(g.schedule.due_at).toBe('2027-04-04T00:30:00.000Z');

    const p2 = await textPost(t, conns.facebook);
    const fold = await queuePost(t.ownerCtx, { post_id: p2, expected_version: 1 }, randomUUID(), { now: new Date('2027-10-30T12:00:00Z') });
    const f = fold.body as QueueBody;
    expect(f.queue.occurrence).toMatchObject({ local: '2027-10-31T01:30', offset: '+01:00', fold: true });
    expect(f.schedule.due_at).toBe('2027-10-31T00:30:00.000Z');
    expect(f.schedule.input_offset).toBe('+01:00');
    // The fold is a single occurrence: the next post goes to the following Sunday, not 01:30 GMT the same night.
    const p3 = await textPost(t, conns.facebook);
    const next = await queuePost(t.ownerCtx, { post_id: p3, expected_version: 1 }, randomUUID(), { now: new Date('2027-10-30T12:00:00Z') });
    expect((next.body as QueueBody).schedule.input_local_time).toBe('2027-11-07T01:30');
  });

  it('approval-required brands submit for review at the slot time instead of scheduling', async () => {
    const { t, conns } = await setup({ approvalRequired: true });
    const editor = await createUser();
    await addMember(t.workspaceId, editor.id, 'editor');
    const eCtx = ctxFor(editor.id, t.workspaceId, 'editor');
    await createSlot(t.ownerCtx, t.brandId, { weekdays: [1, 2, 3, 4, 5, 6, 7], local_time: '18:00', connection_ids: [conns.x] });
    const p = await textPost(t, conns.x, eCtx);
    const r = await queuePost(eCtx, { post_id: p, expected_version: 1 }, randomUUID());
    const b = r.body as QueueBody;
    expect(b.schedule.status).toBe('pending_approval');
    expect(b.approval?.decision).toBe('pending');
    expect(b.queue.mode).toBe('submitted_for_review');
    const d = await testPool().query(`SELECT count(*)::int n FROM deliveries WHERE schedule_id=$1`, [b.schedule.id]);
    expect(d.rows[0].n).toBe(0);
  });

  it('permission rules apply: editors without publish rights, viewers and other tenants are refused and hold no slot', async () => {
    const { t, conns } = await setup({ editorsCanPublish: false });
    await createSlot(t.ownerCtx, t.brandId, { weekdays: [1, 2, 3, 4, 5, 6, 7], local_time: '07:00', connection_ids: [conns.x] });
    const p = await textPost(t, conns.x);
    const editor = await createUser(); await addMember(t.workspaceId, editor.id, 'editor');
    const viewer = await createUser(); await addMember(t.workspaceId, viewer.id, 'viewer');
    await expect(queuePost(ctxFor(editor.id, t.workspaceId, 'editor'), { post_id: p, expected_version: 1 }, randomUUID())).rejects.toMatchObject({ code: 'forbidden' });
    await expect(queuePost(ctxFor(viewer.id, t.workspaceId, 'viewer'), { post_id: p, expected_version: 1 }, randomUUID())).rejects.toMatchObject({ code: 'forbidden' });
    const other = await tenant();
    await expect(queuePost(other.ownerCtx, { post_id: p, expected_version: 1 }, randomUUID())).rejects.toMatchObject({ code: 'not_found' });
    // Validation failure (stale version) also leaves nothing reserved.
    await updateDraft(t.ownerCtx, p, { expected_version: 1, title: 'changed' });
    await expect(queuePost(t.ownerCtx, { post_id: p, expected_version: 1 }, randomUUID())).rejects.toMatchObject({ code: 'version_conflict' });
    const n = await testPool().query(`SELECT count(*)::int n FROM slot_reservations WHERE post_id=$1`, [p]);
    expect(n.rows[0].n).toBe(0);
  });

  it('a cancelled queued post frees its occurrence; a brand/workspace timezone change never moves queued posts', async () => {
    const { t, conns } = await setup();
    const slot = await createSlot(t.ownerCtx, t.brandId, { weekdays: [1, 2, 3, 4, 5, 6, 7], local_time: '10:00', connection_ids: [conns.facebook] });
    const p1 = await textPost(t, conns.facebook);
    const a = (await queuePost(t.ownerCtx, { post_id: p1, expected_version: 1 }, randomUUID())).body as QueueBody;
    await updateBrand(t.ownerCtx, t.brandId, { timezone: 'Asia/Tokyo' });
    await testPool().query(`UPDATE workspaces SET timezone='Asia/Tokyo' WHERE id=$1`, [t.workspaceId]);
    const s = await testPool().query(`SELECT due_at, input_timezone FROM schedules WHERE id=$1`, [a.schedule.id]);
    expect(s.rows[0].due_at.toISOString()).toBe(a.schedule.due_at);
    expect(s.rows[0].input_timezone).toBe('Europe/London');
    expect((await listSlots(t.ownerCtx, t.brandId)).items.find((x) => x.id === slot.id)!.timezone).toBe('Europe/London');
    await cancelSchedule(t.ownerCtx, a.schedule.id);
    const p2 = await textPost(t, conns.facebook);
    const b = (await queuePost(t.ownerCtx, { post_id: p2, expected_version: 1 }, randomUUID())).body as QueueBody;
    expect(b.schedule.due_at).toBe(a.schedule.due_at); // freed occurrence reused
  });

  it('refuses when the brand has no active slot', async () => {
    const { t, conns } = await setup();
    const p = await textPost(t, conns.x);
    const err = await queuePost(t.ownerCtx, { post_id: p, expected_version: 1 }, randomUUID()).catch((e: AppError) => e);
    expect((err as AppError).code).toBe('invalid_state');
  });
});
