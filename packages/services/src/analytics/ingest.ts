// Analytics ingestion (V3 spec §9 pipeline): validated provider points → metric_observations (deduplicated on the fact
// key) → metric_cumulative_facts (lifetime/snapshot as-of series) | metric_daily_facts (reported daily buckets and
// labelled observed changes) → metric_resource_latest → metric_rollups (recomputed per touched 15-minute bucket).
//
// Idempotency: the same point observed again never adds a row; a different value for the same fact key updates the row
// (revision+1, previous_value kept). An OLDER observation arriving late never overwrites a newer one.
// Validation: unknown metric names, non-finite or negative values are rejected (counted, never stored, never "0").
import type { Provider } from '@social-lite/core';
import { withTx, type PoolClient, type Queryable } from '@social-lite/db';
import type { MetricPoint } from '@social-lite/providers/metrics';
import {
  DERIVED, ENGAGEMENT_FAMILIES, ensureMetricRegistry, fetchedPostDefinitions, resolveNative, type MetricDefinition,
} from './registry.js';
import type { FetchState } from './semantics.js';

export type DataSource = 'provider' | 'simulated' | 'synthetic';

export interface IngestTarget {
  workspaceId: string;
  brandId: string;
  connectionId: string;
  provider: Provider;
  resourceType: 'post' | 'account';
  /** delivery id (post) or connection id (account). */
  resourceId: string;
  providerObjectId: string | null;
  publishedAt: Date | null;
  source: DataSource;
}

export interface IngestResult {
  written: number;
  unchanged: number;
  /** Restated daily buckets or decreases of cumulative counters (late corrections). */
  corrections: number;
  rejected: Array<{ name: string; reason: string }>;
}

const WINDOW_RE = /^(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})$/;
const utcDate = (d: Date) => d.toISOString().slice(0, 10);

/** 15-minute floor (every real UTC offset is a multiple of 15 minutes ⇒ exact local-day bucketing). */
export function rollupBucket(publishedAt: Date): Date {
  return new Date(Math.floor(publishedAt.getTime() / 900_000) * 900_000);
}

interface Normalized {
  def: MetricDefinition;
  dimension: string;
  value: number;
  periodKey: string;
  nativePeriod: string;
  kind: 'cumulative' | 'daily';
  basis: 'lifetime' | 'window' | 'snapshot';
  windowStart: string | null;
  asOfDate: string;
  bucketDate: string | null;
  throughAt: Date;
}

/** Validate + normalize one provider point (pure). */
export function normalizePoint(t: Pick<IngestTarget, 'provider' | 'resourceType' | 'publishedAt'>, p: MetricPoint, observedAt: Date): Normalized | { reject: string } {
  const def = resolveNative(t.provider, p.name, t.resourceType === 'account' ? 'account' : 'resource-post');
  if (!def) return { reject: 'unmapped metric (not in the registry)' };
  if (typeof p.value !== 'number' || !Number.isFinite(p.value)) return { reject: 'non-numeric value' };
  if (p.value < 0) return { reject: 'negative counter value' };
  if (def.dimensionKey === null && p.dimension) return { reject: `unexpected dimension for ${def.id}` };
  const delayMs = def.providerDelayHours * 3_600_000;
  const dimension = (p.dimension ?? '').slice(0, 100);
  const nativePeriod = (p.period ?? '').slice(0, 40);
  if (def.timeBasis === 'daily' || nativePeriod === 'day') {
    const day = (p.windowEnd ?? '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return { reject: 'daily point without a day' };
    return { def, dimension, value: p.value, periodKey: `day:${day}`, nativePeriod, kind: 'daily', basis: 'lifetime', windowStart: null, asOfDate: day, bucketDate: day,
      throughAt: new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000) };
  }
  const asOfDate = utcDate(observedAt);
  let throughAt = new Date(observedAt.getTime() - delayMs);
  if (def.timeBasis === 'snapshot') {
    return { def, dimension, value: p.value, periodKey: `asof:${asOfDate}`, nativePeriod, kind: 'cumulative', basis: 'snapshot', windowStart: null, asOfDate, bucketDate: null, throughAt };
  }
  let basis: 'lifetime' | 'window' = 'lifetime';
  let windowStart: string | null = null;
  const w = WINDOW_RE.exec(nativePeriod);
  if (w) {
    windowStart = w[1]!;
    const endInstant = new Date(Date.parse(`${w[2]!}T00:00:00Z`) + 86_400_000);
    if (endInstant < throughAt) throughAt = endInstant;
    const published = t.publishedAt ? utcDate(t.publishedAt) : null;
    // A window that starts on/before the publication day covers the whole life of the post ⇒ lifetime.
    basis = published && windowStart <= published ? 'lifetime' : 'window';
  } else if (nativePeriod !== 'lifetime' && nativePeriod !== '') {
    return { reject: `unrecognised period "${nativePeriod}"` };
  }
  return { def, dimension, value: p.value, periodKey: `asof:${asOfDate}`, nativePeriod, kind: 'cumulative', basis, windowStart, asOfDate, bucketDate: null, throughAt };
}

async function lockSeries(tx: Queryable, t: IngestTarget) {
  await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 15))`, [`an:${t.connectionId}:${t.resourceId}`]);
}

/** Recompute observed changes (labelled deltas) for a cumulative series around `asOfDate`. */
async function recomputeObservedChanges(tx: Queryable, t: IngestTarget, n: Normalized): Promise<void> {
  if (n.basis === 'window') return; // rolling-window totals have no meaningful lifetime delta
  const key = [t.workspaceId, t.connectionId, t.resourceType, t.resourceId, n.def.id, n.dimension, n.def.version];
  const rows = (await tx.query<{ as_of_date: string; value: string; observed_at: Date }>(
    `(SELECT as_of_date::text, value::text, observed_at FROM metric_cumulative_facts
       WHERE workspace_id=$1 AND connection_id=$2 AND resource_type=$3 AND resource_id=$4 AND metric_id=$5 AND dimension=$6 AND definition_version=$7
         AND as_of_date < $8 AND basis <> 'window' ORDER BY as_of_date DESC LIMIT 1)
     UNION ALL
     (SELECT as_of_date::text, value::text, observed_at FROM metric_cumulative_facts
       WHERE workspace_id=$1 AND connection_id=$2 AND resource_type=$3 AND resource_id=$4 AND metric_id=$5 AND dimension=$6 AND definition_version=$7
         AND as_of_date >= $8 AND basis <> 'window' ORDER BY as_of_date LIMIT 2)
     ORDER BY 1`, [...key, n.asOfDate])).rows;
  // rows: [prev?, current, next?] in date order. Rebuild the change ending at `current` and the one ending at `next`.
  const idx = rows.findIndex((r) => r.as_of_date === n.asOfDate);
  for (const i of [idx, idx + 1]) {
    const cur = rows[i];
    if (!cur || i < 0) continue;
    const prev = rows[i - 1];
    if (!prev) {
      // One snapshot is not a history: no fabricated change.
      await tx.query(`DELETE FROM metric_daily_facts WHERE workspace_id=$1 AND connection_id=$2 AND resource_type=$3 AND resource_id=$4 AND metric_id=$5
                        AND dimension=$6 AND definition_version=$7 AND fact_kind='observed_change' AND bucket_date=$8`, [...key, cur.as_of_date]);
      continue;
    }
    await tx.query(
      `INSERT INTO metric_daily_facts(workspace_id, brand_id, connection_id, resource_type, resource_id, provider, metric_id, definition_version, dimension,
          fact_kind, bucket_date, bucket_tz, value, period_start, period_end, observed_at, source)
       VALUES ($1,$9,$2,$3,$4,$10,$5,$7,$6,'observed_change',$8,'UTC',$11,$12,$13,$13,$14)
       ON CONFLICT (workspace_id, connection_id, resource_type, resource_id, metric_id, dimension, definition_version, fact_kind, bucket_date)
       DO UPDATE SET value=EXCLUDED.value, period_start=EXCLUDED.period_start, period_end=EXCLUDED.period_end, observed_at=EXCLUDED.observed_at,
                     revision = metric_daily_facts.revision + CASE WHEN metric_daily_facts.value <> EXCLUDED.value THEN 1 ELSE 0 END`,
      [...key, cur.as_of_date, t.brandId, t.provider, Number(cur.value) - Number(prev.value), prev.observed_at, cur.observed_at, t.source]);
  }
}

/**
 * SQL computing rollup rows from metric_resource_latest. `where` filters `l` (alias of metric_resource_latest, post
 * rows); `$fam` is the engagement family array parameter. Output columns: connection_id, brand_id, provider, source,
 * bucket_start, metric_key, definition_version, dimension, value_sum, resources, min_through_at, min_observed_at,
 * max_observed_at. Used for maintenance (one bucket) and for filtered queries (per-post path) — same semantics.
 */
export function rollupSelectSql(where: string, fam: string, bucketExpr = 'l.rollup_bucket'): string {
  return `
  WITH lt AS (
    SELECT l.connection_id, l.brand_id, l.provider, l.source, ${bucketExpr} AS bucket_start, l.resource_id, l.metric_id, l.definition_version, l.dimension,
           l.value, l.through_at, l.observed_at, md.family
      FROM metric_resource_latest l JOIN metric_definitions md ON md.metric_id = l.metric_id AND md.version = l.definition_version
     WHERE l.resource_type = 'post' AND md.paid <> 'paid' AND ${where}
  ), per_metric AS (
    SELECT connection_id, brand_id, provider, source, bucket_start, metric_id AS metric_key, definition_version, dimension,
           sum(value) AS value_sum, count(DISTINCT resource_id)::int AS resources, min(through_at) AS min_through_at,
           min(observed_at) AS min_observed_at, max(observed_at) AS max_observed_at
      FROM lt GROUP BY 1,2,3,4,5,6,7,8
  ), per_post AS (
    SELECT connection_id, brand_id, provider, source, bucket_start, resource_id,
           sum(value) FILTER (WHERE family = ANY(${fam})) AS eng, bool_or(family = ANY(${fam})) AS has_eng,
           sum(value) FILTER (WHERE family = 'views') AS views, bool_or(family = 'views') AS has_views,
           sum(value) FILTER (WHERE family = 'impressions') AS impr, bool_or(family = 'impressions') AS has_impr,
           sum(value) FILTER (WHERE family = 'watch_time') AS wt, bool_or(family = 'watch_time') AS has_wt,
           min(through_at) AS mt, min(observed_at) AS mo, max(observed_at) AS xo
      FROM lt GROUP BY 1,2,3,4,5,6
  ), per_family AS (
    SELECT connection_id, brand_id, provider, source, bucket_start, '_family.' || family AS metric_key, 0 AS definition_version, '' AS dimension,
           sum(value) AS value_sum, count(DISTINCT resource_id)::int AS resources, min(through_at) AS min_through_at,
           min(observed_at) AS min_observed_at, max(observed_at) AS max_observed_at
      FROM lt GROUP BY 1,2,3,4,5,6
  ), derived AS (
    SELECT connection_id, brand_id, provider, source, bucket_start, k.metric_key, 0 AS definition_version, '' AS dimension,
           sum(CASE k.metric_key WHEN '${DERIVED.erViewsDen}' THEN views WHEN '${DERIVED.erImprDen}' THEN impr
                                 WHEN '${DERIVED.avdNum}' THEN wt * 60 WHEN '${DERIVED.avdDen}' THEN views ELSE eng END) AS value_sum,
           count(*)::int AS resources, min(mt) AS min_through_at, min(mo) AS min_observed_at, max(xo) AS max_observed_at
      FROM per_post
      JOIN (VALUES ('${DERIVED.engagements}'), ('${DERIVED.erViewsNum}'), ('${DERIVED.erViewsDen}'), ('${DERIVED.erImprNum}'), ('${DERIVED.erImprDen}'),
                   ('${DERIVED.avdNum}'), ('${DERIVED.avdDen}')) AS k(metric_key)
        ON (k.metric_key = '${DERIVED.engagements}' AND has_eng)
        OR (k.metric_key IN ('${DERIVED.erViewsNum}', '${DERIVED.erViewsDen}') AND has_eng AND has_views)
        OR (k.metric_key IN ('${DERIVED.erImprNum}', '${DERIVED.erImprDen}') AND has_eng AND has_impr)
        OR (k.metric_key IN ('${DERIVED.avdNum}', '${DERIVED.avdDen}') AND has_wt AND has_views)
     GROUP BY 1,2,3,4,5,6
  )
  SELECT * FROM per_metric UNION ALL SELECT * FROM per_family UNION ALL SELECT * FROM derived`;
}

/** Recompute the cached aggregate rows of ONE (connection, source, 15-minute bucket). */
export async function recomputeRollupBucket(tx: Queryable, workspaceId: string, connectionId: string, source: DataSource, bucket: Date): Promise<void> {
  await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 16))`, [`rollup:${connectionId}:${source}:${bucket.toISOString()}`]);
  await tx.query(`DELETE FROM metric_rollups WHERE workspace_id=$1 AND connection_id=$2 AND source=$3 AND bucket_start=$4`, [workspaceId, connectionId, source, bucket]);
  await tx.query(
    `INSERT INTO metric_rollups(connection_id, brand_id, provider, source, bucket_start, metric_key, definition_version, dimension, value_sum, resources,
        min_through_at, min_observed_at, max_observed_at, workspace_id)
     SELECT r.*, $1::uuid FROM (${rollupSelectSql('l.workspace_id = $1 AND l.connection_id = $2 AND l.source = $3 AND l.rollup_bucket = $4', '$5::text[]')}) r
      WHERE r.resources > 0`,
    [workspaceId, connectionId, source, bucket, ENGAGEMENT_FAMILIES]);
}

/**
 * Ingest provider points for one resource, observed at `observedAt`. One transaction; safe to retry.
 */
export async function ingestPoints(target: IngestTarget, points: MetricPoint[], observedAt: Date, opts: { syncRunId?: string | null; legacySnapshotId?: number | null; db?: PoolClient } = {}): Promise<IngestResult> {
  await ensureMetricRegistry();
  const result: IngestResult = { written: 0, unchanged: 0, corrections: 0, rejected: [] };
  const normalized: Normalized[] = [];
  for (const p of points) {
    const n = normalizePoint(target, p, observedAt);
    if ('reject' in n) result.rejected.push({ name: String(p.name).slice(0, 100), reason: n.reject });
    else normalized.push(n);
  }
  if (!normalized.length) return result;
  const run = async (tx: PoolClient) => {
    await lockSeries(tx, target);
    let latestChanged = false;
    for (const n of normalized) {
      const keyParams = [target.workspaceId, target.connectionId, target.resourceType, target.resourceId, n.def.id, n.periodKey, n.dimension, n.def.version];
      const before = (await tx.query<{ value: string; observed_at: Date }>(
        `SELECT value::text, observed_at FROM metric_observations WHERE workspace_id=$1 AND connection_id=$2 AND resource_type=$3 AND resource_id=$4
            AND metric_id=$5 AND period_key=$6 AND dimension=$7 AND definition_version=$8`, keyParams)).rows[0];
      if (before && before.observed_at > observedAt) { result.unchanged++; continue; } // older observation arrived late: newer kept
      const valueChanged = !!before && Number(before.value) !== n.value;
      await tx.query(
        `INSERT INTO metric_observations(workspace_id, brand_id, connection_id, resource_type, resource_id, provider, provider_object_id, metric_id, definition_version,
            native_metric, dimension, period_key, native_period, window_start, value, source, observed_at, first_observed_at, sync_run_id, legacy_snapshot_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$17,$18,$19)
         ON CONFLICT (workspace_id, connection_id, resource_type, resource_id, metric_id, period_key, dimension, definition_version) DO UPDATE SET
           previous_value = CASE WHEN $20 THEN metric_observations.value ELSE metric_observations.previous_value END,
           revision = metric_observations.revision + CASE WHEN $20 THEN 1 ELSE 0 END,
           corrected_at = CASE WHEN $20 THEN EXCLUDED.observed_at ELSE metric_observations.corrected_at END,
           value = EXCLUDED.value, window_start = EXCLUDED.window_start, native_period = EXCLUDED.native_period, observed_at = EXCLUDED.observed_at,
           sync_run_id = coalesce(EXCLUDED.sync_run_id, metric_observations.sync_run_id),
           legacy_snapshot_id = coalesce(metric_observations.legacy_snapshot_id, EXCLUDED.legacy_snapshot_id)`,
        [target.workspaceId, target.brandId, target.connectionId, target.resourceType, target.resourceId, target.provider, target.providerObjectId,
          n.def.id, n.def.version, n.def.nativeMetric, n.dimension, n.periodKey, n.nativePeriod || null, n.windowStart, n.value, target.source, observedAt,
          opts.syncRunId ?? null, opts.legacySnapshotId ?? null, valueChanged]);
      if (!before || valueChanged) {
        result.written++;
        if (valueChanged && (n.kind === 'daily' || n.value < Number(before!.value))) result.corrections++;
      } else {
        result.unchanged++;
      }
      if (n.kind === 'daily') {
        await tx.query(
          `INSERT INTO metric_daily_facts(workspace_id, brand_id, connection_id, resource_type, resource_id, provider, metric_id, definition_version, dimension,
              fact_kind, bucket_date, bucket_tz, value, period_start, period_end, observed_at, source)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'reported',$10,$11,$12,$13,$14,$15,$16)
           ON CONFLICT (workspace_id, connection_id, resource_type, resource_id, metric_id, dimension, definition_version, fact_kind, bucket_date)
           DO UPDATE SET value=EXCLUDED.value, observed_at=EXCLUDED.observed_at,
                         revision = metric_daily_facts.revision + CASE WHEN metric_daily_facts.value <> EXCLUDED.value THEN 1 ELSE 0 END
           WHERE EXCLUDED.observed_at >= metric_daily_facts.observed_at`,
          [target.workspaceId, target.brandId, target.connectionId, target.resourceType, target.resourceId, target.provider, n.def.id, n.def.version, n.dimension,
            n.bucketDate, 'UTC', n.value, `${n.bucketDate}T00:00:00Z`, new Date(Date.parse(`${n.bucketDate}T00:00:00Z`) + 86_400_000), observedAt, target.source]);
        continue;
      }
      await tx.query(
        `INSERT INTO metric_cumulative_facts(workspace_id, brand_id, connection_id, resource_type, resource_id, provider, metric_id, definition_version, dimension,
            as_of_date, basis, window_start, value, observed_at, through_at, source)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
         ON CONFLICT (workspace_id, connection_id, resource_type, resource_id, metric_id, dimension, definition_version, as_of_date)
         DO UPDATE SET value=EXCLUDED.value, basis=EXCLUDED.basis, window_start=EXCLUDED.window_start, observed_at=EXCLUDED.observed_at, through_at=EXCLUDED.through_at,
                       revision = metric_cumulative_facts.revision + CASE WHEN metric_cumulative_facts.value <> EXCLUDED.value THEN 1 ELSE 0 END
         WHERE EXCLUDED.observed_at >= metric_cumulative_facts.observed_at`,
        [target.workspaceId, target.brandId, target.connectionId, target.resourceType, target.resourceId, target.provider, n.def.id, n.def.version, n.dimension,
          n.asOfDate, n.basis, n.windowStart, n.value, observedAt, n.throughAt, target.source]);
      await recomputeObservedChanges(tx, target, n);
      const bucket = target.resourceType === 'post' && target.publishedAt ? rollupBucket(target.publishedAt) : null;
      const l = await tx.query(
        `INSERT INTO metric_resource_latest(workspace_id, brand_id, connection_id, resource_type, resource_id, provider, metric_id, definition_version, dimension,
            basis, value, as_of_date, observed_at, through_at, published_at, rollup_bucket, source)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
         ON CONFLICT (workspace_id, connection_id, resource_type, resource_id, metric_id, dimension, definition_version)
         DO UPDATE SET basis=EXCLUDED.basis, value=EXCLUDED.value, as_of_date=EXCLUDED.as_of_date, observed_at=EXCLUDED.observed_at, through_at=EXCLUDED.through_at,
                       published_at=EXCLUDED.published_at, rollup_bucket=EXCLUDED.rollup_bucket, source=EXCLUDED.source
         WHERE (EXCLUDED.as_of_date, EXCLUDED.observed_at) >= (metric_resource_latest.as_of_date, metric_resource_latest.observed_at)`,
        [target.workspaceId, target.brandId, target.connectionId, target.resourceType, target.resourceId, target.provider, n.def.id, n.def.version, n.dimension,
          n.basis, n.value, n.asOfDate, observedAt, n.throughAt, target.publishedAt, bucket, target.source]);
      if (l.rowCount) latestChanged = true;
    }
    if (latestChanged && target.resourceType === 'post' && target.publishedAt) {
      await recomputeRollupBucket(tx, target.workspaceId, target.connectionId, target.source, rollupBucket(target.publishedAt));
    }
  };
  if (opts.db) await run(opts.db); else await withTx(run);
  return result;
}

// ------------------------------------------------------------------ coverage
export interface CoverageOutcome {
  /** Whole-call state (ok when the provider answered). */
  state: FetchState;
  message: string | null;
  /** Metric names returned with a value. */
  reported: string[];
  /** Metric names the provider did not report, with its reason. */
  unavailable: Array<{ name: string; reason: string }>;
}

/** Classify a provider "not reported" reason. Delays are provider_delayed; everything else is unsupported for this resource. */
export function classifyUnavailable(reason: string): FetchState {
  return /delay|no analytics data yet|not available yet/i.test(reason) ? 'provider_delayed' : 'unsupported';
}

/**
 * Record the fetch outcome per metric (and the resource-level '*' row that drives cadence). A successful fetch with a
 * metric missing from the response is 'unsupported'/'provider_delayed' for that metric — never stored as 0.
 */
export async function recordCoverage(db: Queryable, t: IngestTarget, o: CoverageOutcome, at: Date, next: Date | null, runId: string | null): Promise<void> {
  const defs = t.resourceType === 'post' ? fetchedPostDefinitions(t.provider) : [];
  const reported = new Set(o.reported.map((n) => resolveNative(t.provider, n)?.id).filter(Boolean) as string[]);
  const unavailable = new Map<string, string>();
  for (const u of o.unavailable) { const id = resolveNative(t.provider, u.name)?.id; if (id) unavailable.set(id, u.reason); }
  const rows: Array<{ metric: string; state: FetchState; reason: string | null; success: boolean }> = [];
  for (const d of defs) {
    if (o.state !== 'ok') rows.push({ metric: d.id, state: o.state, reason: o.message, success: false });
    else if (reported.has(d.id)) rows.push({ metric: d.id, state: 'ok', reason: null, success: true });
    else if (unavailable.has(d.id)) rows.push({ metric: d.id, state: classifyUnavailable(unavailable.get(d.id)!), reason: unavailable.get(d.id)!.slice(0, 300), success: false });
    else rows.push({ metric: d.id, state: 'unsupported', reason: 'Not returned by the network for this content.', success: false });
  }
  rows.push({ metric: '*', state: o.state, reason: o.message, success: o.state === 'ok' });
  for (const r of rows) {
    await db.query(
      `INSERT INTO data_coverage(workspace_id, brand_id, connection_id, resource_type, resource_id, provider, metric_id, status, reason, last_attempt_at,
          last_success_at, next_attempt_at, consecutive_failures, last_sync_run_id, source, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, CASE WHEN $11 THEN $10::timestamptz END, $12, CASE WHEN $11 THEN 0 ELSE 1 END, $13, $14, now())
       ON CONFLICT (workspace_id, connection_id, resource_type, resource_id, metric_id) DO UPDATE SET
         status=EXCLUDED.status, reason=EXCLUDED.reason, last_attempt_at=EXCLUDED.last_attempt_at,
         last_success_at=CASE WHEN $11 THEN EXCLUDED.last_attempt_at ELSE data_coverage.last_success_at END,
         next_attempt_at=EXCLUDED.next_attempt_at,
         consecutive_failures=CASE WHEN $11 OR EXCLUDED.status IN ('unsupported','provider_delayed') THEN 0 ELSE data_coverage.consecutive_failures + 1 END,
         last_sync_run_id=coalesce(EXCLUDED.last_sync_run_id, data_coverage.last_sync_run_id), source=EXCLUDED.source, updated_at=now()`,
      [t.workspaceId, t.brandId, t.connectionId, t.resourceType, t.resourceId, t.provider, r.metric, r.state, r.reason, at, r.success, r.metric === '*' ? next : null, runId, t.source]);
  }
}
