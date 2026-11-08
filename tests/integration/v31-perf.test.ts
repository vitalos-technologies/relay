// V3.1 PERF integration tests (real PostgreSQL, real policy path via v2Ctx):
//  - per-provider dispatch cap is exact under concurrent claimers and never trades duplicate prevention;
//  - batched approval inbox: same eligibility, and a revoked approver loses can_decide immediately (no cached authority);
//  - planner/dashboard bounds are explicit (truncated flags), posts list summaries are tenant-scoped;
//  - workload samples: recorded by the runner, reported per workspace only, permission-gated.
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { approvalInbox, claimDelivery, createPost, listPosts, processDelivery, publishNow, submitForReview, type Ctx } from '@social-lite/services';
import { dashboard, planner } from '@social-lite/services/readmodels';
import { SampleRecorder, WorkloadRunner } from '@social-lite/services/workload/runner';
import { workloadPolicies } from '@social-lite/services/workload/policy';
import { workloadStats } from '@social-lite/services/workload/stats';
import { addMember, closeTestPool, createBrand, createUser, createWorkspace, grant, testPool, v2Ctx } from './helpers.js';
import { scriptedWorld, seedConnections } from './engine-helpers.js';

const db = () => testPool();
beforeAll(() => { testPool(); });
afterAll(closeTestPool);

const draftFor = (text: string, ids: string[]) => ({ baseText: text, baseLink: null, baseAssetIds: [] as string[], variants: ids.map((connectionId) => ({ connectionId, inheritText: true, inheritMedia: true })) });

async function ownerWorld(name = 'Perf') {
  const ws = await createWorkspace(name);
  const brand = await createBrand(ws, `${name} brand`);
  const owner = await createUser();
  await addMember(ws, owner.id, 'owner');
  const conns = await seedConnections(ws, brand);
  return { ws, brand, owner, conns, ctx: () => v2Ctx(owner.id, ws) };
}

describe('per-provider dispatch cap', () => {
  afterEach(() => { delete process.env.DISPATCH_PROVIDER_CONCURRENCY_X; });
  beforeAll(async () => {
    await db().query(`UPDATE deliveries SET next_attempt_at = now() + interval '30 days' WHERE state IN ('scheduled','retry_wait','processing') AND next_attempt_at <= now()`);
  });

  it('never exceeds the provider cap across workspaces with concurrent claimers; other providers keep flowing; no duplicate sends', async () => {
    process.env.DISPATCH_PROVIDER_CONCURRENCY_X = '1';
    const worlds = [await ownerWorld('ProvA'), await ownerWorld('ProvB')];
    for (const w of worlds) {
      const ctx = await w.ctx();
      for (let i = 0; i < 2; i++) {
        const ids = [w.conns.x, w.conns.facebook];
        const { id } = await createPost(ctx, w.brand, { draft: draftFor(`Cap ${i} ${randomUUID()}`, ids) }, randomUUID());
        await publishNow(ctx, id, { expected_version: 1, connection_ids: ids }, randomUUID());
      }
    }
    const wsIds = worlds.map((w) => w.ws);
    const claims = (await Promise.all(Array.from({ length: 8 }, (_, i) => claimDelivery(`cap-${i}`)))).filter((c) => c && wsIds.includes(c.workspace_id));
    const byProvider = claims.reduce<Record<string, number>>((a, c) => ({ ...a, [c!.provider]: (a[c!.provider] ?? 0) + 1 }), {});
    expect(byProvider.x).toBe(1); // cap 1 although two workspaces have due X work on idle connections
    expect(byProvider.facebook).toBeGreaterThanOrEqual(1); // other providers are not blocked by X's cap
    const live = await db().query<{ n: number }>(`SELECT count(*)::int n FROM deliveries WHERE provider='x' AND lease_owner IS NOT NULL AND lease_expires_at > now()`);
    expect(live.rows[0]!.n).toBe(1);
    // Drain everything: X never overlaps, and nothing is sent twice.
    const world = scriptedWorld();
    for (const c of claims) await processDelivery(world.deps, c!);
    for (let i = 0; i < 20; i++) { const c = await claimDelivery('cap-drain'); if (!c) break; await processDelivery(world.deps, c); }
    const states = await db().query<{ state: string; n: number }>(`SELECT state, count(*)::int n FROM deliveries WHERE workspace_id = ANY($1::uuid[]) GROUP BY state`, [wsIds]);
    expect(states.rows).toEqual([{ state: 'published', n: 8 }]);
    const dup = await db().query<{ n: number }>(`SELECT count(*)::int n FROM (SELECT delivery_id FROM delivery_attempts a JOIN deliveries d ON d.id=a.delivery_id
      WHERE d.workspace_id = ANY($1::uuid[]) AND a.phase='sending' GROUP BY delivery_id HAVING count(*) > 1) x`, [wsIds]);
    expect(dup.rows[0]!.n).toBe(0);
  });
});

describe('approval inbox (batched) and revocation', () => {
  it('reflects current authority on every request: a revoked approver loses can_decide at once, even with an old context', async () => {
    const ws = await createWorkspace('Inbox');
    const brand = await createBrand(ws, 'Reviewed', { approvalRequired: true });
    const owner = await createUser();
    await addMember(ws, owner.id, 'owner');
    const editor = await createUser();
    await db().query(`INSERT INTO memberships(workspace_id, user_id, role) VALUES ($1,$2,'viewer')`, [ws, editor.id]);
    await grant(ws, editor.id, 'editor', brand);
    const approver = await createUser();
    await db().query(`INSERT INTO memberships(workspace_id, user_id, role) VALUES ($1,$2,'viewer')`, [ws, approver.id]);
    const g = await grant(ws, approver.id, 'approver', brand);
    const conns = await seedConnections(ws, brand);
    const ectx = await v2Ctx(editor.id, ws);
    for (let i = 0; i < 3; i++) {
      const { id } = await createPost(ectx, brand, { draft: draftFor(`Review me ${i}`, [conns.facebook]) }, randomUUID());
      await submitForReview(ectx, id, { expected_version: 1, connection_ids: [conns.facebook] }, randomUUID());
    }
    const actx: Ctx = await v2Ctx(approver.id, ws);
    const before = await approvalInbox(actx);
    expect(before.items).toHaveLength(3);
    expect(before.items.every((i) => i.can_decide)).toBe(true);
    // The editor cannot decide their own work's review (role not eligible) — same answer as the unbatched path.
    expect((await approvalInbox(ectx)).items.every((i) => !i.can_decide)).toBe(true);
    await db().query(`UPDATE scoped_role_grants SET revoked_at=now() WHERE id=$1`, [g]);
    await db().query(`UPDATE workspaces SET policy_version = policy_version + 1 WHERE id=$1`, [ws]);
    const after = await approvalInbox(actx); // stale request context: eligibility is still re-read from the database
    expect(after.items.every((i) => !i.can_decide)).toBe(true);
  });
});

describe('bounded read models', () => {
  it('planner reports truncation instead of silently cutting; dashboard bounds today; posts summaries stay in the workspace', async () => {
    const w = await ownerWorld('Bounds');
    const ctx = await w.ctx();
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const { id } = await createPost(ctx, w.brand, { draft: draftFor(`Bound ${i}`, [w.conns.facebook]) }, randomUUID());
      await publishNow(ctx, id, { expected_version: 1, connection_ids: [w.conns.facebook] }, randomUUID());
      ids.push(id);
    }
    const from = new Date(Date.now() - 3600_000).toISOString(); const to = new Date(Date.now() + 3600_000).toISOString();
    const all = await planner(ctx, { from, to });
    expect(all).toMatchObject({ truncated: false });
    expect(all.items).toHaveLength(3);
    const two = await planner(ctx, { from, to, limit: 2 });
    expect(two.items).toHaveLength(2);
    expect(two.truncated).toBe(true);
    const d = await dashboard(ctx, {});
    expect(d.today_truncated).toBe(false);
    expect(d.today).toHaveLength(3);
    const list = await listPosts(ctx, w.brand, {});
    expect(list.items.map((p) => p.status).sort()).toEqual(['scheduled', 'scheduled', 'scheduled']);
    expect(list.items.every((p) => p.destinations.length === 1 && p.destinations[0]!.connection_id === w.conns.facebook)).toBe(true);
    await db().query(`UPDATE deliveries SET next_attempt_at = now() + interval '30 days' WHERE workspace_id=$1`, [w.ws]);
  });
});

describe('workload samples', () => {
  it('records dispatch delay / processing / provider time per class and reports only the caller workspace', async () => {
    const a = await ownerWorld('SamplesA');
    const b = await ownerWorld('SamplesB');
    const recorder = new SampleRecorder(() => db());
    const runner = new WorkloadRunner({ workerId: 'test', recorder, policies: workloadPolicies({}) });
    const eligible = new Date(Date.now() - 1500);
    await runner.publishing({ workspaceId: a.ws, provider: 'x', eligibleAt: eligible }, async () => undefined);
    await runner.run('report_export', { workspaceId: a.ws, queue: 'report-export' }, async () => new Promise((r) => setTimeout(r, 20)));
    await expect(runner.run('video', { workspaceId: a.ws }, async () => { throw new Error('transcode failed'); })).rejects.toThrow();
    await runner.run('video', { workspaceId: b.ws }, async () => undefined);
    expect(await recorder.flush()).toBe(4);
    const stats = await workloadStats(await a.ctx(), { window_minutes: 30 });
    const by = Object.fromEntries(stats.classes.map((c) => [c.class, c]));
    expect(by.publishing!.finished).toBe(1);
    expect(by.publishing!.dispatch_delay.p50_ms).toBeGreaterThanOrEqual(1400);
    expect(by.publishing!.provider).not.toBeNull(); // instrumented
    expect(by.report_export!.provider).toBeNull(); // not instrumented → null, never 0
    expect(by.report_export!.processing.p50_ms).toBeGreaterThanOrEqual(15);
    expect(by.video).toMatchObject({ finished: 1, failed: 1 }); // workspace B's video item is not counted
    expect(stats.queues[0]).toMatchObject({ queue: 'deliveries', class: 'publishing' });
    expect(stats.policies.find((p) => p.class === 'publishing')!.pool).toBe('main');
    // diagnostics.read is required (an editor cannot read operations data).
    const editor = await createUser();
    await db().query(`INSERT INTO memberships(workspace_id, user_id, role) VALUES ($1,$2,'viewer')`, [a.ws, editor.id]);
    await grant(a.ws, editor.id, 'editor', a.brand);
    await expect(workloadStats(await v2Ctx(editor.id, a.ws))).rejects.toMatchObject({ code: 'forbidden' });
  });
});
