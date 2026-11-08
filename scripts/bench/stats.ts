// Sample statistics for the benchmark harness. p50/p95 use nearest-rank on the sorted samples (no interpolation),
// so a p95 from 30 samples is the 29th value: report it with its sample count, never as a population claim.
import type { Pool, PoolClient } from '@social-lite/db';

export interface Summary { n: number; p50: number; p95: number; mean: number; stdev: number; cv: number; min: number; max: number }

export function summarize(xs: number[]): Summary {
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  if (!n) return { n: 0, p50: NaN, p95: NaN, mean: NaN, stdev: NaN, cv: NaN, min: NaN, max: NaN };
  const rank = (p: number) => s[Math.min(n - 1, Math.max(0, Math.ceil(p * n) - 1))]!;
  const mean = s.reduce((a, b) => a + b, 0) / n;
  const stdev = n > 1 ? Math.sqrt(s.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) : 0;
  const r = (v: number) => Math.round(v * 100) / 100;
  return { n, p50: r(rank(0.5)), p95: r(rank(0.95)), mean: r(mean), stdev: r(stdev), cv: mean ? r(stdev / mean) : 0, min: r(s[0]!), max: r(s[n - 1]!) };
}

/** Counts SQL statements issued through a pool (per checked-out client, so pool.query and transactions both count once). */
export function countQueries(pool: Pool): { reset(): void; read(): number } {
  let n = 0;
  const seen = new WeakSet<PoolClient>();
  pool.on('acquire', (client: PoolClient) => {
    if (seen.has(client)) return;
    seen.add(client);
    const orig = client.query.bind(client) as (...a: unknown[]) => unknown;
    (client as unknown as { query: (...a: unknown[]) => unknown }).query = (...a: unknown[]) => { n++; return orig(...a); };
  });
  return { reset() { n = 0; }, read() { return n; } };
}
