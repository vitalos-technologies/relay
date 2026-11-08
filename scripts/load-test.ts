// Load test (spec §3/§18): N deliveries due in the same minute across M simulated destinations,
// processed by the REAL worker. Measures dispatch start latency and completion. Never uses real networks.
// Usage: MOCK_PROVIDER_LATENCY_MS=250 (for the worker) then: pnpm tsx scripts/load-test.ts [jobs=100] [destinations=25]
//
// V2 fairness mode (stream D): two workspaces — a bulk campaign (A) and a small one (B) — on a DISPOSABLE
// database, processed by in-process worker slots running the real claim + engine code with simulated
// providers, once with plain due-time ordering (baseline) and once with fair dispatch. Writes
// evidence/v2/fairness.json.
// Usage: pnpm tsx --env-file=.env scripts/load-test.ts --fairness [bulkJobs=360] [otherJobs=30] [slots=8]
import { randomUUID } from 'node:crypto';
import { writeFileSync, mkdirSync } from 'node:fs';
import { closePool, getPool, one } from '@social-lite/db';
import type { Provider } from '@social-lite/core';
import { config, createPost, schedulePost, type Ctx } from '@social-lite/services';
import { toLocalInput } from '@social-lite/core';
import { connectMock } from '@social-lite/services/connections/index';

const FAIRNESS = process.argv.includes('--fairness');
const ARGS = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const JOBS = Number(ARGS[0] ?? 100);
const DESTS = Number(ARGS[1] ?? 25);
if (config().APP_ENV === 'production') throw new Error('never in production');
const db = FAIRNESS || process.argv.includes('--isolation') ? (undefined as unknown as ReturnType<typeof getPool>) : getPool();

async function main() {
  const owner = await one<{ id: string }>(db, `INSERT INTO users(oidc_issuer, oidc_subject, email, name) VALUES ('pending',$1,$2,'Load test') RETURNING id`, [`lt:${randomUUID()}`, `load-${randomUUID().slice(0, 8)}@loadtest.social-lite.test`]);
  const ws = await one<{ id: string }>(db, `INSERT INTO workspaces(name, is_demo) VALUES ('Load test (synthetic)', true) RETURNING id`);
  await db.query(`INSERT INTO memberships(workspace_id, user_id, role) VALUES ($1,$2,'owner')`, [ws.id, owner.id]);
  const brand = await one<{ id: string }>(db, `INSERT INTO brands(workspace_id, name, is_demo) VALUES ($1,'Load brand',true) RETURNING id`, [ws.id]);
  const ctx: Ctx = { actor: { userId: owner.id, email: 'lt', name: 'lt', sessionId: randomUUID() }, access: { workspaceId: ws.id, role: 'owner', brandIds: null, isDemo: true }, correlationId: 'load' };
  const providers: Provider[] = ['facebook', 'telegram', 'x'];
  const conns: string[] = [];
  for (let i = 0; i < DESTS; i++) conns.push((await connectMock(ctx, brand.id, { provider: providers[i % 3]!, display_name: `Load ${i}` })).id);
  const t0 = Date.now();
  for (let i = 0; i < JOBS; i++) {
    const c = conns[i % conns.length]!;
    const { id } = await createPost(ctx, brand.id, { draft: { baseText: `Load test ${i} ${randomUUID().slice(0, 6)}`, baseLink: null, baseAssetIds: [], variants: [{ connectionId: c, inheritText: true, inheritMedia: true }] } }, randomUUID());
    // Scheduled 2h ahead so nothing is due while enqueueing; then all are made due at the same instant.
    await schedulePost(ctx, id, { expected_version: 1, connection_ids: [c], input_local_time: toLocalInput(new Date(Date.now() + 2 * 3600_000), 'Europe/London'), timezone: 'Europe/London' }, randomUUID());
  }
  const enqueueMs = Date.now() - t0;
  // Normalise due time: all jobs due at the same instant.
  await db.query(`UPDATE deliveries SET due_at=now(), next_attempt_at=now(), publish_before=now() + interval '15 minutes' WHERE workspace_id=$1`, [ws.id]);
  const start = Date.now();
  let done = 0;
  while (Date.now() - start < 10 * 60_000) {
    const r = await one<{ n: number }>(db, `SELECT count(*)::int n FROM deliveries WHERE workspace_id=$1 AND state IN ('published','failed','unknown','blocked','expired')`, [ws.id]);
    done = r.n;
    if (done >= JOBS) break;
    await new Promise((res) => setTimeout(res, 500));
  }
  const totalS = (Date.now() - start) / 1000;
  const stats = await one<Record<string, number>>(db, `
    SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY lag) p50, percentile_cont(0.95) WITHIN GROUP (ORDER BY lag) p95, max(lag) max,
           count(*) FILTER (WHERE lag <= 60)::float / count(*) within_60s
      FROM (SELECT extract(epoch FROM (min(a.started_at) - d.due_at)) lag FROM deliveries d JOIN delivery_attempts a ON a.delivery_id=d.id
             WHERE d.workspace_id=$1 GROUP BY d.id, d.due_at) x`, [ws.id]);
  const states = (await db.query(`SELECT state, count(*)::int n FROM deliveries WHERE workspace_id=$1 GROUP BY state`, [ws.id])).rows;
  const dupes = await one<{ n: number }>(db, `SELECT count(*)::int n FROM (SELECT delivery_id FROM delivery_attempts a JOIN deliveries d ON d.id=a.delivery_id WHERE d.workspace_id=$1 AND a.phase='sending' GROUP BY delivery_id HAVING count(*)>1) x`, [ws.id]);
  const result = {
    measured_at: new Date().toISOString(), jobs: JOBS, destinations: DESTS, simulated_provider_latency_ms: Number(process.env.MOCK_PROVIDER_LATENCY_MS ?? 'see worker env'),
    enqueue_seconds: enqueueMs / 1000, completed: done, wall_seconds_to_complete: totalS,
    dispatch_start_latency_seconds: { p50: stats.p50, p95: stats.p95, max: stats.max }, fraction_started_within_60s: stats.within_60s,
    target: '95% of eligible due jobs begin within 60 s', states, deliveries_sent_more_than_once: dupes.n,
  };
  mkdirSync('evidence/load', { recursive: true });
  writeFileSync(`evidence/load/load-${JOBS}-${Date.now()}.json`, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
}
if (process.argv.includes('--isolation')) {
  // V3.1 workload isolation (scripts/load-test-isolation.ts): publishing waves during a bulk burst, shared vs isolated.
  // Usage: pnpm tsx --env-file=.env scripts/load-test.ts --isolation [publishJobs=180] [bulkPerClass=6] [slots=4] [providerLatencyMs=150] [repeats=3]
  import('./load-test-isolation.js').then((m) => m.runIsolation({ publishJobs: Number(ARGS[0] ?? 180), bulkPerClass: Number(ARGS[1] ?? 6), slots: Number(ARGS[2] ?? 4), latencyMs: Number(ARGS[3] ?? 150), repeats: Number(ARGS[4] ?? 3) }))
    .then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
} else if (FAIRNESS) {
  import('./load-test-fairness.js').then((m) => m.runFairness({ bulkJobs: Number(ARGS[0] ?? 360), otherJobs: Number(ARGS[1] ?? 30), slots: Number(ARGS[2] ?? 8) })).then(() => process.exit(0))
    .catch((e) => { console.error(e); process.exit(1); });
} else {
  main().then(closePool).catch(async (e) => { console.error(e); await closePool(); process.exit(1); });
}
