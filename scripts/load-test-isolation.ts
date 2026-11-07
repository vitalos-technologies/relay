// Workload-isolation load test (V3.1 brief §6/§18 "queue fairness during backfill/video/export") — invoked by
// scripts/load-test.ts --isolation. One DISPOSABLE database per phase (created, migrated, dropped).
//
// Workload (same in both phases):
//  - Publishing: 3 workspaces × N/3 posts on 30 simulated destinations, released in waves (every 2 s) so due work
//    keeps arriving while bulk work runs. Processed by in-process claim slots running the REAL claimDelivery +
//    processDelivery (live engine deps, simulated providers with MOCK_PROVIDER_LATENCY_MS per request).
//  - Bulk burst at t=0 in a separate workspace, all classes at once, through REAL service code:
//      historical_backfill = analytics rebuildAggregates() over a synthetic history (heavy SQL writes);
//      analytics_refresh   = bulkLoadSynthetic() ingest of new observations + rebuild (provider fetch replaced by fixtures);
//      report_export       = the query phase of a report export (analytics overview 365 d + content table);
//      video               = sharp transcode of a 3000×2000 frame to three renditions (real CPU) + an asset-sized DB write.
// Phases:
//  - "shared"   (V3 topology): bulk handlers and publishing share ONE pool; bulk concurrency as in V3 worker wiring;
//                no backpressure, no provider cap.
//  - "isolated" (V3.1): WorkloadRunner (same per-class concurrency) + bulk on its own pool + publishing-pressure
//                deferral + per-provider dispatch cap.
// Reported separately: dispatch delay (due → claimed), processing (app vs provider), queue age samples, bulk progress.
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import pg from 'pg';
import sharp from 'sharp';
import { createPool, migrate, one, setPool, type Pool } from '@social-lite/db';
import { toLocalInput, type Provider } from '@social-lite/core';
import type { WorkloadClass } from '@social-lite/core/contracts/v31-perf';
import { claimDelivery, createPost, loadAccess, processDelivery, schedulePost, type Ctx } from '@social-lite/services';
import { connectMock } from '@social-lite/services/connections/index';
import { liveEngineDeps } from '@social-lite/services/engine/live-deps';
import { instrumentEngineDeps, publishingPressure, withProviderClock, WorkloadRunner } from '@social-lite/services/workload/runner';
import { workloadPolicies } from '@social-lite/services/workload/policy';
import { bulkLoadSynthetic, generateLargeHistory, rebuildAggregates } from '@social-lite/services/analytics/demo';
import { contentTable, overview } from '@social-lite/services/analytics/query';
import { parseFilters } from '@social-lite/services/analytics/filters';
import { definitionsFor } from '@social-lite/services/analytics/registry';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const r3 = (n: number) => Math.round(n * 1000) / 1000;

function adminUrl(): string {
  if (process.env.TEST_ADMIN_DATABASE_URL) return process.env.TEST_ADMIN_DATABASE_URL;
  const u = new URL(process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL ?? 'postgres://socialite:socialite-local-only@localhost:54329/socialite_dev');
  u.pathname = '/postgres';
  return u.toString();
}

function pctl(xs: number[], p: number): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return r3(s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))]!);
}
const summary = (xs: number[]) => ({ n: xs.length, p50: pctl(xs, 0.5), p95: pctl(xs, 0.95), max: pctl(xs, 1) });

async function tenant(pool: Pool, name: string, destinations: number, providers: Provider[]) {
  const user = await one<{ id: string }>(pool, `INSERT INTO users(oidc_issuer, oidc_subject, email, name) VALUES ('pending',$1,$2,'Load test') RETURNING id`,
    [`lt:${randomUUID()}`, `iso-${randomUUID().slice(0, 8)}@loadtest.social-lite.test`]);
  const ws = await one<{ id: string }>(pool, `INSERT INTO workspaces(name, is_demo) VALUES ($1, true) RETURNING id`, [name]);
  await pool.query(`INSERT INTO memberships(workspace_id, user_id, role) VALUES ($1,$2,'owner')`, [ws.id, user.id]);
  await pool.query(`INSERT INTO scoped_role_grants(workspace_id, principal_type, user_id, role, scope_type, source) VALUES ($1,'user',$2,'owner','workspace','load_test')`, [ws.id, user.id]);
  const brand = await one<{ id: string }>(pool, `INSERT INTO brands(workspace_id, name, is_demo) VALUES ($1,$2,true) RETURNING id`, [ws.id, `${name} brand`]);
  const access = await loadAccess(user.id, ws.id, pool, { mfaVerified: true, authTime: new Date().toISOString() });
  if (!access) throw new Error('no access');
  const ctx: Ctx = { actor: { userId: user.id, email: 'lt', name: 'lt', sessionId: randomUUID() }, access, correlationId: `iso-${name}` };
  const conns: string[] = [];
  for (let i = 0; i < destinations; i++) conns.push((await connectMock(ctx, brand.id, { provider: providers[i % providers.length]!, display_name: `${name} ${i}` })).id);
  return { ws: ws.id, brand: brand.id, ctx, conns, user: user.id };
}

interface BulkJob { cls: WorkloadClass; queue: string; ws: string; run(): Promise<void>; enqueuedAt: number; startedAt?: number; finishedAt?: number; error?: string }

/** V3 worker wiring per class (pg-boss localConcurrency / loops): used by BOTH phases so only isolation differs. */
const V3_CONCURRENCY: Partial<Record<WorkloadClass, number>> = { historical_backfill: 1, analytics_refresh: 2, report_export: 2, video: 1 };

export interface IsolationOptions { publishJobs: number; bulkPerClass: number; slots: number; latencyMs: number; repeats?: number }

async function phase(name: 'shared' | 'isolated', o: IsolationOptions) {
  const dbName = `socialite_isolation_${name}_${Date.now().toString(36)}`;
  const admin = new pg.Client({ connectionString: adminUrl() });
  await admin.connect();
  await admin.query(`CREATE DATABASE "${dbName}"`);
  const url = new URL(adminUrl()); url.pathname = `/${dbName}`;
  process.env.DATABASE_URL = url.toString();
  const pool = createPool(url.toString(), 10); // V3 worker default DATABASE_POOL_MAX
  const bulkPool = name === 'isolated' ? createPool(url.toString(), 6, { connectionTimeoutMillis: 120_000 }) : null;
  setPool(pool);
  if (name === 'shared') { process.env.DISPATCH_PROVIDER_CONCURRENCY = '1000'; } else { delete process.env.DISPATCH_PROVIDER_CONCURRENCY; }
  try {
    await migrate(pool);
    // ---------------- setup
    const pubProviders: Provider[] = ['facebook', 'telegram', 'x', 'linkedin', 'bluesky'];
    const pubs = [];
    for (let t = 0; t < 3; t++) pubs.push(await tenant(pool, `Pub ${t}`, 10, pubProviders));
    const perTenant = Math.ceil(o.publishJobs / 3);
    for (const t of pubs) {
      for (let i = 0; i < perTenant; i++) {
        const c = t.conns[i % t.conns.length]!;
        const { id } = await createPost(t.ctx, t.brand, { draft: { baseText: `Iso ${i} ${randomUUID().slice(0, 6)}`, baseLink: null, baseAssetIds: [], variants: [{ connectionId: c, inheritText: true, inheritMedia: true }] } }, randomUUID());
        await schedulePost(t.ctx, id, { expected_version: 1, connection_ids: [c], input_local_time: toLocalInput(new Date(Date.now() + 2 * 3600_000), 'Europe/London'), timezone: 'Europe/London' }, randomUUID());
      }
    }
    const bulk = await tenant(pool, 'Bulk', 1, ['facebook']);
    await pool.query(`UPDATE workspaces SET is_demo = true WHERE id=$1`, [bulk.ws]);
    const hist = await generateLargeHistory({ workspaceId: bulk.ws, anchor: new Date().toISOString().slice(0, 10), days: 365, postsPerDay: 1, connectionsPerProvider: 1 });
    await pool.query('ANALYZE');
    const today = new Date().toISOString().slice(0, 10);
    const f365 = { ...parseFilters(new URLSearchParams(), { timezone: 'Europe/London' }), from: new Date(Date.now() - 364 * 86_400_000).toISOString().slice(0, 10), to: today, dataset: 'demo' as const };
    const frame = await sharp({ create: { width: 3000, height: 2000, channels: 3, background: { r: 0, g: 0, b: 0 }, noise: { type: 'gaussian', mean: 128, sigma: 40 } } }).png().toBuffer();
    const fdef = definitionsFor('instagram').find((d) => d.family === 'views' && d.dimensionKey == null)!;
    const igConn = (await pool.query<{ id: string; brand_id: string }>(`SELECT id, brand_id FROM connections WHERE workspace_id=$1 AND provider='instagram' AND is_synthetic`, [bulk.ws])).rows[0]!;
    const posts = (await pool.query<{ id: string; published_at: Date }>(`SELECT id, published_at FROM deliveries WHERE connection_id=$1 ORDER BY published_at DESC LIMIT 200`, [igConn.id])).rows;

    const jobs: BulkJob[] = [];
    const add = (cls: WorkloadClass, queue: string, run: () => Promise<void>) => jobs.push({ cls, queue, ws: bulk.ws, run, enqueuedAt: 0 });
    for (let i = 0; i < o.bulkPerClass; i++) {
      add('historical_backfill', 'analytics-backfill', () => rebuildAggregates(bulk.ws, hist.connectionIds.slice((i * 3) % hist.connectionIds.length, (i * 3) % hist.connectionIds.length + 3)));
      add('analytics_refresh', 'analytics-sync', async () => {
        const at = new Date(Date.now() - 60_000);
        await bulkLoadSynthetic(posts.map((p, k) => ({ workspaceId: bulk.ws, brandId: igConn.brand_id, connectionId: igConn.id, provider: 'instagram' as Provider, resourceType: 'post' as const,
          resourceId: p.id, def: fdef, dimension: '', value: 1000 + i * 10 + k, observedAt: at, publishedAt: p.published_at })));
      });
      add('report_export', 'report-export', async () => { await overview(bulk.ctx, f365); await contentTable(bulk.ctx, f365, { sort: 'engagement_rate', page_size: 100 }); });
      add('video', 'media-transcode', async () => {
        for (const w of [1920, 1280, 640]) await sharp(frame).resize({ width: w }).jpeg({ quality: 80 }).toBuffer();
        await pool.query(`SELECT pg_sleep(0.05)`); // asset/derivative row writes (connection held, like the real handler)
      });
    }

    // Release publishing in waves: 15 waves, 2 s apart, starting 1 s after t0.
    const t0 = (await one<{ t: Date }>(pool, `SELECT now() AS t`)).t;
    const ids = (await pool.query<{ id: string }>(`SELECT id FROM deliveries WHERE workspace_id = ANY($1::uuid[]) ORDER BY id`, [pubs.map((p) => p.ws)])).rows.map((r) => r.id);
    for (let k = 0; k < ids.length; k++) {
      const wave = k % 15;
      await pool.query(`UPDATE deliveries SET due_at=$2::timestamptz + make_interval(secs => $3), next_attempt_at=$2::timestamptz + make_interval(secs => $3),
                          publish_before=$2::timestamptz + interval '30 minutes' WHERE id=$1`, [ids[k], t0, 1 + wave * 2]);
    }

    // ---------------- run
    process.env.MOCK_PROVIDER_LATENCY_MS = String(o.latencyMs);
    const timings = new Map<string, { claimedAt: number; finishedAt: number; providerMs: number }>();
    let stop = false;
    const runner: WorkloadRunner | null = name === 'isolated'
      ? new WorkloadRunner({ workerId: 'iso', bulkPool, publishingSlots: o.slots, deferPollMs: 200,
          pressure: publishingPressure({ slots: o.slots, busy: (): number => runner?.publishingRunning ?? 0, dueAgeSeconds: 2 }), recorder: null,
          policies: workloadPolicies({ ...process.env, WORKLOAD_HISTORICAL_BACKFILL_CONCURRENCY: '1', WORKLOAD_ANALYTICS_REFRESH_CONCURRENCY: '2', WORKLOAD_REPORT_EXPORT_CONCURRENCY: '2', WORKLOAD_VIDEO_CONCURRENCY: '1' }, o.slots) })
      : null;
    const deps = instrumentEngineDeps(liveEngineDeps());
    const queueAge: number[] = [];
    const sampler = (async () => {
      while (!stop) {
        const r = await pool.query<{ age: number | null }>(`SELECT extract(epoch FROM now() - min(next_attempt_at))::float8 age FROM deliveries
          WHERE workspace_id = ANY($1::uuid[]) AND state IN ('scheduled','retry_wait') AND next_attempt_at <= now() AND lease_owner IS NULL`, [pubs.map((p) => p.ws)]);
        queueAge.push(Math.max(0, r.rows[0]?.age ?? 0));
        await sleep(250);
      }
    })();
    const started = Date.now();
    for (const j of jobs) j.enqueuedAt = Date.now();
    // Bulk workers: one in-memory queue per class drained with the V3 per-class concurrency.
    const bulkWorkers = Object.entries(V3_CONCURRENCY).flatMap(([cls, n]) => Array.from({ length: n! }, async () => {
      for (;;) {
        const j = jobs.find((x) => x.cls === cls && x.startedAt === undefined);
        if (!j) return;
        j.startedAt = -1;
        const exec = async () => { j.startedAt = Date.now(); await j.run(); };
        try { await (runner ? runner.run(j.cls, { workspaceId: j.ws, queue: j.queue, eligibleAt: new Date(j.enqueuedAt) }, exec) : exec()); }
        catch (e) { j.error = (e as Error).message.slice(0, 200); }
        j.finishedAt = Date.now();
      }
    }));
    const slots = Array.from({ length: o.slots }, (_, slot) => (async () => {
      while (!stop) {
        const d = await claimDelivery(`iso-${name}#${slot}`, {}, pool);
        if (!d) { await sleep(100); continue; }
        const claimedAt = Date.now();
        const go = () => withProviderClock(() => processDelivery(deps, d, pool));
        const { providerMs } = runner ? await runner.publishing({ workspaceId: d.workspace_id, provider: d.provider, eligibleAt: d.next_attempt_at }, go) : await go();
        timings.set(d.id, { claimedAt, finishedAt: Date.now(), providerMs });
      }
    })());
    while (Date.now() - started < 10 * 60_000) {
      const r = await one<{ n: number }>(pool, `SELECT count(*)::int n FROM deliveries WHERE workspace_id = ANY($1::uuid[]) AND state IN ('published','failed','unknown','blocked','expired')`, [pubs.map((p) => p.ws)]);
      if (r.n >= ids.length && jobs.every((j) => j.finishedAt)) break;
      await sleep(200);
    }
    stop = true;
    await Promise.all([...slots, sampler, ...bulkWorkers]);
    const wall = (Date.now() - started) / 1000;

    // ---------------- results
    const rows = (await pool.query<{ id: string; due: Date; started: Date; ended: Date | null; state: string }>(
      `SELECT d.id, d.due_at due, a.started_at started, a.ended_at ended, d.state FROM deliveries d
         JOIN LATERAL (SELECT started_at, ended_at FROM delivery_attempts x WHERE x.delivery_id=d.id ORDER BY attempt_number LIMIT 1) a ON true
        WHERE d.workspace_id = ANY($1::uuid[])`, [pubs.map((p) => p.ws)])).rows;
    const dispatch = rows.map((r) => (r.started.getTime() - r.due.getTime()) / 1000);
    const processing = [...timings.values()].map((t) => (t.finishedAt - t.claimedAt) / 1000);
    const providerS = [...timings.values()].map((t) => t.providerMs / 1000);
    const appS = [...timings.values()].map((t) => (t.finishedAt - t.claimedAt - t.providerMs) / 1000);
    const dupes = await one<{ n: number }>(pool, `SELECT count(*)::int n FROM (SELECT delivery_id FROM delivery_attempts a JOIN deliveries d ON d.id=a.delivery_id
      WHERE d.workspace_id = ANY($1::uuid[]) AND a.phase='sending' GROUP BY delivery_id HAVING count(*)>1) x`, [pubs.map((p) => p.ws)]);
    const states = Object.fromEntries((await pool.query<{ state: string; n: number }>(`SELECT state, count(*)::int n FROM deliveries WHERE workspace_id = ANY($1::uuid[]) GROUP BY state`, [pubs.map((p) => p.ws)])).rows.map((x) => [x.state, x.n]));
    const bulkByClass = Object.fromEntries(Object.keys(V3_CONCURRENCY).map((cls) => {
      const js = jobs.filter((j) => j.cls === cls);
      return [cls, { jobs: js.length, completed: js.filter((j) => j.finishedAt && !j.error).length, errors: js.filter((j) => j.error).map((j) => j.error).slice(0, 3),
        start_delay_seconds: summary(js.filter((j) => (j.startedAt ?? -1) > 0).map((j) => (j.startedAt! - j.enqueuedAt) / 1000)),
        run_seconds: summary(js.filter((j) => j.finishedAt && (j.startedAt ?? -1) > 0).map((j) => (j.finishedAt! - j.startedAt!) / 1000)),
        all_done_after_seconds: r3((Math.max(...js.map((j) => j.finishedAt ?? 0)) - started) / 1000) }];
    }));
    return {
      phase: name, wall_seconds: r3(wall),
      topology: name === 'shared'
        ? 'one pool (10) shared by publishing and bulk; V3 per-queue concurrency; no backpressure; no provider cap'
        : 'publishing pool (10, reserved) + bulk pool (6); WorkloadRunner per-class caps (same as V3) + per-workspace caps; bulk defers under publishing pressure (due age > 2 s or all slots busy, ≤ 60 s); per-provider dispatch cap (default 8)',
      publishing: {
        deliveries: ids.length, states, duplicate_sends: dupes.n,
        dispatch_delay_seconds: summary(dispatch),
        processing_seconds: summary(processing),
        processing_app_seconds: summary(appS),
        processing_provider_seconds: summary(providerS),
        queue_age_seconds_sampled_every_250ms: summary(queueAge),
      },
      bulk: bulkByClass,
      analytics_history: { posts: hist.posts, points: hist.points },
    };
  } finally {
    await pool.end().catch(() => undefined);
    await bulkPool?.end().catch(() => undefined);
    setPool(undefined);
    await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`).catch(() => undefined);
    await admin.end();
  }
}

/** Each phase runs in its own process (module-level pools/caches never leak between the two databases). */
export async function runIsolation(o: IsolationOptions) {
  process.env.LOG_LEVEL ??= 'error';
  process.env.APP_ENV ??= 'test';
  process.env.ENABLE_MOCK_PROVIDERS = 'true';
  process.env.KEY_ENCRYPTION_KEYS ??= 'iso-1:' + Buffer.alloc(32, 5).toString('base64');
  const only = process.env.ISOLATION_PHASE as 'shared' | 'isolated' | undefined;
  if (only) {
    const r = await phase(only, o);
    writeFileSync(process.env.ISOLATION_OUT!, JSON.stringify(r));
    return;
  }
  const run = (name: string) => {
    const out = `evidence/perf/.isolation-${name}.json`;
    mkdirSync('evidence/perf', { recursive: true });
    execFileSync(process.execPath, [...process.execArgv, process.argv[1]!, ...process.argv.slice(2)], { stdio: 'inherit', env: { ...process.env, ISOLATION_PHASE: name, ISOLATION_OUT: out } });
    const r = JSON.parse(readFileSync(out, 'utf8')) as Awaited<ReturnType<typeof phase>>;
    rmSync(out, { force: true });
    return r;
  };
  // Repeated, alternating phases (shared, isolated, shared, …): no claim from one run.
  const runs: Array<{ shared: Awaited<ReturnType<typeof phase>>; isolated: Awaited<ReturnType<typeof phase>> }> = [];
  for (let i = 0; i < (o.repeats ?? 3); i++) runs.push({ shared: run('shared'), isolated: run('isolated') });
  const med = (xs: Array<number | null>) => { const v = xs.filter((x): x is number => x !== null).sort((a, b) => a - b); return v.length ? v[Math.floor((v.length - 1) / 2)]! : null; };
  const per = (f: (x: Awaited<ReturnType<typeof phase>>) => number | null) => ({
    shared: runs.map((r) => f(r.shared)), isolated: runs.map((r) => f(r.isolated)),
    median: { shared: med(runs.map((r) => f(r.shared))), isolated: med(runs.map((r) => f(r.isolated))) } });
  const result = {
    measured_at: new Date().toISOString(),
    setup: { publish_jobs: o.publishJobs, bulk_jobs_per_class: o.bulkPerClass, publishing_slots: o.slots, simulated_provider_latency_ms_per_request: o.latencyMs, repeats: runs.length,
      release: 'publishing due in 15 waves 2 s apart from t0+1 s; the whole bulk burst is enqueued at t0',
      database: 'one disposable PostgreSQL database per phase run (created and dropped)',
      code_path: 'claimDelivery + processDelivery (live engine deps, simulated providers); bulk via real analytics/sharp code; isolated phase via services/workload/runner.ts' },
    conclusion: {
      publishing_dispatch_delay_p50_seconds: per((x) => x.publishing.dispatch_delay_seconds.p50),
      publishing_dispatch_delay_p95_seconds: per((x) => x.publishing.dispatch_delay_seconds.p95),
      publishing_dispatch_delay_max_seconds: per((x) => x.publishing.dispatch_delay_seconds.max),
      publishing_processing_app_p95_seconds: per((x) => x.publishing.processing_app_seconds.p95),
      publishing_processing_provider_p95_seconds: per((x) => x.publishing.processing_provider_seconds.p95),
      queue_age_p95_seconds: per((x) => x.publishing.queue_age_seconds_sampled_every_250ms.p95),
      bulk_all_done_after_seconds: per((x) => Math.max(...Object.values(x.bulk).map((b) => b.all_done_after_seconds))),
      bulk_all_completed: runs.every((r) => [r.shared, r.isolated].every((x) => Object.values(x.bulk).every((b) => b.completed === b.jobs))),
      all_published: runs.every((r) => [r.shared, r.isolated].every((x) => x.publishing.states.published === x.publishing.deliveries)),
      no_duplicate_sends: runs.every((r) => r.shared.publishing.duplicate_sends === 0 && r.isolated.publishing.duplicate_sends === 0),
    },
    runs,
  };
  mkdirSync('evidence/perf', { recursive: true });
  writeFileSync('evidence/perf/isolation.json', JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
}
