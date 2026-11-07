// V2 stream B: publication authority (spec §4 "Queued publication after permission changes", §12.13/17).
// Recorded at schedule/approval time; revalidated at dispatch; HOLD (blocked/authority_hold) on failure;
// adoption by an authorised publisher re-queues; policy loosening never auto-releases; in-flight completes.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { toLocalInput } from '@social-lite/core';
import {
  approve, claimDelivery, createPost, onConnectionRestored, processDelivery, publishNow, retryDelivery, schedulePost, submitForReview,
} from '@social-lite/services';
import { adoptPublication, checkPublicationAuthority, listHeldPublications } from '../../packages/services/src/engine/authority.js';
import { addMemberGrant, listMembers, revokeGrant } from '../../packages/services/src/members.js';
import { handoverPreview, reassignWork, removeMember, suspendMember } from '../../packages/services/src/lifecycle.js';
import { addTeamGrant, addTeamMember, createTeam, removeTeamMember } from '../../packages/services/src/teams.js';
import { addMember, closeTestPool, createBrand, createUser, createWorkspace, grant, testPool, v2Ctx } from './helpers.js';
import { scriptedWorld, seedConnections, type ScriptedWorld } from './engine-helpers.js';

afterAll(closeTestPool);

let world: ScriptedWorld;
beforeEach(async () => {
  world = scriptedWorld();
  await testPool().query(`UPDATE system_flags SET value='true' WHERE key='dispatch_enabled'`);
  await testPool().query(`DELETE FROM provider_circuits`);
});

async function agency(opts: { approvalRequired?: boolean } = {}) {
  const ws = await createWorkspace('Agency');
  const brandA = await createBrand(ws, 'Brand A', { approvalRequired: opts.approvalRequired });
  const brandB = await createBrand(ws, 'Brand B');
  const owner = await createUser();
  await addMember(ws, owner.id, 'owner');
  const admin = await createUser();
  await addMember(ws, admin.id, 'admin');
  const conns = await seedConnections(ws, brandA);
  return { ws, brandA, brandB, owner, admin, conns, own: () => v2Ctx(owner.id, ws), adm: () => v2Ctx(admin.id, ws) };
}
type Agency = Awaited<ReturnType<typeof agency>>;

async function member(ws: string, role?: string, brandId?: string) {
  const u = await createUser();
  await testPool().query(`INSERT INTO memberships(workspace_id, user_id, role) VALUES ($1,$2,'viewer')`, [ws, u.id]);
  if (role) await grant(ws, u.id, role, brandId);
  return u;
}

async function textPost(t: Agency, connIds: string[]) {
  const draft = { baseText: `Post ${randomUUID().slice(0, 6)}`, baseLink: null, baseAssetIds: [], variants: connIds.map((connectionId) => ({ connectionId, inheritText: true, inheritMedia: true })) };
  return (await createPost(await t.own(), t.brandA, { title: 'Authority', draft }, randomUUID())).id;
}

/** Timed schedule an hour ahead by `userId` (V2 ctx), made due now for the test. */
async function scheduleBy(t: Agency, userId: string, connIds = [t.conns.facebook, t.conns.telegram]) {
  const id = await textPost(t, connIds);
  const when = toLocalInput(new Date(Date.now() + 3600_000), 'Europe/London');
  const r = await schedulePost(await v2Ctx(userId, t.ws), id, { expected_version: 1, connection_ids: connIds, input_local_time: when, timezone: 'Europe/London' }, randomUUID());
  const scheduleId = (r.body as { schedule: { id: string } }).schedule.id;
  await testPool().query(`UPDATE deliveries SET next_attempt_at=now() - interval '1 second' WHERE schedule_id=$1`, [scheduleId]);
  return { postId: id, scheduleId };
}

const deliveries = async (scheduleId: string) => (await testPool().query<{ id: string; state: string; last_error_code: string | null; blocked_reason: string | null }>(
  `SELECT id, state, last_error_code, blocked_reason FROM deliveries WHERE schedule_id=$1 ORDER BY provider`, [scheduleId])).rows;

/** Dispatch exactly this schedule's due deliveries (other tests' work is never claimed). */
async function dispatch(scheduleId: string): Promise<string[]> {
  const out: string[] = [];
  for (const d of await deliveries(scheduleId)) {
    const c = await claimDelivery('w-b', { deliveryId: d.id });
    if (c) out.push(await processDelivery(world.deps, c));
  }
  return out;
}

describe('publication authority (§12.13)', () => {
  it('is recorded at schedule time with revision, destinations, principal and policy version', async () => {
    const t = await agency();
    const pub = await member(t.ws, 'publisher', t.brandA);
    const { scheduleId, postId } = await scheduleBy(t, pub.id);
    const a = (await testPool().query(`SELECT * FROM publication_authorizations WHERE schedule_id=$1`, [scheduleId])).rows[0];
    const s = (await testPool().query(`SELECT revision_id FROM schedules WHERE id=$1`, [scheduleId])).rows[0];
    expect(a).toMatchObject({ basis: 'scheduler', principal_user_id: pub.id, principal_permission: 'content.schedule', post_id: postId, revision_id: s.revision_id,
      brand_id: t.brandA, workspace_id: t.ws, status: 'active' });
    expect([...a.connection_ids].sort()).toEqual([t.conns.facebook, t.conns.telegram].sort());
    expect(Number(a.policy_version)).toBeGreaterThan(0);
    // The authorised scope is immutable.
    await expect(testPool().query(`UPDATE publication_authorizations SET connection_ids=$2 WHERE id=$1`, [a.id, [t.conns.x]])).rejects.toThrow(/immutable/);
    expect(await dispatch(scheduleId)).toEqual(['published', 'published']);
  });

  it('revoking the scheduler’s publishing grant HOLDS queued work; re-granting does not release it; adoption re-queues', async () => {
    const t = await agency();
    const pub = await member(t.ws, 'publisher', t.brandA);
    const pub2 = await member(t.ws, 'publisher', t.brandA);
    const { scheduleId } = await scheduleBy(t, pub.id);
    const g = (await listMembers(await t.adm())).members.find((m) => m.user_id === pub.id)!.grants[0]!;
    await revokeGrant(await t.adm(), g.id); // proactive hold in the same transaction
    expect((await deliveries(scheduleId)).map((d) => [d.state, d.last_error_code])).toEqual([['blocked', 'authority_hold'], ['blocked', 'authority_hold']]);
    expect(await dispatch(scheduleId)).toEqual([]); // blocked work is never claimed
    expect(world.publishCalls.size).toBe(0);
    // Policy loosening (re-grant) never auto-releases; neither does a reconnect or a manual retry.
    await addMemberGrant(await t.adm(), pub.id, { role: 'publisher', brand_id: t.brandA });
    await onConnectionRestored(testPool(), t.conns.facebook);
    expect((await deliveries(scheduleId)).every((d) => d.state === 'blocked' && d.last_error_code === 'authority_hold')).toBe(true);
    const fb = (await deliveries(scheduleId))[0]!;
    await expect(retryDelivery(await v2Ctx(pub2.id, t.ws), fb.id, {})).rejects.toMatchObject({ code: 'invalid_state', details: { reason: 'authority_hold' } });
    // Adoption queue: visible to brand members; only authorised publishers may adopt.
    const viewer = await member(t.ws, 'viewer', t.brandA);
    const q = await listHeldPublications(await v2Ctx(viewer.id, t.ws));
    expect(q.items).toEqual([expect.objectContaining({ schedule_id: scheduleId, hold_code: 'scheduler_unauthorized', can_adopt: false, adoptable: true, scheduled_by_email: pub.email })]);
    await expect(adoptPublication(await v2Ctx(viewer.id, t.ws), scheduleId)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(adoptPublication(await v2Ctx(pub2.id, t.ws, { mfaVerified: false }), scheduleId)).rejects.toMatchObject({ code: 'mfa_required' });
    const other = await agency();
    await expect(adoptPublication(await other.own(), scheduleId)).rejects.toMatchObject({ code: 'not_found' });
    const res = await adoptPublication(await v2Ctx(pub2.id, t.ws), scheduleId);
    expect(res).toMatchObject({ requeued: 2, expired: 0 });
    expect((await adoptPublication(await v2Ctx(pub2.id, t.ws), scheduleId)).already_active).toBe(true);
    const ev = (await testPool().query(`SELECT from_user_id, to_user_id, hold_code FROM adoption_events WHERE schedule_id=$1`, [scheduleId])).rows;
    expect(ev).toEqual([{ from_user_id: pub.id, to_user_id: pub2.id, hold_code: 'scheduler_unauthorized' }]);
    expect(await dispatch(scheduleId)).toEqual(['published', 'published']);
  });

  it('the dispatch gate is the backstop: a change made outside the services still holds at claim time', async () => {
    const t = await agency();
    const pub = await member(t.ws, 'publisher', t.brandA);
    const { scheduleId } = await scheduleBy(t, pub.id, [t.conns.facebook]);
    await testPool().query(`UPDATE scoped_role_grants SET revoked_at=now() WHERE workspace_id=$1 AND user_id=$2`, [t.ws, pub.id]);
    expect(await dispatch(scheduleId)).toEqual(['blocked']);
    expect(await deliveries(scheduleId)).toEqual([expect.objectContaining({ state: 'blocked', last_error_code: 'authority_hold' })]);
    expect((await testPool().query(`SELECT status, hold_code FROM publication_authorizations WHERE schedule_id=$1`, [scheduleId])).rows[0])
      .toEqual({ status: 'held', hold_code: 'scheduler_unauthorized' });
    expect(world.publishCalls.size).toBe(0);
  });

  it('suspension/removal of the scheduler holds; removal via a team and approver revocation hold; the author alone does not', async () => {
    const t = await agency();
    // (a) suspension
    const pub = await member(t.ws, 'publisher', t.brandA);
    const s1 = await scheduleBy(t, pub.id, [t.conns.facebook]);
    expect((await suspendMember(await t.adm(), pub.id, {})).held_publications).toBe(1);
    expect(await dispatch(s1.scheduleId)).toEqual([]);
    // (b) team-derived publishing rights removed with the team membership
    const tp = await member(t.ws);
    const team = await createTeam(await t.adm(), { name: 'Publishing' });
    await addTeamGrant(await t.adm(), team.id, { role: 'publisher', brand_id: t.brandA });
    await addTeamMember(await t.adm(), team.id, { user_id: tp.id });
    const s2 = await scheduleBy(t, tp.id, [t.conns.telegram]);
    await removeTeamMember(await t.adm(), team.id, tp.id);
    expect((await deliveries(s2.scheduleId))[0]).toMatchObject({ state: 'blocked', last_error_code: 'authority_hold' });
    // (c) handover: removal holds, reassignment to an authorised publisher releases into their name
    const leaver = await member(t.ws, 'publisher', t.brandA);
    const heir = await member(t.ws, 'publisher', t.brandA);
    const s3 = await scheduleBy(t, leaver.id, [t.conns.x]);
    expect((await handoverPreview(await t.adm(), leaver.id)).scheduled.count).toBe(1);
    await removeMember(await t.adm(), leaver.id, { reassign_to: heir.id });
    expect((await testPool().query(`SELECT principal_user_id, status FROM publication_authorizations WHERE schedule_id=$1`, [s3.scheduleId])).rows[0])
      .toEqual({ principal_user_id: heir.id, status: 'active' });
    expect(await dispatch(s3.scheduleId)).toEqual(['published']);
    // Reassignment never goes to someone without publishing rights on that brand.
    const pubB = await member(t.ws, 'publisher', t.brandB);
    const s4 = await scheduleBy(t, heir.id, [t.conns.facebook]);
    const r = await reassignWork(await t.adm(), heir.id, { to_user_id: pubB.id, items: ['scheduled'] });
    expect(r.scheduled).toEqual({ transferred: 0, skipped: 1 });
    expect((await testPool().query(`SELECT principal_user_id FROM publication_authorizations WHERE schedule_id=$1`, [s4.scheduleId])).rows[0].principal_user_id).toBe(heir.id);
  });

  it('approval-activated work is held when a required approver loses approval rights, not when the draft author leaves', async () => {
    const t = await agency({ approvalRequired: true });
    const ed = await member(t.ws, 'editor', t.brandA);
    const ap = await member(t.ws, 'approver', t.brandA);
    const submit = async () => {
      const id = (await createPost(await v2Ctx(ed.id, t.ws), t.brandA, { draft: { baseText: `x ${randomUUID()}`, baseLink: null, baseAssetIds: [],
        variants: [{ connectionId: t.conns.facebook, inheritText: true, inheritMedia: true }] } }, randomUUID())).id;
      const sub = await submitForReview(await v2Ctx(ed.id, t.ws), id, { expected_version: 1, connection_ids: [t.conns.facebook] }, randomUUID());
      const a = (sub.body as { approval: { id: string; fingerprint: string } }).approval;
      const res = await approve(await v2Ctx(ap.id, t.ws), a.id, a.fingerprint);
      return res.schedule.id as string;
    };
    // Author leaves: independently approved work still publishes (spec §4.4).
    const s1 = await submit();
    const rec = (await testPool().query(`SELECT basis, principal_user_id, approver_user_ids FROM publication_authorizations WHERE schedule_id=$1`, [s1])).rows[0];
    expect(rec).toEqual({ basis: 'approval', principal_user_id: ed.id, approver_user_ids: [ap.id] });
    const s2 = await submit();
    await removeMember(await t.adm(), ed.id);
    expect(await dispatch(s1)).toEqual(['published']);
    // Approver loses approval rights ⇒ held, and not adoptable by a publisher (needs a new review).
    await testPool().query(`UPDATE scoped_role_grants SET revoked_at=now() WHERE workspace_id=$1 AND user_id=$2`, [t.ws, ap.id]);
    // Held at dispatch (stream C's approval gate or this authority gate, whichever runs first) — never sent.
    expect(await dispatch(s2)).toEqual(['blocked']);
    expect(world.publishCalls.size).toBe(1);
    const d2 = (await testPool().query(`SELECT schedule_id, connection_id, revision_id, workspace_id FROM deliveries WHERE schedule_id=$1`, [s2])).rows[0];
    expect(await checkPublicationAuthority(testPool(), d2)).toMatchObject({ ok: false, code: 'authority_hold', detail: 'approver_unauthorized' });
    const pub = await member(t.ws, 'publisher', t.brandA);
    const q = await listHeldPublications(await v2Ctx(pub.id, t.ws));
    expect(q.items.find((i) => i.schedule_id === s2)).toMatchObject({ hold_code: 'approver_unauthorized', adoptable: false, can_adopt: false });
    await expect(adoptPublication(await v2Ctx(pub.id, t.ws), s2)).rejects.toMatchObject({ code: 'invalid_state' });
  });

  it('in-flight sends complete; missing records and evaluation failures fail closed (§12.22)', async () => {
    const t = await agency();
    const pub = await member(t.ws, 'publisher', t.brandA);
    const { scheduleId } = await scheduleBy(t, pub.id, [t.conns.facebook, t.conns.telegram]);
    const [d1] = await deliveries(scheduleId);
    // d1 is already sending (external call started) when the scheduler is suspended.
    await testPool().query(`UPDATE deliveries SET state='publishing', phase='sending', lease_owner='w-x', lease_expires_at=now() + interval '1 minute' WHERE id=$1`, [d1!.id]);
    await suspendMember(await t.adm(), pub.id, {});
    const after = await deliveries(scheduleId);
    expect(after.find((d) => d.id === d1!.id)!.state).toBe('publishing'); // not touched
    expect(after.find((d) => d.id !== d1!.id)).toMatchObject({ state: 'blocked', last_error_code: 'authority_hold' });
    // Missing authority record ⇒ hold, never send.
    const pub2 = await member(t.ws, 'publisher', t.brandA);
    const s2 = await scheduleBy(t, pub2.id, [t.conns.x]);
    await testPool().query(`DELETE FROM publication_authorizations WHERE schedule_id=$1`, [s2.scheduleId]);
    expect(await dispatch(s2.scheduleId)).toEqual(['blocked']);
    // Policy evaluation failure ⇒ hold.
    const broken = { query: async () => { throw new Error('policy store down'); } } as unknown as Parameters<typeof checkPublicationAuthority>[0];
    const r = await checkPublicationAuthority(broken, { schedule_id: s2.scheduleId, connection_id: t.conns.x, revision_id: randomUUID(), workspace_id: t.ws });
    expect(r).toMatchObject({ ok: false, code: 'authority_hold' });
    // Immediate publish records content.publish authority and dispatches normally.
    const pid = await textPost(t, [t.conns.telegram]);
    const now = await publishNow(await v2Ctx(pub2.id, t.ws), pid, { expected_version: 1, connection_ids: [t.conns.telegram] }, randomUUID());
    const sid = (now.body as { schedule: { id: string } }).schedule.id;
    expect((await testPool().query(`SELECT principal_permission FROM publication_authorizations WHERE schedule_id=$1`, [sid])).rows[0].principal_permission).toBe('content.publish');
    expect(await dispatch(sid)).toEqual(['published']);
    // Editors without a publisher grant cannot schedule (V2: editors_can_publish grants nothing).
    const ed = await member(t.ws, 'editor', t.brandA);
    const p3 = await textPost(t, [t.conns.telegram]);
    await expect(publishNow(await v2Ctx(ed.id, t.ws), p3, { expected_version: 1, connection_ids: [t.conns.telegram] }, randomUUID())).rejects.toMatchObject({ code: 'forbidden' });
  });
});
