// V3.1 DATA stream: draft resilience (§9), trash/undo (§10), bulk jobs (§11), global search (§8) against real
// PostgreSQL through the real V2 policy path (v2Ctx). Covers concurrency, permission revocation, workspace isolation,
// partial bulk failure + idempotent retry, trash with a scheduled asset reference, search isolation + cancellation.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppError } from '@social-lite/core';
import type { Ctx } from '@social-lite/services';
import { cancelSchedule, createPost, listPosts, loadPost, schedulePost, submitForReview } from '@social-lite/services';
import { createCampaign } from '@social-lite/services/collab/campaigns';
import { autosaveDraft, recoverDraft, recoveryStatus } from '@social-lite/services/data/drafts';
import { updateDataPolicy } from '@social-lite/services/data/policy';
import { listTrash, purgeTrash, restoreItem, trashConsequences, trashItem } from '@social-lite/services/data/trash';
import { getBulkJob, previewBulk, retryBulk, runBulkJob, startBulk, undoBulk } from '@social-lite/services/data/bulk';
import { globalSearch, recentItems, recordRecent, SearchCancelledError } from '@social-lite/services/data/search';
import { sessionInfo } from '@social-lite/services/workspaces';
import { addMember, closeTestPool, createBrand, createUser, createWorkspace, grant, testPool, v2Ctx } from './helpers.js';
import { seedConnections, seedReadyImage } from './engine-helpers.js';

beforeAll(() => { testPool(); });
afterAll(async () => { await closeTestPool(); });

const DRAFT = (text: string, extra: Record<string, unknown> = {}) => ({ baseText: text, baseLink: null, baseAssetIds: [] as string[], variants: [] as unknown[], ...extra });
const tomorrow = (hours = 26) => {
  const d = new Date(Date.now() + hours * 3600_000);
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .format(d).replace(' ', 'T').replace(/\d{2}$/, '00');
};

async function world(opts: { approvalB?: boolean } = {}) {
  const owner = await createUser();
  const ws = await createWorkspace('Data WS', { isDemo: false });
  const brandA = await createBrand(ws, 'Brand A');
  const brandB = await createBrand(ws, 'Brand B', { approvalRequired: opts.approvalB });
  await addMember(ws, owner.id, 'owner');
  const ctx = await v2Ctx(owner.id, ws);
  const connsA = await seedConnections(ws, brandA);
  return { owner, ws, brandA, brandB, ctx, connsA };
}

async function post(ctx: Ctx, brandId: string, text: string, opts: { title?: string; connectionIds?: string[]; assetIds?: string[] } = {}) {
  const r = await createPost(ctx, brandId, {
    title: opts.title, draft: DRAFT(text, { baseAssetIds: opts.assetIds ?? [], variants: (opts.connectionIds ?? []).map((c) => ({ connectionId: c, inheritText: true, inheritMedia: true })) }),
  }, randomUUID());
  return r.id;
}

async function member(ws: string, role: string, brandId?: string): Promise<{ id: string; ctx: () => Promise<Ctx> }> {
  const u = await createUser();
  await testPool().query(`INSERT INTO memberships(workspace_id, user_id, role) VALUES ($1,$2,'viewer')`, [ws, u.id]);
  await grant(ws, u.id, role, brandId);
  return { id: u.id, ctx: () => v2Ctx(u.id, ws) };
}

const revokeAll = (ws: string, userId: string) => testPool().query(`UPDATE scoped_role_grants SET revoked_at=now() WHERE workspace_id=$1 AND user_id=$2`, [ws, userId]);
const code = async (p: Promise<unknown>) => { try { await p; return 'ok'; } catch (e) { return e instanceof AppError ? e.code : (e as Error).name; } };

// ================================================================== §9 drafts

describe('V3.1 draft autosave + recovery', () => {
  it('autosave: revisions, lost-response retry, out-of-order saves, no-op saves', async () => {
    const w = await world();
    const id = await post(w.ctx, w.brandA, 'v1');
    const tab = 'tab-aaaaaaaa';
    const s1 = await autosaveDraft(w.ctx, id, { base_version: 1, client_id: tab, client_revision: 1, draft: DRAFT('typing one') });
    expect(s1).toMatchObject({ status: 'saved', version: 2, unchanged: false, duplicate: false });
    // the same request again (response was lost): original result, no new version, no conflict
    expect(await autosaveDraft(w.ctx, id, { base_version: 1, client_id: tab, client_revision: 1, draft: DRAFT('typing one') })).toMatchObject({ status: 'saved', version: 2, duplicate: true });
    // an older save from the same tab arriving late never rolls content back
    expect(await autosaveDraft(w.ctx, id, { base_version: 1, client_id: tab, client_revision: 0, draft: DRAFT('typ') })).toMatchObject({ status: 'stale_ignored', version: 2 });
    // identical content: no version churn
    expect(await autosaveDraft(w.ctx, id, { base_version: 2, client_id: tab, client_revision: 2, draft: DRAFT('typing one') })).toMatchObject({ status: 'saved', version: 2, unchanged: true });
    expect((await loadPost(w.ctx, id)).draft.baseText).toBe('typing one');
    const v = await testPool().query(`SELECT kind, version FROM post_versions WHERE post_id=$1 ORDER BY created_at`, [id]);
    expect(v.rows.map((r) => r.kind)).toEqual(['created', 'saved']);
  });

  it('concurrency: two tabs saving on the same base → one wins, the other gets the server copy + a kept conflict copy', async () => {
    const w = await world();
    const id = await post(w.ctx, w.brandA, 'base');
    const editor = await member(w.ws, 'editor');
    const eCtx = await editor.ctx();
    const results = await Promise.allSettled([
      autosaveDraft(w.ctx, id, { base_version: 1, client_id: 'tab-owner01', client_revision: 1, draft: DRAFT('owner text') }),
      autosaveDraft(eCtx, id, { base_version: 1, client_id: 'tab-editor1', client_revision: 1, draft: DRAFT('editor text') }),
    ]);
    const won = results.filter((r) => r.status === 'fulfilled');
    const lost = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    const e = lost[0]!.reason as AppError;
    expect(e.code).toBe('version_conflict');
    const details = e.details as { current: { version: number; draft: { baseText: string } }; conflict_copy_id: string };
    expect(details.current.version).toBe(2);
    expect(['owner text', 'editor text']).toContain(details.current.draft.baseText);
    expect(details.conflict_copy_id).toMatch(/^[0-9a-f-]{36}$/);
    const copies = await testPool().query(`SELECT draft->>'baseText' AS t FROM post_versions WHERE post_id=$1 AND kind='conflict'`, [id]);
    expect(copies.rows).toHaveLength(1);
    expect(copies.rows[0].t).not.toBe(details.current.draft.baseText); // the loser's text is kept, not lost
  });

  it('recover: applied when the server has not moved on; kept as a copy (never overwrites) when it has; never schedules', async () => {
    const w = await world();
    const id = await post(w.ctx, w.brandA, 'server v1', { connectionIds: [w.connsA.facebook] });
    const a = await recoverDraft(w.ctx, id, { base_version: 1, client_id: 'tab-recover1', draft: DRAFT('recovered after restart', { variants: [{ connectionId: w.connsA.facebook, inheritText: true, inheritMedia: true }] }) });
    expect(a).toMatchObject({ status: 'applied', version: 2 });
    const kinds = await testPool().query(`SELECT kind FROM post_versions WHERE post_id=$1 AND version=2`, [id]);
    expect(kinds.rows[0].kind).toBe('recovered');
    await autosaveDraft(w.ctx, id, { base_version: 2, client_id: 'tab-other01', client_revision: 1, draft: DRAFT('newer on server') });
    const b = await recoverDraft(w.ctx, id, { base_version: 2, client_id: 'tab-recover1', draft: DRAFT('stale local copy') });
    expect(b.status).toBe('kept_as_copy');
    expect((await loadPost(w.ctx, id)).draft.baseText).toBe('newer on server');
    const sched = await testPool().query(`SELECT count(*)::int n FROM schedules WHERE post_id=$1`, [id]);
    expect(sched.rows[0].n).toBe(0);
    const st = await recoveryStatus(w.ctx, id, 2);
    expect(st).toMatchObject({ current_version: 3, editable: true, server_newer: true });
    expect(st.conflict_copies).toHaveLength(1);
  });

  it('recover re-checks permission (revocation) and workspace isolation; archived/trashed block sync', async () => {
    const w = await world();
    const other = await world();
    const id = await post(w.ctx, w.brandA, 'text');
    const editor = await member(w.ws, 'editor', w.brandA);
    expect((await recoverDraft(await editor.ctx(), id, { base_version: 1, client_id: 'tab-editor2', draft: DRAFT('ok') })).status).toBe('applied');
    await revokeAll(w.ws, editor.id);
    expect(await code(recoverDraft(await editor.ctx(), id, { base_version: 2, client_id: 'tab-editor2', draft: DRAFT('after revoke') }))).toBe('forbidden');
    expect(await code(recoverDraft(other.ctx, id, { base_version: 2, client_id: 'tab-intruder', draft: DRAFT('x') }))).toBe('not_found');
    expect(await code(recoveryStatus(other.ctx, id, null))).toBe('not_found');
    await trashItem(w.ctx, 'post', id);
    expect(await code(recoverDraft(w.ctx, id, { base_version: 2, client_id: 'tab-owner02', draft: DRAFT('into trash') }))).toBe('not_found');
    expect((await recoveryStatus(w.ctx, id, 2))).toMatchObject({ editable: false, blocked_reason: 'trashed' });
  });

  it('workspace policy disables persistent local recovery and is exposed in the session payload', async () => {
    const w = await world();
    const editor = await member(w.ws, 'editor');
    expect(await code(updateDataPolicy(await editor.ctx(), { local_recovery: 'off' }))).toBe('forbidden');
    const p = await updateDataPolicy(w.ctx, { local_recovery: 'off', max_age_hours: 12 });
    expect(p).toMatchObject({ local_recovery: 'off', max_age_hours: 12, clear_on_logout: true });
    const s = await sessionInfo({ id: randomUUID(), activeWorkspaceId: w.ws, csrfToken: 'x', mfaVerified: true, authTime: new Date() } as never, w.ctx.actor);
    expect(s.draft_recovery).toMatchObject({ local_recovery: 'off', max_age_hours: 12 });
    expect(s.draft_recovery!.namespace).toContain(`${w.owner.id}:${w.ws}`);
    const audit = await testPool().query(`SELECT 1 FROM audit_events WHERE workspace_id=$1 AND action='workspace.data_policy_updated'`, [w.ws]);
    expect(audit.rowCount).toBe(1);
  });
});

// ================================================================== §10 trash

describe('V3.1 trash, restore, undo, purge', () => {
  it('trash hides a post everywhere; restore with undo token; never republishes; audited', async () => {
    const w = await world();
    const id = await post(w.ctx, w.brandA, 'to trash', { connectionIds: [w.connsA.facebook] });
    const s = await schedulePost(w.ctx, id, { expected_version: 1, connection_ids: [w.connsA.facebook], input_local_time: tomorrow(), timezone: 'UTC' }, randomUUID());
    await cancelSchedule(w.ctx, (s.body as { schedule: { id: string } }).schedule.id);
    const c = await trashConsequences(w.ctx, 'post', id);
    expect(c).toMatchObject({ can_trash: true, external_posts_affected: false, retention_days: 30 });
    const t = await trashItem(w.ctx, 'post', id, { expectedVersion: 1 });
    expect(t.undo).toMatchObject({ operation: 'trash.restore', kind: 'post', id });
    expect(await code(loadPost(w.ctx, id))).toBe('not_found');
    expect((await listPosts(w.ctx, w.brandA, {})).items.map((p) => p.id)).not.toContain(id);
    expect((await listTrash(w.ctx, { kind: 'post' })).items.map((i) => i.id)).toContain(id);
    // undo after someone else restored + re-trashed it ⇒ conflict
    const r1 = await restoreItem(w.ctx, 'post', id, { expectedDeletedAt: t.undo.expected_deleted_at });
    expect(r1).toMatchObject({ restored: true, republished: false });
    const t2 = await trashItem(w.ctx, 'post', id);
    expect(await code(restoreItem(w.ctx, 'post', id, { expectedDeletedAt: t.undo.expected_deleted_at }))).toBe('conflict');
    await restoreItem(w.ctx, 'post', id, { expectedDeletedAt: t2.undo.expected_deleted_at });
    expect((await loadPost(w.ctx, id)).id).toBe(id);
    const live = await testPool().query(`SELECT count(*)::int n FROM schedules WHERE post_id=$1 AND status IN ('active','pending_approval')`, [id]);
    expect(live.rows[0].n).toBe(0);
    const acts = await testPool().query(`SELECT action FROM audit_events WHERE resource_id=$1 AND action LIKE 'post.%' ORDER BY id`, [id]);
    expect(acts.rows.map((r) => r.action).filter((a) => a === 'post.trashed' || a === 'post.restored')).toEqual(['post.trashed', 'post.restored', 'post.trashed', 'post.restored']);
  });

  it('refuses live schedules and published history (deleting locally never touches networks)', async () => {
    const w = await world();
    const id = await post(w.ctx, w.brandA, 'scheduled', { connectionIds: [w.connsA.facebook] });
    const s = await schedulePost(w.ctx, id, { expected_version: 1, connection_ids: [w.connsA.facebook], input_local_time: tomorrow(), timezone: 'UTC' }, randomUUID());
    expect(await code(trashItem(w.ctx, 'post', id))).toBe('conflict');
    expect((await trashConsequences(w.ctx, 'post', id)).can_trash).toBe(false);
    await cancelSchedule(w.ctx, (s.body as { schedule: { id: string } }).schedule.id);
    await testPool().query(`UPDATE deliveries SET state='published', published_at=now() WHERE post_id=$1`, [id]);
    const c = await trashConsequences(w.ctx, 'post', id);
    expect(c.can_trash).toBe(false);
    expect(c.blocked_reason).toMatch(/Archive it instead/);
  });

  it('asset with a scheduled reference: trash refused; purge defers while any schedule/draft uses it; unreferenced purged', async () => {
    const w = await world();
    const used = await seedReadyImage(w.ws, w.brandA);
    const id = await post(w.ctx, w.brandA, 'with image', { connectionIds: [w.connsA.facebook], assetIds: [used] });
    await schedulePost(w.ctx, id, { expected_version: 1, connection_ids: [w.connsA.facebook], input_local_time: tomorrow(), timezone: 'UTC' }, randomUUID());
    expect(await code(trashItem(w.ctx, 'asset', used))).toBe('conflict');
    const c = await trashConsequences(w.ctx, 'asset', used);
    expect(c.can_trash).toBe(false);
    expect(c.references.live_schedules).toBe(1);

    // Trashed while only a draft used it; then that draft is scheduled. Purge must not delete it.
    const later = await seedReadyImage(w.ws, w.brandA);
    const p2 = await post(w.ctx, w.brandA, 'draft with image', { connectionIds: [w.connsA.facebook], assetIds: [later] });
    const tc = await trashConsequences(w.ctx, 'asset', later);
    expect(tc.can_trash).toBe(true);
    expect(tc.consequences.join(' ')).toMatch(/Used by 1 draft/);
    await trashItem(w.ctx, 'asset', later);
    await schedulePost(w.ctx, p2, { expected_version: 1, connection_ids: [w.connsA.facebook], input_local_time: tomorrow(), timezone: 'UTC' }, randomUUID());
    const orphan = await seedReadyImage(w.ws, w.brandA);
    await trashItem(w.ctx, 'asset', orphan);
    const future = new Date(Date.now() + 31 * 86_400_000);
    const r = await purgeTrash({ now: future });
    expect(r.assets).toBeGreaterThanOrEqual(1);
    const rows = await testPool().query(`SELECT id, purge_blocked_reason FROM assets WHERE id = ANY($1::uuid[])`, [[later, orphan]]);
    expect(rows.rows).toEqual([{ id: later, purge_blocked_reason: 'used_by_scheduled_post' }]);
    const purged = await testPool().query(`SELECT 1 FROM audit_events WHERE resource_id=$1 AND action='asset.purged'`, [orphan]);
    expect(purged.rowCount).toBe(1);
  });

  it('restore/trash need the right permission; other workspaces cannot see or restore', async () => {
    const w = await world();
    const other = await world();
    const asset = await seedReadyImage(w.ws, w.brandA);
    const editor = await member(w.ws, 'editor');
    expect(await code(trashItem(await editor.ctx(), 'asset', asset))).toBe('forbidden'); // assets.manage needed
    await trashItem(w.ctx, 'asset', asset);
    expect(await code(restoreItem(await editor.ctx(), 'asset', asset))).toBe('forbidden');
    expect(await code(restoreItem(other.ctx, 'asset', asset))).toBe('not_found');
    expect((await listTrash(other.ctx, {})).items).toHaveLength(0);
    const viewer = await member(w.ws, 'viewer');
    const vt = await listTrash(await viewer.ctx(), {});
    expect(vt.items.find((i) => i.id === asset)?.can_restore).toBe(false);
  });

  it('purge deletes trashed posts after retention', async () => {
    const w = await world();
    const id = await post(w.ctx, w.brandA, 'old');
    await trashItem(w.ctx, 'post', id);
    expect((await purgeTrash({ now: new Date() })).posts).toBe(0); // retention not over
    await purgeTrash({ now: new Date(Date.now() + 31 * 86_400_000) });
    const r = await testPool().query(`SELECT 1 FROM posts WHERE id=$1`, [id]);
    expect(r.rowCount).toBe(0);
  });
});

// ================================================================== §11 bulk

describe('V3.1 bulk jobs', () => {
  it('partial failure, then idempotent retry of only the failed item; idempotent start', async () => {
    const w = await world();
    const ids = [await post(w.ctx, w.brandA, 'a'), await post(w.ctx, w.brandA, 'b'), await post(w.ctx, w.brandA, 'c')];
    const req = { target_kind: 'post' as const, action: 'add_tags' as const, item_ids: ids, params: { tags: ['promo'] } };
    const pv = await previewBulk(w.ctx, req);
    expect(pv).toMatchObject({ total: 3, eligible: 3 });
    const key = `bulk-${randomUUID()}`;
    const job = await startBulk(w.ctx, { ...req, preview_hash: pv.preview_hash }, key);
    expect((await startBulk(w.ctx, { ...req, preview_hash: pv.preview_hash }, key)).id).toBe(job.id);
    await trashItem(w.ctx, 'post', ids[1]!); // changes after start: that item must fail on its own
    expect((await runBulkJob(job.id)).status).toBe('completed_with_errors');
    let v = await getBulkJob(w.ctx, job.id);
    expect(v.counts).toMatchObject({ succeeded: 2, failed: 1 });
    expect(v.items.find((i) => i.id === ids[1])).toMatchObject({ status: 'failed', error_code: 'not_found' });
    expect(v.can_retry).toBe(true);
    await restoreItem(w.ctx, 'post', ids[1]!);
    await retryBulk(w.ctx, job.id, [ids[1]!]);
    expect((await runBulkJob(job.id)).status).toBe('completed');
    v = await getBulkJob(w.ctx, job.id);
    expect(v.counts).toMatchObject({ succeeded: 3, failed: 0 });
    expect(v.items.filter((i) => i.id !== ids[1]).every((i) => i.attempts === 1)).toBe(true); // successes never re-run
    for (const id of ids) expect((await loadPost(w.ctx, id)).tags).toEqual(['promo']);
    expect(await code(retryBulk(w.ctx, job.id))).toBe('invalid_state'); // nothing failed
  });

  it('a stale preview is rejected (selection/state changed)', async () => {
    const w = await world();
    const ids = [await post(w.ctx, w.brandA, 'a'), await post(w.ctx, w.brandA, 'b')];
    const req = { target_kind: 'post' as const, action: 'archive' as const, item_ids: ids };
    const pv = await previewBulk(w.ctx, req);
    await testPool().query(`UPDATE posts SET archived_at=now() WHERE id=$1`, [ids[0]]);
    const e = await startBulk(w.ctx, { ...req, preview_hash: pv.preview_hash }, `bulk-${randomUUID()}`).catch((x) => x as AppError);
    expect(e).toBeInstanceOf(AppError);
    expect((e as AppError).details?.reason).toBe('preview_stale');
  });

  it('permission revocation before the job runs: every item fails forbidden and nothing changes', async () => {
    const w = await world();
    const editor = await member(w.ws, 'editor', w.brandA);
    const eCtx = await editor.ctx();
    const ids = [await post(eCtx, w.brandA, 'x'), await post(eCtx, w.brandA, 'y')];
    const req = { target_kind: 'post' as const, action: 'archive' as const, item_ids: ids };
    const pv = await previewBulk(eCtx, req);
    const job = await startBulk(eCtx, { ...req, preview_hash: pv.preview_hash }, `bulk-${randomUUID()}`);
    await revokeAll(w.ws, editor.id);
    expect((await runBulkJob(job.id)).status).toBe('failed');
    const items = await testPool().query(`SELECT status, error_code FROM bulk_job_items WHERE job_id=$1`, [job.id]);
    expect(items.rows.every((r) => r.status === 'failed' && ['forbidden', 'not_found'].includes(r.error_code))).toBe(true);
    const archived = await testPool().query(`SELECT count(*)::int n FROM posts WHERE id = ANY($1::uuid[]) AND archived_at IS NOT NULL`, [ids]);
    expect(archived.rows[0].n).toBe(0);
    // the revoked person cannot read the job's items any more
    const owner = await getBulkJob(w.ctx, job.id);
    expect(owner.items).toHaveLength(2);
  });

  it('no access broadening: other brands invisible, assignees/campaigns must belong to the brand', async () => {
    const w = await world();
    const pa = await post(w.ctx, w.brandA, 'on A');
    const pb = await post(w.ctx, w.brandB, 'on B');
    const editor = await member(w.ws, 'editor', w.brandA);
    const pv = await previewBulk(await editor.ctx(), { target_kind: 'post', action: 'add_tags', item_ids: [pa, pb], params: { tags: ['t'] } });
    expect(pv.items.find((i) => i.id === pb)).toMatchObject({ eligibility: 'not_found', brand_id: null, title: null });
    const outsider = await member(w.ws, 'editor', w.brandB); // no access to brand A
    const assign = await previewBulk(w.ctx, { target_kind: 'post', action: 'assign', item_ids: [pa, pb], params: { assignee_user_id: outsider.id } });
    expect(assign.items.find((i) => i.id === pa)).toMatchObject({ eligibility: 'ineligible', reason_code: 'assignee_no_access' });
    expect(assign.items.find((i) => i.id === pb)?.eligibility).toBe('eligible');
    const camp = await createCampaign(w.ctx, w.brandA, { name: `Camp ${randomUUID().slice(0, 6)}` });
    const sc = await previewBulk(w.ctx, { target_kind: 'post', action: 'set_campaign', item_ids: [pa, pb], params: { campaign_id: camp.id } });
    expect(sc.items.find((i) => i.id === pb)).toMatchObject({ eligibility: 'ineligible', reason_code: 'campaign_other_brand' });
    const other = await world();
    const iso = await previewBulk(other.ctx, { target_kind: 'post', action: 'archive', item_ids: [pa] });
    expect(iso.items[0]).toMatchObject({ eligibility: 'not_found', title: null });
  });

  it('a crash between the change and the status update never repeats work (duplicate)', async () => {
    const w = await world();
    const ids = [await post(w.ctx, w.brandA, 'dup me'), await post(w.ctx, w.brandA, 'and me')];
    const req = { target_kind: 'post' as const, action: 'duplicate' as const, item_ids: ids };
    const pv = await previewBulk(w.ctx, req);
    const job = await startBulk(w.ctx, { ...req, preview_hash: pv.preview_hash }, `bulk-${randomUUID()}`);
    await runBulkJob(job.id);
    const first = (await getBulkJob(w.ctx, job.id)).items.map((i) => i.result?.post_id);
    const count = async () => (await testPool().query(`SELECT count(*)::int n FROM posts WHERE workspace_id=$1`, [w.ws])).rows[0].n as number;
    const n = await count();
    // simulate: work done but the item status write was lost
    await testPool().query(`UPDATE bulk_job_items SET status='pending', after=NULL WHERE job_id=$1`, [job.id]);
    await testPool().query(`UPDATE bulk_jobs SET status='queued' WHERE id=$1`, [job.id]);
    expect((await runBulkJob(job.id)).status).toBe('completed');
    expect(await count()).toBe(n);
    expect((await getBulkJob(w.ctx, job.id)).items.map((i) => i.result?.post_id)).toEqual(first);
    const sched = await testPool().query(`SELECT count(*)::int n FROM schedules WHERE post_id = ANY($1::uuid[])`, [first]);
    expect(sched.rows[0].n).toBe(0); // copies are never scheduled
  });

  it('reschedule keeps approval rules: approval brands need approval again, others move directly', async () => {
    const w = await world({ approvalB: true });
    const connsB = await seedConnections(w.ws, w.brandB);
    const pa = await post(w.ctx, w.brandA, 'normal', { connectionIds: [w.connsA.facebook] });
    const pb = await post(w.ctx, w.brandB, 'needs approval', { connectionIds: [connsB.facebook] });
    const t = tomorrow();
    await schedulePost(w.ctx, pa, { expected_version: 1, connection_ids: [w.connsA.facebook], input_local_time: t, timezone: 'UTC' }, randomUUID());
    await submitForReview(w.ctx, pb, { expected_version: 1, connection_ids: [connsB.facebook], input_local_time: t, timezone: 'UTC' }, randomUUID());
    const oldApproval = await testPool().query(`SELECT a.id FROM approvals a WHERE a.post_id=$1 AND a.decision='pending'`, [pb]);
    const req = { target_kind: 'post' as const, action: 'reschedule' as const, item_ids: [pa, pb], params: { shift_minutes: 60 } };
    const pv = await previewBulk(w.ctx, req);
    expect(pv.eligible).toBe(2);
    expect(pv.items.find((i) => i.id === pb)!.consequences.join(' ')).toMatch(/approval again/);
    const job = await startBulk(w.ctx, { ...req, preview_hash: pv.preview_hash }, `bulk-${randomUUID()}`);
    expect((await runBulkJob(job.id)).status).toBe('completed');
    const s = await testPool().query(`SELECT post_id, status, due_at FROM schedules WHERE post_id = ANY($1::uuid[]) AND status IN ('active','pending_approval')`, [[pa, pb]]);
    const byPost = Object.fromEntries(s.rows.map((r) => [r.post_id, r]));
    expect(byPost[pa].status).toBe('active');
    expect(byPost[pb].status).toBe('pending_approval');
    expect(new Date(byPost[pa].due_at).getTime() - new Date(`${t}:00Z`).getTime()).toBe(3_600_000);
    expect(new Date(byPost[pb].due_at).getTime() - new Date(`${t}:00Z`).getTime()).toBe(3_600_000);
    const inv = await testPool().query(`SELECT decision FROM approvals WHERE id=$1`, [oldApproval.rows[0].id]);
    expect(inv.rows[0].decision).toBe('invalidated');
  });

  it('undo reverses succeeded items with a concurrency check', async () => {
    const w = await world();
    const ids = [await post(w.ctx, w.brandA, 'a1'), await post(w.ctx, w.brandA, 'a2')];
    const req = { target_kind: 'post' as const, action: 'archive' as const, item_ids: ids };
    const pv = await previewBulk(w.ctx, req);
    const job = await startBulk(w.ctx, { ...req, preview_hash: pv.preview_hash }, `bulk-${randomUUID()}`);
    await runBulkJob(job.id);
    // someone re-archives item 2 independently after the bulk action ⇒ its archived_at differs ⇒ undo leaves it alone
    await testPool().query(`UPDATE posts SET archived_at = archived_at + interval '1 second' WHERE id=$1`, [ids[1]]);
    const u = await undoBulk(w.ctx, job.id, `undo-${randomUUID()}`);
    await runBulkJob(u.id);
    const uv = await getBulkJob(w.ctx, u.id);
    expect(uv.items.find((i) => i.id === ids[0])?.status).toBe('succeeded');
    expect(uv.items.find((i) => i.id === ids[1])).toMatchObject({ status: 'failed', error_code: 'changed_since' });
    expect((await loadPost(w.ctx, ids[0]!)).archived_at).toBeNull();
    expect(await code(undoBulk(w.ctx, job.id, `undo-${randomUUID()}`))).toBe('conflict'); // only once
  });
});

// ================================================================== §8 search

describe('V3.1 global search', () => {
  it('authorized results only, safe snippets, workspace isolation, trash excluded, settings by permission', async () => {
    const w = await world();
    const other = await world();
    const pa = await post(w.ctx, w.brandA, 'Matchday preview: Arsenal travel north on Saturday', { title: 'Weekend preview' });
    const pb = await post(w.ctx, w.brandB, 'Arsenal confidential lineup for brand B');
    const pt = await post(w.ctx, w.brandA, 'Arsenal trashed draft');
    await post(other.ctx, other.brandA, 'Arsenal in another workspace');
    await trashItem(w.ctx, 'post', pt);
    await createCampaign(w.ctx, w.brandA, { name: 'Arsenal spring push', description: 'Season tickets' });
    const editor = await member(w.ws, 'editor', w.brandA);
    const r = await globalSearch(await editor.ctx(), { q: 'arsen' });
    const posts = r.results.filter((x) => x.kind === 'post');
    expect(posts.map((x) => x.id)).toEqual([pa]);
    const hit = posts[0]!;
    expect(hit.title).toBe('Weekend preview');
    expect(hit.snippet).toContain('Arsenal');
    const [s, e] = hit.highlights[0]!;
    expect(hit.snippet!.slice(s, e)).toBe('Arsenal');
    expect(JSON.stringify(r)).not.toMatch(/confidential|another workspace|trashed/);
    expect(r.results.some((x) => x.kind === 'campaign')).toBe(true);
    expect(r.workspace_id).toBe(w.ws);
    const owner = await globalSearch(w.ctx, { q: 'arsenal', kinds: ['post'] });
    expect(owner.results.map((x) => x.id).sort()).toEqual([pa, pb].sort());
    // settings destinations are filtered by permission
    const eSettings = await globalSearch(await editor.ctx(), { q: 'members', kinds: ['setting'] });
    expect(eSettings.results).toHaveLength(0);
    const oSettings = await globalSearch(w.ctx, { q: 'members', kinds: ['setting'] });
    expect(oSettings.results.map((x) => x.href)).toContain('/team');
    // query syntax cannot be injected
    expect((await globalSearch(w.ctx, { q: "arsenal' | !:* & (" })).results.length).toBeGreaterThan(0);
  });

  it('revocation: results and recent items vanish on the next request', async () => {
    const w = await world();
    const id = await post(w.ctx, w.brandA, 'Revocable content about Chelsea');
    const editor = await member(w.ws, 'editor', w.brandA);
    await recordRecent(await editor.ctx(), 'post', id);
    expect((await recentItems(await editor.ctx())).items.map((i) => i.id)).toEqual([id]);
    expect((await globalSearch(await editor.ctx(), { q: 'chelsea' })).results).toHaveLength(1);
    await revokeAll(w.ws, editor.id);
    expect((await globalSearch(await editor.ctx(), { q: 'chelsea' })).results).toHaveLength(0);
    expect((await recentItems(await editor.ctx())).items).toHaveLength(0);
    // a trashed item also disappears from recents of people who still have access
    await recordRecent(w.ctx, 'post', id);
    await trashItem(w.ctx, 'post', id);
    expect((await recentItems(w.ctx)).items).toHaveLength(0);
  });

  it('cancellation: an aborted request cancels the running SQL statement; a slow query is bounded', async () => {
    const w = await world();
    await post(w.ctx, w.brandA, 'Lockable fixture text');
    const pre = new AbortController();
    pre.abort();
    await expect(globalSearch(w.ctx, { q: 'lockable' }, pre.signal)).rejects.toBeInstanceOf(SearchCancelledError);
    const blocker = await testPool().connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query('LOCK TABLE posts IN ACCESS EXCLUSIVE MODE'); // makes the search statement wait
      const ac = new AbortController();
      const started = Date.now();
      const p = globalSearch(w.ctx, { q: 'lockable', kinds: ['post'] }, ac.signal);
      setTimeout(() => ac.abort(), 150);
      await expect(p).rejects.toBeInstanceOf(SearchCancelledError);
      expect(Date.now() - started).toBeLessThan(1500); // well before the 2 s statement timeout
      const waiting = await testPool().query(`SELECT count(*)::int n FROM pg_stat_activity WHERE state='active' AND query LIKE '%to_tsquery%' AND pid <> pg_backend_pid()`);
      expect(waiting.rows[0].n).toBe(0);
      // without an abort the time budget bounds it: partial result, no error
      const slow = await globalSearch(w.ctx, { q: 'lockable', kinds: ['post'] });
      expect(slow.partial).toBe(true);
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
    }
    expect((await globalSearch(w.ctx, { q: 'lockable' })).results).toHaveLength(1);
  });
});
