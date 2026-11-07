// Thin request helpers for the /api/analytics/** routes (filters from the URL, manual sync request, coverage summary).
import { AppError, notFound } from '@social-lite/core';
import type { AnalyticsFilters } from '@social-lite/core/contracts/analytics';
import { getPool, many, maybeOne } from '@social-lite/db';
import type { Ctx } from '../context.js';
import { assertUuid, brandAllowed, requireAction } from '../tenancy.js';
import { brandForPermission } from '../product/scope.js';
import { parseFilters } from './filters.js';
import { defaultTimezone, resolveScope } from './query.js';
import { requestConnectionSync } from './sync.js';

/** Filters from a request URL; the default timezone is the single selected brand's, else the workspace's. */
export async function filtersFromQuery(ctx: Ctx, q: URLSearchParams): Promise<AnalyticsFilters> {
  return parseFilters(q, { timezone: await defaultTimezone(ctx, q.get('brand')) });
}

/** Ask for a sync of one account soon (the worker does the provider calls). analytics.read on the account's brand. */
export async function requestSync(ctx: Ctx, connectionId: string): Promise<{ connection_id: string; next_run_at: string; throttled: boolean }> {
  requireAction(ctx, 'analytics.read');
  assertUuid(connectionId, 'Account');
  const c = await maybeOne<{ id: string; brand_id: string; is_synthetic: boolean }>(getPool(),
    `SELECT id, brand_id, is_synthetic FROM connections WHERE id=$1 AND workspace_id=$2`, [connectionId, ctx.access.workspaceId]);
  if (!c) throw notFound('Account');
  await brandForPermission(ctx, c.brand_id, 'analytics.read');
  if (!brandAllowed(ctx, c.brand_id)) throw notFound('Account');
  if (c.is_synthetic) throw new AppError('invalid_state', 'Demo accounts are not synced.');
  const cur = await maybeOne<{ status: string; stop_reason: string | null }>(getPool(), `SELECT status, stop_reason FROM sync_cursors WHERE connection_id=$1 AND stream='post_metrics'`, [c.id]);
  if (cur && cur.status !== 'active') throw new AppError('invalid_state', `Sync is stopped for this account (${cur.stop_reason ?? 'stopped'}).`, undefined, { stop_reason: cur.stop_reason });
  if (!cur) throw new AppError('invalid_state', 'This account has not been scheduled for analytics sync yet. It will be picked up automatically.');
  return { connection_id: c.id, ...(await requestConnectionSync(c.id)) };
}

/** Sync status per account in scope (data-health detail). */
export async function syncStatus(ctx: Ctx, filters: AnalyticsFilters) {
  const scope = await resolveScope(ctx, filters);
  const ids = scope.connections.map((c) => c.id);
  const runs = ids.length ? await many<{ connection_id: string; status: string; stop_reason: string | null; started_at: Date; finished_at: Date | null; items_processed: number; items_failed: number; observations_written: number; corrections: number }>(getPool(),
    `SELECT DISTINCT ON (connection_id) connection_id, status, stop_reason, started_at, finished_at, items_processed, items_failed, observations_written, corrections
       FROM sync_runs WHERE workspace_id=$1 AND connection_id = ANY($2::uuid[]) ORDER BY connection_id, started_at DESC`, [scope.workspaceId, ids]) : [];
  const cursors = ids.length ? await many<{ connection_id: string; status: string; stop_reason: string | null; next_run_at: Date; last_success_at: Date | null; backfill_from: Date }>(getPool(),
    `SELECT connection_id, status, stop_reason, next_run_at, last_success_at, backfill_from FROM sync_cursors WHERE workspace_id=$1 AND connection_id = ANY($2::uuid[])`, [scope.workspaceId, ids]) : [];
  return {
    accounts: scope.connections.map((c) => {
      const k = cursors.find((x) => x.connection_id === c.id);
      const r = runs.find((x) => x.connection_id === c.id);
      return {
        connection_id: c.id, provider: c.provider, display_name: c.display_name,
        cursor: k ? { status: k.status, stop_reason: k.stop_reason, next_run_at: k.next_run_at.toISOString(), last_success_at: k.last_success_at?.toISOString() ?? null, backfill_from: k.backfill_from.toISOString() } : null,
        last_run: r ? { status: r.status, stop_reason: r.stop_reason, started_at: r.started_at.toISOString(), finished_at: r.finished_at?.toISOString() ?? null,
          processed: r.items_processed, failed: r.items_failed, written: r.observations_written, corrections: r.corrections } : null,
      };
    }),
  };
}
