// V3.1 benchmark helper: builds a DISPOSABLE database, generates a synthetic history (DAYS env, default 365) and times the
// main analytics views + EXPLAINs the key queries. Never touches the dev database. Usage: DAYS=365 npx tsx scripts/analytics-bench.ts
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { migrate } from '../packages/db/src/migrate.js';
import { createPool, setPool } from '../packages/db/src/pool.js';
const ADMIN = 'postgres://socialite:socialite-local-only@localhost:54329/postgres';
const name = `an_bench_${Date.now()}`;
const a = new pg.Client({ connectionString: ADMIN }); await a.connect(); await a.query(`CREATE DATABASE "${name}"`); await a.end();
const url = ADMIN.replace('/postgres', '/' + name);
process.env.DATABASE_URL = url; process.env.APP_ENV = 'test'; process.env.KEY_ENCRYPTION_KEYS = 'test-1:' + Buffer.alloc(32, 7).toString('base64'); process.env.LOG_LEVEL = 'error';
const pool = createPool(url, 6); setPool(pool);
try {
  await migrate(pool);
  const { generateLargeHistory } = await import('../packages/services/src/analytics/demo.js');
  const { overview, contentTable } = await import('../packages/services/src/analytics/query.js');
  const { loadAccess } = await import('../packages/services/src/tenancy.js');
  const { parseFilters } = await import('../packages/services/src/analytics/filters.js');
  const ws = (await pool.query(`INSERT INTO workspaces(name,is_demo) VALUES ('bench',true) RETURNING id`)).rows[0].id;
  const u = (await pool.query(`INSERT INTO users(oidc_issuer,oidc_subject,email,email_verified,name) VALUES ('t',$1,'b@x.test',true,'b') RETURNING id`, [randomUUID()])).rows[0].id;
  await pool.query(`INSERT INTO memberships(workspace_id,user_id,role) VALUES ($1,$2,'owner')`, [ws, u]);
  await pool.query(`INSERT INTO scoped_role_grants(workspace_id,principal_type,user_id,role,scope_type,source) VALUES ($1,'user',$2,'owner','workspace','t')`, [ws, u]);
  let t = Date.now();
  const r = await generateLargeHistory({ workspaceId: ws, anchor: '2026-11-01', days: Number(process.env.DAYS ?? 365), postsPerDay: 2, connectionsPerProvider: 2 });
  console.log('generated', r.posts, 'posts', r.points, 'points in', Date.now() - t, 'ms');
  await pool.query('ANALYZE');
  for (const tbl of ['metric_observations','metric_cumulative_facts','metric_daily_facts','metric_resource_latest','metric_rollups']) console.log(tbl, (await pool.query(`SELECT count(*) n FROM ${tbl}`)).rows[0].n);
  const access = await loadAccess(u, ws, pool, { mfaVerified: true, authTime: new Date().toISOString() });
  const ctx = { actor: { userId: u, email: 'b', name: 'b', sessionId: 's' }, access: access!, correlationId: 'c' };
  for (const [from, to] of [['2026-10-05','2026-11-01'], ['2025-11-02','2026-11-01']] as Array<[string, string]>) {
    const f = { ...parseFilters(new URLSearchParams(), { timezone: 'Europe/London' }), from, to, dataset: 'demo' as const };
    t = Date.now(); await overview(ctx, f); console.log(`overview ${from}..${to}`, Date.now() - t, 'ms');
    t = Date.now(); await contentTable(ctx, f, { sort: 'engagement_rate' }); console.log(`content sort=ER ${from}..${to}`, Date.now() - t, 'ms');
    t = Date.now(); await overview(ctx, { ...f, formats: ['image','video','text'] }); console.log(`overview per-post path ${from}..${to}`, Date.now() - t, 'ms');
  }
  { const q = await import('../packages/services/src/analytics/query.js');
    const f = { ...parseFilters(new URLSearchParams(), { timezone: 'Europe/London' }), from: '2025-11-02', to: '2026-11-01', dataset: 'demo' as const };
    const sc = await q.resolveScope(ctx, f);
    t = Date.now(); await q.aggregate(sc, sc.period); console.log('aggregate 365d', Date.now() - t);
    t = Date.now(); await q.postStates(sc, sc.period); console.log('postStates 365d', Date.now() - t); }
  const conns = (await pool.query(`SELECT array_agg(id) a FROM connections WHERE workspace_id=$1`, [ws])).rows[0].a;
  const ex = async (label: string, sql: string, p: unknown[]) => { const e = (await pool.query(`EXPLAIN (ANALYZE, BUFFERS) ${sql}`, p)).rows.map((x: any) => x['QUERY PLAN']); console.log(`--- ${label}\n` + e.filter((l: string) => /Scan|Execution|Planning|Sort|Hash|Aggregate/.test(l)).slice(0, 14).join('\n')); };
  await ex('rollup aggregate (365d)', `SELECT connection_id, (bucket_start AT TIME ZONE 'Europe/London')::date, metric_key, sum(value_sum), sum(resources) FROM metric_rollups WHERE workspace_id=$1 AND source = ANY($2::text[]) AND connection_id = ANY($3::uuid[]) AND bucket_start >= $4 AND bucket_start < $5 GROUP BY 1,2,3`, [ws, ['synthetic'], conns, '2025-11-01T00:00Z', '2026-11-02T00:00Z']);
  await ex('published deliveries scope (28d)', `SELECT d.id FROM deliveries d WHERE d.workspace_id=$1 AND d.state='published' AND d.connection_id = ANY($2::uuid[]) AND d.published_at >= $3 AND d.published_at < $4`, [ws, conns, '2026-10-05T00:00Z', '2026-11-02T00:00Z']);
  await ex('resource latest by post ids', `SELECT l.resource_id, sum(l.value) FROM metric_resource_latest l WHERE l.workspace_id=$1 AND l.resource_type='post' AND l.source = ANY($2::text[]) AND l.resource_id IN (SELECT id FROM deliveries WHERE workspace_id=$1 AND published_at >= $3 AND published_at < $4) GROUP BY 1`, [ws, ['synthetic'], '2026-10-05T00:00Z', '2026-11-02T00:00Z']);
  await ex('observation fact-key upsert lookup', `SELECT value FROM metric_observations WHERE workspace_id=$1 AND connection_id=$2 AND resource_type='post' AND resource_id=(SELECT resource_id FROM metric_observations WHERE workspace_id=$1 LIMIT 1) AND metric_id='instagram.post.views' AND period_key='asof:2026-10-20' AND dimension='' AND definition_version=1`, [ws, conns[0]]);
} finally {
  await pool.end();
  const b = new pg.Client({ connectionString: ADMIN }); await b.connect(); await b.query(`DROP DATABASE "${name}" WITH (FORCE)`); await b.end();
}
