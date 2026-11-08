// GET /api/ops/workload — workload classes, publishing pressure and the three separate timings (brief §6):
// queue age (gauge, now), dispatch delay and processing time (per finished item, from workload_samples), with provider
// time reported apart from app time. Percentiles are over THIS workspace's items only; queue gauges are system-wide
// counts/ages (no tenant data), like ops(). Permission: diagnostics.read.
import type { Percentiles, QueueGauge, WorkloadClass, WorkloadClassStats, WorkloadResponse } from '@social-lite/core/contracts/v31-perf';
import { WORKLOAD_CLASSES } from '@social-lite/core/contracts/v31-perf';
import { getPool, many, maybeOne, type Queryable } from '@social-lite/db';
import type { Ctx } from '../context.js';
import { requireAction } from '../tenancy.js';
import { QUEUE_CLASS, workloadPolicies } from './policy.js';
import { publishingPressure } from './runner.js';

const pct = (r: { n: number; p50: number | null; p95: number | null; max: number | null } | undefined): Percentiles =>
  ({ n: Number(r?.n ?? 0), p50_ms: r?.p50 ?? null, p95_ms: r?.p95 ?? null, max_ms: r?.max ?? null });

export async function workloadStats(ctx: Ctx, q: { window_minutes?: number | string | null } = {}): Promise<WorkloadResponse> {
  requireAction(ctx, 'diagnostics.read');
  const db = getPool();
  const window = Math.min(Math.max(Math.floor(Number(q.window_minutes) || 60), 5), 7 * 24 * 60);
  const hasSamples = !!(await maybeOne<{ ok: boolean }>(db, `SELECT to_regclass('public.workload_samples') IS NOT NULL AS ok`))?.ok;
  type Row = { c: WorkloadClass; finished: number; failed: number; [k: string]: unknown };
  const rows = hasSamples ? await many<Row>(db,
    `SELECT workload_class c, count(*)::int finished, count(*) FILTER (WHERE outcome <> 'ok')::int failed,
            percentile_disc(0.5) WITHIN GROUP (ORDER BY dispatch_delay_ms) dd50, percentile_disc(0.95) WITHIN GROUP (ORDER BY dispatch_delay_ms) dd95, max(dispatch_delay_ms) ddmax,
            percentile_disc(0.5) WITHIN GROUP (ORDER BY processing_ms) pr50, percentile_disc(0.95) WITHIN GROUP (ORDER BY processing_ms) pr95, max(processing_ms) prmax,
            count(provider_ms)::int pvn, percentile_disc(0.5) WITHIN GROUP (ORDER BY provider_ms) pv50, percentile_disc(0.95) WITHIN GROUP (ORDER BY provider_ms) pv95, max(provider_ms) pvmax,
            percentile_disc(0.5) WITHIN GROUP (ORDER BY processing_ms - provider_ms) ap50, percentile_disc(0.95) WITHIN GROUP (ORDER BY processing_ms - provider_ms) ap95, max(processing_ms - provider_ms) apmax,
            percentile_disc(0.5) WITHIN GROUP (ORDER BY local_wait_ms) lw50, percentile_disc(0.95) WITHIN GROUP (ORDER BY local_wait_ms) lw95, max(local_wait_ms) lwmax
       FROM workload_samples WHERE workspace_id = $1 AND finished_at > now() - make_interval(mins => $2) GROUP BY workload_class`,
    [ctx.access.workspaceId, window]) : [];
  const byClass = new Map(rows.map((r) => [r.c, r]));
  const classes: WorkloadClassStats[] = WORKLOAD_CLASSES.map((c) => {
    const r = byClass.get(c);
    const n = r?.finished ?? 0;
    const g = (k: string) => (r?.[k] ?? null) as number | null;
    const provider = r && Number(r.pvn) > 0 ? pct({ n: Number(r.pvn), p50: g('pv50'), p95: g('pv95'), max: g('pvmax') }) : null;
    return {
      class: c, finished: n, failed: r?.failed ?? 0,
      dispatch_delay: pct({ n, p50: g('dd50'), p95: g('dd95'), max: g('ddmax') }),
      processing: pct({ n, p50: g('pr50'), p95: g('pr95'), max: g('prmax') }),
      provider,
      app: provider ? pct({ n: provider.n, p50: g('ap50'), p95: g('ap95'), max: g('apmax') }) : null,
      local_wait: pct({ n, p50: g('lw50'), p95: g('lw95'), max: g('lwmax') }),
    };
  });

  const queues: QueueGauge[] = [];
  const due = await maybeOne<{ n: number; age: number | null }>(db,
    `SELECT count(*)::int n, extract(epoch FROM now() - min(next_attempt_at))::float8 age FROM deliveries
      WHERE state IN ('scheduled','retry_wait') AND next_attempt_at <= now() AND lease_owner IS NULL`);
  queues.push({ queue: 'deliveries', class: 'publishing', waiting: due?.n ?? 0, oldest_age_seconds: Math.max(0, Math.round(due?.age ?? 0)) });
  const boss = await pgbossReadable(db);
  if (boss) {
    const jobs = await many<{ name: string; n: number; age: number | null }>(db,
      `SELECT name, count(*)::int n, extract(epoch FROM now() - min(start_after))::float8 age FROM pgboss.job
        WHERE state IN ('created','retry') AND start_after <= now() AND name = ANY($1::text[]) GROUP BY name`, [Object.keys(QUEUE_CLASS)]);
    for (const j of jobs) queues.push({ queue: j.name, class: QUEUE_CLASS[j.name]!, waiting: j.n, oldest_age_seconds: Math.max(0, Math.round(j.age ?? 0)) });
  }
  const pressure = await publishingPressure({ slots: Number.MAX_SAFE_INTEGER, busy: () => 0, cacheMs: 0 }).check();
  return {
    generated_at: new Date().toISOString(), window_minutes: window, publishing_pressure: pressure,
    policies: Object.values(workloadPolicies()), classes, queues,
    note: hasSamples
      ? 'Queue age = oldest waiting item now. Dispatch delay = eligible → started. Processing = started → finished; provider time is time inside provider adapters (publishing only), app = processing − provider.'
      : 'Per-item timings need migration 020_v31_perf (workload_samples). Queue gauges are live.',
  };
}

/** pg-boss belongs to the worker role; the web role may not read it (then queue gauges show deliveries only). */
export async function pgbossReadable(db: Queryable): Promise<boolean> {
  const s = await maybeOne<{ ok: boolean }>(db, `SELECT to_regnamespace('pgboss') IS NOT NULL AND has_schema_privilege('pgboss', 'USAGE') AS ok`);
  if (!s?.ok) return false;
  return !!(await maybeOne<{ ok: boolean }>(db, `SELECT to_regclass('pgboss.job') IS NOT NULL AND has_table_privilege('pgboss.job', 'SELECT') AS ok`))?.ok;
}
