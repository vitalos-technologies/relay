// Fairness load test (V2 §7 "Fair scheduling", §12 case 18) — invoked by scripts/load-test.ts --fairness.
// Disposable database; two workspaces: A = bulk campaign (many jobs, more destinations than worker slots,
// due first), B = small workspace (due right after). In-process worker slots run the REAL claimDelivery +
// processDelivery with live engine deps against simulated providers (MOCK_PROVIDER_LATENCY_MS per request).
// Phase 1 "baseline": plain due-time ordering, no per-workspace cap. Phase 2 "fair": fair ordering + cap.
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import pg from 'pg';
import { createPool, migrate, one, setPool, type Pool } from '@social-lite/db';
import { toLocalInput, type Provider } from '@social-lite/core';
import { claimDelivery, createPost, loadAccess, processDelivery, schedulePost, type Ctx } from '@social-lite/services';
import { connectMock } from '@social-lite/services/connections/index';
import { liveEngineDeps } from '@social-lite/services/engine/live-deps';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function adminUrl(): string {
  if (process.env.TEST_ADMIN_DATABASE_URL) return process.env.TEST_ADMIN_DATABASE_URL;
  const u = new URL(process.env.DATABASE_URL ?? 'postgres://socialite:socialite-local-only@localhost:54329/socialite_dev');
  u.pathname = '/postgres';
  return u.toString();
}

async function workspace(pool: Pool, name: string, destinations: number): Promise<{ ws: string; brand: string; ctx: Ctx; conns: string[] }> {
  const user = await one<{ id: string }>(pool, `INSERT INTO users(oidc_issuer, oidc_subject, email, name) VALUES ('pending',$1,$2,'Load test') RETURNING id`,
    [`lt:${randomUUID()}`, `fair-${randomUUID().slice(0, 8)}@loadtest.social-lite.test`]);
  const ws = await one<{ id: string }>(pool, `INSERT INTO workspaces(name, is_demo) VALUES ($1, true) RETURNING id`, [name]);
  await pool.query(`INSERT INTO memberships(workspace_id, user_id, role) VALUES ($1,$2,'owner')`, [ws.id, user.id]);
  await pool.query(`INSERT INTO scoped_role_grants(workspace_id, principal_type, user_id, role, scope_type, source) VALUES ($1,'user',$2,'owner','workspace','load_test') ON CONFLICT DO NOTHING`, [ws.id, user.id]);
  const brand = await one<{ id: string }>(pool, `INSERT INTO brands(workspace_id, name, is_demo) VALUES ($1,$2,true) RETURNING id`, [ws.id, `${name} brand`]);
  const access = await loadAccess(user.id, ws.id, pool, { mfaVerified: true, authTime: new Date().toISOString() });
  if (!access) throw new Error('no access');
  const ctx: Ctx = { actor: { userId: user.id, email: 'lt', name: 'lt', sessionId: randomUUID() }, access, correlationId: `fair-${name}` };
  const providers: Provider[] = ['facebook', 'telegram', 'x'];
  const conns: string[] = [];
  for (let i = 0; i < destinations; i++) conns.push((await connectMock(ctx, brand.id, { provider: providers[i % 3]!, display_name: `${name} ${i}` })).id);
  return { ws: ws.id, brand: brand.id, ctx, conns };
}

async function enqueue(t: { brand: string; ctx: Ctx; conns: string[] }, jobs: number, label: string) {
  for (let i = 0; i < jobs; i++) {
    const c = t.conns[i % t.conns.length]!;
    const { id } = await createPost(t.ctx, t.brand, { draft: { baseText: `${label} ${i} ${randomUUID().slice(0, 6)}`, baseLink: null, baseAssetIds: [], variants: [{ connectionId: c, inheritText: true, inheritMedia: true }] } }, randomUUID());
    await schedulePost(t.ctx, id, { expected_version: 1, connection_ids: [c], input_local_time: toLocalInput(new Date(Date.now() + 2 * 3600_000), 'Europe/London'), timezone: 'Europe/London' }, randomUUID());
  }
}

interface PhaseResult {
  phase: string; ordering: string; per_workspace_cap: number | null; wall_seconds: number;
  workspaces: Record<'A_bulk' | 'B_small', { jobs: number; completed: number; start_lag_seconds: { p50: number; p95: number; max: number }; all_done_after_seconds: number; max_concurrent_leases: number }>;
  deliveries_sent_more_than_once: number;
}

async function phase(pool: Pool, name: 'baseline' | 'fair', o: { bulkJobs: number; otherJobs: number; slots: number }): Promise<PhaseResult> {
  if (name === 'baseline') { process.env.DISPATCH_FAIR_ORDERING = 'off'; process.env.DISPATCH_WORKSPACE_CONCURRENCY = '1000'; }
  else { delete process.env.DISPATCH_FAIR_ORDERING; process.env.DISPATCH_WORKSPACE_CONCURRENCY = String(Math.max(1, Math.floor(o.slots / 2))); }
  // A has more destinations than there are worker slots, so plain ordering lets it occupy every slot.
  const A = await workspace(pool, `A-${name}`, o.slots + 4);
  const B = await workspace(pool, `B-${name}`, 3);
  await enqueue(A, o.bulkJobs, 'Bulk');
  await enqueue(B, o.otherJobs, 'Small');
  // A's campaign is due 5 s before B's posts; both are due when the workers start.
  const t0 = (await one<{ t: Date }>(pool, `SELECT now() AS t`)).t;
  await pool.query(`UPDATE deliveries SET due_at=$2::timestamptz - interval '5 seconds', next_attempt_at=$2::timestamptz - interval '5 seconds', publish_before=$2::timestamptz + interval '30 minutes' WHERE workspace_id=$1`, [A.ws, t0]);
  await pool.query(`UPDATE deliveries SET due_at=$2, next_attempt_at=$2, publish_before=$2::timestamptz + interval '30 minutes' WHERE workspace_id=$1`, [B.ws, t0]);

  const deps = liveEngineDeps();
  let stop = false;
  const maxLeases = { A: 0, B: 0 };
  const sampler = (async () => {
    while (!stop) {
      const r = await pool.query<{ workspace_id: string; n: number }>(
        `SELECT workspace_id, count(*)::int n FROM deliveries WHERE lease_owner IS NOT NULL AND lease_expires_at > now() AND workspace_id = ANY($1::uuid[]) GROUP BY workspace_id`, [[A.ws, B.ws]]);
      for (const row of r.rows) { const k = row.workspace_id === A.ws ? 'A' : 'B'; maxLeases[k] = Math.max(maxLeases[k], row.n); }
      await sleep(50);
    }
  })();
  const started = Date.now();
  const workers = Array.from({ length: o.slots }, (_, slot) => (async () => {
    while (!stop) {
      const d = await claimDelivery(`fair-${name}#${slot}`);
      if (!d) { await sleep(25); continue; }
      await processDelivery(deps, d, pool);
    }
  })());
  const total = o.bulkJobs + o.otherJobs;
  while (Date.now() - started < 10 * 60_000) {
    const r = await one<{ n: number }>(pool, `SELECT count(*)::int n FROM deliveries WHERE workspace_id = ANY($1::uuid[]) AND state IN ('published','failed','unknown','blocked','expired')`, [[A.ws, B.ws]]);
    if (r.n >= total) break;
    await sleep(200);
  }
  stop = true;
  await Promise.all([...workers, sampler]);
  const wall = (Date.now() - started) / 1000;
  const stats = async (ws: string) => one<{ p50: number; p95: number; max: number; done: number; last: number }>(pool, `
    SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY lag) p50, percentile_cont(0.95) WITHIN GROUP (ORDER BY lag) p95, max(lag) max,
           (SELECT count(*)::int FROM deliveries WHERE workspace_id=$1 AND state='published') done,
           (SELECT extract(epoch FROM (max(updated_at) - $2::timestamptz)) FROM deliveries WHERE workspace_id=$1) last
      FROM (SELECT extract(epoch FROM (min(a.started_at) - greatest(d.due_at, $2::timestamptz))) lag
              FROM deliveries d JOIN delivery_attempts a ON a.delivery_id=d.id WHERE d.workspace_id=$1 GROUP BY d.id, d.due_at) x`, [ws, t0]);
  const sa = await stats(A.ws);
  const sb = await stats(B.ws);
  const dupes = await one<{ n: number }>(pool, `SELECT count(*)::int n FROM (SELECT delivery_id FROM delivery_attempts a JOIN deliveries d ON d.id=a.delivery_id
    WHERE d.workspace_id = ANY($1::uuid[]) AND a.phase='sending' GROUP BY delivery_id HAVING count(*)>1) x`, [[A.ws, B.ws]]);
  const r3 = (n: number) => Math.round(Number(n) * 1000) / 1000;
  return {
    phase: name, ordering: name === 'fair' ? 'fewest live leases → least recently served → due time' : 'due time only',
    per_workspace_cap: name === 'fair' ? Number(process.env.DISPATCH_WORKSPACE_CONCURRENCY) : null, wall_seconds: r3(wall),
    workspaces: {
      A_bulk: { jobs: o.bulkJobs, completed: sa.done, start_lag_seconds: { p50: r3(sa.p50), p95: r3(sa.p95), max: r3(sa.max) }, all_done_after_seconds: r3(sa.last), max_concurrent_leases: maxLeases.A },
      B_small: { jobs: o.otherJobs, completed: sb.done, start_lag_seconds: { p50: r3(sb.p50), p95: r3(sb.p95), max: r3(sb.max) }, all_done_after_seconds: r3(sb.last), max_concurrent_leases: maxLeases.B },
    },
    deliveries_sent_more_than_once: dupes.n,
  };
}

export async function runFairness(o: { bulkJobs: number; otherJobs: number; slots: number }) {
  process.env.MOCK_PROVIDER_LATENCY_MS ??= '60';
  const dbName = `socialite_fairness_${Date.now().toString(36)}`;
  const admin = new pg.Client({ connectionString: adminUrl() });
  await admin.connect();
  await admin.query(`CREATE DATABASE "${dbName}"`);
  const url = new URL(adminUrl()); url.pathname = `/${dbName}`;
  process.env.DATABASE_URL = url.toString();
  const pool = createPool(url.toString(), o.slots + 6);
  setPool(pool);
  try {
    await migrate(pool);
    const baseline = await phase(pool, 'baseline', o);
    const fair = await phase(pool, 'fair', o);
    const b = baseline.workspaces.B_small.start_lag_seconds.p95;
    const f = fair.workspaces.B_small.start_lag_seconds.p95;
    const result = {
      measured_at: new Date().toISOString(),
      setup: { worker_slots: o.slots, simulated_provider_latency_ms_per_request: Number(process.env.MOCK_PROVIDER_LATENCY_MS),
        A_bulk: `${o.bulkJobs} jobs over ${o.slots + 4} simulated destinations, due 5 s before B`, B_small: `${o.otherJobs} jobs over 3 simulated destinations`,
        database: 'disposable PostgreSQL database (created and dropped by this run)', code_path: 'claimDelivery (engine/claim.ts + engine/fairness.ts) + processDelivery with live engine deps; simulated providers only' },
      baseline, fair,
      conclusion: {
        small_workspace_p95_start_lag_seconds: { baseline: b, fair: f, improvement_factor: f > 0 ? Math.round((b / f) * 10) / 10 : null },
        per_workspace_cap_respected: fair.workspaces.A_bulk.max_concurrent_leases <= (fair.per_workspace_cap ?? Infinity) && fair.workspaces.B_small.max_concurrent_leases <= (fair.per_workspace_cap ?? Infinity),
        no_duplicate_sends: baseline.deliveries_sent_more_than_once === 0 && fair.deliveries_sent_more_than_once === 0,
        all_completed: baseline.workspaces.A_bulk.completed + baseline.workspaces.B_small.completed === o.bulkJobs + o.otherJobs
          && fair.workspaces.A_bulk.completed + fair.workspaces.B_small.completed === o.bulkJobs + o.otherJobs,
      },
    };
    mkdirSync('evidence/v2', { recursive: true });
    writeFileSync('evidence/v2/fairness.json', JSON.stringify(result, null, 2) + '\n');
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await pool.end().catch(() => undefined);
    setPool(undefined);
    await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`).catch(() => undefined);
    await admin.end();
  }
}
