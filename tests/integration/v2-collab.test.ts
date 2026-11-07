// V2 collaboration (stream C) through the REAL policy path (v2Ctx): spec §12 cases 11, 12, 13 (approval
// invalidation), 14; quorum dedupe across teams; policy weakening needs step-up and never releases holds.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  addReviewComment, approvalInbox, approve, claimDelivery, createCampaign, createComment, createPost, getPostDetail, getReview,
  listComments, listMyReviews, listPosts, listVersions, openNotification, processDelivery, publishNow, reject, reschedule, restoreVersion, reviewApprove,
  reviewReject, revokeReviewShare, saveApprovalPolicy, schedulePost, sendDigests, sendDueEmails, shareReview, submitForReview, updateDraft, updatePostPlanning,
  updateNotificationPreferences, notifySecurityAlert, assignReview, getApprovalPolicy, type Ctx, type EngineDeps,
} from '@social-lite/services';
import { updateBrand } from '@social-lite/services/brands';
import { handleEvent } from '@social-lite/services/engine/notify';
import { history, historyCsv } from '@social-lite/services/readmodels';
import { listNotifications } from '@social-lite/services/audit-read';
import { toLocalInput } from '@social-lite/core';
import { addMember, closeTestPool, createBrand, createUser, createWorkspace, grant, testPool, v2Ctx } from './helpers.js';
import { scriptedWorld, seedConnections, seedReadyImage, type ScriptedWorld } from './engine-helpers.js';

afterAll(closeTestPool);

let world: ScriptedWorld;
beforeEach(async () => {
  world = scriptedWorld();
  await testPool().query(`UPDATE deliveries SET state='cancelled' WHERE state IN ('scheduled','retry_wait','processing','preparing','publishing')`);
  await testPool().query(`UPDATE system_flags SET value='true' WHERE key='dispatch_enabled'`);
  await testPool().query(`DELETE FROM provider_circuits`);
});

async function drain(deps: EngineDeps, max = 20): Promise<string[]> {
  const out: string[] = [];
  for (let i = 0; i < max; i++) {
    const c = await claimDelivery('c-worker');
    if (!c) break;
    out.push(await processDelivery(deps, c));
  }
  return out;
}

async function blockedCodes(postId: string): Promise<string[]> {
  const r = await testPool().query<{ last_error_code: string }>(`SELECT last_error_code FROM deliveries WHERE post_id=$1 AND state='blocked'`, [postId]);
  return r.rows.map((x) => x.last_error_code);
}

/** Process this workspace's pending outbox events through the notification handler (what the worker does). */
async function runOutbox(workspaceId: string) {
  const r = await testPool().query<{ id: string; event_type: string; aggregate_id: string; payload: Record<string, unknown> }>(
    `UPDATE outbox SET dispatch_state='dispatched', dispatched_at=now() WHERE workspace_id=$1 AND dispatch_state='pending' AND event_type <> 'delivery.due'
     RETURNING id, event_type, aggregate_id, payload`, [workspaceId]);
  for (const e of r.rows.sort((a, b) => Number(a.id) - Number(b.id))) {
    await handleEvent({ event_type: e.event_type, workspace_id: workspaceId, aggregate_id: e.aggregate_id, payload: e.payload });
  }
  return r.rows.length;
}

async function member(ws: string, role: string, brandId?: string) {
  const u = await createUser();
  await testPool().query(`INSERT INTO memberships(workspace_id, user_id, role) VALUES ($1,$2,'viewer')`, [ws, u.id]);
  await grant(ws, u.id, role, brandId);
  return u;
}

async function team(ws: string, name: string, role: string, brandId: string, members: string[]) {
  const t = await testPool().query<{ id: string }>(`INSERT INTO teams(workspace_id, name) VALUES ($1,$2) RETURNING id`, [ws, name]);
  const id = t.rows[0]!.id;
  await testPool().query(`INSERT INTO scoped_role_grants(workspace_id, principal_type, team_id, role, scope_type, brand_id) VALUES ($1,'team',$2,$3,'brand',$4)`, [ws, id, role, brandId]);
  for (const m of members) await testPool().query(`INSERT INTO team_memberships(workspace_id, team_id, user_id) VALUES ($1,$2,$3)`, [ws, id, m]);
  return id;
}

/** Agency fixture: two brands, owner, editors, approvers, publisher, a guest (expiring) and an expired guest. */
async function agency(opts: { approvalRequired?: boolean } = { approvalRequired: true }) {
  const ws = await createWorkspace('Agency');
  const brandA = await createBrand(ws, 'Brand A', { approvalRequired: opts.approvalRequired });
  const brandB = await createBrand(ws, 'Brand B');
  const owner = await createUser();
  await addMember(ws, owner.id, 'owner');
  const editor = await member(ws, 'editor', brandA);
  const editor2 = await member(ws, 'editor', brandA);
  const approver = await member(ws, 'approver', brandA);
  const approver2 = await member(ws, 'approver', brandA);
  const publisher = await member(ws, 'publisher', brandA);
  const outsider = await member(ws, 'editor', brandB);
  const guest = await createUser();
  await testPool().query(`INSERT INTO memberships(workspace_id, user_id, role) VALUES ($1,$2,'viewer')`, [ws, guest.id]);
  await grant(ws, guest.id, 'guest', brandA, new Date(Date.now() + 7 * 86_400_000));
  const conns = await seedConnections(ws, brandA);
  return { ws, brandA, brandB, owner, editor, editor2, approver, approver2, publisher, outsider, guest, conns };
}

type Agency = Awaited<ReturnType<typeof agency>>;

async function draftPost(t: Agency, ctx: Ctx, text = 'Launch day', providers: Array<keyof Agency['conns']> = ['facebook', 'telegram']) {
  const ids = providers.map((p) => t.conns[p]);
  const draft = { baseText: text, baseLink: null, baseAssetIds: [] as string[], variants: ids.map((connectionId) => ({ connectionId, inheritText: true, inheritMedia: true })) };
  const { id } = await createPost(ctx, t.brandA, { title: 'Internal title', draft }, randomUUID());
  return { id, ids, draft };
}

const later = () => toLocalInput(new Date(Date.now() + 3600_000), 'Europe/London');
type SubmitBody = { approval: { id: string; fingerprint: string }; schedule: { id: string; generation: number } };

async function submit(ctx: Ctx, postId: string, ids: string[], version = 1, timed = false) {
  const r = await submitForReview(ctx, postId, { expected_version: version, connection_ids: ids, ...(timed ? { input_local_time: later(), timezone: 'Europe/London' } : {}) }, randomUUID());
  return r.body as SubmitBody;
}

async function makeDue(postId: string) {
  await testPool().query(`UPDATE deliveries SET next_attempt_at=now() - interval '1 second' WHERE post_id=$1 AND state IN ('scheduled','retry_wait')`, [postId]);
}

async function setPolicy(t: Agency, stages: Parameters<typeof saveApprovalPolicy>[2]['stages'], sod = false) {
  const ctx = await v2Ctx(t.owner.id, t.ws);
  const cur = await getApprovalPolicy(ctx, t.brandA);
  return saveApprovalPolicy(ctx, t.brandA, { expected_generation: cur.generation, separation_of_duties: sod, stages });
}

// ------------------------------------------------------------------ case 11
describe('§12 case 11 — concurrent draft saves', () => {
  it('shows a conflict without losing either revision; both stay recoverable and restorable', async () => {
    const t = await agency({ approvalRequired: false });
    const { id, draft } = await draftPost(t, await v2Ctx(t.editor.id, t.ws), 'Original');
    // Two editors both opened version 1.
    const a = await updateDraft(await v2Ctx(t.editor.id, t.ws), id, { expected_version: 1, draft: { ...draft, baseText: 'Alice wins the race' } });
    expect(a.version).toBe(2);
    const err = await updateDraft(await v2Ctx(t.editor2.id, t.ws), id, { expected_version: 1, draft: { ...draft, baseText: 'Bob was slower' } }).catch((e) => e);
    expect(err).toMatchObject({ code: 'version_conflict', details: { current: { version: 2 } } });
    const copyId = (err as { details: { conflict_copy_id: string } }).details.conflict_copy_id;
    expect(copyId).toBeTruthy();
    // Nothing was overwritten: the post still has Alice's text; Bob's text is kept as a conflict copy.
    const detail = await getPostDetail(await v2Ctx(t.editor.id, t.ws), id);
    expect(detail.draft.baseText).toBe('Alice wins the race');
    const h = await listVersions(await v2Ctx(t.editor2.id, t.ws), id);
    const texts = h.versions.map((v) => `${v.kind}:${(v.draft as { baseText: string }).baseText}`);
    expect(texts).toEqual(expect.arrayContaining(['saved:Alice wins the race', 'conflict:Bob was slower', 'created:Original']));
    // Bob restores his copy explicitly (an optimistic-concurrency save on top of v2): both versions remain in history.
    const r = await restoreVersion(await v2Ctx(t.editor2.id, t.ws), id, copyId, 2);
    expect(r.version).toBe(3);
    const h2 = await listVersions(await v2Ctx(t.editor.id, t.ws), id);
    expect(h2.versions.find((v) => v.version === 3)).toMatchObject({ kind: 'restored', restored_from: copyId });
    expect(h2.versions.some((v) => v.version === 2 && (v.draft as { baseText: string }).baseText === 'Alice wins the race')).toBe(true);
    // Another tenant cannot read the history.
    await expect(listVersions(await v2Ctx(t.outsider.id, t.ws), id)).rejects.toMatchObject({ code: 'not_found' });
  });
});

// ------------------------------------------------------------------ case 12
describe('§12 case 12 — separation of duties and quorum of distinct people', () => {
  it('authors/editors of the revision cannot give its independent approval', async () => {
    const t = await agency();
    await setPolicy(t, [{ name: 'Review', quorum: 1, eligible_roles: [], eligible_team_ids: [], allow_guests: false }], true);
    // The owner (who can approve) edits the content, then an editor submits.
    const { id, ids, draft } = await draftPost(t, await v2Ctx(t.editor.id, t.ws));
    await updateDraft(await v2Ctx(t.owner.id, t.ws), id, { expected_version: 1, draft: { ...draft, baseText: 'Owner polished this' } });
    const sub = await submit(await v2Ctx(t.editor.id, t.ws), id, ids, 2);
    await expect(approve(await v2Ctx(t.owner.id, t.ws), sub.approval.id, sub.approval.fingerprint))
      .rejects.toMatchObject({ code: 'forbidden', details: { reason: 'separation_of_duties' } });
    const ok = await approve(await v2Ctx(t.approver.id, t.ws), sub.approval.id, sub.approval.fingerprint);
    expect(ok.approval.decision).toBe('approved');
    expect(ok.deliveries).toHaveLength(2);
  });

  it('a person in two eligible teams counts once toward quorum', async () => {
    const t = await agency();
    const dual = await createUser();
    await testPool().query(`INSERT INTO memberships(workspace_id, user_id, role) VALUES ($1,$2,'viewer')`, [t.ws, dual.id]);
    const t1 = await team(t.ws, 'Reviewers North', 'approver', t.brandA, [dual.id, t.approver.id]);
    const t2 = await team(t.ws, 'Reviewers South', 'approver', t.brandA, [dual.id]);
    await setPolicy(t, [{ name: 'Two reviewers', quorum: 2, eligible_roles: [], eligible_team_ids: [t1, t2], allow_guests: false }]);
    const { id, ids } = await draftPost(t, await v2Ctx(t.editor.id, t.ws));
    const sub = await submit(await v2Ctx(t.editor.id, t.ws), id, ids);
    const first = await approve(await v2Ctx(dual.id, t.ws), sub.approval.id, sub.approval.fingerprint);
    expect(first.approval.decision).toBe('pending');
    expect(first.deliveries).toHaveLength(0);
    await expect(approve(await v2Ctx(dual.id, t.ws), sub.approval.id, sub.approval.fingerprint)).rejects.toMatchObject({ code: 'conflict' });
    const inbox = await approvalInbox(await v2Ctx(t.approver.id, t.ws));
    expect(inbox.items.find((i) => i.id === sub.approval.id)).toMatchObject({ stage: { approvals: 1, quorum: 2 }, can_decide: true });
    // approver2 holds approver on the brand but is in neither team => not eligible.
    await expect(approve(await v2Ctx(t.approver2.id, t.ws), sub.approval.id, sub.approval.fingerprint)).rejects.toMatchObject({ details: { reason: 'team_not_eligible' } });
    const final = await approve(await v2Ctx(t.approver.id, t.ws), sub.approval.id, sub.approval.fingerprint);
    expect(final.approval.decision).toBe('approved');
    expect(final.deliveries).toHaveLength(2);
    expect((await drain(world.deps)).sort()).toEqual(['published', 'published']);
  });

  it('two sequential stages: internal review, then the shared client (guest) review', async () => {
    const t = await agency();
    await setPolicy(t, [
      { name: 'Internal', quorum: 1, eligible_roles: ['approver'], eligible_team_ids: [], allow_guests: false },
      { name: 'Client', quorum: 1, eligible_roles: [], eligible_team_ids: [], allow_guests: true },
    ]);
    const { id, ids } = await draftPost(t, await v2Ctx(t.editor.id, t.ws));
    const sub = await submit(await v2Ctx(t.editor.id, t.ws), id, ids);
    await shareReview(await v2Ctx(t.editor.id, t.ws), id, t.guest.id);
    const g = await v2Ctx(t.guest.id, t.ws);
    // Guests cannot satisfy the internal stage.
    await expect(reviewApprove(g, sub.approval.id, sub.approval.fingerprint)).rejects.toMatchObject({ details: { reason: 'guests_not_allowed' } });
    const s1 = await approve(await v2Ctx(t.approver.id, t.ws), sub.approval.id, sub.approval.fingerprint);
    expect(s1).toMatchObject({ stage: 1, approval: { decision: 'pending' } });
    // Owner is not 'approver' role => not eligible for Internal; and the internal approver cannot also approve stage 2.
    await expect(approve(await v2Ctx(t.approver.id, t.ws), sub.approval.id, sub.approval.fingerprint)).rejects.toMatchObject({ code: 'conflict' });
    const done = await reviewApprove(await v2Ctx(t.guest.id, t.ws), sub.approval.id, sub.approval.fingerprint);
    expect(done.decision).toBe('approved');
    const n = await testPool().query(`SELECT count(*)::int n FROM deliveries WHERE schedule_id=$1`, [sub.schedule.id]);
    expect(n.rows[0].n).toBe(2);
  });

  it('a publisher cannot bypass required review', async () => {
    const t = await agency();
    const { id, ids } = await draftPost(t, await v2Ctx(t.editor.id, t.ws));
    const p = await v2Ctx(t.publisher.id, t.ws);
    await expect(schedulePost(p, id, { expected_version: 1, connection_ids: ids, input_local_time: later(), timezone: 'Europe/London' }, randomUUID()))
      .rejects.toMatchObject({ code: 'invalid_state', details: { reason: 'approval_required' } });
    await expect(publishNow(p, id, { expected_version: 1, connection_ids: ids }, randomUUID())).rejects.toMatchObject({ code: 'invalid_state' });
    const sub = await submit(await v2Ctx(t.editor.id, t.ws), id, ids);
    await expect(approve(p, sub.approval.id, sub.approval.fingerprint)).rejects.toMatchObject({ code: 'forbidden' });
  });
});

// ------------------------------------------------------------------ case 13
describe('§12 case 13 — changes invalidate approvals; revoked approver authority holds jobs', () => {
  it('content and schedule-time changes invalidate a pending approval', async () => {
    const t = await agency();
    const { id, ids, draft } = await draftPost(t, await v2Ctx(t.editor.id, t.ws));
    const sub = await submit(await v2Ctx(t.editor.id, t.ws), id, ids, 1, true);
    await updateDraft(await v2Ctx(t.editor.id, t.ws), id, { expected_version: 1, draft: { ...draft, baseText: 'Edited after submit' } });
    await expect(approve(await v2Ctx(t.approver.id, t.ws), sub.approval.id, sub.approval.fingerprint)).rejects.toMatchObject({ code: 'invalid_state' });
    const sub2 = await submit(await v2Ctx(t.editor.id, t.ws), id, ids, 2, true);
    // Time change: reschedule creates a fresh request; the old one is void.
    const moved = await reschedule(await v2Ctx(t.editor.id, t.ws), sub2.schedule.id, { input_local_time: toLocalInput(new Date(Date.now() + 7200_000), 'Europe/London'), timezone: 'Europe/London', expected_generation: sub2.schedule.generation }, randomUUID());
    expect((moved.body as { approval: { decision: string } }).approval.decision).toBe('pending');
    const old = await testPool().query(`SELECT decision FROM approvals WHERE id=$1`, [sub2.approval.id]);
    expect(old.rows[0].decision).toBe('invalidated');
    await expect(approve(await v2Ctx(t.approver.id, t.ws), sub2.approval.id, sub2.approval.fingerprint)).rejects.toMatchObject({ code: 'invalid_state' });
  });

  it('a media version change after submission invalidates the request (binding)', async () => {
    const t = await agency();
    const img = await seedReadyImage(t.ws, t.brandA);
    const ids = [t.conns.facebook];
    const draft = { baseText: 'With a picture', baseLink: null, baseAssetIds: [img], variants: ids.map((connectionId) => ({ connectionId, inheritText: true, inheritMedia: true })) };
    const { id } = await createPost(await v2Ctx(t.editor.id, t.ws), t.brandA, { draft }, randomUUID());
    const sub = await submit(await v2Ctx(t.editor.id, t.ws), id, ids);
    await testPool().query(`UPDATE assets SET alt_text='Different alt text', checksum_sha256='changed' WHERE id=$1`, [img]);
    await expect(approve(await v2Ctx(t.approver.id, t.ws), sub.approval.id, sub.approval.fingerprint))
      .rejects.toMatchObject({ code: 'invalid_state', details: { reason: 'binding_changed' } });
    const a = await testPool().query(`SELECT decision FROM approvals WHERE id=$1`, [sub.approval.id]);
    expect(a.rows[0].decision).toBe('invalidated'); // persisted although the call failed
  });

  it('a destination identity change after approval holds the job', async () => {
    const t = await agency();
    const { id, ids } = await draftPost(t, await v2Ctx(t.editor.id, t.ws), 'Dest', ['telegram']);
    const sub = await submit(await v2Ctx(t.editor.id, t.ws), id, ids);
    await approve(await v2Ctx(t.approver.id, t.ws), sub.approval.id, sub.approval.fingerprint);
    await testPool().query(`UPDATE connections SET provider_account_id='mock_telegram_other_channel' WHERE id=$1`, [t.conns.telegram]);
    await makeDue(id);
    expect(await drain(world.deps)).toEqual(['blocked']);
    expect(await blockedCodes(id)).toEqual(['approval_stale']);
  });

  it('revoking the approver’s authority holds an approved job at dispatch', async () => {
    const t = await agency();
    const { id, ids } = await draftPost(t, await v2Ctx(t.editor.id, t.ws), 'Revoke', ['facebook']);
    const sub = await submit(await v2Ctx(t.editor.id, t.ws), id, ids);
    await approve(await v2Ctx(t.approver.id, t.ws), sub.approval.id, sub.approval.fingerprint);
    await testPool().query(`UPDATE scoped_role_grants SET revoked_at=now() WHERE workspace_id=$1 AND user_id=$2`, [t.ws, t.approver.id]);
    await makeDue(id);
    expect(await drain(world.deps)).toEqual(['blocked']);
    expect(await blockedCodes(id)).toEqual(['approver_authority_revoked']);
    expect(world.publishCalls.size).toBe(0);
  });
});

// ------------------------------------------------------------------ policy weakening
describe('approval policy changes', () => {
  it('weakening needs brands.manage + step-up, is audited, and never releases held publications', async () => {
    const t = await agency();
    // A post approved under the current policy, and one waiting for review.
    const approved = await draftPost(t, await v2Ctx(t.editor.id, t.ws), 'Approved earlier', ['facebook']);
    const s1 = await submit(await v2Ctx(t.editor.id, t.ws), approved.id, approved.ids);
    await approve(await v2Ctx(t.approver.id, t.ws), s1.approval.id, s1.approval.fingerprint);
    const waiting = await draftPost(t, await v2Ctx(t.editor.id, t.ws), 'Waiting', ['telegram']);
    const s2 = await submit(await v2Ctx(t.editor.id, t.ws), waiting.id, waiting.ids);

    const stale = await v2Ctx(t.owner.id, t.ws, { authTime: new Date(Date.now() - 3600_000).toISOString() });
    const cur = await getApprovalPolicy(stale, t.brandA);
    // Disabling = weakening: stale session is refused (step-up), editors/approvers/publishers are refused outright.
    await expect(saveApprovalPolicy(stale, t.brandA, { expected_generation: cur.generation, separation_of_duties: false, stages: [] })).rejects.toMatchObject({ code: 'step_up_required' });
    await expect(saveApprovalPolicy(await v2Ctx(t.publisher.id, t.ws), t.brandA, { expected_generation: cur.generation, separation_of_duties: false, stages: [] })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(updateBrand(stale, t.brandA, { approval_required: false })).rejects.toMatchObject({ code: 'step_up_required' });
    // Strengthening needs no step-up.
    const strong = await saveApprovalPolicy(stale, t.brandA, { expected_generation: cur.generation, separation_of_duties: true, stages: [{ name: 'Review', quorum: 1, eligible_roles: [], eligible_team_ids: [], allow_guests: false }] });
    expect(strong.weakening).toBe(false);
    // Fresh authentication: allowed, audited.
    const fresh = await v2Ctx(t.owner.id, t.ws);
    const off = await saveApprovalPolicy(fresh, t.brandA, { expected_generation: strong.policy.generation, separation_of_duties: false, stages: [] });
    expect(off).toMatchObject({ weakening: true });
    const audit = await testPool().query(`SELECT action, diff FROM audit_events WHERE workspace_id=$1 AND action LIKE 'approval_policy.%' ORDER BY id`, [t.ws]);
    expect(audit.rows.map((r) => r.action)).toEqual(['approval_policy.updated', 'approval_policy.weakened']);
    // Nothing was released: the waiting request was voided (no deliveries) and the approved job is held at dispatch.
    expect((await testPool().query(`SELECT decision FROM approvals WHERE id=$1`, [s2.approval.id])).rows[0].decision).toBe('invalidated');
    expect((await testPool().query(`SELECT count(*)::int n FROM deliveries WHERE post_id=$1`, [waiting.id])).rows[0].n).toBe(0);
    await makeDue(approved.id);
    expect(await drain(world.deps)).toEqual(['blocked']);
    expect(await blockedCodes(approved.id)).toEqual(['approval_policy_changed']);
    // approval_required can never be flipped behind the policy's back.
    await expect(testPool().query(`UPDATE brands SET approval_required=true WHERE id=$1`, [t.brandA])).rejects.toThrow(/derived from the approval policy/);
  });
});

// ------------------------------------------------------------------ case 14
describe('§12 case 14 — guests see only shared reviews', () => {
  it('cannot read internal notes, unrelated posts or notifications via API, export or deep link', async () => {
    const t = await agency();
    await setPolicy(t, [{ name: 'Client', quorum: 1, eligible_roles: [], eligible_team_ids: [], allow_guests: true }]);
    const e = await v2Ctx(t.editor.id, t.ws);
    const shared = await draftPost(t, e, 'Shared with the client');
    const other = await draftPost(t, e, 'Secret unrelated campaign');
    const sub = await submit(e, shared.id, shared.ids);
    const subOther = await submit(e, other.id, other.ids);
    await createComment(await v2Ctx(t.editor.id, t.ws), shared.id, { body: 'INTERNAL: client is difficult, keep margin', visibility: 'internal', mention_user_ids: [t.guest.id, t.approver.id] });
    await createComment(await v2Ctx(t.editor.id, t.ws), shared.id, { body: 'Please review the copy', visibility: 'shared', mention_user_ids: [t.guest.id] });

    const g = () => v2Ctx(t.guest.id, t.ws);
    // Before sharing: nothing at all.
    expect((await listMyReviews(await g())).items).toEqual([]);
    await expect(getReview(await g(), sub.approval.id)).rejects.toMatchObject({ code: 'not_found' });
    await shareReview(e, shared.id, t.guest.id);
    await runOutbox(t.ws);

    // Main app APIs: no brand visibility, no posts, comments, history, inbox; export forbidden.
    expect((await g()).access.brandIds).toEqual([]);
    await expect(listPosts(await g(), t.brandA, {})).rejects.toMatchObject({ code: 'not_found' });
    await expect(getPostDetail(await g(), shared.id)).rejects.toMatchObject({ code: 'not_found' });
    await expect(listComments(await g(), shared.id)).rejects.toMatchObject({ code: 'not_found' });
    expect((await history(await g(), {})).items).toEqual([]);
    await expect(historyCsv(await g(), {})).rejects.toMatchObject({ code: 'forbidden' });
    expect((await approvalInbox(await g())).items).toEqual([]);
    await expect(approve(await g(), sub.approval.id, sub.approval.fingerprint)).rejects.toMatchObject({ code: 'not_found' });

    // Review portal: exactly the shared request; shared comments only; no internal title, note or reviewer identities.
    const mine = await listMyReviews(await g());
    expect(mine.items.map((i) => i.id)).toEqual([sub.approval.id]);
    const review = await getReview(await g(), sub.approval.id);
    const json = JSON.stringify(review);
    expect(json).not.toContain('INTERNAL');
    expect(json).not.toContain('Internal title');
    expect(json).not.toContain('Secret unrelated');
    expect(review.comments.map((c) => c.body)).toEqual(['Please review the copy']);
    expect(review.variants.map((v) => v.text)).toEqual(['Shared with the client', 'Shared with the client']);
    await expect(getReview(await g(), subOther.approval.id)).rejects.toMatchObject({ code: 'not_found' });

    // Notifications: the guest got the shared mention + review request, never the internal one.
    const notes = await listNotifications(await g());
    const kinds = notes.items.map((n) => n.title);
    expect(kinds).toEqual(expect.arrayContaining(['You were mentioned in a comment', 'A post is ready for your review']));
    expect(kinds).not.toContain('You were mentioned in an internal note');
    const internalMention = await testPool().query(`SELECT m.skipped_reason FROM comment_mentions m JOIN comments c ON c.id=m.comment_id WHERE c.visibility='internal' AND m.user_id=$1`, [t.guest.id]);
    expect(internalMention.rows[0].skipped_reason).toBe('not_entitled');
    expect((await listNotifications(await v2Ctx(t.approver.id, t.ws))).items.map((n) => n.title)).toContain('You were mentioned in an internal note');

    // Guest comments are shared; guest can reject with a reason.
    const c = await addReviewComment(await g(), sub.approval.id, 'Change the second line please');
    expect(c).toMatchObject({ visibility: 'shared', author: { email: null } });

    // Revoking the share closes everything immediately: deep link, list and notifications re-check on open.
    const noteId = notes.items.find((n) => n.reference_type === 'review')!.id;
    expect((await openNotification(await g(), noteId)).href).toBe(`/review/${sub.approval.id}`);
    await revokeReviewShare(e, shared.id, t.guest.id);
    await expect(getReview(await g(), sub.approval.id)).rejects.toMatchObject({ code: 'not_found' });
    await expect(openNotification(await g(), noteId)).rejects.toMatchObject({ code: 'not_found' });
    expect((await listNotifications(await g())).items.filter((n) => n.reference_type === 'review')).toEqual([]);
    expect((await listMyReviews(await g())).items).toEqual([]);
    await expect(reviewReject(await g(), sub.approval.id, 'no')).rejects.toMatchObject({ code: 'not_found' });

    // An expired guest grant gives nothing even with a live share.
    await shareReview(e, shared.id, t.guest.id);
    await testPool().query(`UPDATE scoped_role_grants SET expires_at=now() - interval '1 second' WHERE user_id=$1`, [t.guest.id]);
    await expect(getReview(await g(), sub.approval.id)).rejects.toMatchObject({ code: 'not_found' });
    // A guest of another brand cannot be shared with.
    const g2 = await createUser();
    await testPool().query(`INSERT INTO memberships(workspace_id, user_id, role) VALUES ($1,$2,'viewer')`, [t.ws, g2.id]);
    await grant(t.ws, g2.id, 'guest', t.brandB, new Date(Date.now() + 86_400_000));
    await expect(shareReview(e, shared.id, g2.id)).rejects.toMatchObject({ code: 'validation_failed' });
  });
});

// ------------------------------------------------------------------ mentions & notification delivery
describe('mentions and notifications', () => {
  it('mentions notify only people entitled at SEND time; delayed emails re-check; quiet hours and digest', async () => {
    const t = await agency({ approvalRequired: false });
    const { id } = await draftPost(t, await v2Ctx(t.editor.id, t.ws));
    // Approver loses access between the comment and the (asynchronous) send.
    await createComment(await v2Ctx(t.editor.id, t.ws), id, { body: '@approver see this', visibility: 'internal', mention_user_ids: [t.approver.id, t.editor2.id, t.outsider.id] });
    await testPool().query(`UPDATE scoped_role_grants SET revoked_at=now() WHERE user_id=$1`, [t.approver.id]);
    await runOutbox(t.ws);
    const m = await testPool().query<{ user_id: string; skipped_reason: string | null; notified_at: Date | null }>(`SELECT user_id, skipped_reason, notified_at FROM comment_mentions`, []);
    const by = (u: string) => m.rows.find((r) => r.user_id === u)!;
    expect(by(t.approver.id).skipped_reason).toBe('not_entitled');
    expect(by(t.outsider.id).skipped_reason).toBe('not_entitled'); // Brand B editor: not entitled to Brand A
    expect(by(t.editor2.id).notified_at).not.toBeNull();
    // Once per actionable event: replaying the event creates nothing new.
    const c1 = await testPool().query(`SELECT count(*)::int n FROM notifications WHERE user_id=$1`, [t.editor2.id]);
    await testPool().query(`UPDATE outbox SET dispatch_state='pending' WHERE workspace_id=$1 AND event_type='comment.created'`, [t.ws]);
    await testPool().query(`UPDATE comment_mentions SET notified_at=NULL, skipped_reason=NULL`);
    await runOutbox(t.ws);
    expect((await testPool().query(`SELECT count(*)::int n FROM notifications WHERE user_id=$1`, [t.editor2.id])).rows[0].n).toBe(c1.rows[0].n);

    // Quiet hours defer the email; access lost before the deferred send => skipped, nothing emailed.
    const ed2 = await v2Ctx(t.editor2.id, t.ws);
    const nowMin = new Date().getUTCHours() * 60 + new Date().getUTCMinutes();
    await updateNotificationPreferences(ed2, { timezone: 'UTC', quiet_start: (nowMin + 1440 - 30) % 1440, quiet_end: (nowMin + 60) % 1440 });
    await createComment(await v2Ctx(t.editor.id, t.ws), id, { body: 'second', visibility: 'internal', mention_user_ids: [t.editor2.id] });
    await runOutbox(t.ws);
    const deferred = await testPool().query(`SELECT id, email_state, email_after FROM notifications WHERE user_id=$1 AND kind='mention' ORDER BY created_at DESC LIMIT 1`, [t.editor2.id]);
    expect(deferred.rows[0].email_state).toBe('pending');
    expect(new Date(deferred.rows[0].email_after).getTime()).toBeGreaterThan(Date.now());
    await testPool().query(`UPDATE notifications SET email_after=now() - interval '1 second' WHERE id=$1`, [deferred.rows[0].id]);
    await testPool().query(`UPDATE scoped_role_grants SET revoked_at=now() WHERE user_id=$1`, [t.editor2.id]);
    await sendDueEmails();
    expect((await testPool().query(`SELECT email_state FROM notifications WHERE id=$1`, [deferred.rows[0].id])).rows[0].email_state).toBe('skipped');

    // Critical security alerts ignore quiet hours.
    await notifySecurityAlert(testPool(), { workspaceId: t.ws, userId: t.editor2.id, title: 'New sign-in', dedupeKey: `sec:${randomUUID()}` });
    const sec = await testPool().query(`SELECT email_state FROM notifications WHERE user_id=$1 AND critical_security`, [t.editor2.id]);
    expect(['sent', 'pending']).toContain(sec.rows[0].email_state);
    expect(sec.rows[0].email_state).not.toBe('skipped');

    // Daily digest: batched, re-checked, sent once.
    const ed = await v2Ctx(t.editor.id, t.ws);
    await updateNotificationPreferences(ed, { events: [{ event_type: 'assignment', in_app: true, email: false, digest: true }], timezone: 'UTC', digest_hour: 0 });
    await updatePostPlanning(await v2Ctx(t.owner.id, t.ws), id, { assignee_user_id: t.editor.id, due_at: new Date(Date.now() + 86_400_000).toISOString() });
    await runOutbox(t.ws);
    expect((await testPool().query(`SELECT email_state FROM notifications WHERE user_id=$1 AND kind='assignment'`, [t.editor.id])).rows[0].email_state).toBe('digest');
    expect(await sendDigests(testPool(), new Date())).toBeGreaterThanOrEqual(1);
    expect((await testPool().query(`SELECT email_state FROM notifications WHERE user_id=$1 AND kind='assignment'`, [t.editor.id])).rows[0].email_state).toBe('sent');
    expect(await sendDigests(testPool(), new Date())).toBe(0);
  });
});

// ------------------------------------------------------------------ campaigns & assignments
describe('campaigns and assignments', () => {
  it('campaigns are brand-scoped; assignees must be entitled to the brand at assign time', async () => {
    const t = await agency({ approvalRequired: true });
    const o = await v2Ctx(t.owner.id, t.ws);
    const camp = await createCampaign(o, t.brandA, { name: 'Spring launch', starts_on: '2026-12-01', ends_on: '2026-12-20' });
    const campB = await createCampaign(o, t.brandB, { name: 'Other brand' });
    const { id, ids } = await draftPost(t, await v2Ctx(t.editor.id, t.ws));
    const plan = await updatePostPlanning(await v2Ctx(t.editor.id, t.ws), id, { campaign_id: camp.id, assignee_user_id: t.editor2.id, due_at: '2026-12-05T10:00:00Z' });
    expect(plan).toMatchObject({ campaign: { name: 'Spring launch' }, assignee: { id: t.editor2.id }, due_at: '2026-12-05T10:00:00.000Z' });
    await expect(updatePostPlanning(await v2Ctx(t.editor.id, t.ws), id, { campaign_id: campB.id })).rejects.toMatchObject({ code: 'validation_failed' });
    await expect(updatePostPlanning(await v2Ctx(t.editor.id, t.ws), id, { assignee_user_id: t.outsider.id })).rejects.toMatchObject({ code: 'validation_failed' });
    await expect(updatePostPlanning(await v2Ctx(t.editor.id, t.ws), id, { assignee_user_id: t.guest.id })).rejects.toMatchObject({ code: 'validation_failed' });
    await expect(createCampaign(await v2Ctx(t.outsider.id, t.ws), t.brandA, { name: 'x' })).rejects.toMatchObject({ code: 'not_found' });
    // Review request assignment: the reviewer must be able to approve on the brand.
    const sub = await submit(await v2Ctx(t.editor.id, t.ws), id, ids);
    await expect(assignReview(await v2Ctx(t.editor.id, t.ws), sub.approval.id, { assignee_user_id: t.editor2.id })).rejects.toMatchObject({ code: 'validation_failed' });
    await assignReview(await v2Ctx(t.editor.id, t.ws), sub.approval.id, { assignee_user_id: t.approver.id, due_at: '2026-12-04T09:00:00Z' });
    const inbox = await approvalInbox(await v2Ctx(t.approver.id, t.ws));
    expect(inbox.items.find((i) => i.id === sub.approval.id)).toMatchObject({ assignee: { id: t.approver.id }, review_due_at: '2026-12-04T09:00:00.000Z', campaign_name: 'Spring launch', can_decide: true });
    // An approval decision is never implied by assignment; rejection needs eligibility.
    await expect(reject(await v2Ctx(t.editor2.id, t.ws), sub.approval.id, 'no')).rejects.toMatchObject({ code: 'forbidden' });
  });
});
