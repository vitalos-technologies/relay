// Seed the SYNTHETIC analytics demo (demo workspaces only; never production) or a large benchmark history.
//   npx tsx scripts/analytics-demo.ts                                  # 'Demo Workspace', 90 days, deterministic
//   npx tsx scripts/analytics-demo.ts --workspace <uuid> --days 30 --anchor 2026-11-07
//   npx tsx scripts/analytics-demo.ts --large --days 730 --per-day 3 --accounts 4   # V3.1 benchmark history
// Data is flagged synthetic (connections.is_synthetic, source='synthetic') and appears only with dataset=demo.
import { closePool, getPool, maybeOne } from '@social-lite/db';
import { generateLargeHistory, seedAnalyticsDemo } from '@social-lite/services/analytics/demo';

const arg = (k: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : undefined; };

async function main() {
  const wsArg = arg('workspace');
  const ws = wsArg ?? (await maybeOne<{ id: string }>(getPool(), `SELECT id FROM workspaces WHERE name='Demo Workspace' AND is_demo ORDER BY created_at LIMIT 1`))?.id;
  if (!ws) throw new Error('No demo workspace found (run pnpm db:seed or pass --workspace <uuid> of a demo workspace).');
  const opts = { workspaceId: ws, anchor: arg('anchor'), days: arg('days') ? Number(arg('days')) : undefined, postsPerDay: arg('per-day') ? Number(arg('per-day')) : undefined,
    connectionsPerProvider: arg('accounts') ? Number(arg('accounts')) : undefined };
  const started = Date.now();
  const r = process.argv.includes('--large') ? await generateLargeHistory(opts) : await seedAnalyticsDemo(opts);
  console.log(JSON.stringify({ msg: 'analytics demo seeded (synthetic)', workspaceId: ws, ...r, ms: Date.now() - started }));
}

main().catch((err) => { console.error(err); process.exitCode = 1; }).finally(() => closePool());
