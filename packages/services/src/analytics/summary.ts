// V3.1 PERF: precomputed per-local-day analytics summary (migration 025, table metric_rollup_days).
//  - Maintained incrementally by statement-level triggers on metric_rollups (any writer: ingest, rebuild, cascade).
//  - One zone per (workspace, time zone) — workspace and brand zones are tracked automatically; a zone is used by
//    readers only once the worker has backfilled it ('ready'). Other zones (e.g. a viewer-picked tz) read the
//    15-minute rollups exactly as before.
//  - Same grouping expression as the rollup query ((bucket_start AT TIME ZONE tz)::date), `source` in the key → the
//    summary is equal to the rollup aggregate (tests/integration/v31-analytics-summary.test.ts) and datasets never mix.
import { getPool, many, maybeOne, withTx, type Queryable } from '@social-lite/db';

let tableExists = false;

/** Is the per-day summary usable for this workspace + time zone? (false when migration 025 is missing). */
export async function summaryReady(workspaceId: string, tz: string, db: Queryable = getPool()): Promise<boolean> {
  if (!tableExists) {
    const r = await maybeOne<{ ok: boolean }>(db, `SELECT to_regclass('public.metric_summary_zones') IS NOT NULL AS ok`);
    if (!r?.ok) return false;
    tableExists = true;
  }
  const z = await maybeOne<{ status: string }>(db, `SELECT status FROM metric_summary_zones WHERE workspace_id=$1 AND tz=$2`, [workspaceId, tz]);
  return z?.status === 'ready';
}

/**
 * Backfill pending zones (worker): recompute every day that has rollups, one (connection, source) per transaction
 * (each takes the same advisory key the triggers use, so concurrent ingest serializes with it), then mark ready.
 * Bounded per call; returns the number of zones that became ready.
 */
export async function backfillSummaryZones(o: { maxCells?: number } = {}): Promise<{ ready: number; cells: number }> {
  const db = getPool();
  const exists = await maybeOne<{ ok: boolean }>(db, `SELECT to_regclass('public.metric_summary_zones') IS NOT NULL AS ok`);
  if (!exists?.ok) return { ready: 0, cells: 0 };
  const zones = await many<{ workspace_id: string; tz: string }>(db,
    `SELECT workspace_id, tz FROM metric_summary_zones WHERE status='pending' ORDER BY requested_at LIMIT 20`);
  let ready = 0; let cells = 0;
  const max = o.maxCells ?? 200;
  for (const z of zones) {
    if (cells >= max) break; // the bound applies between zones: a started zone is always finished (no restart loop)
    const pairs = await many<{ connection_id: string; source: string }>(db,
      `SELECT DISTINCT connection_id, source FROM metric_rollups WHERE workspace_id=$1`, [z.workspace_id]);
    for (const p of pairs) {
      await withTx(async (tx) => {
        await tx.query(
          `SELECT metric_rollup_days_refresh(array_agg(workspace_id), array_agg(connection_id), array_agg(source), array_agg(bucket_start), $4)
             FROM (SELECT DISTINCT workspace_id, connection_id, source, bucket_start FROM metric_rollups WHERE workspace_id=$1 AND connection_id=$2 AND source=$3) b`,
          [z.workspace_id, p.connection_id, p.source, z.tz]);
      });
      cells++;
    }
    const r = await db.query(`UPDATE metric_summary_zones SET status='ready', ready_at=now() WHERE workspace_id=$1 AND tz=$2 AND status='pending'`, [z.workspace_id, z.tz]);
    ready += r.rowCount ?? 0;
  }
  return { ready, cells };
}
