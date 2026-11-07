// Read models: history (DE-04), CSV export, planner (bounded UTC range), home dashboard, operations.
import { AppError, aggregateStatus, isDeliveryOverdue, OVERDUE_GRACE_MS, type DeliveryState, type Provider } from '@social-lite/core';
import { getPool, many, maybeOne, one } from '@social-lite/db';
import type { Ctx } from './context.js';
import { DELIVERY_SELECT, deliveryJson, type DeliveryRow } from './posts/serialize.js';
import { excerpt } from './posts/shared.js';
import { requireAction } from './tenancy.js';

const MAX_PLANNER_DAYS = 62;
const PROVIDERS = new Set(['instagram', 'facebook', 'telegram', 'x']);
const STATES = new Set(['scheduled', 'preparing', 'publishing', 'processing', 'retry_wait', 'published', 'failed', 'blocked', 'paused', 'cancelled', 'expired', 'unknown']);

function parseDate(v: string | undefined | null, field: string): Date | null {
  if (!v) return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) throw new AppError('validation_failed', `Invalid ${field}`, { [field]: 'Use an ISO date' });
  return d;
}

/** Brand scoping applied to every read model: workspace + brand grants (+ optional brand filter). */
function scope(ctx: Ctx, alias: string, params: unknown[], brandId?: string | null): string {
  params.push(ctx.access.workspaceId);
  let sql = `${alias}.workspace_id = $${params.length}`;
  if (ctx.access.brandIds !== null) { params.push(ctx.access.brandIds); sql += ` AND ${alias}.brand_id = ANY($${params.length}::uuid[])`; }
  if (brandId) {
    if (!/^[0-9a-f-]{36}$/i.test(brandId)) throw new AppError('validation_failed', 'Invalid brand');
    params.push(brandId); sql += ` AND ${alias}.brand_id = $${params.length}`;
  }
  return sql;
}

export interface HistoryFilters { brand_id?: string; provider?: string; state?: string; from?: string; to?: string; cursor?: string; limit?: number }

type HistoryRow = DeliveryRow & { brand_name: string; post_title: string | null; base_text: string; revision_number: number; input_local_time: string; input_timezone: string };

async function historyRows(ctx: Ctx, f: HistoryFilters, limit: number) {
  const params: unknown[] = [];
  let where = scope(ctx, 'd', params, f.brand_id);
  if (f.provider) { if (!PROVIDERS.has(f.provider)) throw new AppError('validation_failed', 'Unknown provider'); params.push(f.provider); where += ` AND d.provider = $${params.length}`; }
  if (f.state) { if (!STATES.has(f.state)) throw new AppError('validation_failed', 'Unknown state'); params.push(f.state); where += ` AND d.state = $${params.length}::delivery_state`; }
  const from = parseDate(f.from, 'from'); const to = parseDate(f.to, 'to');
  if (from) { params.push(from); where += ` AND d.due_at >= $${params.length}`; }
  if (to) { params.push(to); where += ` AND d.due_at < $${params.length}`; }
  if (f.cursor) {
    const [ts, id] = Buffer.from(f.cursor, 'base64url').toString().split('|');
    params.push(ts, id); where += ` AND (d.due_at, d.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`;
  }
  params.push(limit + 1);
  return many<HistoryRow>(getPool(),
    `SELECT ${DELIVERY_SELECT}, b.name AS brand_name, p.title AS post_title, r.base_text, r.revision_number, s.input_local_time, s.input_timezone
       FROM deliveries d JOIN connections c ON c.id=d.connection_id JOIN brands b ON b.id=d.brand_id JOIN posts p ON p.id=d.post_id
       JOIN post_revisions r ON r.id=d.revision_id JOIN schedules s ON s.id=d.schedule_id
      WHERE ${where} ORDER BY d.due_at DESC, d.id DESC LIMIT $${params.length}`, params);
}

function historyJson(r: HistoryRow) {
  return { ...deliveryJson(r), brand_id: r.brand_id, brand_name: r.brand_name, post_title: r.post_title, excerpt: excerpt(r.base_text),
    revision_number: r.revision_number, scheduled_input: r.input_local_time, input_timezone: r.input_timezone };
}

export async function history(ctx: Ctx, f: HistoryFilters) {
  requireAction(ctx, 'history.read');
  const limit = Math.min(Math.max(Number(f.limit) || 50, 1), 100);
  const rows = await historyRows(ctx, f, limit);
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return { items: page.map(historyJson), next_cursor: rows.length > limit && last ? Buffer.from(`${last.due_at.toISOString()}|${last.id}`).toString('base64url') : null };
}

/** CSV cells are escaped and formula-injection-safe (leading = + - @ are prefixed). */
export function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  let s = Array.isArray(v) ? v.join(' ') : v instanceof Date ? v.toISOString() : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export async function historyCsv(ctx: Ctx, f: HistoryFilters): Promise<string> {
  requireAction(ctx, 'history.export');
  const header = ['brand', 'post_title', 'excerpt', 'revision', 'destination', 'provider', 'simulated', 'state', 'scheduled_local_time', 'timezone',
    'scheduled_at_utc', 'publish_before_utc', 'published_at_utc', 'attempts', 'provider_ids', 'provider_url', 'error_code', 'error_message', 'delivery_id'];
  const lines = [header.join(',')];
  let cursor: string | undefined;
  for (let page = 0; page < 200; page++) { // hard bound: 20,000 rows per export
    const rows = await historyRows(ctx, { ...f, cursor }, 100);
    for (const r of rows.slice(0, 100)) {
      lines.push([r.brand_name, r.post_title, excerpt(r.base_text, 200), r.revision_number, r.display_name, r.provider, r.is_mock ? 'yes' : 'no',
        r.is_mock && r.state === 'published' ? 'simulated' : r.state, r.input_local_time, r.input_timezone, r.due_at, r.publish_before, r.published_at,
        r.attempt_count, r.provider_ids, r.provider_url, r.last_error_code, r.last_error_message, r.id].map(csvCell).join(','));
    }
    if (rows.length <= 100) break;
    const last = rows[99]!;
    cursor = Buffer.from(`${last.due_at.toISOString()}|${last.id}`).toString('base64url');
  }
  return lines.join('\r\n') + '\r\n';
}

export async function planner(ctx: Ctx, q: { from?: string; to?: string; brand_id?: string; connection_id?: string; status?: string }) {
  requireAction(ctx, 'history.read');
  const from = parseDate(q.from, 'from'); const to = parseDate(q.to, 'to');
  if (!from || !to) throw new AppError('validation_failed', 'from and to are required (UTC ISO instants)');
  if (to <= from || to.getTime() - from.getTime() > MAX_PLANNER_DAYS * 86_400_000) throw new AppError('validation_failed', `The range must be positive and at most ${MAX_PLANNER_DAYS} days`);
  const params: unknown[] = [];
  let where = scope(ctx, 's', params, q.brand_id);
  params.push(from, to);
  where += ` AND s.due_at >= $${params.length - 1} AND s.due_at < $${params.length} AND s.status IN ('active','pending_approval','completed','cancelled')`;
  if (q.connection_id) { params.push(q.connection_id); where += ` AND EXISTS (SELECT 1 FROM variants v WHERE v.revision_id=s.revision_id AND v.connection_id=$${params.length}::uuid)`; }
  const rows = await many<{ id: string; post_id: string; brand_id: string; title: string | null; base_text: string; due_at: Date; input_timezone: string; input_local_time: string; status: string; generation: number; is_immediate: boolean }>(getPool(),
    `SELECT s.id, s.post_id, s.brand_id, p.title, r.base_text, s.due_at, s.input_timezone, s.input_local_time, s.status, s.generation, s.is_immediate
       FROM schedules s JOIN posts p ON p.id=s.post_id JOIN post_revisions r ON r.id=s.revision_id
      WHERE ${where} AND s.generation = p.schedule_generation ORDER BY s.due_at LIMIT 1000`, params);
  const ids = rows.map((r) => r.id);
  const dels = ids.length ? await many<{ schedule_id: string; connection_id: string; provider: Provider; is_mock: boolean; state: DeliveryState; next_attempt_at: Date | null }>(getPool(),
    `SELECT schedule_id, connection_id, provider, is_mock, state, next_attempt_at FROM deliveries WHERE schedule_id = ANY($1::uuid[])`, [ids]) : [];
  const pendingDest = ids.length ? await many<{ schedule_id: string; connection_id: string; provider: Provider; is_mock: boolean }>(getPool(),
    `SELECT s.id schedule_id, v.connection_id, c.provider, c.is_mock FROM schedules s JOIN variants v ON v.revision_id=s.revision_id JOIN connections c ON c.id=v.connection_id
      WHERE s.id = ANY($1::uuid[]) AND s.status='pending_approval'`, [ids]) : [];
  let items = rows.map((r) => {
    const ds = dels.filter((d) => d.schedule_id === r.id);
    let status = ds.length ? aggregateStatus(ds.map((d) => d.state)) : 'scheduled';
    if (r.status === 'pending_approval') status = 'pending_approval';
    if (r.status === 'cancelled' && !ds.some((d) => d.state === 'published')) status = 'cancelled';
    const destinations = ds.length ? ds.map((d) => ({ connection_id: d.connection_id, provider: d.provider, is_mock: d.is_mock, state: d.state, overdue: isDeliveryOverdue(d.state, d.next_attempt_at) }))
      : pendingDest.filter((d) => d.schedule_id === r.id).map((d) => ({ connection_id: d.connection_id, provider: d.provider, is_mock: d.is_mock, state: null }));
    return { schedule_id: r.id, post_id: r.post_id, brand_id: r.brand_id, title: r.title, excerpt: excerpt(r.base_text), due_at: r.due_at.toISOString(),
      input_timezone: r.input_timezone, input_local_time: r.input_local_time, status, schedule_status: r.status, generation: r.generation, destinations,
      overdue: destinations.some((d) => 'overdue' in d && d.overdue) };
  });
  if (q.status) items = items.filter((i) => i.status === q.status);
  return { items };
}

export async function dashboard(ctx: Ctx, q: { brand_id?: string }) {
  requireAction(ctx, 'history.read');
  const now = new Date();
  const dayStart = new Date(now.getTime() - 12 * 3600_000);
  const dayEnd = new Date(now.getTime() + 36 * 3600_000);
  const today = await planner(ctx, { from: dayStart.toISOString(), to: dayEnd.toISOString(), brand_id: q.brand_id });
  const attention = async (state: string) => {
    const params: unknown[] = [];
    const where = scope(ctx, 'd', params, q.brand_id);
    params.push(state);
    const rows = await many<DeliveryRow & { post_title: string | null }>(getPool(),
      `SELECT ${DELIVERY_SELECT}, p.title AS post_title FROM deliveries d JOIN connections c ON c.id=d.connection_id JOIN posts p ON p.id=d.post_id
         JOIN schedules s ON s.id=d.schedule_id
        WHERE ${where} AND d.state=$${params.length}::delivery_state AND s.generation = p.schedule_generation
          AND d.updated_at > now() - interval '14 days' ORDER BY d.updated_at DESC LIMIT 20`, params);
    return rows.map((r) => ({ ...deliveryJson(r), post_title: r.post_title }));
  };
  const params: unknown[] = [];
  const cw = scope(ctx, 'c', params, q.brand_id);
  const warnings = await many<Record<string, unknown>>(getPool(),
    `SELECT c.id, c.brand_id, c.provider, c.display_name, c.status, c.is_mock, c.paused, c.health_detail->>'message' AS message
       FROM connections c WHERE ${cw} AND c.disconnected_at IS NULL AND (c.status <> 'ready' OR c.paused) ORDER BY c.provider`, params);
  const recent = await history(ctx, { brand_id: q.brand_id, limit: 10, to: new Date(now.getTime() + 60_000).toISOString() });
  const ws = await one<{ publishing_paused: boolean; paused_reason: string | null }>(getPool(), `SELECT publishing_paused, paused_reason FROM workspaces WHERE id=$1`, [ctx.access.workspaceId]);
  const pausedBrands = await many<{ id: string }>(getPool(), `SELECT id FROM brands WHERE workspace_id=$1 AND publishing_paused`, [ctx.access.workspaceId]);
  return {
    today: today.items,
    attention: { blocked: await attention('blocked'), unknown: await attention('unknown'), failed: await attention('failed'), expired: await attention('expired'), handoff: await attention('handoff') },
    delayed: await delayed(ctx, q.brand_id),
    account_warnings: warnings,
    recent: recent.items.filter((r) => !['scheduled', 'paused'].includes(r.state)),
    paused: { workspace: ws.publishing_paused, reason: ws.paused_reason, brands: pausedBrands.map((b) => b.id) },
  };
}

/** Posts past their time that have not been sent, and whether the publisher is running (no silent "Scheduled"). */
async function delayed(ctx: Ctx, brandId?: string) {
  const params: unknown[] = [];
  const where = scope(ctx, 'd', params, brandId);
  const r = await one<{ n: number; oldest: Date | null }>(getPool(),
    `SELECT count(DISTINCT d.post_id)::int n, min(d.next_attempt_at) oldest FROM deliveries d
      WHERE ${where} AND d.state IN ('scheduled','retry_wait') AND d.next_attempt_at < now() - interval '${OVERDUE_GRACE_MS / 1000} seconds'`, params);
  const hb = await maybeOne<{ last: Date | null }>(getPool(), `SELECT max(last_seen_at) last FROM worker_heartbeats WHERE NOT coalesce((info->>'stopped')::boolean, false)`);
  const flag = await maybeOne<{ value: unknown }>(getPool(), `SELECT value FROM system_flags WHERE key='dispatch_enabled'`);
  return { overdue: r.n, oldest_due_at: r.oldest?.toISOString() ?? null, publisher_running: !!hb?.last && Date.now() - hb.last.getTime() < 60_000, dispatch_enabled: flag?.value !== false };
}

/** Operational facts only — real counts with periods and denominators (spec §17). */
export async function ops(ctx: Ctx) {
  requireAction(ctx, 'diagnostics.read');
  const db = getPool();
  const ws = ctx.access.workspaceId;
  const counts = await many<{ state: string; is_mock: boolean; n: number }>(db,
    `SELECT state, is_mock, count(*)::int n FROM deliveries WHERE workspace_id=$1 AND due_at > now() - interval '7 days' GROUP BY state, is_mock`, [ws]);
  const queue = await maybeOne<{ oldest_due: Date | null; due_now: number }>(db,
    `SELECT min(next_attempt_at) oldest_due, count(*)::int due_now FROM deliveries WHERE state IN ('scheduled','retry_wait') AND next_attempt_at <= now()`);
  const outbox = await one<{ pending: number; dead: number; oldest: Date | null }>(db,
    `SELECT count(*) FILTER (WHERE dispatch_state='pending' AND available_at <= now())::int pending, count(*) FILTER (WHERE dispatch_state='dead')::int dead,
            min(available_at) FILTER (WHERE dispatch_state='pending' AND available_at <= now()) oldest FROM outbox`);
  const workers = await many<{ worker_id: string; last_seen_at: Date; version: string | null; info: Record<string, unknown> }>(db,
    `SELECT worker_id, last_seen_at, version, info FROM worker_heartbeats WHERE last_seen_at > now() - interval '1 day' ORDER BY last_seen_at DESC`);
  const lateness = await maybeOne<{ p50: number | null; p95: number | null; n: number }>(db,
    `SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY lag) p50, percentile_cont(0.95) WITHIN GROUP (ORDER BY lag) p95, count(*)::int n FROM (
       SELECT extract(epoch FROM (a.started_at - d.due_at)) lag FROM delivery_attempts a JOIN deliveries d ON d.id=a.delivery_id
        WHERE d.workspace_id=$1 AND a.attempt_number=1 AND a.kind='automatic' AND a.started_at > now() - interval '7 days') x`, [ws]);
  const flag = await maybeOne<{ value: unknown }>(db, `SELECT value FROM system_flags WHERE key='dispatch_enabled'`);
  const circuits = await many<Record<string, unknown>>(db, `SELECT provider, state, failure_count, opened_until FROM provider_circuits`);
  const usage = await many<{ meter: string; period: string; used: string }>(db, `SELECT meter, period, used FROM usage_counters WHERE workspace_id=$1 AND team_id IS NULL ORDER BY period DESC, meter`, [ws]);
  const sum = (pred: (r: { state: string; is_mock: boolean }) => boolean) => counts.filter(pred).reduce((a, r) => a + r.n, 0);
  const finished = (mock: boolean) => sum((r) => r.is_mock === mock && ['published', 'failed', 'expired', 'unknown', 'blocked'].includes(r.state));
  const published = (mock: boolean) => sum((r) => r.is_mock === mock && r.state === 'published');
  const eligible = (mock: boolean) => sum((r) => r.is_mock === mock && ['published', 'failed', 'unknown'].includes(r.state));
  const rate = (a: number, b: number) => (b ? { value: a / b, numerator: a, denominator: b } : { value: null, numerator: a, denominator: b });
  const limits = await one<{ limits: Record<string, number> }>(db, `SELECT limits FROM workspaces WHERE id=$1`, [ws]);
  return {
    period: 'last 7 days (by scheduled time)',
    generated_at: new Date().toISOString(),
    dispatch_enabled: flag?.value !== false,
    queue: { due_now: queue?.due_now ?? 0, oldest_due_age_seconds: queue?.oldest_due ? Math.round((Date.now() - queue.oldest_due.getTime()) / 1000) : 0 },
    outbox: { pending: outbox.pending, dead: outbox.dead, oldest_age_seconds: outbox.oldest ? Math.round((Date.now() - outbox.oldest.getTime()) / 1000) : 0 },
    workers: workers.map((w) => ({ worker_id: w.worker_id, last_seen_at: w.last_seen_at.toISOString(), age_seconds: Math.round((Date.now() - w.last_seen_at.getTime()) / 1000), version: w.version, stopped: !!w.info?.stopped })),
    state_counts: { live: Object.fromEntries(counts.filter((c) => !c.is_mock).map((c) => [c.state, c.n])), simulated: Object.fromEntries(counts.filter((c) => c.is_mock).map((c) => [c.state, c.n])) },
    success_rate: {
      live: { unfiltered: rate(published(false), finished(false)), eligible: rate(published(false), eligible(false)) },
      simulated: { unfiltered: rate(published(true), finished(true)), eligible: rate(published(true), eligible(true)) },
      note: 'Eligible excludes blocked/paused/expired/throttled jobs. Simulated destinations are reported separately and are not real publications.',
    },
    dispatch_lateness_seconds: { p50: lateness?.p50 ?? null, p95: lateness?.p95 ?? null, sample: lateness?.n ?? 0, target_p95: 60 },
    circuits,
    usage: usage.map((u) => ({ ...u, used: Number(u.used) })),
    limits: limits.limits,
    alerts: [
      ...(flag?.value === false ? [{ severity: 'critical', message: 'Dispatch is disabled (restore/maintenance mode).' }] : []),
      ...(!workers.some((w) => Date.now() - w.last_seen_at.getTime() < 60_000) ? [{ severity: 'critical', message: 'No worker heartbeat in the last 60 seconds.' }] : []),
      ...((queue?.oldest_due && Date.now() - queue.oldest_due.getTime() > 120_000) ? [{ severity: 'warning', message: 'Due jobs have waited more than 2 minutes.' }] : []),
      ...(outbox.pending > 100 ? [{ severity: 'warning', message: `Outbox backlog: ${outbox.pending}` }] : []),
      ...(outbox.dead > 0 ? [{ severity: 'warning', message: `${outbox.dead} outbox events could not be dispatched.` }] : []),
      ...(sum((r) => !r.is_mock && r.state === 'unknown') > 0 ? [{ severity: 'warning', message: 'Some live results are Unknown and need reconciliation.' }] : []),
    ],
  };
}
