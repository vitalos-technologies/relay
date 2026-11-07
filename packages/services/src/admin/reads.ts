// V3.1 Admin read models for Connections (§9), Content jobs + storage (§10), Analytics ingestion (§11) and inbound
// webhooks (§12). Stored data only (no provider/Google/Notion calls in a request), bounded queries, brand-scoped,
// permission-gated per section. Actions stay on their existing routes (reconnect, pause, diagnostics, resync, retry).
import { z } from 'zod';
import type { Provider } from '@social-lite/core';
import { getPool, many, one, type Queryable } from '@social-lite/db';
import type { Ctx } from '../context.js';
import { canAnywhere } from '../access.js';
import { requireAction } from '../tenancy.js';

const iso = (d: Date | null | undefined) => d?.toISOString() ?? null;
/** Error text from jobs can quote provider responses: keep it short and strip anything token-like. */
export function safeError(s: string | null | undefined): string | null {
  if (!s) return null;
  return s.replace(/(bearer|basic)\s+\S+/gi, '$1 <redacted>').replace(/([?&](?:access_token|token|key|secret|code|signature)=)[^&\s]+/gi, '$1<redacted>')
    .replace(/\b(?:sk|pk|xox[abp]|ghp|ya29)[-_.A-Za-z0-9]{12,}\b/g, '<redacted>').slice(0, 200);
}

// ------------------------------------------------------------------ connections
export interface AdminConnection {
  id: string; brand_id: string; brand_name: string; provider: Provider; display_name: string; username: string | null;
  status: string; paused: boolean; disconnected_at: string | null; simulated: boolean;
  token_expires_at: string | null; refresh_expires_at: string | null; scopes: number | null; throttled_until: string | null; checked_at: string | null;
  last_published_at: string | null; last_sync_ok_at: string | null; last_sync_failed: { at: string; code: string | null } | null; sync_state: string | null;
  upcoming: number; capabilities: string[];
}

export async function adminConnections(ctx: Ctx, db: Queryable = getPool()): Promise<{ items: AdminConnection[] }> {
  requireAction(ctx, 'connections.read');
  const rows = await many<{
    id: string; brand_id: string; brand_name: string; provider: Provider; display_name: string; username: string | null; status: string; paused: boolean;
    disconnected_at: Date | null; simulated: boolean; expires_at: Date | null; refresh_expires_at: Date | null; scopes: number | null; throttled_until: Date | null;
    health_checked_at: Date | null; last_published_at: Date | null; last_ok: Date | null; fail_at: Date | null; fail_code: string | null; sync_state: string | null;
    upcoming: number; capabilities: Record<string, unknown> | null;
  }>(db,
    `SELECT c.id, c.brand_id, b.name brand_name, c.provider, c.display_name, c.username, c.status::text, c.paused, c.disconnected_at, (c.is_mock OR c.is_synthetic) simulated,
            cr.expires_at, cr.refresh_expires_at, cardinality(cr.granted_scopes) scopes, c.throttled_until, c.health_checked_at,
            (SELECT max(d.published_at) FROM deliveries d WHERE d.connection_id=c.id AND d.state='published') last_published_at,
            (SELECT max(k.last_success_at) FROM sync_cursors k WHERE k.connection_id=c.id) last_ok,
            f.started_at fail_at, f.error_code fail_code,
            (SELECT k.status FROM sync_cursors k WHERE k.connection_id=c.id ORDER BY k.updated_at DESC LIMIT 1) sync_state,
            (SELECT count(*)::int FROM deliveries d WHERE d.connection_id=c.id AND d.state IN ('scheduled','retry_wait','paused','blocked') AND d.publish_before > now()) upcoming,
            c.capabilities
       FROM connections c JOIN brands b ON b.id=c.brand_id
       LEFT JOIN credentials cr ON cr.id=c.credential_id AND cr.workspace_id=c.workspace_id
       LEFT JOIN LATERAL (SELECT r.started_at, r.error_code FROM sync_runs r WHERE r.connection_id=c.id AND r.status='failed' ORDER BY r.started_at DESC LIMIT 1) f ON true
      WHERE c.workspace_id=$1 AND ($2::uuid[] IS NULL OR c.brand_id = ANY($2)) AND (c.disconnected_at IS NULL OR c.disconnected_at > now() - interval '30 days')
      ORDER BY b.name, c.provider, c.display_name LIMIT 500`, [ctx.access.workspaceId, ctx.access.brandIds]);
  return {
    items: rows.map((r) => ({
      id: r.id, brand_id: r.brand_id, brand_name: r.brand_name, provider: r.provider, display_name: r.display_name, username: r.username,
      status: r.disconnected_at ? 'disconnected' : r.status, paused: r.paused, disconnected_at: iso(r.disconnected_at), simulated: r.simulated,
      token_expires_at: iso(r.expires_at), refresh_expires_at: iso(r.refresh_expires_at), scopes: r.scopes, throttled_until: iso(r.throttled_until),
      checked_at: iso(r.health_checked_at), last_published_at: iso(r.last_published_at), last_sync_ok_at: iso(r.last_ok),
      last_sync_failed: r.fail_at ? { at: r.fail_at.toISOString(), code: r.fail_code } : null, sync_state: r.sync_state, upcoming: r.upcoming,
      capabilities: Object.entries(r.capabilities ?? {}).filter(([, v]) => v === true || (typeof v === 'object' && v !== null)).map(([k]) => k).slice(0, 12),
    })),
  };
}

// ------------------------------------------------------------------ jobs (imports, exports, writebacks, reports, bulk, media)
export const JOB_KINDS = ['import', 'export', 'writeback', 'report', 'bulk', 'media'] as const;
export type JobKind = (typeof JOB_KINDS)[number];
export interface AdminJob { id: string; kind: JobKind; title: string; status: string; failed: boolean; error: string | null; brand_name: string | null; by: string | null; created_at: string; finished_at: string | null; detail: string | null }

const jobsQuery = z.object({ kind: z.enum(JOB_KINDS).optional().nullable(), status: z.enum(['failed', 'running', 'all']).optional().nullable() });

export async function adminJobs(ctx: Ctx, raw: unknown, db: Queryable = getPool()): Promise<{ items: AdminJob[]; kinds: JobKind[]; storage: { bytes: number; assets: number; trashed_assets: number; trashed_posts: number; held: number } | null }> {
  requireAction(ctx, 'content.read');
  const q = jobsQuery.parse(raw ?? {});
  const ws = ctx.access.workspaceId;
  const brands = ctx.access.brandIds;
  const can = (p: Parameters<typeof canAnywhere>[1]) => canAnywhere(ctx, p);
  const kinds = JOB_KINDS.filter((k) => (k === 'report' ? can('analytics.read') : k === 'media' ? can('assets.read') : true));
  const want = (k: JobKind) => kinds.includes(k) && (!q.kind || q.kind === k);
  const st = q.status ?? 'all';
  const failedOnly = st === 'failed';
  const running = st === 'running';
  const items: AdminJob[] = [];
  const push = (kind: JobKind, rows: Array<{ id: string; title: string | null; status: string; error: string | null; brand_name: string | null; by: string | null; created_at: Date; finished_at: Date | null; detail?: string | null }>, failed: (s: string) => boolean) => {
    for (const r of rows) items.push({ id: r.id, kind, title: r.title || kind, status: r.status, failed: failed(r.status), error: safeError(r.error), brand_name: r.brand_name, by: r.by, created_at: r.created_at.toISOString(), finished_at: iso(r.finished_at), detail: r.detail ?? null });
  };
  const filt = (failedSet: string[], runningSet: string[]) => (failedOnly ? `AND x.status = ANY('{${failedSet.join(',')}}'::text[])` : running ? `AND x.status = ANY('{${runningSet.join(',')}}'::text[])` : '');
  const B = `AND ($2::uuid[] IS NULL OR x.brand_id = ANY($2))`;
  if (want('import')) push('import', await many(db,
    `SELECT x.id, coalesce(si.title, x.action) title, x.status, coalesce(x.error_code || ': ', '') || coalesce(x.error_message, '') error, b.name brand_name, u.email::text "by", x.created_at, x.completed_at finished_at
       FROM imports x LEFT JOIN source_items si ON si.id=x.source_item_id LEFT JOIN brands b ON b.id=x.brand_id LEFT JOIN users u ON u.id=x.requested_by
      WHERE x.workspace_id=$1 ${B} ${filt(['failed', 'partial'], ['queued', 'running'])} ORDER BY x.created_at DESC LIMIT 50`, [ws, brands]),
    (s) => s === 'failed' || s === 'partial');
  if (want('export')) push('export', await many(db,
    `SELECT x.id, x.title, x.status, coalesce(x.error_code || ': ', '') || coalesce(x.error_message, '') error, b.name brand_name, u.email::text "by", x.created_at, x.completed_at finished_at, x.destination_kind detail
       FROM export_jobs x LEFT JOIN brands b ON b.id=x.brand_id LEFT JOIN users u ON u.id=x.requested_by
      WHERE x.workspace_id=$1 ${B} ${filt(['failed'], ['queued', 'running'])} ORDER BY x.created_at DESC LIMIT 50`, [ws, brands]), (s) => s === 'failed');
  if (want('writeback')) push('writeback', await many(db,
    `SELECT x.id, x.field title, x.status, coalesce(x.conflict_detail::text, x.error_message) error, b.name brand_name, NULL::text "by", x.created_at, x.completed_at finished_at, x.origin detail
       FROM writeback_jobs x LEFT JOIN brands b ON b.id=x.brand_id
      WHERE x.workspace_id=$1 ${B} ${filt(['failed', 'conflict'], ['pending', 'running'])} ORDER BY x.created_at DESC LIMIT 50`, [ws, brands]), (s) => s === 'failed' || s === 'conflict');
  if (want('report')) push('report', await many(db,
    `SELECT x.id, coalesce(x.filename, x.view || ' ' || x.format) title, x.status, coalesce(x.error_code || ': ', '') || coalesce(x.error_message, '') error, NULL::text brand_name, u.email::text "by", x.created_at, x.finished_at, x.destination detail
       FROM report_exports x LEFT JOIN users u ON u.id=x.requested_by
      WHERE x.workspace_id=$1 ${filt(['failed'], ['queued', 'running'])} ORDER BY x.created_at DESC LIMIT 50`, [ws]), (s) => s === 'failed');
  if (want('bulk')) push('bulk', await many(db,
    `SELECT x.id, x.action || ' · ' || x.item_count || ' items' title, x.status,
            (SELECT count(*)::text || ' item(s) failed' FROM bulk_job_items i WHERE i.job_id=x.id AND i.status='failed' HAVING count(*) > 0) error,
            NULL::text brand_name, u.email::text "by", x.created_at, x.finished_at, x.target_kind detail
       FROM bulk_jobs x LEFT JOIN users u ON u.id=x.created_by
      WHERE x.workspace_id=$1 ${filt(['failed', 'completed_with_errors'], ['queued', 'running'])} ORDER BY x.created_at DESC LIMIT 50`, [ws]),
    (s) => s === 'failed' || s === 'completed_with_errors');
  if (want('media')) push('media', await many(db,
    `SELECT x.id, coalesce(x.original_filename, x.media_kind) title, x.status::text status, x.rejection_reason error, b.name brand_name, u.email::text "by", x.created_at, x.validated_at finished_at, x.media_kind detail
       FROM assets x LEFT JOIN brands b ON b.id=x.brand_id LEFT JOIN users u ON u.id=x.uploaded_by
      WHERE x.workspace_id=$1 ${B} AND x.deleted_at IS NULL ${failedOnly ? `AND x.status = 'rejected'` : running ? `AND x.status IN ('pending_upload','quarantined')` : `AND x.status NOT IN ('ready','archived')`}
      ORDER BY x.created_at DESC LIMIT 50`, [ws, brands]), (s) => s === 'rejected');
  items.sort((a, b) => b.created_at.localeCompare(a.created_at));
  const storage = can('assets.read') ? await one<{ bytes: string; assets: number; trashed_assets: number; trashed_posts: number; held: number }>(db,
    `SELECT coalesce(sum(bytes) FILTER (WHERE deleted_at IS NULL), 0)::text bytes, count(*) FILTER (WHERE deleted_at IS NULL)::int assets,
            count(*) FILTER (WHERE deleted_at IS NOT NULL)::int trashed_assets, count(*) FILTER (WHERE purge_blocked_reason IS NOT NULL)::int held,
            (SELECT count(*)::int FROM posts p WHERE p.workspace_id=$1 AND p.deleted_at IS NOT NULL AND ($2::uuid[] IS NULL OR p.brand_id = ANY($2))) trashed_posts
       FROM assets WHERE workspace_id=$1 AND ($2::uuid[] IS NULL OR brand_id = ANY($2))`, [ws, brands]) : null;
  return { items: items.slice(0, 150), kinds, storage: storage ? { ...storage, bytes: Number(storage.bytes) } : null };
}

// ------------------------------------------------------------------ analytics ingestion (operational, not product analytics)
export interface IngestionRow {
  connection_id: string; provider: Provider; display_name: string; brand_name: string; dataset: 'live' | 'simulated';
  stream_states: Array<{ stream: string; status: string; stop_reason: string | null; last_success_at: string | null; next_run_at: string | null; consecutive_failures: number; backfill_from: string | null }>;
  last_run: { status: string; started_at: string; finished_at: string | null; processed: number; failed: number; error_code: string | null; trigger: string } | null;
  stale: boolean;
}

export async function adminAnalyticsOps(ctx: Ctx, db: Queryable = getPool()) {
  requireAction(ctx, 'analytics.read');
  const ws = ctx.access.workspaceId;
  const conns = await many<{ id: string; provider: Provider; display_name: string; brand_name: string; simulated: boolean }>(db,
    `SELECT c.id, c.provider, c.display_name, b.name brand_name, (c.is_mock OR c.is_synthetic) simulated FROM connections c JOIN brands b ON b.id=c.brand_id
      WHERE c.workspace_id=$1 AND c.disconnected_at IS NULL AND ($2::uuid[] IS NULL OR c.brand_id = ANY($2)) ORDER BY b.name, c.provider LIMIT 300`, [ws, ctx.access.brandIds]);
  const ids = conns.map((c) => c.id);
  const cursors = ids.length ? await many<{ connection_id: string; stream: string; status: string; stop_reason: string | null; last_success_at: Date | null; next_run_at: Date | null; consecutive_failures: number; backfill_from: Date | null }>(db,
    `SELECT connection_id, stream, status, stop_reason, last_success_at, next_run_at, consecutive_failures, backfill_from FROM sync_cursors WHERE workspace_id=$1 AND connection_id = ANY($2::uuid[]) ORDER BY stream`, [ws, ids]) : [];
  const runs = ids.length ? await many<{ connection_id: string; status: string; started_at: Date; finished_at: Date | null; items_processed: number; items_failed: number; error_code: string | null; trigger: string }>(db,
    `SELECT DISTINCT ON (connection_id) connection_id, status, started_at, finished_at, items_processed, items_failed, error_code, trigger FROM sync_runs
      WHERE workspace_id=$1 AND connection_id = ANY($2::uuid[]) ORDER BY connection_id, started_at DESC`, [ws, ids]) : [];
  const failed = await many<{ id: string; connection_id: string; display_name: string; stream: string; error_code: string | null; error_message: string | null; started_at: Date; trigger: string }>(db,
    `SELECT r.id, r.connection_id, c.display_name, r.stream, r.error_code, r.error_message, r.started_at, r.trigger FROM sync_runs r JOIN connections c ON c.id=r.connection_id
      WHERE r.workspace_id=$1 AND r.status IN ('failed','partial') AND r.started_at > now() - interval '7 days' AND ($2::uuid[] IS NULL OR c.brand_id = ANY($2))
      ORDER BY r.started_at DESC LIMIT 50`, [ws, ctx.access.brandIds]);
  const backfills = await many<{ connection_id: string; display_name: string; status: string; items_planned: number | null; items_processed: number; started_at: Date; finished_at: Date | null }>(db,
    `SELECT r.connection_id, c.display_name, r.status, r.items_planned, r.items_processed, r.started_at, r.finished_at FROM sync_runs r JOIN connections c ON c.id=r.connection_id
      WHERE r.workspace_id=$1 AND r.trigger='backfill' AND ($2::uuid[] IS NULL OR c.brand_id = ANY($2)) ORDER BY r.started_at DESC LIMIT 20`, [ws, ctx.access.brandIds]);
  const now = Date.now();
  const rows: IngestionRow[] = conns.map((c) => {
    const ks = cursors.filter((k) => k.connection_id === c.id);
    const r = runs.find((x) => x.connection_id === c.id);
    const lastOk = ks.map((k) => k.last_success_at?.getTime() ?? 0).reduce((a, b) => Math.max(a, b), 0);
    return {
      connection_id: c.id, provider: c.provider, display_name: c.display_name, brand_name: c.brand_name, dataset: c.simulated ? 'simulated' : 'live',
      stream_states: ks.map((k) => ({ stream: k.stream, status: k.status, stop_reason: k.stop_reason, last_success_at: iso(k.last_success_at), next_run_at: iso(k.next_run_at),
        consecutive_failures: k.consecutive_failures, backfill_from: iso(k.backfill_from) })),
      last_run: r ? { status: r.status, started_at: r.started_at.toISOString(), finished_at: iso(r.finished_at), processed: r.items_processed, failed: r.items_failed, error_code: r.error_code, trigger: r.trigger } : null,
      stale: !lastOk || now - lastOk > 48 * 3600_000,
    };
  });
  return {
    generated_at: new Date().toISOString(),
    accounts: rows,
    failed_runs: failed.map((f) => ({ ...f, started_at: f.started_at.toISOString(), error_message: safeError(f.error_message) })),
    backfills: backfills.map((b) => ({ ...b, started_at: b.started_at.toISOString(), finished_at: iso(b.finished_at) })),
  };
}

// ------------------------------------------------------------------ inbound webhooks (provider callbacks we receive)
export async function adminWebhookReceipts(ctx: Ctx, db: Queryable = getPool()) {
  requireAction(ctx, 'workspace.manage');
  const rows = await many<{ id: string; provider: string; display_name: string | null; received_at: Date; processing_state: string; processed_at: Date | null; error: string | null }>(db,
    `SELECT w.id::text, w.provider::text, c.display_name, w.received_at, w.processing_state, w.processed_at, w.error
       FROM webhook_receipts w JOIN connections c ON c.id=w.connection_id
      WHERE c.workspace_id=$1 ORDER BY w.received_at DESC LIMIT 100`, [ctx.access.workspaceId]);
  return { items: rows.map((r) => ({ ...r, received_at: r.received_at.toISOString(), processed_at: iso(r.processed_at), error: safeError(r.error) })) };
}
