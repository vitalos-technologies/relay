// V2 stream D — product & fairness, through the REAL policy path (v2Ctx): usage budgets with atomic
// reservations, fair claim ordering across workspaces, readiness preflight, duplicate window, account
// health centre, activity centre (filters + export) and client handover export scoping.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { toLocalInput } from '@social-lite/core';
import { audit, claimDelivery, createPost, processDelivery, publishNow, schedulePost, type Ctx } from '@social-lite/services';
import {
  accountHealth, activityCsv, handoverExport, listActivity, readMeterUsage, readiness, releaseUsage, reserveUsage, setDuplicateWindow,
  settleUsage, sweepExpiredReservations, textSimilarity, unzip, updateTeamBudgets, getWorkspaceLimits, updateWorkspaceLimits,
} from '@social-lite/services/product/index';
import { checkAndConsumeBudget } from '@social-lite/services/engine/budget';
import { createUploadIntent } from '@social-lite/services/media/assets';
import { withTx } from '@social-lite/db';
import { closeTestPool, createBrand, createUser, createWorkspace, testPool, v2Ctx } from './helpers.js';
import { scriptedWorld, seedConnections, seedReadyImage } from './engine-helpers.js';

afterAll(closeTestPool);

const db = () => testPool();

/** A workspace member holding exactly the given V2 grants (V1 role column is a placeholder). */
async function member(ws: string, grants: Array<{ role: string; brandId?: string }>, email?: string): Promise<{ id: string; ctx: () => Promise<Ctx> }> {
  const u = await createUser(email);
  await db().query(`INSERT INTO memberships(workspace_id, user_id, role, brand_restricted) VALUES ($1,$2,'viewer',$3)`, [ws, u.id, grants.some((g) => g.brandId)]);
  for (const g of grants) {
    await db().query(`INSERT INTO scoped_role_grants(workspace_id, principal_type, user_id, role, scope_type, brand_id, source) VALUES ($1,'user',$2,$3,$4,$5,'test')`,
      [ws, u.id, g.role, g.brandId ? 'brand' : 'workspace', g.brandId ?? null]);
  }
  return { id: u.id, ctx: () => v2Ctx(u.id, ws) };
}

async function fixture() {
  const ws = await createWorkspace('Product WS');
  const brandA = await createBrand(ws, 'Brand A');
  const brandB = await createBrand(ws, 'Brand B');
  const owner = await member(ws, [{ role: 'owner' }]);
  return { ws, brandA, brandB, owner };
}

async function team(ws: string, name: string, userIds: string[]): Promise<string> {
  const t = await db().query<{ id: string }>(`INSERT INTO teams(workspace_id, name) VALUES ($1,$2) RETURNING id`, [ws, name]);
  for (const u of userIds) await db().query(`INSERT INTO team_memberships(workspace_id, team_id, user_id) VALUES ($1,$2,$3)`, [ws, t.rows[0]!.id, u]);
  return t.rows[0]!.id;
}

const counter = async (ws: string, meter: string, teamId: string | null = null) => {
  const r = await db().query<{ used: string; reserved: string }>(
    `SELECT used, reserved FROM usage_counters WHERE workspace_id=$1 AND meter=$2 AND team_id IS NOT DISTINCT FROM $3::uuid`, [ws, meter, teamId]);
  return { used: Number(r.rows[0]?.used ?? 0), reserved: Number(r.rows[0]?.reserved ?? 0) };
};

const draftFor = (text: string, connectionIds: string[], assetIds: string[] = []) => ({
  baseText: text, baseLink: null, baseAssetIds: assetIds, variants: connectionIds.map((connectionId) => ({ connectionId, inheritText: true, inheritMedia: true })),
});

// ====================================================================== budgets
describe('usage budgets: atomic reservations', () => {
  it('concurrent reservations never exceed the workspace cap; settle/release are idempotent', async () => {
    const t = await fixture();
    await db().query(`UPDATE workspaces SET limits = limits || '{"monthly_exports": 5}'::jsonb WHERE id=$1`, [t.ws]);
    const results = await Promise.allSettled(Array.from({ length: 20 }, () => reserveUsage({ workspaceId: t.ws, meter: 'exports.count', amount: 1, userId: t.owner.id })));
    const ok = results.filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof reserveUsage>>> => r.status === 'fulfilled').map((r) => r.value);
    expect(ok).toHaveLength(5);
    expect(results.filter((r) => r.status === 'rejected').every((r) => (r as PromiseRejectedResult).reason.code === 'budget_exhausted')).toBe(true);
    expect(await counter(t.ws, 'exports.count')).toEqual({ used: 0, reserved: 5 });
    // settle 3, release 2; repeating either is a no-op
    for (const r of ok.slice(0, 3)) expect(await settleUsage(r.id, 1)).toBe(true);
    for (const r of ok.slice(3)) expect(await releaseUsage(r.id)).toBe(true);
    expect(await settleUsage(ok[0]!.id, 1)).toBe(false);
    expect(await releaseUsage(ok[3]!.id)).toBe(false);
    expect(await counter(t.ws, 'exports.count')).toEqual({ used: 3, reserved: 0 });
    // exactly 2 more fit
    const more = await Promise.allSettled(Array.from({ length: 6 }, () => reserveUsage({ workspaceId: t.ws, meter: 'exports.count', amount: 1 })));
    expect(more.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
  });

  it('team budgets cap team members (in parallel) without limiting people outside the team', async () => {
    const t = await fixture();
    const alice = await member(t.ws, [{ role: 'editor' }]);
    const bob = await member(t.ws, [{ role: 'editor' }]);
    const teamId = await team(t.ws, 'Agency', [alice.id]);
    await updateTeamBudgets(await t.owner.ctx(), teamId, { 'ai.tokens': 1000 });
    const runs = await Promise.allSettled(Array.from({ length: 12 }, () => reserveUsage({ workspaceId: t.ws, meter: 'ai.tokens', amount: 300, userId: alice.id })));
    expect(runs.filter((r) => r.status === 'fulfilled')).toHaveLength(3);
    const rej = runs.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(rej.reason).toMatchObject({ code: 'budget_exhausted', details: { scope: 'team', team_id: teamId } });
    expect(rej.reason.message).toMatch(/Agency/);
    expect((await counter(t.ws, 'ai.tokens', teamId)).reserved).toBe(900);
    // Bob is not in the team: only the workspace cap (default 200k) applies.
    await expect(reserveUsage({ workspaceId: t.ws, meter: 'ai.tokens', amount: 5000, userId: bob.id })).resolves.toMatchObject({ amount: 5000, teamIds: [] });
    expect((await counter(t.ws, 'ai.tokens')).reserved).toBe(900 + 5000);
  });

  it('expired reservations are swept; a late settle still records the usage', async () => {
    const t = await fixture();
    const r = await reserveUsage({ workspaceId: t.ws, meter: 'storage.bytes', amount: 4096, ttlSeconds: 1 });
    await db().query(`UPDATE usage_reservations SET expires_at = now() - interval '1 second' WHERE id=$1`, [r.id]);
    expect(await sweepExpiredReservations({ workspaceId: t.ws })).toBe(1);
    expect(await counter(t.ws, 'storage.bytes')).toEqual({ used: 0, reserved: 0 });
    expect(await settleUsage(r.id, 4000)).toBe(true);
    expect(await counter(t.ws, 'storage.bytes')).toEqual({ used: 4000, reserved: 0 });
  });

  it('provider calls: engine consume honours the schedule creator’s team cap; storage uploads reserve before presigning', async () => {
    const t = await fixture();
    const pub = await member(t.ws, [{ role: 'publisher' }]);
    const teamId = await team(t.ws, 'Social', [pub.id]);
    await updateTeamBudgets(await t.owner.ctx(), teamId, { 'x.write': 1 });
    const first = await withTx((tx) => checkAndConsumeBudget(tx, t.ws, 'x.write', 1, { userId: pub.id }));
    expect(first).toEqual({ ok: true });
    const second = await withTx((tx) => checkAndConsumeBudget(tx, t.ws, 'x.write', 1, { userId: pub.id }));
    expect(second).toMatchObject({ ok: false, message: expect.stringMatching(/Social.*X API post budget/) });
    expect(await withTx((tx) => checkAndConsumeBudget(tx, t.ws, 'x.write', 1, { userId: t.owner.id }))).toEqual({ ok: true });
    expect((await counter(t.ws, 'x.write')).used).toBe(2);
    // storage: a workspace cap below the declared size refuses the upload intent (402) and leaves nothing behind
    await db().query(`UPDATE workspaces SET limits = limits || '{"storage_bytes": 1000}'::jsonb WHERE id=$1`, [t.ws]);
    await expect(createUploadIntent(await t.owner.ctx(), { brand_id: t.brandA, filename: 'big.png', content_type: 'image/png', bytes: 5000 }))
      .rejects.toMatchObject({ code: 'budget_exhausted' });
    const n = await db().query(`SELECT count(*)::int n FROM assets WHERE workspace_id=$1`, [t.ws]);
    expect(n.rows[0].n).toBe(0);
    const ok = await createUploadIntent(await t.owner.ctx(), { brand_id: t.brandA, filename: 'small.png', content_type: 'image/png', bytes: 800 });
    expect(ok.asset_id).toBeTruthy();
    expect(await counter(t.ws, 'storage.bytes')).toEqual({ used: 0, reserved: 800 });
  });

  it('Settings → Budgets: owner edits workspace + team caps (audited); admins read; others are denied', async () => {
    const t = await fixture();
    const admin = await member(t.ws, [{ role: 'admin' }]);
    const editor = await member(t.ws, [{ role: 'editor' }]);
    const teamId = await team(t.ws, 'Ops', [editor.id]);
    const view = await updateWorkspaceLimits(await t.owner.ctx(), { monthly_exports: 10, storage_bytes: 1_000_000 });
    expect(view.items.find((i) => i.key === 'monthly_exports')).toMatchObject({ cap: 10, meter: 'exports.count' });
    expect(view.can_edit).toBe(true);
    const adminView = await getWorkspaceLimits(await admin.ctx());
    expect(adminView.can_edit).toBe(false);
    expect(adminView.teams.find((x) => x.id === teamId)).toBeTruthy();
    await expect(updateWorkspaceLimits(await admin.ctx(), { monthly_exports: 99 })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(getWorkspaceLimits(await editor.ctx())).rejects.toMatchObject({ code: 'forbidden' });
    const other = await fixture();
    const foreignTeam = await team(other.ws, 'Foreign', []);
    await expect(updateTeamBudgets(await t.owner.ctx(), foreignTeam, { 'ai.tokens': 5 })).rejects.toMatchObject({ code: 'not_found' });
    const a = await db().query(`SELECT action FROM audit_events WHERE workspace_id=$1 AND action IN ('workspace.limits_updated','budget.team_updated')`, [t.ws]);
    expect(a.rows.length).toBe(1);
    await updateTeamBudgets(await t.owner.ctx(), teamId, { 'exports.count': 2 });
    expect((await readMeterUsage(t.ws, 'exports.count', { teamId })).cap).toBe(2);
  });
});

// ====================================================================== fair scheduling
describe('fair dispatch across workspaces', () => {
  async function dueWorkspace(posts: number, providers: Array<'facebook' | 'telegram' | 'x'>) {
    const ws = await createWorkspace('Fair');
    const brand = await createBrand(ws, 'Fair brand');
    const owner = await member(ws, [{ role: 'owner' }]);
    const conns = await seedConnections(ws, brand);
    const ctx = await owner.ctx();
    for (let i = 0; i < posts; i++) {
      const ids = providers.map((p) => conns[p]);
      const { id } = await createPost(ctx, brand, { draft: draftFor(`Fairness ${i} ${randomUUID()}`, ids) }, randomUUID());
      await publishNow(ctx, id, { expected_version: 1, connection_ids: ids }, randomUUID());
    }
    return ws;
  }

  beforeAll(async () => {
    // Isolate from due work left by other files in this shared test database.
    await db().query(`UPDATE deliveries SET next_attempt_at = now() + interval '30 days' WHERE state IN ('scheduled','retry_wait','processing') AND next_attempt_at <= now()`);
  });

  it('per-workspace cap holds and a bulk workspace cannot starve another (claims interleave)', async () => {
    const A = await dueWorkspace(6, ['facebook', 'telegram', 'x']); // 18 jobs, 3 destinations
    await db().query(`UPDATE workspaces SET limits = limits || '{"dispatch_concurrency": 2}'::jsonb WHERE id=$1`, [A]);
    await db().query(`UPDATE deliveries SET next_attempt_at = now() - interval '10 minutes' WHERE workspace_id=$1`, [A]); // A is "older"
    const B = await dueWorkspace(3, ['facebook', 'telegram']); // 6 jobs, 2 destinations
    const order: string[] = [];
    for (let i = 0; i < 8; i++) {
      const c = await claimDelivery(`fair-w${i}`);
      if (!c) break;
      order.push(c.workspace_id === A ? 'A' : c.workspace_id === B ? 'B' : 'other');
    }
    // Old ordering would hand out A, A, A first. Fair: A, B, A, B, then A is at its cap of 2.
    expect(order).toEqual(['A', 'B', 'A', 'B']);
    const live = await db().query<{ workspace_id: string; n: number }>(
      `SELECT workspace_id, count(*)::int n FROM deliveries WHERE lease_owner IS NOT NULL AND lease_expires_at > now() AND workspace_id = ANY($1::uuid[]) GROUP BY workspace_id`, [[A, B]]);
    expect(Object.fromEntries(live.rows.map((r) => [r.workspace_id === A ? 'A' : 'B', r.n]))).toEqual({ A: 2, B: 2 });
    await db().query(`UPDATE deliveries SET lease_owner=NULL, lease_expires_at=NULL, state='scheduled', phase='idle' WHERE workspace_id = ANY($1::uuid[]) AND lease_owner IS NOT NULL`, [[A, B]]);
    await db().query(`UPDATE deliveries SET next_attempt_at = now() + interval '30 days' WHERE workspace_id = ANY($1::uuid[]) AND state='scheduled'`, [[A, B]]);
  });

  it('concurrent workers never exceed the cap; processing order alternates between workspaces', async () => {
    const A = await dueWorkspace(8, ['facebook', 'telegram', 'x']); // 24 jobs
    await db().query(`UPDATE deliveries SET next_attempt_at = now() - interval '10 minutes' WHERE workspace_id=$1`, [A]);
    const B = await dueWorkspace(4, ['telegram']); // 4 jobs
    await db().query(`UPDATE workspaces SET limits = limits || '{"dispatch_concurrency": 1}'::jsonb WHERE id = ANY($1::uuid[])`, [[A, B]]);
    // 10 workers claim at once: at most 1 live lease per workspace.
    const claims = (await Promise.all(Array.from({ length: 10 }, (_, i) => claimDelivery(`par-${i}`)))).filter(Boolean);
    expect(claims.map((c) => (c!.workspace_id === A ? 'A' : 'B')).sort()).toEqual(['A', 'B']);
    const world = scriptedWorld();
    for (const c of claims) await processDelivery(world.deps, c!);
    // Drain one at a time (fresh claims): B's 4 jobs are all served within the first 8 dispatches.
    const served: string[] = [];
    for (let i = 0; i < 40; i++) {
      const c = await claimDelivery('drain');
      if (!c) break;
      served.push(c.workspace_id === A ? 'A' : 'B');
      await processDelivery(world.deps, c);
    }
    // Round-robin: strict alternation while both have work, so B's remaining 3 jobs are in the first 6.
    for (let i = 1; i < 6; i++) expect(served[i]).not.toBe(served[i - 1]);
    expect(served.slice(0, 6).filter((x) => x === 'B')).toHaveLength(3);
    const done = await db().query(`SELECT count(*)::int n FROM deliveries WHERE workspace_id = ANY($1::uuid[]) AND state='published'`, [[A, B]]);
    expect(done.rows[0].n).toBe(28); // per-connection serialization and caps never lose work
  });
});

// ====================================================================== readiness + duplicates
describe('publishing readiness preflight', () => {
  let t: Awaited<ReturnType<typeof fixture>>;
  let conns: Awaited<ReturnType<typeof seedConnections>>;
  beforeAll(async () => {
    t = await fixture();
    conns = await seedConnections(t.ws, t.brandA);
  });

  const at = (minutes: number) => toLocalInput(new Date(Date.now() + minutes * 60_000), 'Europe/London');

  it('returns pass/fail reasons: permission, tokens, scopes, media, deadline, approval, provider limits, budget', async () => {
    const ctx = await t.owner.ctx();
    const img = await seedReadyImage(t.ws, t.brandA);
    await db().query(`UPDATE assets SET status='quarantined' WHERE id=$1`, [img]);
    const { id } = await createPost(ctx, t.brandA, { draft: draftFor('Readiness check', [conns.facebook, conns.telegram], [img]) }, randomUUID());
    // healthy => only media (processing image) fails
    let r = await readiness(ctx, id, { mode: 'schedule', connection_ids: [conns.facebook, conns.telegram], input_local_time: at(120), timezone: 'Europe/London' });
    expect(new Set(r.checks.filter((c) => c.status === 'fail').map((c) => c.key))).toEqual(new Set(['media']));
    expect(r.checks.filter((c) => c.key === 'media').map((c) => c.message).join(' ')).toMatch(/processing|not ready/i);
    await db().query(`UPDATE assets SET status='ready' WHERE id=$1`, [img]);
    r = await readiness(ctx, id, { mode: 'schedule', connection_ids: [conns.facebook, conns.telegram], input_local_time: at(120), timezone: 'Europe/London' });
    expect(r.ready).toBe(true);
    expect(r.resolved?.due_at).toBeTruthy();

    // tokens / scopes
    await db().query(`UPDATE connections SET status='missing_permission', health_detail='{"message":"x","missing_permissions":["pages_manage_posts"]}' WHERE id=$1`, [conns.facebook]);
    await db().query(`UPDATE connections SET disconnected_at=now(), status='disconnected' WHERE id=$1`, [conns.telegram]);
    r = await readiness(ctx, id, { mode: 'schedule', connection_ids: [conns.facebook, conns.telegram], input_local_time: at(120), timezone: 'Europe/London' });
    const tokens = r.checks.filter((c) => c.key === 'tokens' && c.status === 'fail');
    expect(tokens.map((c) => c.connection_id).sort()).toEqual([conns.facebook, conns.telegram].sort());
    expect(tokens.find((c) => c.connection_id === conns.facebook)!.message).toMatch(/pages_manage_posts/);
    expect(tokens.find((c) => c.connection_id === conns.telegram)!.fix).toMatch(/Reconnect|token/);
    await db().query(`UPDATE connections SET status='ready', health_detail='{}', disconnected_at=NULL WHERE id = ANY($1::uuid[])`, [[conns.facebook, conns.telegram]]);

    // deadline in the past
    r = await readiness(ctx, id, { mode: 'schedule', connection_ids: [conns.facebook], input_local_time: at(-180), timezone: 'Europe/London' });
    expect(r.checks.find((c) => c.key === 'deadline')).toMatchObject({ status: 'fail', message: expect.stringMatching(/past/) });
  });

  it('permission via the V2 policy: editor cannot schedule, publisher can, MFA-less publisher is told to verify', async () => {
    const editor = await member(t.ws, [{ role: 'editor', brandId: t.brandA }]);
    const publisher = await member(t.ws, [{ role: 'publisher', brandId: t.brandA }, { role: 'editor', brandId: t.brandA }]);
    const { id } = await createPost(await editor.ctx(), t.brandA, { draft: draftFor('Who may schedule', [conns.x]) }, randomUUID());
    const req = { mode: 'schedule', connection_ids: [conns.x], input_local_time: at(90), timezone: 'Europe/London' };
    const e = await readiness(await editor.ctx(), id, req);
    expect(e.ready).toBe(false);
    expect(e.checks.find((c) => c.key === 'permission')).toMatchObject({ status: 'fail', message: expect.stringMatching(/permission/) });
    const p = await readiness(await publisher.ctx(), id, req);
    expect(p.checks.find((c) => c.key === 'permission')!.status).toBe('pass');
    const noMfa = await v2Ctx(publisher.id, t.ws, { mfaVerified: false });
    const m = await readiness(noMfa, id, req);
    expect(m.checks.find((c) => c.key === 'permission')).toMatchObject({ status: 'fail', message: expect.stringMatching(/MFA|second factor/) });
    // another brand's post is invisible to a brand-A-only member
    const other = await createPost(await t.owner.ctx(), t.brandB, { draft: draftFor('B only', []) }, randomUUID());
    await expect(readiness(await editor.ctx(), other.id, req)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('approval policy, provider limit and X budget reasons', async () => {
    const ctx = await t.owner.ctx();
    const brandR = await createBrand(t.ws, 'Reviewed', { approvalRequired: true });
    const rc = await seedConnections(t.ws, brandR);
    const { id } = await createPost(ctx, brandR, { draft: draftFor('Needs review', [rc.telegram]) }, randomUUID());
    const r = await readiness(ctx, id, { mode: 'schedule', connection_ids: [rc.telegram], input_local_time: at(60), timezone: 'Europe/London' });
    expect(r.checks.find((c) => c.key === 'approval')).toMatchObject({ status: 'fail', fix: expect.stringMatching(/Submit for review/) });
    const s = await readiness(ctx, id, { mode: 'submit', connection_ids: [rc.telegram], input_local_time: at(60), timezone: 'Europe/London' });
    expect(s.checks.find((c) => c.key === 'approval')!.status).toBe('pass');

    // Telegram: 20 messages / minute — 20 already queued in the same minute
    for (let i = 0; i < 20; i++) {
      const p = await createPost(ctx, t.brandA, { draft: draftFor(`Flood ${i} ${randomUUID()}`, [conns.telegram]) }, randomUUID());
      await schedulePost(ctx, p.id, { expected_version: 1, connection_ids: [conns.telegram], input_local_time: at(300), timezone: 'Europe/London' }, randomUUID());
    }
    const q = await createPost(ctx, t.brandA, { draft: draftFor('One more', [conns.telegram]) }, randomUUID());
    const lim = await readiness(ctx, q.id, { mode: 'schedule', connection_ids: [conns.telegram], input_local_time: at(300), timezone: 'Europe/London' });
    expect(lim.checks.find((c) => c.key === 'provider_limits')).toMatchObject({ status: 'fail', connection_id: conns.telegram, message: expect.stringMatching(/20 messages per minute/) });

    // live X with the post budget used up
    const liveX = (await db().query<{ id: string }>(
      `INSERT INTO connections(workspace_id, brand_id, provider, provider_account_id, display_name, status, is_mock, capabilities)
       SELECT workspace_id, brand_id, 'x', '777000', 'Live X', 'ready', false, capabilities FROM connections WHERE id=$1 RETURNING id`, [conns.x])).rows[0]!.id;
    await db().query(`UPDATE workspaces SET limits = limits || '{"x_monthly_writes": 1}'::jsonb WHERE id=$1`, [t.ws]);
    await withTx((tx) => checkAndConsumeBudget(tx, t.ws, 'x.write', 1));
    const xp = await createPost(ctx, t.brandA, { draft: draftFor('X post', [liveX]) }, randomUUID());
    const b = await readiness(ctx, xp.id, { mode: 'publish', connection_ids: [liveX] });
    expect(b.checks.find((c) => c.key === 'budget')).toMatchObject({ status: 'fail', message: expect.stringMatching(/X post budget/) });
  });
});

describe('duplicate / collision warning', () => {
  it('flags similar text or same media to the same destination inside the brand window; never blocks', async () => {
    const t = await fixture();
    const conns = await seedConnections(t.ws, t.brandA);
    const ctx = await t.owner.ctx();
    const due = (m: number) => toLocalInput(new Date(Date.now() + m * 60_000), 'Europe/London');
    const p1 = await createPost(ctx, t.brandA, { draft: draftFor('Big launch today! Read more at https://example.com/launch?utm=1', [conns.facebook, conns.telegram]) }, randomUUID());
    await schedulePost(ctx, p1.id, { expected_version: 1, connection_ids: [conns.facebook], input_local_time: due(180), timezone: 'Europe/London' }, randomUUID());
    const p2 = await createPost(ctx, t.brandA, { draft: draftFor('Big launch today!! Read more at https://example.com/launch', [conns.facebook, conns.telegram]) }, randomUUID());
    const req = (m: number, ids = [conns.facebook]) => ({ mode: 'schedule', connection_ids: ids, input_local_time: due(m), timezone: 'Europe/London' });

    let r = await readiness(ctx, p2.id, req(300)); // 2 h later, default window 24 h
    expect(r.needs_acknowledgement).toBe(true);
    expect(r.ready).toBe(true); // a warning, not a failure
    expect(r.duplicates[0]).toMatchObject({ connection_id: conns.facebook, other_post_id: p1.id, reason: 'similar_text' });
    expect(r.duplicates[0]!.similarity).toBeGreaterThanOrEqual(0.8);
    // a different destination is not a collision
    r = await readiness(ctx, p2.id, req(300, [conns.telegram]));
    expect(r.duplicates).toEqual([]);
    // window is configurable per brand (brands.manage); outside the window => no warning; 0 => off
    await setDuplicateWindow(ctx, t.brandA, { duplicate_window_hours: 1 });
    expect((await readiness(ctx, p2.id, req(300))).duplicates).toEqual([]);
    expect((await readiness(ctx, p2.id, req(200))).duplicates).toHaveLength(1);
    await setDuplicateWindow(ctx, t.brandA, { duplicate_window_hours: 0 });
    expect((await readiness(ctx, p2.id, req(200))).checks.find((c) => c.key === 'duplicates')!.message).toMatch(/off/);
    await setDuplicateWindow(ctx, t.brandA, { duplicate_window_hours: 24 });
    // same media, different words => flagged as same media (byte-identical re-upload counts too)
    const img = await seedReadyImage(t.ws, t.brandA);
    const copy = await seedReadyImage(t.ws, t.brandA); // same checksum 'x'
    const p3 = await createPost(ctx, t.brandA, { draft: draftFor('Photo of the day', [conns.telegram], [img]) }, randomUUID());
    await schedulePost(ctx, p3.id, { expected_version: 1, connection_ids: [conns.telegram], input_local_time: due(120), timezone: 'Europe/London' }, randomUUID());
    const p4 = await createPost(ctx, t.brandA, { draft: draftFor('Completely different caption', [conns.telegram], [copy]) }, randomUUID());
    const m = await readiness(ctx, p4.id, req(150, [conns.telegram]));
    expect(m.duplicates[0]).toMatchObject({ other_post_id: p3.id, same_media: true, reason: 'same_media' });
    // never blocks: scheduling the duplicate succeeds (idempotency is a separate, per-delivery guarantee)
    const s = await schedulePost(ctx, p2.id, { expected_version: 1, connection_ids: [conns.facebook], input_local_time: due(300), timezone: 'Europe/London' }, randomUUID());
    expect(s.status).toBe(202);
    // editors cannot change the window
    const editor = await member(t.ws, [{ role: 'editor', brandId: t.brandA }]);
    await expect(setDuplicateWindow(await editor.ctx(), t.brandA, { duplicate_window_hours: 5 })).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('similarity is robust to punctuation/case/tracking params and low for unrelated text', () => {
    expect(textSimilarity('Hello World! https://a.com/x?utm=1', 'hello world https://a.com/x')).toBeGreaterThan(0.9);
    expect(textSimilarity('Quarterly results are out', 'Join our webinar on Friday')).toBeLessThan(0.3);
  });
});

// ====================================================================== account health centre
describe('account health centre', () => {
  it('explains each problem with its fix and the affected upcoming schedules, scoped to visible brands', async () => {
    const t = await fixture();
    const a = await seedConnections(t.ws, t.brandA);
    const b = await seedConnections(t.ws, t.brandB);
    const ctx = await t.owner.ctx();
    const due = toLocalInput(new Date(Date.now() + 3 * 3600_000), 'Europe/London');
    const post = await createPost(ctx, t.brandA, { draft: draftFor('Affected post', [a.facebook, a.x]) }, randomUUID());
    await schedulePost(ctx, post.id, { expected_version: 1, connection_ids: [a.facebook, a.x], input_local_time: due, timezone: 'Europe/London' }, randomUUID());
    await db().query(`UPDATE connections SET status='missing_permission', health_detail='{"message":"m","missing_permissions":["pages_manage_posts"]}' WHERE id=$1`, [a.facebook]);
    await db().query(`UPDATE connections SET throttled_until = now() + interval '20 minutes' WHERE id=$1`, [a.x]);
    await db().query(`UPDATE connections SET status='reconnect_required', health_detail='{"message":"Token revoked"}' WHERE id=$1`, [a.telegram]);
    await db().query(`UPDATE connections SET paused=true WHERE id=$1`, [b.instagram]);

    const h = await accountHealth(ctx);
    const byId = (id: string) => h.items.find((i) => i.connection.id === id)!;
    expect(byId(a.facebook)).toMatchObject({ state: 'critical', issues: [expect.objectContaining({ code: 'missing_scope', fix: expect.objectContaining({ action: 'reconnect', allowed: true }) })] });
    expect(byId(a.facebook).issues[0]!.detail).toMatch(/pages_manage_posts/);
    expect(byId(a.facebook).affected.count).toBe(1);
    expect(byId(a.facebook).affected.schedules![0]).toMatchObject({ post_id: post.id, title: null, excerpt: 'Affected post' });
    expect(byId(a.x).issues.map((i) => i.code)).toEqual(['throttled']);
    expect(byId(a.telegram).issues[0]).toMatchObject({ code: 'revoked', fix: expect.objectContaining({ how: expect.stringMatching(/BotFather/) }) });
    expect(byId(b.instagram).issues[0]!.code).toBe('paused');
    expect(h.summary).toMatchObject({ critical: 2, affected_schedules: 1 });

    // a brand-A analyst: sees only brand A, cannot fix (who = owner/admin)
    const analyst = await member(t.ws, [{ role: 'analyst', brandId: t.brandA }]);
    const ha = await accountHealth(await analyst.ctx());
    expect(new Set(ha.items.map((i) => i.connection.brand_id))).toEqual(new Set([t.brandA]));
    expect(ha.items.find((i) => i.connection.id === a.facebook)!.issues[0]!.fix).toMatchObject({ allowed: false, who: 'An owner or admin' });
    // content.read restricted on brand A => counts only, no titles/excerpts
    await db().query(`INSERT INTO access_restrictions(workspace_id, user_id, brand_id, actions) VALUES ($1,$2,$3,'{content.read}')`, [t.ws, analyst.id, t.brandA]);
    const hr = await accountHealth(await analyst.ctx());
    expect(hr.items.find((i) => i.connection.id === a.facebook)!.affected).toEqual({ count: 1, schedules: null });
    // another workspace never appears
    const other = await fixture();
    const oc = await seedConnections(other.ws, other.brandA);
    expect((await accountHealth(ctx)).items.some((i) => i.connection.id === oc.facebook)).toBe(false);
  });
});

// ====================================================================== activity centre
describe('activity / security centre', () => {
  it('filters by category/brand/actor with cursor pagination, respects audit.read and brand restrictions', async () => {
    const t = await fixture();
    const admin = await member(t.ws, [{ role: 'admin' }]);
    const editor = await member(t.ws, [{ role: 'editor' }]);
    const W = t.ws;
    const ev = (action: string, brandId: string | null = null, actor: string = t.owner.id) =>
      audit(db(), { workspaceId: W, brandId, actorUserId: actor, action, resourceType: action.split('.')[0]!, resourceId: randomUUID(), diff: { note: action } });
    await ev('member.updated'); await ev('grant.created'); await ev('connection.disconnected', t.brandA); await ev('connection.created', t.brandB);
    await ev('schedule.created', t.brandA, admin.id); await ev('approval.approved', t.brandB); await ev('session.revoked'); await ev('asset.uploaded', t.brandA);
    const other = await fixture();
    await audit(db(), { workspaceId: other.ws, action: 'connection.disconnected', resourceType: 'connection' });

    const ctx = await t.owner.ctx();
    const all = await listActivity(ctx, {});
    expect(all.items.map((i) => i.action)).toEqual(['asset.uploaded', 'session.revoked', 'approval.approved', 'schedule.created', 'connection.created', 'connection.disconnected', 'grant.created', 'member.updated']);
    expect(all.can_export).toBe(true);
    expect((await listActivity(ctx, { category: 'permissions' })).items.map((i) => i.action)).toEqual(['grant.created', 'member.updated']);
    expect((await listActivity(ctx, { category: 'connections' })).items).toHaveLength(2);
    expect((await listActivity(ctx, { category: 'publishing' })).items.map((i) => i.action)).toEqual(['approval.approved', 'schedule.created']);
    expect((await listActivity(ctx, { category: 'security' })).items.map((i) => i.action)).toEqual(['session.revoked']);
    expect((await listActivity(ctx, { brand_id: t.brandA })).items).toHaveLength(3);
    expect((await listActivity(ctx, { actor_user_id: admin.id })).items.map((i) => i.action)).toEqual(['schedule.created']);
    const p1 = await listActivity(ctx, { limit: 3 });
    expect(p1.items).toHaveLength(3);
    const p2 = await listActivity(ctx, { limit: 3, cursor: p1.next_cursor });
    expect(p2.items[0]!.action).toBe('schedule.created');
    // denied: no audit.read
    await expect(listActivity(await editor.ctx(), {})).rejects.toMatchObject({ code: 'forbidden' });
    // admin restricted from audit.read on brand B: brand-B events disappear, filtering on B is 404
    await db().query(`INSERT INTO access_restrictions(workspace_id, user_id, brand_id, actions) VALUES ($1,$2,$3,'{audit.read}')`, [W, admin.id, t.brandB]);
    const ar = await listActivity(await admin.ctx(), {});
    expect(ar.items.some((i) => i.brand_id === t.brandB)).toBe(false);
    expect(ar.items).toHaveLength(6);
    await expect(listActivity(await admin.ctx(), { brand_id: t.brandB })).rejects.toMatchObject({ code: 'not_found' });
    // a brand outside the workspace returns nothing
    expect((await listActivity(ctx, { brand_id: other.brandA })).items).toEqual([]);
  });

  it('export needs exports.create + audit.read, is CSV-injection safe, audited and budgeted', async () => {
    const t = await fixture();
    const evil = await createBrand(t.ws, '=HYPERLINK("http://evil","x")');
    await audit(db(), { workspaceId: t.ws, brandId: evil, actorUserId: t.owner.id, action: 'connection.created', resourceType: 'connection', diff: { name: '+SUM(1)' } });
    const { csv, rows } = await activityCsv(await t.owner.ctx(), { category: 'connections' });
    expect(rows).toBe(1);
    expect(csv).toContain(`"'=HYPERLINK(""http://evil"",""x"")"`);
    expect(csv.split('\r\n')[1]).not.toMatch(/,=|,\+|,-|,@/);
    const a = await db().query(`SELECT diff FROM audit_events WHERE workspace_id=$1 AND action='export.activity'`, [t.ws]);
    expect(a.rows[0].diff).toMatchObject({ rows: 1 });
    expect((await counter(t.ws, 'exports.count')).used).toBe(1);
    // admin with exports.create restricted can read but not export
    const admin = await member(t.ws, [{ role: 'admin' }]);
    await db().query(`INSERT INTO access_restrictions(workspace_id, user_id, actions) VALUES ($1,$2,'{exports.create}')`, [t.ws, admin.id]);
    expect((await listActivity(await admin.ctx(), {})).can_export).toBe(false);
    await expect(activityCsv(await admin.ctx(), {})).rejects.toMatchObject({ code: 'forbidden' });
    // exporter-only (no audit.read) cannot export the activity log
    const exporter = await member(t.ws, [{ role: 'exporter' }]);
    await expect(activityCsv(await exporter.ctx(), {})).rejects.toMatchObject({ code: 'forbidden' });
    // budget exhausted => 402, nothing exported
    await db().query(`UPDATE workspaces SET limits = limits || '{"monthly_exports": 1}'::jsonb WHERE id=$1`, [t.ws]);
    await expect(activityCsv(await t.owner.ctx(), {})).rejects.toMatchObject({ code: 'budget_exhausted' });
  });
});

// ====================================================================== client handover export
describe('client handover export', () => {
  it('exports one brand (content, revisions, history, signed asset links) and nothing else; audited', async () => {
    const t = await fixture();
    const a = await seedConnections(t.ws, t.brandA);
    const b = await seedConnections(t.ws, t.brandB);
    const ctx = await t.owner.ctx();
    const img = await seedReadyImage(t.ws, t.brandA);
    const pa = await createPost(ctx, t.brandA, { title: 'Brand A launch', draft: draftFor('Brand A launch post', [a.telegram], [img]) }, randomUUID());
    await publishNow(ctx, pa.id, { expected_version: 1, connection_ids: [a.telegram] }, randomUUID());
    const pb = await createPost(ctx, t.brandB, { title: 'SECRET brand B', draft: draftFor('Brand B secret text', [b.telegram]) }, randomUUID());
    await publishNow(ctx, pb.id, { expected_version: 1, connection_ids: [b.telegram] }, randomUUID());

    const out = await handoverExport(ctx, t.brandA, { format: 'zip' });
    expect(out.contentType).toBe('application/zip');
    const files = unzip(out.body);
    expect(Object.keys(files).sort()).toEqual(['README.txt', 'assets.csv', 'assets.json', 'deliveries.csv', 'deliveries.json', 'manifest.json', 'posts.csv', 'posts.json', 'revisions.csv']);
    const manifest = JSON.parse(files['manifest.json']!.toString());
    expect(manifest).toMatchObject({ brand: { id: t.brandA }, counts: { posts: 1, revisions: 1, deliveries: 1, assets: 1 }, download_links: { ttl_seconds: 900 } });
    const posts = JSON.parse(files['posts.json']!.toString());
    expect(posts[0]).toMatchObject({ id: pa.id, title: 'Brand A launch', revisions: [expect.objectContaining({ revision: 1, text: 'Brand A launch post' })] });
    const assets = JSON.parse(files['assets.json']!.toString());
    expect(assets[0].download_url).toMatch(/X-Amz-Expires=900/);
    const everything = Object.values(files).map((f) => f.toString()).join('\n');
    expect(everything).not.toContain('SECRET');
    expect(everything).not.toContain(pb.id);
    expect(everything).not.toMatch(/encrypted_blob|access_token|refresh_token/);
    const json = await handoverExport(ctx, t.brandA, { format: 'json' });
    expect(JSON.parse(json.body.toString())).toMatchObject({ manifest: { brand: { id: t.brandA } }, csv: { 'posts.csv': expect.stringContaining('post_id') } });
    const audited = await db().query(`SELECT brand_id, diff FROM audit_events WHERE workspace_id=$1 AND action='export.handover'`, [t.ws]);
    expect(audited.rows).toHaveLength(2);
    expect(audited.rows[0].brand_id).toBe(t.brandA);
  });

  it('requires exports.create on that brand; cross-brand / cross-workspace is denied; rate-limited', async () => {
    const t = await fixture();
    const other = await fixture();
    const exporterA = await member(t.ws, [{ role: 'exporter', brandId: t.brandA }]);
    const editorA = await member(t.ws, [{ role: 'editor', brandId: t.brandA }]);
    await expect(handoverExport(await exporterA.ctx(), t.brandA, {})).resolves.toMatchObject({ contentType: 'application/zip' });
    await expect(handoverExport(await exporterA.ctx(), t.brandB, {})).rejects.toMatchObject({ code: 'not_found' });
    await expect(handoverExport(await editorA.ctx(), t.brandA, {})).rejects.toMatchObject({ code: 'forbidden' });
    await expect(handoverExport(await t.owner.ctx(), other.brandA, {})).rejects.toMatchObject({ code: 'not_found' });
    await expect(handoverExport(await v2Ctx(t.owner.id, t.ws, { mfaVerified: false }), t.brandA, {})).rejects.toMatchObject({ code: 'mfa_required' });
    // 3 per hour per user
    await handoverExport(await exporterA.ctx(), t.brandA, {});
    await handoverExport(await exporterA.ctx(), t.brandA, {});
    await expect(handoverExport(await exporterA.ctx(), t.brandA, {})).rejects.toMatchObject({ code: 'rate_limited' });
    expect((await counter(t.ws, 'exports.count')).used).toBe(3);
  });
});
