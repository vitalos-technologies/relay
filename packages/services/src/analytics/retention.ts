// Analytics retention (V3 spec §9 "Account/content deletion and lost access have explicit retention handling"):
//  - Content deleted ON THE NETWORK (fetch state not_found): refresh stops; last observed values stay, labelled.
//  - Content deleted IN RELAY (delivery row gone): its facts are removed and the affected rollup buckets recomputed.
//  - Lost access (connection disconnected): sync stops immediately (sync.ts gate); historical facts stay visible,
//    labelled "access ended", for ANALYTICS_DISCONNECTED_RETENTION_DAYS (default 90), then are purged.
//  - Raw observations are kept ANALYTICS_RAW_RETENTION_DAYS (default 400); normalized facts are kept with the account.
import { getPool, many, withTx } from '@social-lite/db';
import { recomputeRollupBucket, type DataSource } from './ingest.js';

const days = (name: string, d: number) => { const n = Number(process.env[name] ?? d); return Number.isFinite(n) && n > 0 ? n : d; };
const TABLES = ['metric_observations', 'metric_cumulative_facts', 'metric_daily_facts', 'metric_resource_latest', 'metric_rollups', 'data_coverage'] as const;

export async function purgeAnalyticsRetention(limit = 200): Promise<{ rawDeleted: number; connectionsPurged: number; orphansPurged: number }> {
  const db = getPool();
  const raw = await db.query(
    `DELETE FROM metric_observations WHERE id IN (SELECT id FROM metric_observations WHERE observed_at < now() - make_interval(days => $1) LIMIT 5000)`,
    [days('ANALYTICS_RAW_RETENTION_DAYS', 400)]);
  const gone = await many<{ id: string; workspace_id: string }>(db,
    `SELECT c.id, c.workspace_id FROM connections c WHERE c.disconnected_at < now() - make_interval(days => $1)
        AND EXISTS (SELECT 1 FROM metric_resource_latest l WHERE l.workspace_id = c.workspace_id AND l.connection_id = c.id) LIMIT $2`,
    [days('ANALYTICS_DISCONNECTED_RETENTION_DAYS', 90), limit]);
  for (const c of gone) {
    await withTx(async (tx) => { for (const t of TABLES) await tx.query(`DELETE FROM ${t} WHERE workspace_id=$1 AND connection_id=$2`, [c.workspace_id, c.id]); });
  }
  const orphans = await many<{ workspace_id: string; connection_id: string; resource_id: string; source: DataSource; rollup_bucket: Date | null }>(db,
    `SELECT DISTINCT l.workspace_id, l.connection_id, l.resource_id, l.source, l.rollup_bucket FROM metric_resource_latest l
      WHERE l.resource_type = 'post' AND NOT EXISTS (SELECT 1 FROM deliveries d WHERE d.id = l.resource_id) LIMIT $1`, [limit]);
  for (const o of orphans) {
    await withTx(async (tx) => {
      for (const t of TABLES.filter((x) => x !== 'metric_rollups')) {
        await tx.query(`DELETE FROM ${t} WHERE workspace_id=$1 AND connection_id=$2 AND resource_type='post' AND resource_id=$3`, [o.workspace_id, o.connection_id, o.resource_id]);
      }
      if (o.rollup_bucket) await recomputeRollupBucket(tx, o.workspace_id, o.connection_id, o.source, o.rollup_bucket);
    });
  }
  return { rawDeleted: raw.rowCount ?? 0, connectionsPurged: gone.length, orphansPurged: orphans.length };
}
