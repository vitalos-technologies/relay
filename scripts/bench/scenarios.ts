// Benchmark scenarios: the server-side work behind the core pages and the worker hot paths, called through the same
// service functions the API routes call (route() → loadAccess → service). Excludes Next.js routing, cookie/session
// lookup and HTTP serialisation (measured separately by the UI stream in the browser).
import { randomUUID } from 'node:crypto';
import { toLocalInput, type Provider, type PublishingAdapter } from '@social-lite/core';
import type { Pool } from '@social-lite/db';
import {
  approvalInbox, claimDelivery, createPost, decoratePlannerItems, getPostDetail, listPosts, loadAccess, processDelivery, schedulePost, type Ctx, type EngineDeps,
} from '@social-lite/services';
import { dashboard, history, ops, planner } from '@social-lite/services/readmodels';
import { contentTable, overview } from '@social-lite/services/analytics/query';
import { parseFilters } from '@social-lite/services/analytics/filters';
import { connectMock } from '@social-lite/services/connections/index';
import { liveEngineDeps } from '@social-lite/services/engine/live-deps';
import { dispatchOutbox } from '@social-lite/services/engine/outbox-dispatcher';
import type { GeneratedWorkspace } from './generate.js';

export interface Scenario { name: string; group: 'page' | 'worker'; run(i: number): Promise<unknown> }

export async function ctxFor(pool: Pool, userId: string, ws: string): Promise<Ctx> {
  const access = await loadAccess(userId, ws, pool, { mfaVerified: true, authTime: new Date().toISOString() });
  if (!access) throw new Error('bench user has no access');
  return { actor: { userId, email: 'bench@bench.relay.test', name: 'Bench', sessionId: randomUUID() }, access, correlationId: 'bench' };
}

const iso = (ms: number) => new Date(Date.now() + ms).toISOString();
const DAY = 86_400_000;

export async function pageScenarios(pool: Pool, w: GeneratedWorkspace, opts: { analyticsDataset: boolean }): Promise<Scenario[]> {
  const owner = await ctxFor(pool, w.ownerId, w.workspaceId);
  const editor = await ctxFor(pool, w.editorId, w.workspaceId);
  const brand0 = w.brandIds[0]!;
  const sample = (await pool.query<{ id: string }>(`SELECT id FROM posts WHERE workspace_id=$1 ORDER BY md5(id::text) LIMIT 40`, [w.workspaceId])).rows.map((r) => r.id);
  // Deep cursors (followed once during setup, then requested repeatedly).
  let postsCursor: string | undefined;
  for (let p = 0; p < 4; p++) postsCursor = (await listPosts(owner, brand0, { cursor: postsCursor, limit: 30 })).next_cursor ?? postsCursor;
  let histCursor: string | undefined;
  for (let p = 0; p < 20; p++) histCursor = (await history(owner, { cursor: histCursor, limit: 50 })).next_cursor ?? histCursor;

  const plannerRoute = async (ctx: Ctx, q: Parameters<typeof planner>[1]) => { const r = await planner(ctx, q); return { ...r, items: await decoratePlannerItems(ctx, r.items) }; };
  const list: Scenario[] = [
    { name: 'request.context (loadAccess)', group: 'page', run: () => loadAccess(w.ownerId, w.workspaceId, pool, { mfaVerified: true, authTime: new Date().toISOString() }) },
    { name: 'planner.week (all brands)', group: 'page', run: () => plannerRoute(owner, { from: iso(-DAY), to: iso(6 * DAY) }) },
    { name: 'planner.month (all brands)', group: 'page', run: () => plannerRoute(owner, { from: iso(-3 * DAY), to: iso(28 * DAY) }) },
    { name: 'planner.month (one brand)', group: 'page', run: () => plannerRoute(owner, { from: iso(-3 * DAY), to: iso(28 * DAY), brand_id: brand0 }) },
    { name: 'planner.month (brand-restricted editor)', group: 'page', run: () => plannerRoute(editor, { from: iso(-3 * DAY), to: iso(28 * DAY) }) },
    { name: 'posts.list (first page)', group: 'page', run: () => listPosts(owner, brand0, { limit: 30 }) },
    { name: 'posts.list (page 5, cursor)', group: 'page', run: () => listPosts(owner, brand0, { limit: 30, cursor: postsCursor }) },
    { name: 'posts.search (q=launch)', group: 'page', run: () => listPosts(owner, brand0, { q: 'launch', limit: 30 }) },
    { name: 'post.detail', group: 'page', run: (i) => getPostDetail(owner, sample[i % sample.length]!) },
    { name: 'dashboard', group: 'page', run: () => dashboard(owner, {}) },
    { name: 'history (first page)', group: 'page', run: () => history(owner, { limit: 50 }) },
    { name: 'history (failed, one brand)', group: 'page', run: () => history(owner, { limit: 50, state: 'failed', brand_id: brand0 }) },
    { name: 'history (page 21, cursor)', group: 'page', run: () => history(owner, { limit: 50, cursor: histCursor }) },
    { name: 'history (brand-restricted editor)', group: 'page', run: () => history(editor, { limit: 50 }) },
    { name: 'approvals (pending)', group: 'page', run: () => approvalInbox(owner, { status: 'pending' }) },
    { name: 'approvals (decided)', group: 'page', run: () => approvalInbox(owner, { status: 'decided' }) },
    { name: 'ops (operations)', group: 'page', run: () => ops(owner) },
  ];
  if (opts.analyticsDataset) {
    const today = new Date().toISOString().slice(0, 10);
    const minus = (d: number) => new Date(Date.now() - d * DAY).toISOString().slice(0, 10);
    const f = (days: number) => ({ ...parseFilters(new URLSearchParams(), { timezone: 'Europe/London' }), from: minus(days - 1), to: today, dataset: 'demo' as const });
    list.push(
      { name: 'analytics.overview (28 d)', group: 'page', run: () => overview(owner, f(28)) },
      { name: 'analytics.overview (365 d)', group: 'page', run: () => overview(owner, f(365)) },
      { name: 'analytics.content (28 d, sort ER)', group: 'page', run: () => contentTable(owner, f(28), { sort: 'engagement_rate' }) },
    );
  }
  return list;
}

/** Times every adapter call (the provider part of processing) so it is reported apart from app time. */
export function instrumentDeps(deps: EngineDeps, sink: { providerMs: number }): EngineDeps {
  return {
    ...deps,
    adapterFor(provider: Provider) {
      const a = deps.adapterFor(provider);
      return new Proxy(a, {
        get(target, prop, recv) {
          const v = Reflect.get(target, prop, recv) as unknown;
          if (typeof v !== 'function') return v;
          return (...args: unknown[]) => {
            const t = performance.now();
            const out = (v as (...x: unknown[]) => unknown).apply(target, args);
            if (out && typeof (out as Promise<unknown>).then === 'function') return (out as Promise<unknown>).finally(() => { sink.providerMs += performance.now() - t; });
            sink.providerMs += performance.now() - t;
            return out;
          };
        },
      }) as PublishingAdapter;
    },
  };
}

export interface DispatchResult {
  claim_ms: number[]; process_ms: number[]; app_process_ms: number[]; provider_ms: number[]; idle_claim_ms: number[]; outbox_batch_ms: number[];
  processed: number; states: Record<string, number>; duplicate_sends: number;
}

/** Claim + process a backlog of due deliveries on simulated destinations (sequential: latency, not throughput). */
export async function dispatchScenario(pool: Pool, w: GeneratedWorkspace, backlog: number, samples: number): Promise<DispatchResult> {
  const ctx = await ctxFor(pool, w.ownerId, w.workspaceId);
  const brand = (await pool.query<{ id: string }>(`INSERT INTO brands(workspace_id, name, is_demo) VALUES ($1,'Dispatch bench',true) RETURNING id`, [w.workspaceId])).rows[0]!.id;
  const providers: Provider[] = ['facebook', 'telegram', 'x', 'linkedin', 'bluesky'];
  const conns: string[] = [];
  for (let i = 0; i < 10; i++) conns.push((await connectMock(ctx, brand, { provider: providers[i % providers.length]!, display_name: `Dispatch ${i}` })).id);
  for (let i = 0; i < backlog; i++) {
    const c = conns[i % conns.length]!;
    const { id } = await createPost(ctx, brand, { draft: { baseText: `Dispatch bench ${i} ${randomUUID().slice(0, 6)}`, baseLink: null, baseAssetIds: [], variants: [{ connectionId: c, inheritText: true, inheritMedia: true }] } }, randomUUID());
    await schedulePost(ctx, id, { expected_version: 1, connection_ids: [c], input_local_time: toLocalInput(new Date(Date.now() + 2 * 3600_000), 'Europe/London'), timezone: 'Europe/London' }, randomUUID());
  }
  // Outbox: the scheduling above wrote real outbox rows; time draining them in batches of 50 with a no-op queue.
  const outbox_batch_ms: number[] = [];
  const fakeBoss = { send: async () => 'job' } as unknown as Parameters<typeof dispatchOutbox>[0];
  for (let i = 0; i < 40; i++) {
    const t = performance.now();
    const n = await dispatchOutbox(fakeBoss, pool, 50);
    if (!n) break;
    outbox_batch_ms.push(performance.now() - t);
  }
  const idle_claim_ms: number[] = [];
  for (let i = 0; i < samples; i++) {
    const t = performance.now();
    const d = await claimDelivery(`bench#idle`, {}, pool);
    idle_claim_ms.push(performance.now() - t);
    if (d) throw new Error('unexpected due work before the backlog was released');
  }
  await pool.query(`UPDATE deliveries SET due_at=now() - interval '1 second', next_attempt_at=now() - interval '1 second', publish_before=now() + interval '30 minutes'
                     WHERE workspace_id=$1 AND brand_id=$2`, [w.workspaceId, brand]);
  const sink = { providerMs: 0 };
  const deps = instrumentDeps(liveEngineDeps(), sink);
  const r: DispatchResult = { claim_ms: [], process_ms: [], app_process_ms: [], provider_ms: [], idle_claim_ms, outbox_batch_ms, processed: 0, states: {}, duplicate_sends: 0 };
  for (;;) {
    const t0 = performance.now();
    const d = await claimDelivery(`bench#0`, {}, pool);
    const t1 = performance.now();
    if (!d) break;
    sink.providerMs = 0;
    await processDelivery(deps, d, pool);
    const t2 = performance.now();
    r.claim_ms.push(t1 - t0); r.process_ms.push(t2 - t1); r.provider_ms.push(sink.providerMs); r.app_process_ms.push(t2 - t1 - sink.providerMs);
    r.processed++;
    if (r.processed > backlog + 5) break;
  }
  r.states = Object.fromEntries((await pool.query<{ state: string; n: number }>(`SELECT state, count(*)::int n FROM deliveries WHERE brand_id=$1 GROUP BY state`, [brand])).rows.map((x) => [x.state, x.n]));
  r.duplicate_sends = (await pool.query<{ n: number }>(`SELECT count(*)::int n FROM (SELECT a.delivery_id FROM delivery_attempts a JOIN deliveries d ON d.id=a.delivery_id
     WHERE d.brand_id=$1 AND a.phase='sending' GROUP BY a.delivery_id HAVING count(*) > 1) x`, [brand])).rows[0]!.n;
  return r;
}
