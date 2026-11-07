// Usage budgets with atomic reservations (V2 §7 "Usage and limits"). ONE mechanism for every meter
// and both scopes: counters live in usage_counters (team_id NULL = workspace, else that team);
// workspace caps come from workspaces.limits, team caps from usage_budgets.
//
//   reserve  — lock the workspace row and the actor's team rows (deterministic order: workspace first,
//              then team ids ascending ⇒ no deadlocks), check used + reserved + amount ≤ cap on EVERY
//              capped scope, then reserved += amount. Concurrent reservations therefore never exceed a cap.
//   settle   — reserved -= amount, used += actual (idempotent: only a 'reserved' row transitions).
//   release  — settle with 0 (failure before anything was consumed).
//   consume  — reserve + settle inside the CALLER's transaction (provider writes at the send gate:
//              once the request leaves, it cannot be un-sent, so there is nothing to release).
// Stale reservations (crashed process) expire and are released by sweepExpiredReservations().
import { AppError } from '@social-lite/core';
import { getPool, many, maybeOne, withTx, type Queryable } from '@social-lite/db';
import { writeOutbox } from '../outbox.js';

export const BUDGET_METERS = {
  'ai.tokens': { limitKey: 'ai_monthly_tokens', label: 'AI tokens / month', unit: 'tokens', period: 'month', defaultCap: 200_000 },
  'x.write': { limitKey: 'x_monthly_writes', label: 'X posts / month', unit: 'calls', period: 'month', defaultCap: null },
  'x.read': { limitKey: 'x_monthly_reads', label: 'X reads / month', unit: 'calls', period: 'month', defaultCap: null },
  'storage.bytes': { limitKey: 'storage_bytes', label: 'Media storage', unit: 'bytes', period: 'total', defaultCap: null },
  'exports.count': { limitKey: 'monthly_exports', label: 'Exports / month', unit: 'exports', period: 'month', defaultCap: null },
} as const;
export type BudgetMeter = keyof typeof BUDGET_METERS;
export const BUDGET_METER_KEYS = Object.keys(BUDGET_METERS) as BudgetMeter[];
export const isBudgetMeter = (m: string): m is BudgetMeter => m in BUDGET_METERS;

/** 'YYYY-MM' (UTC) for monthly meters; 'total' for gauges such as storage. */
export function periodFor(meter: BudgetMeter, now = new Date()): string {
  return BUDGET_METERS[meter].period === 'month' ? now.toISOString().slice(0, 7) : 'total';
}

/** Workspace cap for a meter from workspaces.limits (null = uncapped). */
export function workspaceCap(limits: Record<string, unknown> | null | undefined, meter: BudgetMeter): number | null {
  const def = BUDGET_METERS[meter];
  const v = limits?.[def.limitKey];
  if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return Math.floor(v);
  return def.defaultCap;
}

export interface Reservation { id: string; workspaceId: string; meter: BudgetMeter; period: string; amount: number; teamIds: string[] }

export interface ReserveInput {
  workspaceId: string; meter: BudgetMeter; amount: number;
  /** Team attribution: the acting user's (active) teams are charged too. */
  userId?: string | null;
  /** Explicit team attribution (overrides userId lookup). */
  teamIds?: string[];
  ref?: string | null;
  ttlSeconds?: number;
}

const fmt = (meter: BudgetMeter, n: number) => {
  if (BUDGET_METERS[meter].unit === 'bytes') {
    const mb = n / 1_048_576;
    return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
  }
  return n.toLocaleString('en');
};

export interface ExhaustedDetail { meter: BudgetMeter; scope: 'workspace' | 'team'; team_id: string | null; team_name: string | null; cap: number; used: number; reserved: number; needed: number; period: string }

export function exhaustedMessage(d: ExhaustedDetail): string {
  const left = Math.max(0, d.cap - d.used - d.reserved);
  const who = d.scope === 'team' ? `The ${d.team_name ?? 'team'} team’s` : 'This workspace’s';
  const per = BUDGET_METERS[d.meter].period === 'month' ? 'monthly ' : '';
  switch (d.meter) {
    case 'ai.tokens':
      return `${who} ${per}AI allowance is used up (${fmt(d.meter, left)} of ${fmt(d.meter, d.cap)} tokens left; this needs up to ${fmt(d.meter, d.needed)}). It resets next month, or an owner can raise it.`;
    case 'x.write':
      return `${who} monthly X API post budget (${fmt(d.meter, d.cap)}) is used up. X posts are paused until next month or until the cap is raised; other channels continue.`;
    case 'x.read':
      return `${who} monthly X API read budget (${fmt(d.meter, d.cap)}) is used up. Billable X reads are skipped until next month or until the cap is raised.`;
    case 'storage.bytes':
      return `${who} media storage budget is full (${fmt(d.meter, left)} of ${fmt(d.meter, d.cap)} free; this file needs ${fmt(d.meter, d.needed)}). Archive unused media or ask an owner to raise it.`;
    case 'exports.count':
      return `${who} monthly export budget (${fmt(d.meter, d.cap)}) is used up. It resets next month, or an owner can raise it.`;
  }
}

async function teamsOf(db: Queryable, workspaceId: string, userId: string | null | undefined): Promise<string[]> {
  if (!userId) return [];
  const rows = await many<{ team_id: string }>(db,
    `SELECT tm.team_id FROM team_memberships tm JOIN teams t ON t.id = tm.team_id AND t.archived_at IS NULL
      WHERE tm.workspace_id = $1 AND tm.user_id = $2 ORDER BY tm.team_id`, [workspaceId, userId]);
  return rows.map((r) => r.team_id);
}

interface LockedRow { team_id: string | null; used: string; reserved: string }

/** Ensure and lock the counter rows (workspace first, then teams ascending). MUST run in a transaction. */
async function lockCounters(tx: Queryable, workspaceId: string, meter: BudgetMeter, period: string, teamIds: string[]): Promise<LockedRow[]> {
  await tx.query(`INSERT INTO usage_counters(workspace_id, meter, period, used) VALUES ($1,$2,$3,0) ON CONFLICT DO NOTHING`, [workspaceId, meter, period]);
  if (teamIds.length) {
    await tx.query(
      `INSERT INTO usage_counters(workspace_id, team_id, meter, period, used) SELECT $1, t, $3, $4, 0 FROM unnest($2::uuid[]) t ON CONFLICT DO NOTHING`,
      [workspaceId, teamIds, meter, period]);
  }
  return many<LockedRow>(tx,
    `SELECT team_id, used, reserved FROM usage_counters
      WHERE workspace_id = $1 AND meter = $2 AND period = $3 AND (team_id IS NULL OR team_id = ANY($4::uuid[]))
      ORDER BY team_id NULLS FIRST FOR UPDATE`, [workspaceId, meter, period, teamIds]);
}

/** Check every capped scope; returns the first exhausted one (or null). */
async function firstExhausted(tx: Queryable, workspaceId: string, meter: BudgetMeter, period: string, rows: LockedRow[], amount: number): Promise<ExhaustedDetail | null> {
  const ws = await maybeOne<{ limits: Record<string, unknown> }>(tx, `SELECT limits FROM workspaces WHERE id = $1`, [workspaceId]);
  const wsCap = workspaceCap(ws?.limits, meter);
  const teamCaps = rows.some((r) => r.team_id) ? await many<{ team_id: string; cap: string; name: string }>(tx,
    `SELECT b.team_id, b.cap, t.name FROM usage_budgets b JOIN teams t ON t.id = b.team_id
      WHERE b.workspace_id = $1 AND b.meter = $2 AND b.team_id = ANY($3::uuid[])`, [workspaceId, meter, rows.filter((r) => r.team_id).map((r) => r.team_id)]) : [];
  for (const r of rows) {
    const used = Number(r.used);
    const reserved = Number(r.reserved);
    const tc = r.team_id ? teamCaps.find((c) => c.team_id === r.team_id) : null;
    const cap = r.team_id ? (tc ? Number(tc.cap) : null) : wsCap;
    if (cap !== null && used + reserved + amount > cap) {
      return { meter, scope: r.team_id ? 'team' : 'workspace', team_id: r.team_id, team_name: tc?.name ?? null, cap, used, reserved, needed: amount, period };
    }
  }
  return null;
}

/** Threshold notifications (50/80/100 %) when settled usage crosses a cap fraction. */
async function thresholds(tx: Queryable, workspaceId: string, meter: BudgetMeter, period: string, teamId: string | null, before: number, after: number, cap: number | null) {
  if (cap === null || cap <= 0) return;
  for (const pct of [50, 80, 100]) {
    const t = Math.ceil((cap * pct) / 100);
    if (before < t && after >= t) {
      await writeOutbox(tx, { workspaceId, aggregateType: 'budget', aggregateId: `${teamId ? `team:${teamId}:` : ''}${meter}:${period}`, eventType: 'notification.created',
        payload: { kind: 'budget_threshold', meter, percent: pct, cap, period, team_id: teamId } });
    }
  }
}

async function applySettle(tx: Queryable, r: { workspaceId: string; meter: BudgetMeter; period: string; teamIds: string[]; amount: number }, actual: number, releasedReserve: boolean) {
  const rows = await lockCounters(tx, r.workspaceId, r.meter, r.period, r.teamIds);
  const ws = await maybeOne<{ limits: Record<string, unknown> }>(tx, `SELECT limits FROM workspaces WHERE id = $1`, [r.workspaceId]);
  const teamCaps = r.teamIds.length ? await many<{ team_id: string; cap: string }>(tx,
    `SELECT team_id, cap FROM usage_budgets WHERE workspace_id = $1 AND meter = $2 AND team_id = ANY($3::uuid[])`, [r.workspaceId, r.meter, r.teamIds]) : [];
  for (const row of rows) {
    const before = Number(row.used);
    await tx.query(
      `UPDATE usage_counters SET reserved = greatest(0, reserved - $5), used = greatest(0, used + $6)
        WHERE workspace_id = $1 AND meter = $2 AND period = $3 AND team_id IS NOT DISTINCT FROM $4::uuid`,
      [r.workspaceId, r.meter, r.period, row.team_id, releasedReserve ? r.amount : 0, actual]);
    const cap = row.team_id ? (teamCaps.find((c) => c.team_id === row.team_id)?.cap ?? null) : workspaceCap(ws?.limits, r.meter);
    await thresholds(tx, r.workspaceId, r.meter, r.period, row.team_id, before, before + actual, cap === null ? null : Number(cap));
  }
}

async function inTx<T>(db: Queryable | undefined, fn: (tx: Queryable) => Promise<T>): Promise<T> {
  return db ? fn(db) : withTx(fn);
}

/**
 * Atomically reserve `amount` on the workspace and the actor's teams, or throw budget_exhausted.
 * Pass `db` to run inside the caller's transaction (the reservation commits with it).
 */
export async function reserveUsage(input: ReserveInput, db?: Queryable): Promise<Reservation> {
  const amount = Math.max(0, Math.ceil(input.amount));
  if (!db) await sweepExpiredReservations({ workspaceId: input.workspaceId, meter: input.meter }).catch(() => undefined);
  return inTx(db, async (tx) => {
    const period = periodFor(input.meter);
    const teamIds = [...new Set(input.teamIds ?? await teamsOf(tx, input.workspaceId, input.userId))].sort();
    const rows = await lockCounters(tx, input.workspaceId, input.meter, period, teamIds);
    const ex = await firstExhausted(tx, input.workspaceId, input.meter, period, rows, amount);
    if (ex) throw new AppError('budget_exhausted', exhaustedMessage(ex), undefined, { ...ex });
    await tx.query(
      `UPDATE usage_counters SET reserved = reserved + $5
        WHERE workspace_id = $1 AND meter = $2 AND period = $3 AND (team_id IS NULL OR team_id = ANY($4::uuid[]))`,
      [input.workspaceId, input.meter, period, teamIds, amount]);
    const row = await maybeOne<{ id: string }>(tx,
      `INSERT INTO usage_reservations(workspace_id, meter, period, team_ids, amount, ref, actor_user_id, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7, now() + ($8 || ' seconds')::interval) RETURNING id`,
      [input.workspaceId, input.meter, period, teamIds, amount, input.ref?.slice(0, 200) ?? null, input.userId ?? null, String(input.ttlSeconds ?? 900)]);
    return { id: row!.id, workspaceId: input.workspaceId, meter: input.meter, period, amount, teamIds };
  });
}

type ResRow = { id: string; workspace_id: string; meter: BudgetMeter; period: string; team_ids: string[]; amount: string; status: string };

async function finish(id: string, actual: number, status: 'settled' | 'released' | 'expired', db?: Queryable): Promise<boolean> {
  const amount = Math.max(0, Math.round(actual));
  return inTx(db, async (tx) => {
    // Idempotent transition: only an open reservation is finished; a late settle of an expired
    // reservation still records the actual usage (the reserve was already returned by the sweeper).
    const open = await maybeOne<ResRow>(tx,
      `UPDATE usage_reservations SET status = $2, settled_amount = $3, finished_at = now() WHERE id = $1 AND status = 'reserved' RETURNING *`,
      [id, status, status === 'settled' ? amount : 0]);
    if (open) {
      await applySettle(tx, { workspaceId: open.workspace_id, meter: open.meter, period: open.period, teamIds: open.team_ids, amount: Number(open.amount) },
        status === 'settled' ? amount : 0, true);
      return true;
    }
    if (status !== 'settled') return false;
    const late = await maybeOne<ResRow>(tx,
      `UPDATE usage_reservations SET status = 'settled', settled_amount = $2, finished_at = now() WHERE id = $1 AND status = 'expired' RETURNING *`, [id, amount]);
    if (!late) return false;
    await applySettle(tx, { workspaceId: late.workspace_id, meter: late.meter, period: late.period, teamIds: late.team_ids, amount: 0 }, amount, false);
    return true;
  });
}

/** Settle a reservation to the actual usage. Returns false if it was already settled/released. */
export const settleUsage = (id: string, actual: number, db?: Queryable) => finish(id, actual, 'settled', db);
/** Release a reservation that consumed nothing. */
export const releaseUsage = (id: string, db?: Queryable) => finish(id, 0, 'released', db);

/** Settle (or release) the open reservation recorded under `ref` (e.g. 'asset:<id>'). */
export async function settleByRef(workspaceId: string, ref: string, actual: number | null, db?: Queryable): Promise<boolean> {
  const r = await maybeOne<{ id: string }>(db ?? getPool(),
    `SELECT id FROM usage_reservations WHERE workspace_id = $1 AND ref = $2 AND status IN ('reserved','expired') ORDER BY created_at DESC LIMIT 1`, [workspaceId, ref]);
  if (!r) return false;
  return actual === null ? releaseUsage(r.id, db) : settleUsage(r.id, actual, db);
}

/**
 * Reserve + settle in the caller's transaction (provider calls at the send gate). Never throws for an
 * exhausted budget: returns { ok:false, message } so the engine can block just that job.
 */
export async function consumeUsage(tx: Queryable, input: ReserveInput): Promise<{ ok: true } | { ok: false; message: string; detail: ExhaustedDetail }> {
  const amount = Math.max(0, Math.ceil(input.amount));
  const period = periodFor(input.meter);
  const teamIds = [...new Set(input.teamIds ?? await teamsOf(tx, input.workspaceId, input.userId))].sort();
  const rows = await lockCounters(tx, input.workspaceId, input.meter, period, teamIds);
  const ex = await firstExhausted(tx, input.workspaceId, input.meter, period, rows, amount);
  if (ex) return { ok: false, message: exhaustedMessage(ex), detail: ex };
  await applySettle(tx, { workspaceId: input.workspaceId, meter: input.meter, period, teamIds, amount: 0 }, amount, false);
  return { ok: true };
}

/** Release reservations past their expiry (crashed request/worker). Safe to run anywhere, any time. */
export async function sweepExpiredReservations(scope: { workspaceId?: string; meter?: BudgetMeter; limit?: number } = {}): Promise<number> {
  const rows = await many<{ id: string }>(getPool(),
    `SELECT id FROM usage_reservations WHERE status = 'reserved' AND expires_at < now()
        AND ($1::uuid IS NULL OR workspace_id = $1) AND ($2::text IS NULL OR meter = $2)
      ORDER BY expires_at LIMIT $3`, [scope.workspaceId ?? null, scope.meter ?? null, scope.limit ?? 100]);
  let n = 0;
  for (const r of rows) if (await finish(r.id, 0, 'expired')) n++;
  return n;
}

export interface MeterUsage { meter: BudgetMeter; period: string; used: number; reserved: number; cap: number | null; remaining: number | null }

/** Current-period usage for a workspace (and optionally one team). */
export async function readMeterUsage(workspaceId: string, meter: BudgetMeter, opts: { teamId?: string | null } = {}, db: Queryable = getPool()): Promise<MeterUsage> {
  const period = periodFor(meter);
  const row = await maybeOne<{ used: string; reserved: string }>(db,
    `SELECT used, reserved FROM usage_counters WHERE workspace_id = $1 AND meter = $2 AND period = $3 AND team_id IS NOT DISTINCT FROM $4::uuid`,
    [workspaceId, meter, period, opts.teamId ?? null]);
  let cap: number | null;
  if (opts.teamId) {
    const b = await maybeOne<{ cap: string }>(db, `SELECT cap FROM usage_budgets WHERE workspace_id = $1 AND team_id = $2 AND meter = $3`, [workspaceId, opts.teamId, meter]);
    cap = b ? Number(b.cap) : null;
  } else {
    const ws = await maybeOne<{ limits: Record<string, unknown> }>(db, `SELECT limits FROM workspaces WHERE id = $1`, [workspaceId]);
    cap = workspaceCap(ws?.limits, meter);
  }
  const used = Number(row?.used ?? 0);
  const reserved = Number(row?.reserved ?? 0);
  return { meter, period, used, reserved, cap, remaining: cap === null ? null : Math.max(0, cap - used - reserved) };
}

/** Would `amount` fit right now on the workspace and the user's teams? (read-only; for preflight) */
export async function wouldFit(workspaceId: string, meter: BudgetMeter, amount: number, userId?: string | null, db: Queryable = getPool()): Promise<{ ok: boolean; detail: ExhaustedDetail | null; usage: MeterUsage }> {
  const usage = await readMeterUsage(workspaceId, meter, {}, db);
  const period = usage.period;
  const teamIds = await teamsOf(db, workspaceId, userId);
  const rows: LockedRow[] = [{ team_id: null, used: String(usage.used), reserved: String(usage.reserved) }];
  if (teamIds.length) {
    const t = await many<LockedRow>(db, `SELECT team_id, used, reserved FROM usage_counters WHERE workspace_id = $1 AND meter = $2 AND period = $3 AND team_id = ANY($4::uuid[]) ORDER BY team_id`,
      [workspaceId, meter, period, teamIds]);
    for (const id of teamIds) rows.push(t.find((r) => r.team_id === id) ?? { team_id: id, used: '0', reserved: '0' });
  }
  const detail = await firstExhausted(db, workspaceId, meter, period, rows, amount);
  return { ok: !detail, detail, usage };
}
