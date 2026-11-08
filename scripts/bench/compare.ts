// Before/after table from two harness runs (same profiles, same generator):
//   npx tsx scripts/bench/compare.ts [beforeLabel=baseline] [afterLabel=after] [--check]  → markdown on stdout
// --check: exit 1 when the AFTER run violates a budget in scripts/bench/budgets.ts (all violations are listed).
import { existsSync, readFileSync } from 'node:fs';
import { MCP_SERVER_P95_MS, verdict, WORKER_BUDGETS } from './budgets.js';
import type { ProfileName } from './profiles.js';

interface Sum { n: number; p50: number; p95: number; cv: number }
interface Report {
  results: Array<{ scenario: string; ms: Sum; queries_per_call: number; response_bytes: number }>;
  dispatch: null | Record<string, Sum | number | unknown>;
  mcp: null | Array<{ tool: string; client_ms: Sum; server_ms: Sum }>;
  conditions: { host: { loadavg_at_end: number[] }; postgres: { database_mb: number } };
}

const pos = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const CHECK = process.argv.includes('--check');
const [before = 'baseline', after = 'after'] = pos;
const violations: string[] = [];
const kb = (b: number) => (b >= 1024 ? `${Math.round(b / 1024)} KB` : `${b} B`);
const pct = (a: number, b: number) => (a > 0 ? `${b <= a ? '−' : '+'}${Math.abs(Math.round((1 - b / a) * 100))}%` : '');

for (const profile of ['small', 'medium', 'large']) {
  const fb = `evidence/perf/${before}-${profile}.json`; const fa = `evidence/perf/${after}-${profile}.json`;
  if (!existsSync(fb) || !existsSync(fa)) continue;
  const B = JSON.parse(readFileSync(fb, 'utf8')) as Report; const A = JSON.parse(readFileSync(fa, 'utf8')) as Report;
  console.log(`\n### ${profile[0]!.toUpperCase()}${profile.slice(1)} (${B.conditions.postgres.database_mb} MB → ${A.conditions.postgres.database_mb} MB; load avg at end ${B.conditions.host.loadavg_at_end[0]} → ${A.conditions.host.loadavg_at_end[0]})\n`);
  console.log('| Scenario | p50 before → after (ms) | p95 before → after (ms) | n | Δ p95 | queries | payload | budget (after) |');
  console.log('|---|---|---|---|---|---|---|---|');
  for (const r of B.results) {
    const a = A.results.find((x) => x.scenario === r.scenario);
    if (!a) continue;
    const v = verdict(profile as ProfileName, a.scenario, a.ms.p95, a.response_bytes, a.queries_per_call);
    if (v && !v.ok) violations.push(`${profile} ${a.scenario}: ${v.violations.join('; ')}`);
    const status = v ? (v.ok ? `ok (≤ ${v.p95_ms} ms)` : `**over**: ${v.violations.join('; ')}`) : '';
    console.log(`| ${r.scenario} | ${r.ms.p50} → ${a.ms.p50} | ${r.ms.p95} → ${a.ms.p95} | ${r.ms.n}/${a.ms.n} | ${pct(r.ms.p95, a.ms.p95)} | ${r.queries_per_call} → ${a.queries_per_call} | ${kb(r.response_bytes)} → ${kb(a.response_bytes)} | ${status} |`);
  }
  if (B.dispatch && A.dispatch) {
    for (const k of ['claim_ms', 'idle_claim_ms', 'process_app_ms', 'process_provider_ms', 'outbox_batch50_ms']) {
      const b = B.dispatch[k] as Sum; const a = A.dispatch[k] as Sum;
      const lim = (WORKER_BUDGETS as Record<string, Record<string, number>>)[k]?.[profile];
      if (lim !== undefined && a.p95 > lim) violations.push(`${profile} worker ${k}: p95 ${a.p95} > ${lim}`);
      console.log(`| worker: ${k.replace(/_ms$/, '')} | ${b.p50} → ${a.p50} | ${b.p95} → ${a.p95} | ${b.n}/${a.n} | ${pct(b.p95, a.p95)} | | | ${lim === undefined ? '' : a.p95 <= lim ? `ok (≤ ${lim} ms)` : `**over** (≤ ${lim} ms)`} |`);
    }
  }
  if (B.mcp && A.mcp) {
    for (const m of B.mcp) {
      const a = A.mcp.find((x) => x.tool === m.tool);
      if (!a) continue;
      const lim = MCP_SERVER_P95_MS[profile as ProfileName];
      if (a.server_ms.p95 > lim) violations.push(`${profile} MCP ${m.tool}: server p95 ${a.server_ms.p95} > ${lim}`);
      console.log(`| MCP ${m.tool} (client / server) | ${m.client_ms.p50} / ${m.server_ms.p50} → ${a.client_ms.p50} / ${a.server_ms.p50} | ${m.client_ms.p95} / ${m.server_ms.p95} → ${a.client_ms.p95} / ${a.server_ms.p95} | ${m.client_ms.n}/${a.client_ms.n} | ${pct(m.client_ms.p95, a.client_ms.p95)} | | | ${a.server_ms.p95 <= lim ? `ok (server ≤ ${lim} ms)` : `**over** (server ≤ ${lim} ms)`} |`);
    }
  }
}

if (violations.length) {
  console.log(`\n**Budget violations (${after}):**\n` + violations.map((v) => `- ${v}`).join('\n'));
  if (CHECK) process.exit(1);
} else console.log(`\nAll budgets met (${after}).`);
