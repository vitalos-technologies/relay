// Legacy backfill: V1.1 metric_snapshots / metric_fetch_state → V3 pipeline (observations, facts, aggregates,
// coverage). Idempotent and checkpointed (system_flags 'analytics.legacy_backfill'); safe to run repeatedly and
// concurrently with live sync (fact keys dedupe; an older observation never overwrites a newer one).
// Unsupported / permission-missing / failed states become data_coverage rows — never zero-valued observations.
import type { Provider } from '@social-lite/core';
import { getPool, many, maybeOne, type Queryable } from '@social-lite/db';
import type { MetricPoint } from '@social-lite/providers/metrics';
import { log } from '../log.js';
import { nextAttemptAt } from './cadence.js';
import { ingestPoints, recordCoverage, type IngestTarget } from './ingest.js';
import type { FetchState } from './semantics.js';

const FLAG = 'analytics.legacy_backfill';

interface Progress { snapshot_id: number; delivery_id: string | null; done: boolean }

async function progress(db: Queryable): Promise<Progress> {
  const r = await maybeOne<{ value: Progress }>(db, `SELECT value FROM system_flags WHERE key=$1`, [FLAG]);
  return { snapshot_id: 0, delivery_id: null, done: false, ...(r?.value ?? {}) };
}

async function save(db: Queryable, p: Progress): Promise<void> {
  await db.query(`INSERT INTO system_flags(key, value, updated_by) VALUES ($1,$2,'analytics-backfill')
                  ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now(), updated_by=EXCLUDED.updated_by`, [FLAG, JSON.stringify(p)]);
}

const LEGACY_STATE: Record<string, FetchState> = {
  ok: 'ok', unsupported: 'unsupported', unavailable: 'not_found', permission_missing: 'permission_missing', budget_exhausted: 'budget_exhausted',
  reconnect: 'reconnect_required', error: 'fetch_failed',
};

export interface BackfillSummary { snapshots: number; observationsWritten: number; unchanged: number; rejected: number; coverageRows: number; done: boolean }

/** Process up to `batch` legacy snapshots and fetch states. Returns done=true when nothing is left. */
export async function backfillLegacySnapshots(opts: { batch?: number; restart?: boolean } = {}): Promise<BackfillSummary> {
  const db = getPool();
  const batch = Math.min(Math.max(opts.batch ?? 500, 1), 5000);
  const p: Progress = opts.restart ? { snapshot_id: 0, delivery_id: null, done: false } : await progress(db);
  const out: BackfillSummary = { snapshots: 0, observationsWritten: 0, unchanged: 0, rejected: 0, coverageRows: 0, done: false };

  // Phase 1: snapshots → observations (grouped per delivery + observation instant).
  const snaps = await many<{ id: string; workspace_id: string; brand_id: string; connection_id: string; delivery_id: string; provider: Provider; provider_object_id: string;
    metric: string; dimension: string | null; value: string; period: string; window_end: Date | null; observed_at: Date; source: 'provider' | 'simulated'; published_at: Date | null }>(db,
    `SELECT s.id::text, s.workspace_id, s.brand_id, s.connection_id, s.delivery_id, s.provider, s.provider_object_id, s.metric, s.dimension, s.value::text, s.period,
            s.window_end, s.observed_at, s.source, d.published_at
       FROM metric_snapshots s JOIN deliveries d ON d.id = s.delivery_id JOIN connections c ON c.id = s.connection_id AND NOT c.is_synthetic
      WHERE s.id > $1 ORDER BY s.id LIMIT $2`, [p.snapshot_id, batch]);
  const groups = new Map<string, typeof snaps>();
  for (const s of snaps) {
    const k = `${s.delivery_id}|${s.observed_at.toISOString()}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(s);
  }
  for (const rows of groups.values()) {
    const f = rows[0]!;
    const target: IngestTarget = { workspaceId: f.workspace_id, brandId: f.brand_id, connectionId: f.connection_id, provider: f.provider, resourceType: 'post',
      resourceId: f.delivery_id, providerObjectId: f.provider_object_id, publishedAt: f.published_at, source: f.source };
    const points: MetricPoint[] = rows.map((r) => ({ name: r.metric, dimension: r.dimension, value: Number(r.value), period: r.period, windowEnd: r.window_end ? r.window_end.toISOString().slice(0, 10) : null }));
    try {
      const res = await ingestPoints(target, points, f.observed_at, { legacySnapshotId: Number(rows[rows.length - 1]!.id) });
      out.observationsWritten += res.written; out.unchanged += res.unchanged; out.rejected += res.rejected.length;
    } catch (err) {
      log.warn('analytics_backfill_group_failed', { deliveryId: f.delivery_id, err: err as Error });
      throw err; // keep the checkpoint before this group; the job retries
    }
    out.snapshots += rows.length;
  }
  if (snaps.length) { p.snapshot_id = Number(snaps[snaps.length - 1]!.id); await save(db, p); }

  // Phase 2: fetch states → coverage (only where the V3 pipeline has not recorded anything yet).
  const states = await many<{ delivery_id: string; workspace_id: string; status: string; message: string | null; last_attempt_at: Date | null;
    brand_id: string; connection_id: string; provider: Provider; is_mock: boolean; published_at: Date | null; provider_ids: string[]; has_cov: boolean }>(db,
    `SELECT f.delivery_id, f.workspace_id, f.status, f.message, f.last_attempt_at, d.brand_id, d.connection_id, d.provider, d.is_mock, d.published_at, d.provider_ids,
            EXISTS (SELECT 1 FROM data_coverage dc WHERE dc.workspace_id = f.workspace_id AND dc.resource_type='post' AND dc.resource_id = f.delivery_id AND dc.metric_id='*') AS has_cov
       FROM metric_fetch_state f JOIN deliveries d ON d.id = f.delivery_id JOIN connections c ON c.id = d.connection_id AND NOT c.is_synthetic
      WHERE ($1::uuid IS NULL OR f.delivery_id > $1::uuid) AND f.status <> 'pending'
      ORDER BY f.delivery_id LIMIT $2`, [p.delivery_id, batch]);
  for (const s of states) {
    if (s.has_cov) continue;
    const state = LEGACY_STATE[s.status] ?? 'fetch_failed';
    const reported = state === 'ok'
      ? (await many<{ metric: string }>(db, `SELECT DISTINCT metric FROM metric_snapshots WHERE delivery_id=$1`, [s.delivery_id])).map((r) => r.metric) : [];
    const at = s.last_attempt_at ?? new Date();
    const target: IngestTarget = { workspaceId: s.workspace_id, brandId: s.brand_id, connectionId: s.connection_id, provider: s.provider, resourceType: 'post',
      resourceId: s.delivery_id, providerObjectId: s.provider_ids[0] ?? null, publishedAt: s.published_at, source: s.is_mock ? 'simulated' : 'provider' };
    await recordCoverage(db, target, { state, message: s.message, reported, unavailable: [] }, at, nextAttemptAt(s.provider, s.published_at, new Date(), state), null);
    out.coverageRows++;
  }
  if (states.length) { p.delivery_id = states[states.length - 1]!.delivery_id; await save(db, p); }
  out.done = snaps.length < batch && states.length < batch;
  if (out.done && !p.done) { p.done = true; await save(db, p); }
  return out;
}
