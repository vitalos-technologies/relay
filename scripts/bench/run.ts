// V3.1 reproducible benchmark harness (brief §2, §17). One command:
//   pnpm bench                         # small + medium
//   pnpm bench --profile large         # one profile (small | medium | large | all)
//   pnpm bench --samples 50 --label after --keep
// For each profile: CREATE a throwaway database (relay_bench_<profile>_<ts>), migrate, generate the synthetic dataset
// (scripts/bench/generate.ts + the analytics history generator), ANALYZE, warm up, then time every scenario sequentially
// (latency, not throughput) and write evidence/perf/<label>-<profile>.json. The database is dropped afterwards unless
// --keep. Never touches socialite_dev: refuses any database name without the relay_bench_ prefix.
import { cpus, freemem, hostname, loadavg, totalmem } from 'node:os';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import pg from 'pg';
import { createPool, migrate, setPool, type Pool } from '@social-lite/db';
import { PROFILES, type Profile, type ProfileName } from './profiles.js';
import { generateWorkspace, installHelpers, type GeneratedWorkspace } from './generate.js';
import { countQueries, summarize } from './stats.js';

const args = process.argv.slice(2);
const opt = (k: string, d?: string) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const flag = (k: string) => args.includes(`--${k}`);
const SAMPLES = Number(opt('samples', '30'));
const WARMUP = Number(opt('warmup', '3'));
const LABEL = opt('label', 'run')!;
const KEEP = flag('keep');
const ONLY = opt('only'); // substring filter on scenario names
const profileArg = opt('profile', 'small,medium')!;
const profiles: ProfileName[] = profileArg === 'all' ? ['small', 'medium', 'large'] : (profileArg.split(',') as ProfileName[]);

function loadEnvFile(): void {
  if (process.env.DATABASE_URL || !existsSync('.env')) return;
  for (const line of readFileSync('.env', 'utf8').split('\n')) {
    const m = /^(DATABASE_URL|DATABASE_ADMIN_URL)=(.*)$/.exec(line.trim());
    if (m) process.env[m[1]!] ??= m[2]!.replace(/^['"]|['"]$/g, '');
  }
}

function adminUrl(): string {
  loadEnvFile();
  const base = process.env.BENCH_ADMIN_DATABASE_URL ?? process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL ?? 'postgres://socialite:socialite-local-only@localhost:54329/postgres';
  const u = new URL(base); u.pathname = '/postgres';
  return u.toString();
}

function benchEnv(url: string): void {
  process.env.DATABASE_URL = url;
  process.env.APP_ENV = 'test';
  process.env.APP_BASE_URL = 'http://localhost:3000';
  process.env.KEY_ENCRYPTION_KEYS = 'bench-1:' + Buffer.alloc(32, 9).toString('base64'); // throwaway key for a throwaway DB
  process.env.ENABLE_MOCK_PROVIDERS = 'true';
  process.env.MOCK_PROVIDER_LATENCY_MS = process.env.BENCH_PROVIDER_LATENCY_MS ?? '0';
  process.env.LOG_LEVEL = 'error';
  process.env.S3_ENDPOINT ??= 'http://localhost:8333';
  process.env.S3_BUCKET = 'social-lite-test';
}

async function pgFacts(pool: Pool, db: string) {
  const s = async (k: string) => (await pool.query<{ v: string }>(`SELECT current_setting($1) v`, [k])).rows[0]!.v;
  const size = (await pool.query<{ b: string }>(`SELECT pg_database_size($1)::text b`, [db])).rows[0]!.b;
  const tables = (await pool.query<{ t: string; rows: string; bytes: string }>(
    `SELECT c.relname t, c.reltuples::bigint::text rows, pg_total_relation_size(c.oid)::text bytes FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relkind='r' ORDER BY pg_total_relation_size(c.oid) DESC LIMIT 12`)).rows;
  return {
    server_version: await s('server_version'), shared_buffers: await s('shared_buffers'), work_mem: await s('work_mem'), effective_cache_size: await s('effective_cache_size'),
    random_page_cost: await s('random_page_cost'), max_connections: await s('max_connections'),
    database_bytes: Number(size), database_mb: Math.round(Number(size) / 1048576),
    largest_tables: tables.map((t) => ({ table: t.t, est_rows: Number(t.rows), mb: Math.round(Number(t.bytes) / 1048576) })),
  };
}

async function cacheCounters(pool: Pool, db: string) {
  const r = (await pool.query<{ hit: string; read: string }>(`SELECT blks_hit::text hit, blks_read::text read FROM pg_stat_database WHERE datname=$1`, [db])).rows[0]!;
  return { hit: Number(r.hit), read: Number(r.read) };
}

async function runProfile(p: Profile) {
  const admin = new pg.Client({ connectionString: adminUrl() });
  await admin.connect();
  const db = `relay_bench_${p.name}_${Date.now().toString(36)}`;
  if (!/^relay_bench_[a-z0-9_]+$/.test(db)) throw new Error('refusing: not a bench database name');
  await admin.query(`CREATE DATABASE "${db}"`);
  const u = new URL(adminUrl()); u.pathname = `/${db}`;
  benchEnv(u.toString());
  const pool = createPool(u.toString(), 8);
  setPool(pool);
  const started = new Date();
  const timings: Record<string, number> = {};
  try {
    let t = Date.now();
    await migrate(pool);
    const migrations = (await pool.query<{ name: string }>(`SELECT name FROM schema_migrations ORDER BY name`)).rows.map((r) => r.name);
    timings.migrate_ms = Date.now() - t;
    t = Date.now();
    const c = await pool.connect();
    let main: GeneratedWorkspace;
    try {
      await c.query('SET statement_timeout = 0');
      await installHelpers(c);
      await c.query('BEGIN');
      main = await generateWorkspace(c, { name: `Bench ${p.name} (measured)`, brands: p.brands, connections: p.connections, posts: p.posts, seed: `relay-bench-v1:${p.name}:main` });
      await c.query('COMMIT');
      for (let n = 0; n < p.neighbours; n++) {
        await c.query('BEGIN');
        await generateWorkspace(c, { name: `Bench ${p.name} neighbour ${n + 1}`, brands: Math.max(1, Math.round(p.brands * p.neighbourScale)),
          connections: Math.max(5, Math.round(p.connections * p.neighbourScale)), posts: Math.round(p.posts * p.neighbourScale), seed: `relay-bench-v1:${p.name}:n${n}` });
        await c.query('COMMIT');
      }
    } finally { c.release(); }
    timings.generate_core_ms = Date.now() - t;
    t = Date.now();
    const { generateLargeHistory } = await import('@social-lite/services/analytics/demo');
    const hist = await generateLargeHistory({ workspaceId: main.workspaceId, anchor: new Date().toISOString().slice(0, 10), ...p.analytics });
    timings.generate_analytics_ms = Date.now() - t;
    // V3.1: what the analytics worker does after deploy — backfill tracked per-day summary zones (no-op before 025).
    t = Date.now();
    { const { backfillSummaryZones } = await import('@social-lite/services/analytics/summary');
      for (let i = 0; i < 50 && (await backfillSummaryZones({ maxCells: 10_000 })).cells > 0; i++) { /* until no pending zone */ } }
    timings.summary_backfill_ms = Date.now() - t;
    t = Date.now();
    { const v = await pool.connect(); try { await v.query('SET statement_timeout = 0'); await v.query('VACUUM ANALYZE'); } finally { v.release(); } }
    timings.analyze_ms = Date.now() - t;
    const counts = Object.fromEntries(await Promise.all(['workspaces', 'brands', 'connections', 'posts', 'schedules', 'deliveries', 'delivery_attempts', 'approvals', 'metric_observations', 'metric_rollups']
      .map(async (tbl) => [tbl, (await pool.query<{ n: number }>(`SELECT count(*)::int n FROM ${tbl}`)).rows[0]!.n] as const)));
    const mainCounts = (await pool.query<Record<string, number>>(`SELECT
        (SELECT count(*)::int FROM brands WHERE workspace_id=$1) brands, (SELECT count(*)::int FROM connections WHERE workspace_id=$1) connections,
        (SELECT count(*)::int FROM posts WHERE workspace_id=$1) posts, (SELECT count(*)::int FROM deliveries WHERE workspace_id=$1) deliveries`, [main.workspaceId])).rows[0];
    const facts = await pgFacts(pool, db);
    console.log(`[${p.name}] ${db}: ${facts.database_mb} MB, posts total ${counts.posts} (measured ws ${mainCounts!.posts}), analytics ${hist.posts} posts / ${hist.points} points; generate ${timings.generate_core_ms + timings.generate_analytics_ms} ms`);

    const counter = countQueries(pool);
    const { pageScenarios, dispatchScenario } = await import('./scenarios.js');
    const scenarios = (await pageScenarios(pool, main, { analyticsDataset: true })).filter((s) => !ONLY || s.name.includes(ONLY));
    const before = await cacheCounters(pool, db);
    const results = [];
    for (const s of scenarios) {
      const first: number[] = [];
      for (let i = 0; i < WARMUP; i++) { const t0 = performance.now(); await s.run(i); first.push(performance.now() - t0); }
      const ms: number[] = []; let bytes = 0; let queries = 0;
      for (let i = 0; i < SAMPLES; i++) {
        counter.reset();
        const t0 = performance.now();
        const out = await s.run(i);
        ms.push(performance.now() - t0);
        queries = counter.read();
        if (i === 0) bytes = Buffer.byteLength(JSON.stringify(out ?? null));
      }
      const sum = summarize(ms);
      results.push({ scenario: s.name, ms: sum, first_call_ms: Math.round(first[0]! * 100) / 100, queries_per_call: queries, response_bytes: bytes });
      console.log(`  ${s.name.padEnd(44)} p50 ${String(sum.p50).padStart(8)} ms  p95 ${String(sum.p95).padStart(8)} ms  cv ${sum.cv}  q=${queries}  ${bytes} B`);
    }
    const after = await cacheCounters(pool, db);
    let dispatch = null; let mcp = null;
    if (!ONLY || 'dispatch'.includes(ONLY)) {
      const d = await dispatchScenario(pool, main, p.dispatchBacklog, SAMPLES);
      dispatch = {
        backlog: p.dispatchBacklog, processed: d.processed, states: d.states, duplicate_sends: d.duplicate_sends,
        claim_ms: summarize(d.claim_ms), idle_claim_ms: summarize(d.idle_claim_ms), process_total_ms: summarize(d.process_ms),
        process_app_ms: summarize(d.app_process_ms), process_provider_ms: summarize(d.provider_ms), outbox_batch50_ms: summarize(d.outbox_batch_ms),
        simulated_provider_latency_ms: Number(process.env.MOCK_PROVIDER_LATENCY_MS),
      };
      console.log(`  dispatch: claim p50 ${dispatch.claim_ms.p50} p95 ${dispatch.claim_ms.p95}; idle claim p50 ${dispatch.idle_claim_ms.p50}; process app p50 ${dispatch.process_app_ms.p50} p95 ${dispatch.process_app_ms.p95}; outbox/50 p50 ${dispatch.outbox_batch50_ms.p50}`);
    }
    if (!ONLY || 'mcp'.includes(ONLY)) {
      const { mcpScenario } = await import('./mcp.js');
      mcp = await mcpScenario(pool, main, SAMPLES, true);
      for (const m of mcp) console.log(`  mcp ${m.tool.padEnd(22)} client p50 ${m.client_ms.p50} p95 ${m.client_ms.p95}; server p50 ${m.server_ms.p50} p95 ${m.server_ms.p95}; errors ${m.errors}`);
    }
    const report = {
      label: LABEL, profile: p, database: db, started_at: started.toISOString(), finished_at: new Date().toISOString(),
      conditions: {
        host: { hostname: hostname(), cpu: cpus()[0]?.model, cpus: cpus().length, total_mem_gb: Math.round(totalmem() / 1e9 * 10) / 10, free_mem_gb_at_start: Math.round(freemem() / 1e9 * 10) / 10,
          loadavg_at_end: loadavg().map((x) => Math.round(x * 100) / 100), node: process.version },
        postgres: facts,
        cache_state: `warm: ${WARMUP} warm-up calls per scenario before ${SAMPLES} timed samples; shared_buffers ${facts.shared_buffers} vs database ${facts.database_mb} MB`,
        buffer_hit_ratio_during_page_samples: (after.hit - before.hit) / Math.max(1, (after.hit - before.hit) + (after.read - before.read)),
        concurrency: 'sequential single caller (latency); shared host — other agents may be running tests concurrently (see loadavg)',
        measured_layer: 'service functions called by the API routes (authz + SQL + serialisation); excludes Next.js, session cookie lookup and network',
        pool_max: 8, samples: SAMPLES, warmup: WARMUP,
      },
      dataset: { totals: counts, measured_workspace: mainCounts, analytics_history: { posts: hist.posts, points: hist.points, ...p.analytics }, migrations, timings },
      results, dispatch, mcp,
    };
    mkdirSync('evidence/perf', { recursive: true });
    const file = `evidence/perf/${LABEL}-${p.name}.json`;
    writeFileSync(file, JSON.stringify(report, null, 2) + '\n');
    console.log(`  → ${file}`);
  } finally {
    await pool.end().catch(() => undefined);
    setPool(undefined);
    if (!KEEP) await admin.query(`DROP DATABASE IF EXISTS "${db}" WITH (FORCE)`).catch((e) => console.error('drop failed', (e as Error).message));
    else console.log(`  kept ${db}`);
    await admin.end();
  }
}

async function main() {
  for (const name of profiles) if (!PROFILES[name]) throw new Error(`unknown profile ${name}`);
  if (profiles.length === 1) return runProfile(PROFILES[profiles[0]!]);
  // One process per profile: module-level state (pools, config caches) never leaks between datasets.
  const rest = args.filter((a, i) => a !== '--profile' && args[i - 1] !== '--profile');
  for (const name of profiles) execFileSync(process.execPath, [...process.execArgv, process.argv[1]!, ...rest, '--profile', name], { stdio: 'inherit' });
}
main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
