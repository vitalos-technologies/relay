// Native analytics (V1.1, spec §10 metric_snapshots, §15 cost model, §17).
//  - Raw provider-native metrics are snapshotted per published delivery (append-only), with period,
//    observed_at and source ('provider' | 'simulated'). Values are never derived, summed across networks
//    or fabricated: a metric that was not returned is "Unavailable", never 0.
//  - X reads are billable: the workspace 'x.read' budget is consumed BEFORE each call and the call is
//    skipped when exhausted (status budget_exhausted).
//  - Telegram is unsupported (status 'unsupported'). Simulated (mock_) destinations get clearly labelled
//    simulated values and never touch a transport.
//  - Refresh: runDailyMetricsRefresh() (registered by the worker) + on-demand refresh throttled per delivery.
import { AppError, PROVIDER_LABEL, notFound, type AdapterContext, type Provider, type ProviderCredentials, type PublishConnection } from '@social-lite/core';
import { getPool, many, maybeOne, withTx, type Queryable } from '@social-lite/db';
import { METRIC_LABELS, metricsFetcherFor, simulatedMetrics, type MetricsFetcher, type MetricsOutcome } from '@social-lite/providers/metrics';
import type { Ctx } from '../context.js';
import { audit } from '../audit.js';
import { log } from '../log.js';
import { assertUuid, brandAllowed, brandFilter, requireAction } from '../tenancy.js';
import { checkAndConsumeBudget } from '../engine/budget.js';
import { CredentialsUnavailable } from '../engine/process.js';

export const ON_DEMAND_THROTTLE_MINUTES = 15;
export const DAILY_REFRESH_MIN_HOURS = 20;
export const DAILY_REFRESH_MAX_AGE_DAYS = 30;

export type FetchStatus = 'pending' | 'ok' | 'unsupported' | 'unavailable' | 'permission_missing' | 'budget_exhausted' | 'reconnect' | 'error';

export interface AnalyticsDeps {
  getCredentials(connectionId: string): Promise<{ credentials: ProviderCredentials; connection: PublishConnection }>;
  adapterContext(provider: Provider, connection: PublishConnection): Promise<AdapterContext>;
  fetcherFor?(provider: Provider): MetricsFetcher;
  now?(): Date;
}

/** Production wiring (credentials + live/mock transport selection come from the engine's live deps). */
export async function liveAnalyticsDeps(): Promise<AnalyticsDeps> {
  const { liveEngineDeps } = await import('../engine/live-deps.js');
  const e = liveEngineDeps();
  return { getCredentials: (id) => e.getCredentials(id), adapterContext: e.adapterContext };
}

interface DeliveryRef {
  id: string; workspace_id: string; brand_id: string; connection_id: string; provider: Provider; is_mock: boolean; state: string;
  provider_ids: string[]; published_at: Date | null;
}

async function setState(db: Queryable, d: DeliveryRef, status: FetchStatus, message: string | null, success: boolean) {
  await db.query(
    `UPDATE metric_fetch_state SET status=$2, message=$3, last_success_at=CASE WHEN $4 THEN now() ELSE last_success_at END WHERE delivery_id=$1`,
    [d.id, status, message?.slice(0, 300) ?? null, success]);
}

export interface RefreshResult { deliveryId: string; status: FetchStatus; message: string | null; points: number }

/**
 * Fetch and snapshot metrics for one published delivery. Network calls happen outside transactions.
 * `claim` (daily job) skips deliveries attempted within DAILY_REFRESH_MIN_HOURS, atomically, so concurrent
 * workers never double-fetch (and never double-bill X reads).
 */
export async function refreshDeliveryMetrics(deliveryId: string, deps: AnalyticsDeps, opts: { claim?: boolean } = {}): Promise<RefreshResult | null> {
  const db = getPool();
  const d = await maybeOne<DeliveryRef>(db,
    `SELECT id, workspace_id, brand_id, connection_id, provider, is_mock, state, provider_ids, published_at FROM deliveries WHERE id=$1`, [deliveryId]);
  if (!d || d.state !== 'published') return null;
  await db.query(`INSERT INTO metric_fetch_state(delivery_id, workspace_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [d.id, d.workspace_id]);
  const claimed = await maybeOne(db,
    `UPDATE metric_fetch_state SET last_attempt_at=now() WHERE delivery_id=$1
        ${opts.claim ? `AND (last_attempt_at IS NULL OR last_attempt_at < now() - interval '${DAILY_REFRESH_MIN_HOURS} hours')` : ''} RETURNING 1`, [d.id]);
  if (!claimed) return null;
  const done = async (status: FetchStatus, message: string | null, points = 0): Promise<RefreshResult> => {
    await setState(db, d, status, message, status === 'ok');
    return { deliveryId: d.id, status, message, points };
  };

  const fetcher = deps.fetcherFor?.(d.provider) ?? metricsFetcherFor(d.provider);
  if (!fetcher.metricNames.length) return done('unsupported', `${PROVIDER_LABEL[d.provider]} does not provide post statistics.`);
  const objectId = d.provider_ids[0];
  if (!objectId) return done('unavailable', 'No post id was recorded for this delivery.');
  const now = deps.now?.() ?? new Date();

  let outcome: MetricsOutcome;
  let source: 'provider' | 'simulated' = 'provider';
  if (d.is_mock) {
    source = 'simulated';
    outcome = simulatedMetrics(d.provider, objectId, d.published_at?.toISOString() ?? null, now);
  } else {
    if (fetcher.billableRead) {
      const b = await withTx((tx) => checkAndConsumeBudget(tx, d.workspace_id, 'x.read', 1));
      if (!b.ok) return done('budget_exhausted', b.message);
    }
    try {
      const creds = await deps.getCredentials(d.connection_id);
      const actx = await deps.adapterContext(d.provider, creds.connection);
      outcome = await fetcher.fetch(actx, { connection: creds.connection, credentials: creds.credentials, providerIds: d.provider_ids, publishedAt: d.published_at?.toISOString() ?? null });
    } catch (err) {
      if (err instanceof CredentialsUnavailable) return done('reconnect', 'Reconnect the account to read metrics.');
      log.warn('metrics_fetch_failed', { deliveryId: d.id, provider: d.provider, err: err as Error });
      outcome = { kind: 'error', code: 'fetch_failed', message: 'The network could not be reached.' };
    }
  }

  switch (outcome.kind) {
    case 'ok': {
      if (outcome.points.length) {
        await withTx(async (tx) => {
          for (const p of outcome.points) {
            await tx.query(
              `INSERT INTO metric_snapshots(workspace_id, brand_id, connection_id, delivery_id, provider, provider_object_id, metric, dimension, value, period, window_end, observed_at, source)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
              [d.workspace_id, d.brand_id, d.connection_id, d.id, d.provider, objectId, p.name.slice(0, 100), p.dimension?.slice(0, 100) ?? null, p.value, p.period.slice(0, 40), p.windowEnd, now, source]);
          }
        });
      }
      const missing = outcome.unavailable.map((u) => u.name);
      if (!outcome.points.length) return done('unavailable', missing.length ? `Not reported: ${missing.join(', ')}` : 'No metrics were reported.');
      return done('ok', missing.length ? `Not reported: ${missing.join(', ')}` : null, outcome.points.length);
    }
    case 'unsupported': return done('unsupported', outcome.reason);
    case 'permission_missing': return done('permission_missing', outcome.message);
    case 'reconnect': return done('reconnect', outcome.message);
    case 'not_found': return done('unavailable', outcome.message);
    case 'budget': return done('budget_exhausted', outcome.message);
    case 'rate_limited': return done('error', outcome.message);
    case 'error': return done('error', outcome.message);
  }
}

/**
 * Daily refresh job for the worker: published deliveries from the last DAILY_REFRESH_MAX_AGE_DAYS whose
 * metrics were not attempted in the last DAILY_REFRESH_MIN_HOURS. Sequential (budget-friendly, bounded).
 */
export async function runDailyMetricsRefresh(deps: AnalyticsDeps, opts: { limit?: number; maxAgeDays?: number } = {}) {
  const db = getPool();
  const rows = await many<{ id: string }>(db,
    `SELECT d.id FROM deliveries d LEFT JOIN metric_fetch_state f ON f.delivery_id=d.id
      WHERE d.state='published' AND d.published_at > now() - make_interval(days => $1)
        AND (f.last_attempt_at IS NULL OR f.last_attempt_at < now() - interval '${DAILY_REFRESH_MIN_HOURS} hours')
        AND coalesce(f.status, 'pending') <> 'unsupported'
      ORDER BY f.last_attempt_at NULLS FIRST, d.published_at DESC LIMIT $2`,
    [opts.maxAgeDays ?? DAILY_REFRESH_MAX_AGE_DAYS, Math.min(Math.max(opts.limit ?? 200, 1), 2000)]);
  const summary: Record<string, number> = { processed: 0 };
  for (const r of rows) {
    try {
      const res = await refreshDeliveryMetrics(r.id, deps, { claim: true });
      if (!res) continue;
      summary.processed!++;
      summary[res.status] = (summary[res.status] ?? 0) + 1;
    } catch (err) {
      log.warn('metrics_refresh_error', { deliveryId: r.id, err: err as Error });
      summary.error = (summary.error ?? 0) + 1;
    }
  }
  return summary;
}

// ------------------------------------------------------------------ user-facing
async function loadDeliveryForCtx(ctx: Ctx, deliveryId: string) {
  assertUuid(deliveryId, 'Delivery');
  const d = await maybeOne<{ id: string; brand_id: string; state: string }>(getPool(),
    `SELECT id, brand_id, state FROM deliveries WHERE id=$1 AND workspace_id=$2`, [deliveryId, ctx.access.workspaceId]);
  if (!d || !brandAllowed(ctx, d.brand_id)) throw notFound('Delivery');
  return d;
}

/** On-demand refresh, throttled to once per ON_DEMAND_THROTTLE_MINUTES per delivery (any user). */
export async function requestMetricsRefresh(ctx: Ctx, deliveryId: string, deps: AnalyticsDeps) {
  requireAction(ctx, 'history.read');
  const d = await loadDeliveryForCtx(ctx, deliveryId);
  if (d.state !== 'published') throw new AppError('invalid_state', 'Metrics are only available for published posts.');
  const db = getPool();
  await db.query(`INSERT INTO metric_fetch_state(delivery_id, workspace_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [d.id, ctx.access.workspaceId]);
  const ok = await maybeOne(db,
    `UPDATE metric_fetch_state SET last_requested_at=now() WHERE delivery_id=$1
        AND (last_requested_at IS NULL OR last_requested_at <= now() - interval '${ON_DEMAND_THROTTLE_MINUTES} minutes') RETURNING 1`, [d.id]);
  if (!ok) {
    const s = await maybeOne<{ last_requested_at: Date }>(db, `SELECT last_requested_at FROM metric_fetch_state WHERE delivery_id=$1`, [d.id]);
    const next = new Date((s?.last_requested_at ?? new Date()).getTime() + ON_DEMAND_THROTTLE_MINUTES * 60_000);
    throw new AppError('rate_limited', `Refreshed recently. Try again after ${next.toISOString().slice(11, 16)} UTC.`, undefined, { next_allowed_at: next.toISOString() });
  }
  await audit(db, { workspaceId: ctx.access.workspaceId, brandId: d.brand_id, actorUserId: ctx.actor.userId, action: 'metrics.refresh_requested', resourceType: 'delivery', resourceId: d.id, correlationId: ctx.correlationId });
  await refreshDeliveryMetrics(d.id, deps);
  const page = await listAnalytics(ctx, { delivery_id: d.id });
  return page.items[0]!;
}

export interface AnalyticsQuery { brand_id?: string | null; provider?: string | null; cursor?: string | null; limit?: number | null; delivery_id?: string }

interface Row {
  id: string; post_id: string; brand_id: string; brand_name: string; title: string | null; excerpt: string | null; provider: Provider; is_mock: boolean;
  display_name: string; published_at: Date; provider_url: string | null; status: FetchStatus | null; message: string | null;
  last_attempt_at: Date | null; last_success_at: Date | null; last_requested_at: Date | null;
}

/** Published deliveries with their latest snapshot per metric. Brand grants enforced; cross-tenant ⇒ nothing. */
export async function listAnalytics(ctx: Ctx, q: AnalyticsQuery = {}) {
  requireAction(ctx, 'history.read');
  const db = getPool();
  const limit = Math.min(Math.max(q.limit ?? 30, 1), 100);
  const params: unknown[] = [ctx.access.workspaceId];
  const f = brandFilter(ctx, 'd.brand_id', 2);
  params.push(...f.params);
  let where = `d.workspace_id=$1 AND d.state='published' AND d.published_at IS NOT NULL AND ${f.sql}`;
  if (q.brand_id) { assertUuid(q.brand_id, 'Brand'); params.push(q.brand_id); where += ` AND d.brand_id=$${params.length}`; }
  if (q.provider) { params.push(q.provider); where += ` AND d.provider::text=$${params.length}`; }
  if (q.delivery_id) { params.push(q.delivery_id); where += ` AND d.id=$${params.length}`; }
  if (q.cursor) {
    const [ts, id] = Buffer.from(q.cursor, 'base64url').toString().split('|');
    if (!ts || !id) throw new AppError('validation_failed', 'Invalid cursor');
    params.push(ts, id); where += ` AND (d.published_at, d.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`;
  }
  params.push(limit + 1);
  const rows = await many<Row>(db,
    `SELECT d.id, d.post_id, d.brand_id, b.name AS brand_name, p.title, left(p.draft->>'baseText', 140) AS excerpt, d.provider, d.is_mock,
            c.display_name, d.published_at, d.provider_url, f.status, f.message, f.last_attempt_at, f.last_success_at, f.last_requested_at
       FROM deliveries d JOIN posts p ON p.id=d.post_id JOIN brands b ON b.id=d.brand_id JOIN connections c ON c.id=d.connection_id
       LEFT JOIN metric_fetch_state f ON f.delivery_id=d.id
      WHERE ${where} ORDER BY d.published_at DESC, d.id DESC LIMIT $${params.length}`, params);
  const page = rows.slice(0, limit);
  const snaps = page.length ? await many<{ delivery_id: string; metric: string; dimension: string | null; value: string; period: string; window_end: Date | null; observed_at: Date; source: string }>(db,
    `SELECT DISTINCT ON (delivery_id, metric, coalesce(dimension,'')) delivery_id, metric, dimension, value::text, period, window_end, observed_at, source
       FROM metric_snapshots WHERE workspace_id=$1 AND delivery_id = ANY($2::uuid[])
      ORDER BY delivery_id, metric, coalesce(dimension,''), observed_at DESC`, [ctx.access.workspaceId, page.map((r) => r.id)]) : [];
  const last = page[page.length - 1];
  return {
    items: page.map((r) => {
      const fetcher = metricsFetcherFor(r.provider);
      const mine = snaps.filter((s) => s.delivery_id === r.id);
      const order = new Map(fetcher.metricNames.map((n, i) => [n, i]));
      mine.sort((a, b) => (order.get(a.metric) ?? 99) - (order.get(b.metric) ?? 99) || (a.dimension ?? '').localeCompare(b.dimension ?? ''));
      const supported = fetcher.metricNames.length > 0;
      const status: FetchStatus = !supported ? 'unsupported' : (r.status ?? 'pending');
      const nextAllowed = r.last_requested_at ? new Date(r.last_requested_at.getTime() + ON_DEMAND_THROTTLE_MINUTES * 60_000) : null;
      return {
        delivery_id: r.id, post_id: r.post_id, brand_id: r.brand_id, brand_name: r.brand_name, title: r.title, excerpt: r.excerpt,
        provider: r.provider, display_name: r.display_name, is_mock: r.is_mock, published_at: r.published_at.toISOString(), provider_url: r.provider_url,
        supported, status, status_message: !supported ? 'Unavailable: this network does not provide post statistics.' : r.message,
        source: mine[0]?.source ?? (r.is_mock ? 'simulated' : null),
        metrics: mine.map((s) => ({
          name: s.metric, label: METRIC_LABELS[s.metric] ?? s.metric, dimension: s.dimension, value: Number(s.value), period: s.period,
          window_end: s.window_end?.toISOString() ?? null, observed_at: s.observed_at.toISOString(), source: s.source,
        })),
        expected_metrics: fetcher.metricNames.map((n) => ({ name: n, label: METRIC_LABELS[n] ?? n })),
        last_refreshed_at: r.last_success_at?.toISOString() ?? null,
        last_attempt_at: r.last_attempt_at?.toISOString() ?? null,
        next_refresh_allowed_at: nextAllowed && nextAllowed.getTime() > Date.now() ? nextAllowed.toISOString() : null,
        billable: fetcher.billableRead && !r.is_mock,
      };
    }),
    next_cursor: rows.length > limit && last ? Buffer.from(`${last.published_at.toISOString()}|${last.id}`).toString('base64url') : null,
  };
}
