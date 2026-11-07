// Analytics sync (V3 spec §9 pipeline step "provider-specific metric sync jobs").
//  - One cursor per connection/stream (sync_cursors): keyset position (published_at, delivery id) checkpointed after
//    EVERY item, bounded backfill horizon, quota-aware cadence (cadence.ts), lease = one runner per connection.
//  - Per-workspace concurrency: at most ANALYTICS_WORKSPACE_CONCURRENCY connections of a workspace sync at once
//    (claims serialize on a workspace advisory lock and re-count live leases) — and pg-boss groupConcurrency on top.
//  - Publishing keeps priority: a run yields (checkpointed) while publishing work is due.
//  - Authority is re-checked when the job RUNS and before every item: a disconnected/revoked/reconnect-required
//    connection, archived brand or suspended workspace stops the cursor (status 'stopped', stop_reason) — never acting
//    on ids from the queue payload alone.
//  - Runs are idempotent per job key (sync_runs.job_key UNIQUE): a redelivered job never starts a second run, and
//    re-fetching the same facts never duplicates them (ingest.ts fact keys).
import { randomUUID } from 'node:crypto';
import type { Provider } from '@social-lite/core';
import { getPool, many, maybeOne, withTx, type Queryable } from '@social-lite/db';
import { log } from '../log.js';
import { backfillDays } from './cadence.js';
import { fetchedPostDefinitions } from './registry.js';
import { refreshDeliveryMetrics, type AnalyticsDeps, type RefreshResult } from './index.js';

export const QUEUE_ANALYTICS_SYNC = 'analytics-sync';
export const SYNC_LEASE_SECONDS = 600;
export const DEFAULT_MAX_ITEMS = 50;

export function workspaceSyncConcurrency(): number {
  const n = Number(process.env.ANALYTICS_WORKSPACE_CONCURRENCY ?? 2);
  return Number.isInteger(n) && n >= 1 ? n : 2;
}

function publishingBacklogThreshold(): number {
  const n = Number(process.env.ANALYTICS_YIELD_DUE_DELIVERIES ?? 25);
  return Number.isInteger(n) && n >= 0 ? n : 25;
}

export type StopReason = 'unsupported' | 'access_revoked' | 'reconnect_required' | 'connection_paused' | 'brand_archived' | 'workspace_suspended' | 'budget_exhausted' | 'synthetic';

interface ConnRow {
  id: string; workspace_id: string; brand_id: string; provider: Provider; status: string; is_mock: boolean; is_synthetic: boolean;
  disconnected_at: Date | null; brand_archived: Date | null; ws_state: string;
}

const CONN_SQL = `SELECT c.id, c.workspace_id, c.brand_id, c.provider, c.status::text AS status, c.is_mock, c.is_synthetic, c.disconnected_at,
                         b.archived_at AS brand_archived, w.state AS ws_state
                    FROM connections c JOIN brands b ON b.id = c.brand_id JOIN workspaces w ON w.id = c.workspace_id`;

/** Whether analytics may be read for this connection RIGHT NOW (re-evaluated at run time and per item). */
export function gateFor(c: ConnRow): StopReason | null {
  if (c.is_synthetic) return 'synthetic';
  if (c.ws_state !== 'active') return 'workspace_suspended';
  if (c.brand_archived) return 'brand_archived';
  if (c.disconnected_at || c.status === 'disconnected') return 'access_revoked';
  if (c.status === 'reconnect_required') return 'reconnect_required';
  if (!fetchedPostDefinitions(c.provider).length) return 'unsupported';
  return null;
}

/**
 * Create cursors for eligible connections and (re)evaluate stop conditions. Revocable stops (reconnect, revoked,
 * archived, suspended) are lifted automatically once the condition clears. Bounded per call.
 */
export async function ensureSyncCursors(opts: { workspaceId?: string; limit?: number } = {}, db: Queryable = getPool()): Promise<{ created: number; stopped: number; reactivated: number }> {
  const rows = await many<ConnRow & { has_cursor: boolean; cur_status: string | null; cur_reason: string | null }>(db,
    `${CONN_SQL} LEFT JOIN sync_cursors sc ON sc.connection_id = c.id AND sc.stream = 'post_metrics'
      WHERE ($1::uuid IS NULL OR c.workspace_id = $1)
        AND (sc.connection_id IS NULL OR sc.status = 'active' OR sc.stop_reason NOT IN ('unsupported','synthetic'))
        AND NOT (sc.connection_id IS NULL AND (c.disconnected_at IS NOT NULL OR c.is_synthetic))
      ORDER BY sc.updated_at NULLS FIRST LIMIT $2`.replace('SELECT c.id,', 'SELECT sc.connection_id IS NOT NULL AS has_cursor, sc.status AS cur_status, sc.stop_reason AS cur_reason, c.id,'),
    [opts.workspaceId ?? null, Math.min(Math.max(opts.limit ?? 500, 1), 5000)]);
  let created = 0; let stopped = 0; let reactivated = 0;
  for (const c of rows) {
    const reason = gateFor(c);
    if (!c.has_cursor) {
      const days = backfillDays(c.provider);
      await db.query(
        `INSERT INTO sync_cursors(workspace_id, brand_id, connection_id, stream, status, stop_reason, backfill_from, next_run_at)
         VALUES ($1,$2,$3,'post_metrics',$4,$5, now() - make_interval(days => $6), now()) ON CONFLICT DO NOTHING`,
        [c.workspace_id, c.brand_id, c.id, reason ? 'stopped' : 'active', reason, days]);
      created++;
      if (reason) stopped++;
      continue;
    }
    if (reason && c.cur_status === 'active') {
      await db.query(`UPDATE sync_cursors SET status='stopped', stop_reason=$2, lease_owner=NULL, lease_expires_at=NULL, updated_at=now() WHERE connection_id=$1 AND stream='post_metrics'`, [c.id, reason]);
      stopped++;
    } else if (!reason && c.cur_status === 'stopped' && c.cur_reason !== 'budget_exhausted') {
      await db.query(`UPDATE sync_cursors SET status='active', stop_reason=NULL, next_run_at=now(), consecutive_failures=0, updated_at=now() WHERE connection_id=$1 AND stream='post_metrics'`, [c.id]);
      reactivated++;
    } else {
      await db.query(`UPDATE sync_cursors SET updated_at=now() WHERE connection_id=$1 AND stream='post_metrics'`, [c.id]);
    }
  }
  return { created, stopped, reactivated };
}

/** Stop sync for a connection immediately (called on disconnect/revocation paths and by the gate). */
export async function stopConnectionSync(connectionId: string, reason: StopReason, db: Queryable = getPool()): Promise<void> {
  await db.query(`UPDATE sync_cursors SET status='stopped', stop_reason=$2, lease_owner=NULL, lease_expires_at=NULL, updated_at=now() WHERE connection_id=$1`, [connectionId, reason]);
}

export interface SyncJob { connectionId: string; stream: 'post_metrics'; jobKey: string; workspaceId: string }

/** Due cursors → jobs (deterministic job keys per cursor + scheduled slot ⇒ duplicate enqueues collapse). */
export async function dueSyncJobs(limit = 100, db: Queryable = getPool()): Promise<SyncJob[]> {
  const rows = await many<{ connection_id: string; workspace_id: string; next_run_at: Date }>(db,
    `SELECT connection_id, workspace_id, next_run_at FROM sync_cursors
      WHERE status = 'active' AND next_run_at <= now() AND (lease_owner IS NULL OR lease_expires_at < now())
      ORDER BY next_run_at LIMIT $1`, [limit]);
  return rows.map((r) => ({ connectionId: r.connection_id, workspaceId: r.workspace_id, stream: 'post_metrics', jobKey: `analytics-sync:${r.connection_id}:post_metrics:${r.next_run_at.toISOString()}` }));
}

export interface SyncRunSummary {
  runId: string | null;
  status: 'succeeded' | 'partial' | 'failed' | 'cancelled' | 'skipped';
  stopReason: string | null;
  processed: number;
  failed: number;
  written: number;
  unchanged: number;
  corrections: number;
  rejected: number;
}

const skipped = (stopReason: string): SyncRunSummary => ({ runId: null, status: 'skipped', stopReason, processed: 0, failed: 0, written: 0, unchanged: 0, corrections: 0, rejected: 0 });

async function claimCursor(connectionId: string, owner: string): Promise<{ ok: true; cursor: { workspace_id: string; brand_id: string; cursor: { published_at: string; id: string } | null; backfill_from: Date; interval_minutes: number; last_success_at: Date | null } } | { ok: false; reason: string }> {
  return withTx(async (tx) => {
    const c = await maybeOne<{ workspace_id: string; status: string }>(tx, `SELECT workspace_id, status FROM sync_cursors WHERE connection_id=$1 AND stream='post_metrics'`, [connectionId]);
    if (!c) return { ok: false as const, reason: 'no_cursor' };
    if (c.status !== 'active') return { ok: false as const, reason: 'stopped' };
    await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 17))`, [`an-ws:${c.workspace_id}`]);
    const live = await maybeOne<{ n: number }>(tx,
      `SELECT count(*)::int n FROM sync_cursors WHERE workspace_id=$1 AND lease_owner IS NOT NULL AND lease_expires_at > now() AND connection_id <> $2`, [c.workspace_id, connectionId]);
    if ((live?.n ?? 0) >= workspaceSyncConcurrency()) return { ok: false as const, reason: 'workspace_concurrency' };
    const r = await maybeOne<{ workspace_id: string; brand_id: string; cursor: { published_at: string; id: string } | null; backfill_from: Date; interval_minutes: number; last_success_at: Date | null }>(tx,
      `UPDATE sync_cursors SET lease_owner=$2, lease_expires_at=now() + make_interval(secs => $3), pass_started_at=coalesce(pass_started_at, now()), updated_at=now()
        WHERE connection_id=$1 AND stream='post_metrics' AND status='active' AND (lease_owner IS NULL OR lease_expires_at < now())
        RETURNING workspace_id, brand_id, cursor, backfill_from, interval_minutes, last_success_at`, [connectionId, owner, SYNC_LEASE_SECONDS]);
    return r ? { ok: true as const, cursor: r } : { ok: false as const, reason: 'busy' };
  });
}

async function publishingBacklog(db: Queryable): Promise<number> {
  const r = await maybeOne<{ n: number }>(db,
    `SELECT count(*)::int n FROM (SELECT 1 FROM deliveries WHERE state IN ('scheduled','retry_wait') AND next_attempt_at <= now() LIMIT 1000) x`);
  return r?.n ?? 0;
}

/**
 * Run (part of) a sync pass for one connection. Safe to call concurrently and repeatedly with the same job key.
 */
export async function runConnectionSync(connectionId: string, deps: AnalyticsDeps, opts: { workerId?: string; jobKey?: string; trigger?: 'schedule' | 'backfill' | 'manual' | 'retry'; maxItems?: number } = {}): Promise<SyncRunSummary> {
  const db = getPool();
  const owner = opts.workerId ?? `sync-${randomUUID().slice(0, 8)}`;
  const conn = await maybeOne<ConnRow>(db, `${CONN_SQL} WHERE c.id = $1`, [connectionId]);
  if (!conn) return skipped('connection_missing');
  // Re-check authority before anything else: revoked access stops sync (never trust the queue payload).
  const gate = gateFor(conn);
  if (gate) { await stopConnectionSync(connectionId, gate); return skipped(gate); }
  const claim = await claimCursor(connectionId, owner);
  if (!claim.ok) return skipped(claim.reason);
  const cur = claim.cursor;
  const jobKey = opts.jobKey ?? `analytics-sync:${connectionId}:post_metrics:manual:${randomUUID()}`;
  const trigger = opts.trigger ?? (cur.last_success_at ? 'schedule' : 'backfill');
  const run = await maybeOne<{ id: string }>(db,
    `INSERT INTO sync_runs(workspace_id, brand_id, connection_id, stream, trigger, job_key, worker_id) VALUES ($1,$2,$3,'post_metrics',$4,$5,$6)
     ON CONFLICT (job_key) DO NOTHING RETURNING id`, [cur.workspace_id, cur.brand_id, connectionId, trigger, jobKey, owner]);
  if (!run) {
    await db.query(`UPDATE sync_cursors SET lease_owner=NULL, lease_expires_at=NULL WHERE connection_id=$1 AND lease_owner=$2`, [connectionId, owner]);
    return skipped('duplicate_job');
  }
  const s: SyncRunSummary = { runId: run.id, status: 'succeeded', stopReason: null, processed: 0, failed: 0, written: 0, unchanged: 0, corrections: 0, rejected: 0 };
  const maxItems = Math.min(Math.max(opts.maxItems ?? DEFAULT_MAX_ITEMS, 1), 1000);
  let cursor = cur.cursor;
  let passComplete = false;
  let nextRunAt: Date | null = null;
  let anySuccess = false;
  try {
    for (let i = 0; i < maxItems; i++) {
      // Per-item authority re-check (revocation mid-run stops immediately).
      const now = await maybeOne<ConnRow>(db, `${CONN_SQL} WHERE c.id = $1`, [connectionId]);
      const g = now ? gateFor(now) : 'access_revoked';
      if (g) { s.status = 'cancelled'; s.stopReason = g; await stopConnectionSync(connectionId, g); break; }
      if ((await publishingBacklog(db)) > publishingBacklogThreshold()) {
        s.status = 'partial'; s.stopReason = 'publishing_priority'; nextRunAt = new Date(Date.now() + 2 * 60_000); break;
      }
      const item = await maybeOne<{ id: string; published_at: Date }>(db,
        `SELECT d.id, d.published_at FROM deliveries d
           LEFT JOIN data_coverage dc ON dc.workspace_id = d.workspace_id AND dc.connection_id = d.connection_id AND dc.resource_type = 'post'
                                     AND dc.resource_id = d.id AND dc.metric_id = '*'
          WHERE d.workspace_id = $1 AND d.connection_id = $2 AND d.state = 'published' AND d.published_at IS NOT NULL AND d.published_at >= $3
            AND ($4::timestamptz IS NULL OR (d.published_at, d.id) > ($4::timestamptz, $5::uuid))
            AND (dc.resource_id IS NULL OR (dc.next_attempt_at IS NOT NULL AND dc.next_attempt_at <= now()))
          ORDER BY d.published_at, d.id LIMIT 1`,
        [cur.workspace_id, connectionId, cur.backfill_from, cursor?.published_at ?? null, cursor?.id ?? null]);
      if (!item) { passComplete = true; break; }
      let res: RefreshResult | null = null;
      try {
        res = await refreshDeliveryMetrics(item.id, deps, { syncRunId: run.id });
      } catch (err) {
        log.warn('analytics_sync_item_failed', { connectionId, deliveryId: item.id, err: err as Error });
        s.failed++;
      }
      cursor = { published_at: item.published_at.toISOString(), id: item.id };
      // Checkpoint after every item (crash ⇒ resume here; the item itself is idempotent).
      await db.query(`UPDATE sync_cursors SET cursor=$2, lease_expires_at=now() + make_interval(secs => $3), updated_at=now() WHERE connection_id=$1 AND stream='post_metrics' AND lease_owner=$4`,
        [connectionId, JSON.stringify(cursor), SYNC_LEASE_SECONDS, owner]);
      if (!res) continue;
      s.processed++;
      if (res.ingest) { s.written += res.ingest.written; s.unchanged += res.ingest.unchanged; s.corrections += res.ingest.corrections; s.rejected += res.ingest.rejected.length; }
      if (res.state === 'ok' || res.state === 'provider_delayed' || res.state === 'unsupported' || res.state === 'not_found') anySuccess = true;
      else s.failed++;
      if (res.state === 'rate_limited') { s.status = 'partial'; s.stopReason = 'rate_limited'; nextRunAt = new Date(Date.now() + Math.max(res.retryAfterMs ?? 3_600_000, 60_000)); break; }
      if (res.state === 'budget_exhausted') { s.status = 'partial'; s.stopReason = 'budget_exhausted'; nextRunAt = new Date(Date.now() + 24 * 3_600_000); break; }
      if (res.state === 'reconnect_required') { s.status = 'cancelled'; s.stopReason = 'reconnect_required'; await stopConnectionSync(connectionId, 'reconnect_required'); break; }
    }
    if (s.status === 'succeeded' && !passComplete) s.status = 'partial'; // more due items remain: continue soon
    if (s.status === 'succeeded' && s.failed > 0) s.status = s.processed > s.failed ? 'partial' : 'failed';
  } catch (err) {
    s.status = 'failed'; s.stopReason = 'error';
    log.error('analytics_sync_failed', { connectionId, err: err as Error });
  } finally {
    const interval = cur.interval_minutes;
    const next = nextRunAt ?? (passComplete ? new Date(Date.now() + interval * 60_000) : new Date(Date.now() + 60_000));
    await db.query(
      `UPDATE sync_cursors SET lease_owner=NULL, lease_expires_at=NULL, updated_at=now(), last_run_id=$2,
              cursor = CASE WHEN $3 THEN NULL ELSE cursor END, pass_started_at = CASE WHEN $3 THEN NULL ELSE pass_started_at END,
              next_run_at = CASE WHEN status='active' THEN $4 ELSE next_run_at END,
              last_success_at = CASE WHEN $5 OR ($3 AND $6 = 0) THEN now() ELSE last_success_at END,
              consecutive_failures = CASE WHEN $7 THEN consecutive_failures + 1 ELSE 0 END
        WHERE connection_id=$1 AND stream='post_metrics'`,
      [connectionId, run.id, passComplete, next, anySuccess, s.failed, s.status === 'failed']);
    await db.query(
      `UPDATE sync_runs SET status=$2, stop_reason=$3, items_processed=$4, items_failed=$5, observations_written=$6, observations_unchanged=$7, corrections=$8,
              rejected=$9, finished_at=now() WHERE id=$1`,
      [run.id, s.status, s.stopReason, s.processed, s.failed, s.written, s.unchanged, s.corrections, s.rejected]);
  }
  return s;
}

/** Ask for a sync soon (no provider call in the request). Throttled per connection. */
export async function requestConnectionSync(connectionId: string, db: Queryable = getPool()): Promise<{ next_run_at: string; throttled: boolean }> {
  const r = await maybeOne<{ next_run_at: Date }>(db,
    `UPDATE sync_cursors SET next_run_at = now(), updated_at = now()
      WHERE connection_id=$1 AND stream='post_metrics' AND status='active'
        AND (last_run_id IS NULL OR NOT EXISTS (SELECT 1 FROM sync_runs r WHERE r.id = sync_cursors.last_run_id AND r.started_at > now() - interval '15 minutes'))
      RETURNING next_run_at`, [connectionId]);
  if (r) return { next_run_at: r.next_run_at.toISOString(), throttled: false };
  const cur = await maybeOne<{ next_run_at: Date }>(db, `SELECT next_run_at FROM sync_cursors WHERE connection_id=$1 AND stream='post_metrics'`, [connectionId]);
  return { next_run_at: (cur?.next_run_at ?? new Date()).toISOString(), throttled: true };
}
