// GET /api/platform/v1/status — installation status for the Vitalos Super Admin (vitalos-platform ADR-044).
// Server-to-server: `Authorization: Bearer <RELAY_PLATFORM_STATUS_TOKEN>` (or `_PREVIOUS` while rotating), compared in
// constant time. No token configured → 404 (reveals nothing). Wrong or missing token → 401, empty body. Rate-limited
// per IP (shared bucket). Aggregates only: counts and generic alert titles; no names, emails or ids.
//
// The Super Admin times out after 3 s, so the answer comes from a 30 s in-process cache (5 s while the database is
// down); one computation at a time per process. Health reuses readiness() (database + migrations, as /api/ready), the
// worker heartbeat threshold of the diagnostics check and the alert rules of the Platform overview (admin/platform.ts).
// Billing tables are read through one read-only, grouped aggregate (no per-workspace getBillingState calls, which
// would not fit the time budget); access is still decided by billing/policy.ts (see policy.ts).
import { AppError } from '@social-lite/core';
import { PLATFORM_STATUS_PRODUCT, validatePlatformStatus, type PlatformStatus } from '@social-lite/core/contracts/platform-status';
import { getPool, withTx, type Pool, type PoolClient } from '@social-lite/db';
import { LIVE_PROVIDER_STATUSES } from '../billing/policy.js';
import { config } from '../config.js';
import { HEARTBEAT_STALE_MS, readiness } from '../diagnostics.js';
import { log } from '../log.js';
import { clientIp, enforceRateLimit } from '../ratelimit.js';
import {
  bearerToken, buildAlerts, STATUS_THRESHOLDS, statusEnvironment, summarize, superadminUrl, tokenMatches,
  type StatusCounts, type StatusSignals, type TenantGroup,
} from './policy.js';

const CACHE_MS = 30_000;
const DOWN_CACHE_MS = 5_000;
const DB_CHECK_MS = 1_000;
const QUERY_BUDGET_MS = 1_500;
const RATE_LIMIT_MS = 500;
export const PLATFORM_STATUS_RATE_LIMIT = { capacity: 30, refillPerSecond: 30 / 60 }; // per IP: 30 burst, 30/min

let cached: { payload: PlatformStatus; expires: number } | null = null;
let inflight: Promise<PlatformStatus | null> | null = null;
let lastCounts: StatusCounts | null = null;
let databaseDownSince: Date | null = null;

/** Tests only. */
export function resetPlatformStatusCache(): void {
  cached = null; inflight = null; lastCounts = null; databaseDownSince = null;
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([p, new Promise<T>((_, rej) => { t = setTimeout(() => rej(new Error('timed out')), ms); })]);
  } finally { clearTimeout(t); }
}

interface SignalRow {
  worker_last: Date | null;
  dispatch_value: unknown; dispatch_at: Date | null;
  outbox_dead: number; outbox_dead_since: Date | null;
  outbox_backlog: number; outbox_backlog_since: Date | null;
  due_stuck: number; due_since: Date | null;
  lease_stuck: number; lease_since: Date | null;
  webhooks_failing: number; webhooks_since: Date | null;
}

async function readAggregates(pool: Pool): Promise<{ groups: TenantGroup[]; sig: SignalRow }> {
  return withTx(async (tx: PoolClient) => {
    await tx.query('SET TRANSACTION READ ONLY');
    await tx.query(`SET LOCAL statement_timeout = ${QUERY_BUDGET_MS}`);
    // Grouped by state combination only: no workspace id or name leaves the database.
    const phase = (col: string) => `CASE WHEN ${col} IS NULL THEN 'none' WHEN ${col} <= now() THEN 'past' ELSE 'future' END`;
    const groups = await tx.query<TenantGroup>(
      `SELECT w.state, coalesce(b.status, 'legacy') AS status, ${phase('b.trial_ends_at')} AS trial, ${phase('b.grace_ends_at')} AS grace,
              ${phase('b.cancel_at')} AS cancel,
              coalesce(b.provider_subscription_ref IS NOT NULL AND b.provider_status = ANY($1::text[]), false) AS live, count(*)::int AS n
         FROM workspaces w LEFT JOIN workspace_billing b ON b.workspace_id = w.id
        WHERE NOT w.is_demo
        GROUP BY 1, 2, 3, 4, 5, 6`, [LIVE_PROVIDER_STATUSES]);
    const t = STATUS_THRESHOLDS;
    const sig = await tx.query<SignalRow>(
      `SELECT (SELECT max(last_seen_at) FROM worker_heartbeats) AS worker_last,
              f.value AS dispatch_value, f.updated_at AS dispatch_at,
              od.n AS outbox_dead, od.since AS outbox_dead_since, ob.n AS outbox_backlog, ob.since AS outbox_backlog_since,
              dd.n AS due_stuck, dd.since AS due_since, dl.n AS lease_stuck, dl.since AS lease_since,
              wh.n AS webhooks_failing, wh.since AS webhooks_since
         FROM (SELECT count(*)::int n, min(created_at) since FROM outbox WHERE dispatch_state = 'dead') od,
              (SELECT count(*)::int n, min(available_at) since FROM outbox
                WHERE dispatch_state = 'pending' AND available_at <= now() - make_interval(mins => $1::int)) ob,
              (SELECT count(*)::int n, min(next_attempt_at) since FROM deliveries
                WHERE state IN ('scheduled', 'retry_wait') AND next_attempt_at <= now() - make_interval(mins => $2::int) AND lease_owner IS NULL) dd,
              (SELECT count(*)::int n, min(lease_expires_at) since FROM deliveries
                WHERE lease_owner IS NOT NULL AND lease_expires_at <= now() - make_interval(mins => $2::int)) dl,
              (SELECT count(*)::int n, min(received_at) since FROM billing_webhook_events
                WHERE (status = 'failed' AND received_at > now() - make_interval(days => $3::int))
                   OR (status = 'received' AND received_at <= now() - make_interval(mins => $4::int))) wh
         LEFT JOIN system_flags f ON f.key = 'dispatch_enabled'`,
      [t.outboxBacklogMinutes, t.deliveryStuckMinutes, t.billingWebhookFailedDays, t.billingWebhookUnprocessedMinutes]);
    return { groups: groups.rows, sig: sig.rows[0]! };
  }, pool);
}

const minDate = (...ds: Array<Date | null>) => ds.reduce<Date | null>((a, d) => (d && (!a || d < a) ? d : a), null);

async function compute(pool: Pool): Promise<PlatformStatus | null> {
  const c = config();
  const now = new Date();
  const ready = await withTimeout(readiness(pool), DB_CHECK_MS).catch(() => null);
  const database = !!ready?.checks.database.ok;
  if (database) databaseDownSince = null; else databaseDownSince ??= now;

  const signals: StatusSignals = {
    database, queriesFailed: false, databaseDownSince, migrationsApplied: !!ready?.checks.migrations.ok,
    workerLastSeen: null, workerStale: false, dispatchEnabled: true, dispatchChangedAt: null,
    outboxDead: 0, outboxDeadSince: null, outboxBacklog: 0, outboxBacklogSince: null,
    deliveriesStuck: 0, deliveriesStuckSince: null, billingWebhooksFailing: 0, billingWebhooksSince: null,
  };
  let counts = lastCounts;
  if (database) {
    try {
      const { groups, sig } = await withTimeout(readAggregates(pool), QUERY_BUDGET_MS + 300);
      counts = lastCounts = summarize(groups, now);
      signals.workerLastSeen = sig.worker_last;
      signals.workerStale = !sig.worker_last || now.getTime() - sig.worker_last.getTime() > HEARTBEAT_STALE_MS;
      signals.dispatchEnabled = sig.dispatch_value !== false; // same reading as the Platform overview
      signals.dispatchChangedAt = sig.dispatch_at;
      signals.outboxDead = sig.outbox_dead; signals.outboxDeadSince = sig.outbox_dead_since;
      signals.outboxBacklog = sig.outbox_backlog; signals.outboxBacklogSince = sig.outbox_backlog_since;
      signals.deliveriesStuck = sig.due_stuck + sig.lease_stuck; signals.deliveriesStuckSince = minDate(sig.due_since, sig.lease_since);
      signals.billingWebhooksFailing = sig.webhooks_failing; signals.billingWebhooksSince = sig.webhooks_since;
    } catch (err) {
      signals.queriesFailed = true;
      log.warn('platform status: aggregate queries failed', { error: (err as Error).message?.slice(0, 120) });
    }
  }
  // Without figures from this process there is nothing honest to report: the caller answers 503 (Super Admin shows
  // "Status unavailable"). After a failure the last good figures are served with status down/degraded.
  if (!counts) return null;
  const { status, alerts } = buildAlerts(signals, { now, base: c.APP_BASE_URL });
  return {
    product: PLATFORM_STATUS_PRODUCT, environment: statusEnvironment(c), status, checkedAt: now.toISOString(),
    tenants: counts.tenants, subscriptions: counts.subscriptions, alerts, superadminUrl: superadminUrl(c.APP_BASE_URL),
  };
}

/** The current status from the cache, computing it at most once at a time. Null = no figures available. */
export async function currentPlatformStatus(pool: Pool = getPool()): Promise<PlatformStatus | null> {
  if (cached && cached.expires > Date.now()) return cached.payload;
  inflight ??= compute(pool).then((p) => {
    cached = p ? { payload: p, expires: Date.now() + (p.status === 'down' ? DOWN_CACHE_MS : CACHE_MS) } : null;
    return p;
  }).finally(() => { inflight = null; });
  return inflight;
}

const NO_STORE = { 'cache-control': 'no-store' };
const empty = (status: number, headers: Record<string, string> = {}) => new Response(null, { status, headers: { ...NO_STORE, ...headers } });
const unavailable = () => Response.json({ error: 'unavailable' }, { status: 503, headers: NO_STORE });

/** The whole request: configured? → rate limit → token → cached status → strict validation → 200. */
export async function platformStatusRequest(headers: Headers, pool: Pool = getPool()): Promise<Response> {
  const c = config();
  if (!c.RELAY_PLATFORM_STATUS_TOKEN) return empty(404);
  try {
    await withTimeout(enforceRateLimit('platformStatus', clientIp(headers), PLATFORM_STATUS_RATE_LIMIT), RATE_LIMIT_MS);
  } catch (err) {
    if (err instanceof AppError && err.code === 'rate_limited') {
      return empty(429, { 'retry-after': String(Math.max(1, Number(err.details?.retry_after_seconds ?? 1))) });
    }
    // The shared bucket lives in the database: when it is unreachable or slow, answer anyway (the token still applies)
    // so the Super Admin can see "down".
  }
  if (!tokenMatches(bearerToken(headers.get('authorization')), [c.RELAY_PLATFORM_STATUS_TOKEN, c.RELAY_PLATFORM_STATUS_TOKEN_PREVIOUS])) {
    return empty(401, { 'www-authenticate': 'Bearer' });
  }
  const payload = await currentPlatformStatus(pool);
  if (!payload) return unavailable();
  const check = validatePlatformStatus(payload, { now: new Date(), trustedHosts: [new URL(c.APP_BASE_URL).hostname] });
  if (!check.ok) {
    // Field name only (never a value). A non-https APP_BASE_URL fails here (superadminUrl must be https).
    log.warn('platform status: payload failed the ADR-044 contract', { field: check.field });
    return unavailable();
  }
  return Response.json(payload, { status: 200, headers: NO_STORE });
}
