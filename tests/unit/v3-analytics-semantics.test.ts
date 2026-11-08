// V3 analytics pure semantics: periods/DST, comparisons, compatibility rules, ratio of sums, snapshots, status
// derivation, CSV safety, filters serialisation, cadence and point normalization.
import { describe, expect, it } from 'vitest';
import {
  compare, csvCell, deriveStatus, localDayHours, previousPeriod, ratioOfSums, resolvePeriod, snapshotSummary, sumCompatible, sumLatestAcrossAccounts,
} from '@social-lite/services/analytics/semantics';
import { definition, METRIC_DEFINITIONS, FAMILIES, unmappedAdapterMetrics } from '@social-lite/services/analytics/registry';
import { parseFilters, serializeFilters } from '@social-lite/services/analytics/filters';
import { nextAttemptAt } from '@social-lite/services/analytics/cadence';
import { normalizePoint, rollupBucket } from '@social-lite/services/analytics/ingest';

const def = (id: string) => definition(id)!;

describe('periods', () => {
  it('uses local midnights with 23/25-hour DST days (Europe/London)', () => {
    expect(localDayHours('2026-03-29', 'Europe/London')).toBe(23);
    expect(localDayHours('2026-10-25', 'Europe/London')).toBe(25);
    const p = resolvePeriod('2026-03-29', '2026-03-29', 'Europe/London');
    expect(p).toMatchObject({ start_utc: '2026-03-29T00:00:00.000Z', end_utc: '2026-03-29T23:00:00.000Z', days: 1 });
    expect(previousPeriod(resolvePeriod('2026-10-01', '2026-10-31', 'Europe/London'))).toMatchObject({ from: '2026-08-31', to: '2026-09-30', days: 31 });
    expect(() => resolvePeriod('2026-10-02', '2026-10-01', 'Europe/London')).toThrow(/on or after/);
    expect(() => resolvePeriod('2026-10-01', '2026-10-02', 'Mars/Base')).toThrow(/time zone/);
  });
  it('15-minute rollup buckets never straddle a local midnight for quarter-hour offsets', () => {
    expect(rollupBucket(new Date('2026-03-01T18:44:59Z')).toISOString()).toBe('2026-03-01T18:30:00.000Z'); // 00:14 IST next day … bucket 00:00 IST
  });
});

describe('comparisons', () => {
  it('baseline zero ⇒ new, missing ⇒ insufficient, never infinite growth', () => {
    expect(compare(5, 0, { previousPeriod: null }).state).toBe('new');
    expect(compare(5, 0, { previousPeriod: null }).change_pct).toBeNull();
    expect(compare(5, null, { previousPeriod: null }).state).toBe('insufficient');
    expect(compare(5, 4, { previousPeriod: null, previousSufficient: false }).state).toBe('insufficient');
    expect(compare(0, 0, { previousPeriod: null }).state).toBe('flat');
    expect(compare(12, 10, { previousPeriod: null })).toMatchObject({ state: 'up', change_abs: 2, change_pct: 0.2 });
    expect(compare(8, 10, { previousPeriod: null })).toMatchObject({ state: 'down', change_pct: -0.2 });
  });
});

describe('compatibility', () => {
  it('refuses to add different families, unique reach across networks/accounts, ratios and snapshots over dates', () => {
    expect(() => sumCompatible([{ def: def('instagram.post.views'), value: 1 }, { def: def('x.post.impression_count'), value: 1 }])).toThrow(/different measures/);
    expect(() => sumCompatible([{ def: def('instagram.post.reach'), value: 1 }, { def: def('facebook.post.post_total_media_view_unique'), value: 1 }])).toThrow(/across networks/);
    expect(() => sumCompatible([{ def: def('instagram.post.reach'), value: 1, connectionId: 'a' }, { def: def('instagram.post.reach'), value: 1, connectionId: 'b' }])).toThrow(/across accounts/);
    expect(() => sumCompatible([{ def: def('youtube.video.averageViewDuration'), value: 30 }])).toThrow(/ratio_of_sums/);
    expect(() => sumCompatible([{ def: def('instagram.account.followers_count'), value: 10 }])).toThrow(/latest/);
    const ok = sumCompatible([{ def: def('instagram.post.views'), value: 10 }, { def: def('tiktok.video.view_count'), value: 5 }]);
    expect(ok.total).toBe(15);
    expect(ok.label).toMatch(/definitions differ by network/);
    expect(ok.components).toEqual(['instagram:views', 'tiktok:view_count']);
    expect(() => sumLatestAcrossAccounts([{ def: def('x.account.followers_count'), value: 1, connectionId: 'a' }, { def: def('x.account.followers_count'), value: 2, connectionId: 'a' }])).toThrow(/sum over dates/);
    expect(sumLatestAcrossAccounts([{ def: def('x.account.followers_count'), value: 1, connectionId: 'a' }, { def: def('instagram.account.followers_count'), value: 2, connectionId: 'b' }]).total).toBe(3);
  });
  it('ratio of sums excludes resources without both sides', () => {
    const r = ratioOfSums([{ numerator: 10, denominator: 100 }, { numerator: 90, denominator: 300 }, { numerator: 5, denominator: null }]);
    expect(r).toMatchObject({ value: 0.25, included: 2, excluded: 1 });
    expect(ratioOfSums([{ numerator: 3, denominator: 0 }]).value).toBeNull();
  });
  it('snapshots: latest + observed change, never a sum', () => {
    expect(snapshotSummary([{ date: '2026-10-02', value: 110 }, { date: '2026-10-01', value: 100 }])).toEqual({ latest: 110, as_of_date: '2026-10-02', observed_change: 10 });
    expect(snapshotSummary([{ date: '2026-10-02', value: 110 }]).observed_change).toBeNull();
  });
  it('registry: unique families are reach/audience only; every adapter metric mapped; ids are provider-qualified', () => {
    expect(Object.entries(FAMILIES).filter(([, f]) => f.unique).map(([k]) => k).sort()).toEqual(['audience', 'reach']);
    expect(unmappedAdapterMetrics()).toEqual([]);
    expect(new Set(METRIC_DEFINITIONS.map((d) => `${d.id}@${d.version}`)).size).toBe(METRIC_DEFINITIONS.length);
    expect(METRIC_DEFINITIONS.filter((d) => d.paid === 'paid').every((d) => !d.fetched)).toBe(true);
  });
});

describe('status derivation', () => {
  const base = { selected: 4, eligible: 4, withData: 4, unsupported: 0, value: 10, missing: [] };
  it('keeps zero, partial coverage, delays, permissions and unsupported distinct', () => {
    expect(deriveStatus(base).status).toBe('ok');
    expect(deriveStatus({ ...base, value: 0 }).status).toBe('zero');
    expect(deriveStatus({ ...base, withData: 3, missing: [{ state: 'fetch_failed', provider: 'instagram', count: 1 }] }).status).toBe('partial_coverage');
    expect(deriveStatus({ ...base, withData: 3, missing: [{ state: 'provider_delayed', provider: 'youtube', count: 1 }] }).status).toBe('provider_delayed');
    expect(deriveStatus({ ...base, withData: 0, value: null, missing: [{ state: 'permission_missing', provider: 'instagram', count: 4 }] }).status).toBe('permission_missing');
    expect(deriveStatus({ ...base, withData: 0, value: null, missing: [{ state: null, provider: 'instagram', count: 4 }] }).status).toBe('not_fetched');
    expect(deriveStatus({ ...base, withData: 0, value: null, missing: [{ state: 'rate_limited', provider: 'x', count: 4 }] }).status).toBe('fetch_failed');
    expect(deriveStatus({ selected: 2, eligible: 0, withData: 0, unsupported: 2, value: null, missing: [] }).status).toBe('unsupported');
    expect(deriveStatus({ ...base, staleAccounts: 1 }).status).toBe('stale');
  });
});

describe('CSV safety', () => {
  it('neutralises formulas in text but keeps numbers (incl. negative observed changes) numeric', () => {
    expect(csvCell('=1+2')).toBe("'=1+2");
    expect(csvCell('+SUM(A1)')).toBe("'+SUM(A1)");
    expect(csvCell('-2+3')).toBe("'-2+3");
    expect(csvCell('@cmd')).toBe("'@cmd");
    expect(csvCell('a,"b"')).toBe('"a,""b"""');
    expect(csvCell(-5)).toBe('-5');
    expect(csvCell(null)).toBe('');
  });
});

describe('filters', () => {
  it('serialises canonically (ids/dates only) and round-trips', () => {
    const a = '3f1e3c3a-0000-4000-8000-000000000002'; const b = '3f1e3c3a-0000-4000-8000-000000000001';
    const f = parseFilters(new URLSearchParams(`brand=${a},${b}&network=x,instagram&from=2026-10-01&to=2026-10-07&tz=Europe/Paris`), { timezone: 'UTC' });
    expect(f.brand_ids).toEqual([b, a]);
    const qs = serializeFilters(f);
    expect(qs).toBe(`brand=${b}%2C${a}&network=instagram%2Cx&from=2026-10-01&to=2026-10-07&tz=Europe%2FParis`);
    expect(parseFilters(new URLSearchParams(qs), { timezone: 'UTC' })).toEqual(f);
    expect(() => parseFilters(new URLSearchParams('brand=not-a-uuid'), { timezone: 'UTC' })).toThrow(/Invalid brand/);
    expect(() => parseFilters(new URLSearchParams('dataset=everything'), { timezone: 'UTC' })).toThrow(/Invalid dataset/);
    expect(() => parseFilters(new URLSearchParams('from=2024-01-01&to=2026-01-01'), { timezone: 'UTC' })).toThrow(/at most/);
    const d = parseFilters(new URLSearchParams(), { timezone: 'Europe/London', today: new Date('2026-11-07T12:00:00Z') });
    expect(d).toMatchObject({ from: '2026-10-11', to: '2026-11-07', compare: 'previous_period', dataset: 'live' });
  });
});

describe('cadence and normalization', () => {
  const now = new Date('2026-11-07T12:00:00Z');
  const ago = (h: number) => new Date(now.getTime() - h * 3_600_000);
  it('reads young posts often, old posts rarely, stops at the horizon and on permanent states', () => {
    expect(nextAttemptAt('instagram', ago(10), now, 'ok')!.getTime() - now.getTime()).toBe(6 * 3_600_000);
    expect(nextAttemptAt('instagram', ago(24 * 5), now, 'ok')!.getTime() - now.getTime()).toBe(24 * 3_600_000);
    expect(nextAttemptAt('instagram', ago(24 * 100), now, 'ok')).toBeNull();
    expect(nextAttemptAt('x', ago(24 * 40), now, 'ok')).toBeNull(); // billable: 30-day horizon
    expect(nextAttemptAt('instagram', ago(10), now, 'unsupported')).toBeNull();
    expect(nextAttemptAt('instagram', ago(10), now, 'permission_missing')).toBeNull();
    expect(nextAttemptAt('instagram', ago(10), now, 'fetch_failed', 3)!.getTime() - now.getTime()).toBe(8 * 3_600_000);
  });
  it('validates points and maps provider windows to lifetime only when they cover the whole life', () => {
    const t = { provider: 'pinterest' as const, resourceType: 'post' as const, publishedAt: new Date('2026-10-01T10:00:00Z') };
    expect(normalizePoint(t, { name: 'IMPRESSION', dimension: null, value: 5, period: '2026-10-01..2026-11-07', windowEnd: '2026-11-07' }, now)).toMatchObject({ basis: 'lifetime', periodKey: 'asof:2026-11-07' });
    const old = { ...t, publishedAt: new Date('2026-05-01T10:00:00Z') };
    expect(normalizePoint(old, { name: 'IMPRESSION', dimension: null, value: 5, period: '2026-08-10..2026-11-07', windowEnd: '2026-11-07' }, now)).toMatchObject({ basis: 'window', windowStart: '2026-08-10' });
    expect(normalizePoint(t, { name: 'NOT_A_METRIC', dimension: null, value: 5, period: 'lifetime', windowEnd: null }, now)).toEqual({ reject: 'unmapped metric (not in the registry)' });
    expect(normalizePoint(t, { name: 'SAVE', dimension: null, value: -1, period: 'lifetime', windowEnd: null }, now)).toEqual({ reject: 'negative counter value' });
    expect(normalizePoint(t, { name: 'SAVE', dimension: null, value: Number.NaN, period: 'lifetime', windowEnd: null }, now)).toEqual({ reject: 'non-numeric value' });
    const yt = normalizePoint({ provider: 'youtube', resourceType: 'post', publishedAt: new Date('2026-11-01T00:00:00Z') }, { name: 'views', dimension: null, value: 9, period: '2026-11-01..2026-11-07', windowEnd: '2026-11-07' }, now);
    expect(yt).toMatchObject({ basis: 'lifetime' });
    expect((yt as { throughAt: Date }).throughAt.toISOString()).toBe('2026-11-04T12:00:00.000Z'); // 72 h YouTube Analytics delay
    expect(normalizePoint({ provider: 'x', resourceType: 'post', publishedAt: null }, { name: 'retweet_count', dimension: null, value: 1, period: 'lifetime', windowEnd: null }, now))
      .toMatchObject({ def: expect.objectContaining({ id: 'x.post.repost_count' }) });
  });
});
