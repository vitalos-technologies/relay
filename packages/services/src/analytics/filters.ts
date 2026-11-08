// Analytics filter state: parse/validate from URL query params or saved JSON, and serialise canonically so a view is
// shareable by URL without private data (ids, dates, timezone and enums only). Access is NOT implied by a filter:
// every query re-authorizes the referenced brands/accounts/campaigns/teams (query.ts resolveScope).
import { AppError, PROVIDERS, isValidTimeZone, type Provider } from '@social-lite/core';
import {
  ANALYTICS_DATASETS, POST_FORMATS, type AnalyticsDataset, type AnalyticsFilters, type PostFormat,
} from '@social-lite/core/contracts/analytics';
import { addDays, isIsoDate, localDate, MAX_PERIOD_DAYS } from './semantics.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_IDS = 50;
export const DEFAULT_RANGE_DAYS = 28;

type Raw = URLSearchParams | Record<string, unknown>;

function get(raw: Raw, key: string): string | null {
  if (raw instanceof URLSearchParams) {
    const all = raw.getAll(key);
    return all.length ? all.join(',') : null;
  }
  const v = raw[key];
  if (v === undefined || v === null) return null;
  return Array.isArray(v) ? v.join(',') : String(v);
}

function list(raw: Raw, key: string): string[] {
  const v = get(raw, key);
  if (!v) return [];
  const items = [...new Set(v.split(',').map((x) => x.trim()).filter(Boolean))];
  if (items.length > MAX_IDS) throw new AppError('validation_failed', `Too many values for ${key}`, { [key]: `At most ${MAX_IDS}` });
  return items.sort();
}

function ids(raw: Raw, key: string, what: string): string[] {
  const v = list(raw, key);
  for (const id of v) if (!UUID.test(id)) throw new AppError('validation_failed', `Invalid ${what}`, { [key]: 'Use ids' });
  return v.map((x) => x.toLowerCase());
}

/**
 * Parse filters. Query keys: brand, account, network, campaign, team, format, from, to, tz, compare, dataset.
 * JSON (saved reports) may use the AnalyticsFilters field names instead.
 */
export function parseFilters(raw: Raw, defaults: { timezone: string; today?: Date }): AnalyticsFilters {
  const json = !(raw instanceof URLSearchParams);
  const pick = (q: string, j: string) => (json && (raw as Record<string, unknown>)[j] !== undefined ? j : q);
  const timezone = get(raw, pick('tz', 'timezone')) ?? defaults.timezone;
  if (!isValidTimeZone(timezone)) throw new AppError('validation_failed', `Unknown time zone "${timezone}"`, { tz: 'Use an IANA time zone' });
  const today = localDate(defaults.today ?? new Date(), timezone);
  const to = get(raw, 'to') ?? today;
  const from = get(raw, 'from') ?? addDays(to, -(DEFAULT_RANGE_DAYS - 1));
  if (!isIsoDate(from) || !isIsoDate(to)) throw new AppError('validation_failed', 'Dates must be YYYY-MM-DD', { from: 'YYYY-MM-DD', to: 'YYYY-MM-DD' });
  if (to < from) throw new AppError('validation_failed', '`to` must be on or after `from`', { to: 'Must be on or after from' });
  if (addDays(from, MAX_PERIOD_DAYS - 1) < to) throw new AppError('validation_failed', `The range can be at most ${MAX_PERIOD_DAYS} days`, { from: `At most ${MAX_PERIOD_DAYS} days` });
  const providers = list(raw, pick('network', 'providers'));
  for (const p of providers) if (!(PROVIDERS as readonly string[]).includes(p)) throw new AppError('validation_failed', 'Unknown network', { network: p });
  const formats = list(raw, pick('format', 'formats'));
  for (const f of formats) if (!(POST_FORMATS as readonly string[]).includes(f)) throw new AppError('validation_failed', 'Unknown format', { format: f });
  const compare = get(raw, 'compare') ?? 'previous_period';
  if (compare !== 'previous_period' && compare !== 'none') throw new AppError('validation_failed', 'Invalid compare', { compare: 'previous_period or none' });
  const dataset = get(raw, 'dataset') ?? 'live';
  if (!(ANALYTICS_DATASETS as readonly string[]).includes(dataset)) throw new AppError('validation_failed', 'Invalid dataset', { dataset: ANALYTICS_DATASETS.join(', ') });
  return {
    brand_ids: ids(raw, pick('brand', 'brand_ids'), 'brand'),
    connection_ids: ids(raw, pick('account', 'connection_ids'), 'account'),
    providers: providers as Provider[],
    campaign_ids: ids(raw, pick('campaign', 'campaign_ids'), 'campaign'),
    team_ids: ids(raw, pick('team', 'team_ids'), 'team'),
    formats: formats as PostFormat[],
    from, to, timezone,
    compare,
    dataset: dataset as AnalyticsDataset,
  };
}

/** Canonical, shareable query string (stable key order, sorted values, no names or private data). */
export function serializeFilters(f: AnalyticsFilters): string {
  const q = new URLSearchParams();
  const put = (k: string, v: string[]) => { if (v.length) q.set(k, [...v].sort().join(',')); };
  put('brand', f.brand_ids); put('account', f.connection_ids); put('network', f.providers); put('campaign', f.campaign_ids);
  put('team', f.team_ids); put('format', f.formats);
  q.set('from', f.from); q.set('to', f.to); q.set('tz', f.timezone);
  if (f.compare !== 'previous_period') q.set('compare', f.compare);
  if (f.dataset !== 'live') q.set('dataset', f.dataset);
  return q.toString();
}
