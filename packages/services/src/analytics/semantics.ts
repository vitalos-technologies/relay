// Analytics semantics (V3 spec §9) — PURE functions, unit-tested (tests/unit/v3-analytics-semantics.test.ts).
//  - Periods: inclusive local dates in an IANA zone → [start_utc, end_utc) at local midnights (DST-aware: 23/25 h days).
//  - Comparison: baseline zero ⇒ "new"; baseline missing/insufficient ⇒ "insufficient" (never ∞ %).
//  - Compatibility: only same-family values combine; unique (reach) never across networks/accounts; ratio metrics are
//    never summed; snapshots are never summed over dates; engagement rate = Σ numerators ÷ Σ denominators over
//    resources that report BOTH.
//  - Status: zero / unsupported / permission missing / not fetched / stale / provider delayed / partial coverage /
//    fetch failed stay distinct.
import { AppError, isValidTimeZone, resolveWallTime, wallClock, type Provider } from '@social-lite/core';
import type { Comparison, Coverage, Period, SeriesHealth, SeriesStatus, StatusReason } from '@social-lite/core/contracts/analytics';
import { FAMILIES, type MetricDefinition } from './registry.js';

export const MAX_PERIOD_DAYS = 400;
const DAY_MS = 86_400_000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// ------------------------------------------------------------------ dates & periods
export function isIsoDate(s: string): boolean {
  if (!DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export function addDays(date: string, n: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
}

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}

/** The first instant of a local date in tz (midnight; if midnight is skipped by DST, the first valid minute after). */
export function localMidnightUtc(date: string, tz: string): Date {
  for (let m = 0; m <= 180; m += 15) {
    const hh = String(Math.floor(m / 60)).padStart(2, '0');
    const mm = String(m % 60).padStart(2, '0');
    const r = resolveWallTime(`${date}T${hh}:${mm}`, tz);
    if (r.kind === 'ok') return r.instant;
    if (r.kind === 'ambiguous') return r.options[0]!.instant;
    if (r.kind === 'invalid') throw new AppError('validation_failed', r.message);
  }
  throw new AppError('validation_failed', `Cannot resolve the start of ${date} in ${tz}`);
}

/** Local calendar date (YYYY-MM-DD) of an instant in tz. */
export function localDate(instant: Date, tz: string): string {
  const w = wallClock(instant, tz);
  return `${w.y}-${String(w.mo).padStart(2, '0')}-${String(w.d).padStart(2, '0')}`;
}

export function localDateTime(instant: Date, tz: string): string {
  const w = wallClock(instant, tz);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${w.y}-${p(w.mo)}-${p(w.d)}T${p(w.h)}:${p(w.mi)}`;
}

export function resolvePeriod(from: string, to: string, timezone: string): Period {
  if (!isValidTimeZone(timezone)) throw new AppError('validation_failed', `Unknown time zone "${timezone}"`, { tz: 'Use an IANA time zone' });
  if (!isIsoDate(from) || !isIsoDate(to)) throw new AppError('validation_failed', 'Dates must be YYYY-MM-DD', { from: 'YYYY-MM-DD', to: 'YYYY-MM-DD' });
  const days = daysBetween(from, to) + 1;
  if (days < 1) throw new AppError('validation_failed', '`to` must be on or after `from`', { to: 'Must be on or after from' });
  if (days > MAX_PERIOD_DAYS) throw new AppError('validation_failed', `The range can be at most ${MAX_PERIOD_DAYS} days`, { from: `At most ${MAX_PERIOD_DAYS} days` });
  return {
    from, to, timezone, days,
    start_utc: localMidnightUtc(from, timezone).toISOString(),
    end_utc: localMidnightUtc(addDays(to, 1), timezone).toISOString(),
  };
}

/** The same number of days immediately before `p`. */
export function previousPeriod(p: Period): Period {
  return resolvePeriod(addDays(p.from, -p.days), addDays(p.from, -1), p.timezone);
}

/** Local dates of a period, in order. */
export function periodDates(p: Period): string[] {
  return Array.from({ length: p.days }, (_, i) => addDays(p.from, i));
}

/** Length in hours of a local day (23 / 24 / 25 around DST changes). */
export function localDayHours(date: string, tz: string): number {
  return (localMidnightUtc(addDays(date, 1), tz).getTime() - localMidnightUtc(date, tz).getTime()) / 3_600_000;
}

// ------------------------------------------------------------------ comparison
export function compare(current: number | null, previous: number | null, opts: { previousPeriod: Period | null; previousSufficient?: boolean; currentSufficient?: boolean } = { previousPeriod: null }): Comparison {
  const base = { current, previous, previous_period: opts.previousPeriod };
  if (current === null || previous === null || opts.previousSufficient === false || opts.currentSufficient === false) {
    return { ...base, change_abs: null, change_pct: null, state: 'insufficient' };
  }
  const abs = current - previous;
  if (previous === 0) {
    if (current === 0) return { ...base, change_abs: 0, change_pct: null, state: 'flat' };
    return { ...base, change_abs: abs, change_pct: null, state: 'new' };
  }
  const pct = abs / Math.abs(previous);
  return { ...base, change_abs: abs, change_pct: pct, state: abs === 0 ? 'flat' : abs > 0 ? 'up' : 'down' };
}

// ------------------------------------------------------------------ compatibility
export class IncompatibleMetricsError extends AppError {
  constructor(message: string) { super('validation_failed', message, undefined, { reason: 'incompatible_metrics' }); }
}

/**
 * Sum values of the given definitions, or refuse. Rules:
 *  - all definitions must share ONE family (views + impressions + reach never become one total);
 *  - aggregation must be 'sum' (ratio metrics, 'none' and snapshot gauges are refused here);
 *  - a unique family (reach) is never summed across networks or accounts;
 *  - other families may be summed across networks only as a LABELLED total (caller shows the components).
 */
export function sumCompatible(items: Array<{ def: MetricDefinition; value: number; connectionId?: string }>): { total: number; label: string; components: string[] } {
  if (!items.length) throw new IncompatibleMetricsError('Nothing to aggregate');
  const families = new Set(items.map((i) => i.def.family));
  if (families.size > 1) throw new IncompatibleMetricsError(`Cannot add ${[...families].map((f) => FAMILIES[f].label).join(' + ')}: different measures.`);
  const family = items[0]!.def.family;
  const bad = items.find((i) => i.def.aggregation !== 'sum');
  if (bad) throw new IncompatibleMetricsError(`${bad.def.name} (${bad.def.provider}) is aggregated by '${bad.def.aggregation}', not by summing.`);
  const providers = new Set(items.map((i) => i.def.provider));
  if (FAMILIES[family].crossNetwork === 'never' && providers.size > 1) {
    throw new IncompatibleMetricsError(`${FAMILIES[family].label} cannot be combined across networks (${[...providers].join(', ')}).`);
  }
  const connections = new Set(items.map((i) => i.connectionId).filter(Boolean));
  if (FAMILIES[family].unique && connections.size > 1) {
    throw new IncompatibleMetricsError(`${FAMILIES[family].label} counts unique people per account; it cannot be added across accounts.`);
  }
  const components = [...new Set(items.map((i) => `${i.def.provider}:${i.def.nativeMetric}`))];
  const label = providers.size > 1
    ? `${FAMILIES[family].label} — sum of network-reported values (${components.join(', ')}); definitions differ by network`
    : FAMILIES[family].unique ? `${FAMILIES[family].label} — sum of per-post unique counts (people can be counted more than once)` : FAMILIES[family].label;
  return { total: items.reduce((a, i) => a + i.value, 0), label, components };
}

/**
 * Snapshot gauges (followers) across accounts: ONE latest value per account (a second value for the same account
 * would be a sum over dates — refused). Labelled: people may follow several accounts.
 */
export function sumLatestAcrossAccounts(items: Array<{ def: MetricDefinition; value: number; connectionId: string }>): { total: number; label: string } {
  if (!items.length) throw new IncompatibleMetricsError('Nothing to aggregate');
  const fams = new Set(items.map((i) => i.def.family));
  if (fams.size > 1) throw new IncompatibleMetricsError('Cannot add different measures.');
  const bad = items.find((i) => i.def.aggregation !== 'latest');
  if (bad) throw new IncompatibleMetricsError(`${bad.def.name} is not a snapshot gauge.`);
  const seen = new Set<string>();
  for (const i of items) {
    if (seen.has(i.connectionId)) throw new IncompatibleMetricsError('Snapshots of the same account cannot be added (that would sum over dates).');
    seen.add(i.connectionId);
  }
  return { total: items.reduce((a, i) => a + i.value, 0), label: `${FAMILIES[items[0]!.def.family].label} — latest snapshot per account, added across ${items.length} account(s); people may follow several accounts` };
}

/** Engagement rate etc.: Σ numerators ÷ Σ denominators over resources that report BOTH. */
export function ratioOfSums(pairs: Array<{ numerator: number | null; denominator: number | null }>): { value: number | null; numerator: number; denominator: number; included: number; excluded: number } {
  let num = 0; let den = 0; let included = 0; let excluded = 0;
  for (const p of pairs) {
    if (p.numerator === null || p.denominator === null || !Number.isFinite(p.numerator) || !Number.isFinite(p.denominator)) { excluded++; continue; }
    num += p.numerator; den += p.denominator; included++;
  }
  return { value: den > 0 ? num / den : null, numerator: num, denominator: den, included, excluded };
}

/** Snapshot gauges (followers): latest value in the window; observed change = last − first (needs ≥ 2 snapshots). Never a sum. */
export function snapshotSummary(points: Array<{ date: string; value: number }>): { latest: number | null; as_of_date: string | null; observed_change: number | null } {
  if (!points.length) return { latest: null, as_of_date: null, observed_change: null };
  const sorted = [...points].sort((a, b) => a.date.localeCompare(b.date));
  const last = sorted[sorted.length - 1]!;
  return { latest: last.value, as_of_date: last.date, observed_change: sorted.length >= 2 ? last.value - sorted[0]!.value : null };
}

// ------------------------------------------------------------------ status
export type FetchState = 'ok' | 'unsupported' | 'permission_missing' | 'provider_delayed' | 'fetch_failed' | 'not_found' | 'reconnect_required'
  | 'budget_exhausted' | 'rate_limited' | 'access_revoked';

/** Map a stored fetch state to the user-facing series status for resources WITHOUT usable data. */
export function statusForFetchState(s: FetchState | null): Exclude<SeriesStatus, 'ok' | 'zero' | 'partial_coverage' | 'stale'> {
  switch (s) {
    case null: return 'not_fetched';
    case 'unsupported': return 'unsupported';
    case 'permission_missing': case 'reconnect_required': case 'access_revoked': return 'permission_missing';
    case 'provider_delayed': return 'provider_delayed';
    case 'ok': return 'not_fetched'; // fetched OK but this metric was not in the response
    default: return 'fetch_failed';
  }
}

export const STATUS_MESSAGES: Record<Exclude<SeriesStatus, 'ok'>, string> = {
  zero: 'Observed value is zero.',
  unsupported: 'Not provided by this network for this content.',
  permission_missing: 'The connection lacks the permission needed to read this (reconnect to grant it).',
  not_fetched: 'Not fetched yet.',
  stale: 'Data has not been refreshed recently.',
  provider_delayed: 'The network reports this with a delay; recent data is not available yet.',
  partial_coverage: 'Only part of the selected content has data.',
  fetch_failed: 'The last attempt to read this failed.',
};

export interface StatusInput {
  selected: number;
  eligible: number;
  withData: number;
  unsupported: number;
  value: number | null;
  /** Eligible resources WITHOUT data, grouped by their fetch state (null = never attempted). */
  missing: Array<{ state: FetchState | null; provider: Provider | null; count: number }>;
  /** Unsupported resources by provider (selected but not eligible). */
  unsupportedBy?: Array<{ provider: Provider; count: number }>;
  staleAccounts?: number;
}

export function coverage(unit: 'posts' | 'accounts', selected: number, eligible: number, withData: number, unsupported: number): Coverage {
  return { unit, selected, eligible, with_data: withData, unsupported, ratio: eligible > 0 ? withData / eligible : null };
}

/** Derive the series status + reasons from coverage and fetch states (precedence documented in the dictionary). */
export function deriveStatus(i: StatusInput): { status: SeriesStatus; reasons: StatusReason[] } {
  const reasons: StatusReason[] = [];
  const bucket = new Map<string, StatusReason>();
  for (const m of i.missing) {
    if (m.count <= 0) continue;
    const st = statusForFetchState(m.state);
    const key = `${st}|${m.provider ?? ''}`;
    const cur = bucket.get(key);
    if (cur) cur.count += m.count; else bucket.set(key, { status: st, count: m.count, provider: m.provider, message: STATUS_MESSAGES[st] });
  }
  for (const u of i.unsupportedBy ?? []) {
    if (u.count > 0) bucket.set(`unsupported|${u.provider}|sel`, { status: 'unsupported', count: u.count, provider: u.provider, message: STATUS_MESSAGES.unsupported });
  }
  reasons.push(...bucket.values());
  if ((i.staleAccounts ?? 0) > 0) reasons.push({ status: 'stale', count: i.staleAccounts!, provider: null, message: STATUS_MESSAGES.stale });

  let status: SeriesStatus;
  if (i.eligible === 0) {
    status = i.unsupported > 0 ? 'unsupported' : 'ok';
  } else if (i.withData === 0) {
    const order: SeriesStatus[] = ['permission_missing', 'fetch_failed', 'provider_delayed', 'unsupported', 'not_fetched'];
    status = order.find((s) => reasons.some((r) => r.status === s)) ?? 'not_fetched';
  } else if (i.withData < i.eligible) {
    const missingStates = reasons.filter((r) => r.status !== 'stale' && !(r.status === 'unsupported' && i.unsupportedBy?.some((u) => u.provider === r.provider)));
    status = missingStates.length > 0 && missingStates.every((r) => r.status === 'provider_delayed') ? 'provider_delayed' : 'partial_coverage';
    if (!reasons.some((r) => r.status === 'partial_coverage')) {
      reasons.push({ status: 'partial_coverage', count: i.eligible - i.withData, provider: null, message: STATUS_MESSAGES.partial_coverage });
    }
  } else if ((i.staleAccounts ?? 0) > 0) {
    status = 'stale';
  } else if (i.value === 0) {
    status = 'zero';
  } else {
    status = 'ok';
  }
  return { status, reasons };
}

export function health(unit: 'posts' | 'accounts', i: StatusInput, freshness: SeriesHealth['freshness']): SeriesHealth {
  const d = deriveStatus(i);
  return { status: d.status, reasons: d.reasons, coverage: coverage(unit, i.selected, i.eligible, i.withData, i.unsupported), freshness };
}

// ------------------------------------------------------------------ CSV
/** CSV cell: numbers verbatim; text escaped and formula-injection-safe (leading = + - @ tab CR are neutralised). */
export function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  let s = v instanceof Date ? v.toISOString() : Array.isArray(v) ? v.join(' ') : String(v);
  if (/^[=+\-@\t\r|%]/.test(s)) s = `'${s}`;
  return /[",\n\r;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function csvLine(cells: unknown[]): string {
  return cells.map(csvCell).join(',');
}
