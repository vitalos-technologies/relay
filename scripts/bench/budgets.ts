// Server-side performance budgets (docs/PERFORMANCE_BUDGETS.md has the rationale). Checked by every harness run
// (`pnpm bench` writes `budget` per scenario into the JSON and prints violations; `pnpm bench:compare … --check` exits
// non-zero on any violation). Budgets are per profile: Medium is the representative workload; Large is reported
// separately with looser time budgets; payload and statement budgets do not loosen with size (they must not grow).
import type { ProfileName } from './profiles.js';

export interface Budget { match: RegExp; p95_ms: Record<ProfileName, number>; max_bytes?: number; max_queries?: number }

const page = (small: number, medium: number, large: number) => ({ small, medium, large });

export const BUDGETS: Budget[] = [
  { match: /^request\.context/, p95_ms: page(10, 10, 15), max_queries: 6 },
  { match: /^planner\.week/, p95_ms: page(50, 100, 200), max_bytes: 300_000, max_queries: 6 },
  { match: /^planner\.month \(one brand\)/, p95_ms: page(50, 100, 200), max_bytes: 300_000, max_queries: 6 },
  { match: /^planner\.month/, p95_ms: page(50, 150, 300), max_bytes: 1_000_000, max_queries: 6 },
  { match: /^posts\.list/, p95_ms: page(30, 50, 100), max_bytes: 50_000, max_queries: 5 },
  { match: /^posts\.search/, p95_ms: page(50, 100, 150), max_bytes: 50_000, max_queries: 5 },
  { match: /^post\.detail/, p95_ms: page(30, 50, 100), max_bytes: 50_000, max_queries: 12 },
  { match: /^dashboard/, p95_ms: page(50, 100, 200), max_bytes: 300_000, max_queries: 12 },
  { match: /^history/, p95_ms: page(30, 50, 100), max_bytes: 100_000, max_queries: 2 },
  { match: /^approvals/, p95_ms: page(50, 100, 200), max_bytes: 200_000, max_queries: 15 },
  { match: /^ops/, p95_ms: page(30, 100, 200), max_bytes: 20_000, max_queries: 10 },
  { match: /^analytics\.overview \(28 d\)/, p95_ms: page(400, 400, 800), max_bytes: 200_000, max_queries: 16 },
  { match: /^analytics\.overview \(365 d\)/, p95_ms: page(800, 800, 1600), max_bytes: 800_000, max_queries: 16 },
  { match: /^analytics\.content/, p95_ms: page(200, 200, 400), max_bytes: 150_000, max_queries: 12 },
];

/** Worker + MCP budgets (p95 ms). */
export const WORKER_BUDGETS = { claim_ms: page(25, 25, 40), idle_claim_ms: page(15, 15, 20), process_app_ms: page(60, 100, 200) };
export const MCP_SERVER_P95_MS = page(100, 150, 250);

export interface Verdict { p95_ms: number; max_bytes: number | null; max_queries: number | null; ok: boolean; violations: string[] }

export function verdict(profile: ProfileName, scenario: string, p95: number, bytes: number, queries: number): Verdict | null {
  const b = BUDGETS.find((x) => x.match.test(scenario));
  if (!b) return null;
  const v: string[] = [];
  if (p95 > b.p95_ms[profile]) v.push(`p95 ${p95} ms > ${b.p95_ms[profile]} ms`);
  if (b.max_bytes !== undefined && bytes > b.max_bytes) v.push(`payload ${bytes} B > ${b.max_bytes} B`);
  if (b.max_queries !== undefined && queries > b.max_queries) v.push(`${queries} statements > ${b.max_queries}`);
  return { p95_ms: b.p95_ms[profile], max_bytes: b.max_bytes ?? null, max_queries: b.max_queries ?? null, ok: !v.length, violations: v };
}
