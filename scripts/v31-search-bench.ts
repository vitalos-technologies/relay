// V3.1 §8 search measurement: full-text (expression GIN, migration 021) vs ILIKE on posts, in a THROWAWAY database.
// Usage: set -a; . ./.env; set +a; npx tsx scripts/v31-search-bench.ts [posts=50000] [runs=60]
// Creates socialite_bench_<ts>, migrates, seeds synthetic posts across 20 workspaces / 40 brands, measures the
// service's post query shape (one workspace, all its brands, prefix terms, LIMIT 6) and drops the database.
import pg from 'pg';
import { migrate } from '../packages/db/src/migrate.js';

const ADMIN = process.env.TEST_ADMIN_DATABASE_URL ?? 'postgres://socialite:socialite-local-only@localhost:54329/postgres';
const N = Number(process.argv[2] ?? 50_000);
const RUNS = Number(process.argv[3] ?? 60);
const FOOTBALL = 'arsenal chelsea derby matchday preview lineup goal tickets season spring promo offer final result fixture kickoff stadium travel north south weekend highlights interview coach squad injury news transfer window'.split(' ');
// Realistic selectivity: 5,000-token vocabulary (each token in ~0.8% of posts) incl. the football words above.
const WORDS = [...FOOTBALL, ...Array.from({ length: 5000 - FOOTBALL.length }, (_, i) => `tok${i}`)];

const pct = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!; };

async function main() {
  const name = `socialite_bench_${Date.now().toString(36)}`;
  const admin = new pg.Client({ connectionString: ADMIN });
  await admin.connect();
  await admin.query(`CREATE DATABASE "${name}"`);
  const u = new URL(ADMIN); u.pathname = `/${name}`;
  const pool = new pg.Pool({ connectionString: u.toString(), max: 2 });
  try {
    await migrate(pool);
    const ws: string[] = []; const brands: Record<string, string[]> = {};
    for (let i = 0; i < 20; i++) {
      const w = (await pool.query(`INSERT INTO workspaces(name) VALUES ($1) RETURNING id`, [`WS ${i}`])).rows[0].id as string;
      ws.push(w); brands[w] = [];
      for (let b = 0; b < 2; b++) brands[w]!.push((await pool.query(`INSERT INTO brands(workspace_id, name) VALUES ($1,$2) RETURNING id`, [w, `B${i}-${b}`])).rows[0].id);
    }
    const t0 = Date.now();
    await pool.query(
      `INSERT INTO posts(workspace_id, brand_id, title, draft)
       SELECT w.ws, w.b, 'Post ' || g, jsonb_build_object('baseText', (SELECT string_agg(($3::text[])[1 + ((g * 7 + k * 13) % array_length($3::text[], 1))], ' ') FROM generate_series(1, 40) k),
              'baseLink', NULL, 'baseAssetIds', '[]'::jsonb, 'variants', '[]'::jsonb)
         FROM generate_series(1, $1) g
         JOIN LATERAL (SELECT (array_agg(x.ws))[1 + g % 40] ws, (array_agg(x.b))[1 + g % 40] b FROM jsonb_to_recordset($2::jsonb) x(ws uuid, b uuid)) w ON true`,
      [N, JSON.stringify(ws.flatMap((w) => brands[w]!.map((b) => ({ ws: w, b })))), WORDS]);
    await pool.query('ANALYZE posts');
    console.log(`seeded ${N} posts in ${Date.now() - t0} ms`);
    const target = ws[3]!;
    const qs = ['ars', 'derby', 'tickets offer', 'kick', 'tok12' /* broad prefix: ~60% of posts */];
    const fts = (q: string) => [`SELECT x.id FROM posts x, to_tsquery('simple', $3) q WHERE x.workspace_id=$1 AND x.brand_id = ANY($2::uuid[]) AND x.deleted_at IS NULL AND x.archived_at IS NULL
        AND to_tsvector('simple', coalesce(x.title, '') || ' ' || coalesce(x.draft->>'baseText', '')) @@ q
      ORDER BY ts_rank(to_tsvector('simple', coalesce(x.title, '') || ' ' || coalesce(x.draft->>'baseText', '')), q) DESC, x.updated_at DESC LIMIT 6`,
      [target, brands[target], q.split(' ').map((t) => `${t}:*`).join(' & ')]] as const;
    const ftsRecent = (q: string) => [`SELECT x.id FROM posts x WHERE x.workspace_id=$1 AND x.brand_id = ANY($2::uuid[]) AND x.deleted_at IS NULL AND x.archived_at IS NULL
        AND to_tsvector('simple', coalesce(x.title, '') || ' ' || coalesce(x.draft->>'baseText', '')) @@ to_tsquery('simple', $3) ORDER BY x.updated_at DESC LIMIT 6`,
      [target, brands[target], q.split(' ').map((t) => `${t}:*`).join(' & ')]] as const;
    const ilike = (q: string) => [`SELECT x.id FROM posts x WHERE x.workspace_id=$1 AND x.brand_id = ANY($2::uuid[]) AND x.deleted_at IS NULL AND x.archived_at IS NULL
        AND (x.title || ' ' || (x.draft->>'baseText')) ILIKE ALL($3::text[]) ORDER BY x.updated_at DESC LIMIT 6`,
      [target, brands[target], q.split(' ').map((t) => `%${t}%`)]] as const;
    for (const [label, build] of [['fts_rank', fts], ['fts_recency', ftsRecent], ['ilike', ilike]] as const) {
      const times: number[] = [];
      for (let r = 0; r < RUNS; r++) {
        const [sql, params] = build(qs[r % qs.length]!);
        const s = process.hrtime.bigint();
        await pool.query(sql, params as unknown as unknown[]);
        times.push(Number(process.hrtime.bigint() - s) / 1e6);
      }
      for (const q of qs) {
        const [sq, sp] = build(q); const ts: number[] = [];
        for (let r = 0; r < 15; r++) { const s = process.hrtime.bigint(); await pool.query(sq, sp as unknown as unknown[]); ts.push(Number(process.hrtime.bigint() - s) / 1e6); }
        console.log(`  ${label} "${q}": n=15 p50=${pct(ts, 50).toFixed(1)}ms p95=${pct(ts, 95).toFixed(1)}ms`);
      }
      const [sql, params] = build('derby');
      const plan = (await pool.query(`EXPLAIN ${sql}`, params as unknown as unknown[])).rows.map((x) => x['QUERY PLAN']).join(' | ');
      console.log(`${label}: runs=${RUNS} p50=${pct(times, 50).toFixed(1)}ms p95=${pct(times, 95).toFixed(1)}ms max=${Math.max(...times).toFixed(1)}ms`);
      console.log(`  plan: ${plan.slice(0, 400)}`);
    }
  } finally {
    await pool.end();
    await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await admin.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
