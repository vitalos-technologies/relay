// Analytics query API (V3 spec §8/§9) — authorized, scope-filtered reads over the V3 facts. No provider calls.
// Every view: persistent filters (brand/account/network/campaign/team/format/date range/timezone/dataset), previous
// period comparison, coverage + through-date per series, freshness. Semantics enforced here (see semantics.ts):
//  - lifetime counters of posts are bucketed by the post's PUBLISH time in the filter timezone and labelled
//    "Lifetime performance of posts published in this period";
//  - views / impressions / reach are never combined; reach (unique) is never summed across accounts or networks;
//  - engagement rate = Σ engagements ÷ Σ denominator over posts reporting BOTH;
//  - missing values are null with a status (never 0); demo/simulated data only in their own datasets.
import { AppError, PROVIDER_LABEL, forbidden, notFound, type Provider } from '@social-lite/core';
import type {
  AnalyticsFilters, AudienceResponse, BestTimeResponse, ChannelComparison, ChannelRow, ChannelsResponse, ContentDetailResponse, ContentRow, ContentSort,
  ContentTableResponse, DataHealth, Freshness, Insight, Kpi, MeasureBasis, MeasureComponent, MeasureDefinition, MeasureKey, MeasureOption, MetricDefinitionDto,
  MetricValue, OverviewResponse, Period, PostFormat, ResponseMeta, SeriesHealth, SeriesStatus, StatusReason, Thumbnail, Trend, TrendPoint, TrendSeries,
  VideoResponse, WorkflowResponse,
} from '@social-lite/core/contracts/analytics';
import { CONTENT_SORTS, MEASURE_KEYS } from '@social-lite/core/contracts/analytics';
import { getPool, many, maybeOne } from '@social-lite/db';
import type { Ctx } from '../context.js';
import { signedGetUrl } from '../storage.js';
import { assertUuid, brandAllowed, requireAction } from '../tenancy.js';
import { brandForPermission, brandsWith } from '../product/scope.js';
import { serializeFilters } from './filters.js';
import { summaryReady } from './summary.js';
import { rollupSelectSql, type DataSource } from './ingest.js';
import {
  DERIVED, ENGAGEMENT_FAMILIES, FAMILIES, MEASURES, METRIC_DEFINITIONS, definition, definitionsFor, ensureMetricRegistry, familyKey, fetchedPostDefinitions,
  type MetricDefinition, type MetricFamily,
} from './registry.js';
import {
  IncompatibleMetricsError, STATUS_MESSAGES, compare, coverage, deriveStatus, localDate, localDateTime, periodDates, previousPeriod, ratioOfSums, resolvePeriod,
  snapshotSummary, statusForFetchState, sumCompatible, sumLatestAcrossAccounts, type FetchState, type StatusInput,
} from './semantics.js';

export const LIFETIME_LABEL = 'Lifetime performance of posts published in this period';
export const OBSERVED_CHANGE_LABEL = 'Observed change between consecutive snapshots (includes corrections; not event-time counts)';
const STALE_HOURS = 48;
const MAX_POST_STATES = 50_000;
const PREVIEW_TTL = 15 * 60;

// ------------------------------------------------------------------ scope (authorization)
export interface ConnInfo {
  id: string; brand_id: string; provider: Provider; display_name: string; status: string; is_mock: boolean; is_synthetic: boolean; disconnected_at: Date | null;
}

export interface Scope {
  filters: AnalyticsFilters;
  queryString: string;
  period: Period;
  previous: Period | null;
  sources: DataSource[];
  synthetic: boolean;
  brands: Array<{ id: string; name: string }>;
  connections: ConnInfo[];
  /** Post-level filters that the rollups cannot answer (campaign/team/format) ⇒ per-post aggregation path. */
  perPost: boolean;
  workspaceId: string;
}

const DATASET_PREDICATE = { live: 'NOT c.is_mock', simulated: 'c.is_mock AND NOT c.is_synthetic', demo: 'c.is_synthetic' } as const;
const DATASET_SOURCE: Record<AnalyticsFilters['dataset'], DataSource> = { live: 'provider', simulated: 'simulated', demo: 'synthetic' };

/**
 * Authorize and resolve the filter scope against the CURRENT policy: analytics.read on every brand involved (404 for
 * brands/accounts/campaigns/teams outside the caller's reach). Demo data only in demo workspaces.
 */
export async function resolveScope(ctx: Ctx, filters: AnalyticsFilters, opts: { permission?: 'analytics.read' } = {}): Promise<Scope> {
  const perm = opts.permission ?? 'analytics.read';
  requireAction(ctx, perm);
  await ensureMetricRegistry();
  const db = getPool();
  const ws = ctx.access.workspaceId;
  if (filters.dataset === 'demo') {
    const w = await maybeOne<{ is_demo: boolean }>(db, `SELECT is_demo FROM workspaces WHERE id=$1`, [ws]);
    if (!w?.is_demo) throw forbidden('Demo data is only available in demo workspaces.');
  }
  let brands: Array<{ id: string; name: string }>;
  if (filters.brand_ids.length) {
    brands = [];
    for (const id of filters.brand_ids) { const b = await brandForPermission(ctx, id, perm); brands.push({ id: b.id, name: b.name }); }
  } else {
    brands = await brandsWith(ctx, perm);
  }
  for (const b of brands) if (!brandAllowed(ctx, b.id)) throw notFound('Brand');
  const brandIds = brands.map((b) => b.id);
  const conns = brandIds.length ? await many<ConnInfo>(db,
    `SELECT c.id, c.brand_id, c.provider, c.display_name, c.status::text AS status, c.is_mock, c.is_synthetic, c.disconnected_at FROM connections c
      WHERE c.workspace_id=$1 AND c.brand_id = ANY($2::uuid[]) AND ${DATASET_PREDICATE[filters.dataset]}
        AND ($3::text[] IS NULL OR c.provider::text = ANY($3::text[])) ORDER BY c.provider, c.display_name, c.id`,
    [ws, brandIds, filters.providers.length ? filters.providers : null]) : [];
  let connections = conns;
  if (filters.connection_ids.length) {
    const byId = new Map(conns.map((c) => [c.id, c]));
    connections = filters.connection_ids.map((id) => { const c = byId.get(id); if (!c) throw notFound('Account'); return c; });
  }
  if (filters.campaign_ids.length) {
    const found = await many<{ id: string }>(db, `SELECT id FROM campaigns WHERE workspace_id=$1 AND id = ANY($2::uuid[]) AND brand_id = ANY($3::uuid[])`, [ws, filters.campaign_ids, brandIds]);
    if (found.length !== filters.campaign_ids.length) throw notFound('Campaign');
  }
  if (filters.team_ids.length) {
    const found = await many<{ id: string }>(db, `SELECT id FROM teams WHERE workspace_id=$1 AND id = ANY($2::uuid[])`, [ws, filters.team_ids]);
    if (found.length !== filters.team_ids.length) throw notFound('Team');
  }
  const period = resolvePeriod(filters.from, filters.to, filters.timezone);
  return {
    filters, queryString: serializeFilters(filters), period, previous: filters.compare === 'previous_period' ? previousPeriod(period) : null,
    sources: [DATASET_SOURCE[filters.dataset]], synthetic: filters.dataset === 'demo', brands, connections,
    perPost: filters.campaign_ids.length > 0 || filters.team_ids.length > 0 || filters.formats.length > 0, workspaceId: ws,
  };
}

function meta(scope: Scope, period: Period = scope.period): ResponseMeta {
  return {
    filters: scope.filters, query_string: scope.queryString, period, previous_period: scope.previous, dataset: scope.filters.dataset,
    synthetic: scope.synthetic, generated_at: new Date().toISOString(),
    scope: {
      brands: scope.brands,
      accounts: scope.connections.map((c) => ({ connection_id: c.id, brand_id: c.brand_id, provider: c.provider, display_name: c.display_name, status: c.disconnected_at ? 'disconnected' : c.status, is_mock: c.is_mock })),
    },
  };
}

// ------------------------------------------------------------------ SQL builders
class Params {
  values: unknown[] = [];
  p(v: unknown): string { this.values.push(v); return `$${this.values.length}`; }
}

interface PostScopeOpts { videoOnly?: boolean; deliveryIds?: string[] }

/** SELECT of published deliveries in scope and period (+ campaign/team/format filters). */
function postScopeSql(scope: Scope, period: Period, q: Params, o: PostScopeOpts = {}): string {
  const f = scope.filters;
  const conds = [
    `d.workspace_id = ${q.p(scope.workspaceId)}`, `d.state = 'published'`, `d.published_at IS NOT NULL`,
    `d.connection_id = ANY(${q.p(scope.connections.map((c) => c.id))}::uuid[])`,
    `d.published_at >= ${q.p(period.start_utc)}::timestamptz`, `d.published_at < ${q.p(period.end_utc)}::timestamptz`,
  ];
  if (f.campaign_ids.length) conds.push(`p.campaign_id = ANY(${q.p(f.campaign_ids)}::uuid[])`);
  if (f.team_ids.length) conds.push(`p.team_id = ANY(${q.p(f.team_ids)}::uuid[])`);
  if (f.formats.length) conds.push(`v.format = ANY(${q.p(f.formats)}::text[])`);
  if (o.videoOnly) conds.push(`(v.format IN ('video','reel') OR d.provider IN ('youtube','tiktok'))`);
  if (o.deliveryIds) conds.push(`d.id = ANY(${q.p(o.deliveryIds)}::uuid[])`);
  return `SELECT d.id, d.post_id, d.brand_id, d.connection_id, d.provider, d.published_at, d.provider_url, d.revision_id, d.variant_id, v.format, p.campaign_id, p.title
            FROM deliveries d JOIN posts p ON p.id = d.post_id AND p.workspace_id = d.workspace_id
            JOIN variants v ON v.id = d.variant_id AND v.workspace_id = d.workspace_id
           WHERE ${conds.join(' AND ')}`;
}

export interface Agg {
  connection_id: string; provider: Provider; local_date: string; metric_key: string; definition_version: number; dimension: string;
  value: number; resources: number; min_through: Date | null; min_observed: Date | null; max_observed: Date | null;
}

/**
 * Aggregates per (connection, local publish date, metric key). Rollup path (cached 15-minute buckets) unless post-level
 * filters are present; the per-post path computes identical rows from metric_resource_latest.
 */
export async function aggregate(scope: Scope, period: Period,
  o: PostScopeOpts & {
    forcePerPost?: boolean; forceRollups?: boolean;
    /** V3.1: one row per key for the whole period (local_date = ''), family/derived keys only… */
    totals?: boolean;
    /** …plus, in the same statement, per-day rows for these keys only (rows with local_date ≠ ''). */
    dayKeys?: string[];
  } = {}): Promise<Agg[]> {
  if (!scope.connections.length) return [];
  const q = new Params();
  let sql: string;
  const rollupPath = !scope.perPost && !o.videoOnly && !o.deliveryIds && !o.forcePerPost;
  if (rollupPath) {
    // V3.1 PERF: the precomputed per-local-day summary (migration 025) when this zone is ready, else the 15-minute rollups.
    // Both produce identical rows (tests/integration/v31-analytics-summary.test.ts). Totals are the same sums/min/max as
    // adding up the per-day rows in measureFromAggs.
    const summary = !o.forceRollups && await zoneReady(scope, period.timezone);
    const ws = q.p(scope.workspaceId); const src = q.p(scope.sources); const conns = q.p(scope.connections.map((c) => c.id));
    let tzp: string | null = null;
    const tz = () => (tzp ??= q.p(period.timezone)); // allocated only when referenced (no unused, untyped parameter)
    const where = summary
      ? `workspace_id = ${ws} AND tz = ${tz()} AND source = ANY(${src}::text[]) AND local_date >= ${q.p(period.from)}::date AND local_date <= ${q.p(period.to)}::date
         AND connection_id IN (SELECT unnest(${conns}::uuid[]))`
      : `workspace_id = ${ws} AND source = ANY(${src}::text[]) AND connection_id IN (SELECT unnest(${conns}::uuid[]))
         AND bucket_start >= ${q.p(period.start_utc)}::timestamptz AND bucket_start < ${q.p(period.end_utc)}::timestamptz`;
    const day = () => (summary ? 'local_date::text' : `(bucket_start AT TIME ZONE ${tz()})::date::text`);
    const select = (dateCol: string, keyFilter: string) => `SELECT connection_id, provider::text AS provider, ${dateCol} AS local_date, metric_key, definition_version, dimension,
                  sum(value_sum)::float8 AS value, sum(resources)::int AS resources, min(min_through_at) AS min_through, min(min_observed_at) AS min_observed,
                  max(max_observed_at) AS max_observed
             FROM ${summary ? 'metric_rollup_days' : 'metric_rollups'} WHERE ${where}${keyFilter} GROUP BY 1,2,3,4,5,6`;
    if (o.totals) {
      sql = select(`''`, ` AND left(metric_key, 1) = '_'`);
      if (o.dayKeys?.length) sql += `\n UNION ALL ${select(day(), ` AND metric_key = ANY(${q.p(o.dayKeys)}::text[])`)}`;
    } else {
      sql = select(day(), '');
    }
  } else {
    const tz = q.p(period.timezone);
    const fam = q.p([...ENGAGEMENT_FAMILIES]);
    const scopeSql = postScopeSql(scope, period, q, o);
    const where = `l.workspace_id = ${q.p(scope.workspaceId)} AND l.source = ANY(${q.p(scope.sources)}::text[]) AND l.resource_id IN (SELECT id FROM (${scopeSql}) sp)`;
    sql = `SELECT connection_id, provider::text AS provider, bucket_start::text AS local_date, metric_key, definition_version, dimension, sum(value_sum)::float8 AS value,
                  sum(resources)::int AS resources, min(min_through_at) AS min_through, min(min_observed_at) AS min_observed, max(max_observed_at) AS max_observed
             FROM (${rollupSelectSql(where, `${fam}::text[]`, `(l.published_at AT TIME ZONE ${tz})::date`)}) r GROUP BY 1,2,3,4,5,6`;
  }
  const rows = await many<Agg>(getPool(), sql, q.values);
  return rows.map((r) => ({ ...r, value: Number(r.value), resources: Number(r.resources) }));
}

export interface PostState {
  id: string; connection_id: string; provider: Provider; local_date: string; families: Set<string>; cov: Map<string, FetchState>; any: FetchState | null;
}

const SEVERITY = `CASE dc.status WHEN 'permission_missing' THEN 0 WHEN 'access_revoked' THEN 1 WHEN 'reconnect_required' THEN 2 WHEN 'fetch_failed' THEN 3
  WHEN 'rate_limited' THEN 4 WHEN 'budget_exhausted' THEN 5 WHEN 'not_found' THEN 6 WHEN 'provider_delayed' THEN 7 WHEN 'unsupported' THEN 8 ELSE 9 END`;

/** One row per post in scope: families with data + the representative fetch state per family. */
export async function postStates(scope: Scope, period: Period, o: PostScopeOpts = {}): Promise<PostState[]> {
  if (!scope.connections.length) return [];
  const q = new Params();
  const tz = q.p(period.timezone);
  const src = q.p(scope.sources);
  const ws = q.p(scope.workspaceId);
  const scopeSql = postScopeSql(scope, period, q, o);
  const rows = await many<{ id: string; connection_id: string; provider: Provider; local_date: string; fams: string[] | null; cov: Record<string, FetchState> | null; any_state: FetchState | null }>(getPool(),
    // V3.1 PERF: families per post from ONE grouped scan of metric_resource_latest (was a correlated subquery per post).
    `WITH sp AS MATERIALIZED (${scopeSql}),
     fams AS (
       SELECT l.connection_id, l.resource_id, array_agg(DISTINCT md.family) AS fams
         FROM metric_resource_latest l JOIN metric_definitions md ON md.metric_id = l.metric_id AND md.version = l.definition_version
        WHERE l.workspace_id = ${ws} AND l.resource_type = 'post' AND l.source = ANY(${src}::text[]) AND l.resource_id IN (SELECT id FROM sp)
        GROUP BY 1, 2)
     SELECT sp.id, sp.connection_id, sp.provider::text AS provider, (sp.published_at AT TIME ZONE ${tz})::date::text AS local_date, f.fams,
            (SELECT jsonb_object_agg(family, status) FROM (
               SELECT md.family, (array_agg(dc.status ORDER BY ${SEVERITY}))[1] AS status
                 FROM data_coverage dc JOIN (SELECT DISTINCT metric_id, family FROM metric_definitions) md ON md.metric_id = dc.metric_id
                WHERE dc.workspace_id = ${ws} AND dc.connection_id = sp.connection_id AND dc.resource_type = 'post' AND dc.resource_id = sp.id
                GROUP BY md.family) x) AS cov,
            (SELECT dc.status FROM data_coverage dc WHERE dc.workspace_id = ${ws} AND dc.connection_id = sp.connection_id AND dc.resource_type = 'post'
                AND dc.resource_id = sp.id AND dc.metric_id = '*') AS any_state
       FROM sp LEFT JOIN fams f ON f.connection_id = sp.connection_id AND f.resource_id = sp.id
      LIMIT ${MAX_POST_STATES}`, q.values);
  return rows.map((r) => ({ id: r.id, connection_id: r.connection_id, provider: r.provider, local_date: r.local_date, families: new Set(r.fams ?? []),
    cov: new Map(Object.entries(r.cov ?? {})), any: r.any_state }));
}

// ------------------------------------------------------------------ measures
const rep = (p: Provider, f: MetricFamily): MetricDefinition | undefined => fetchedPostDefinitions(p).find((d) => d.family === f);
const supportsFamily = (p: Provider, f: MetricFamily) => !!rep(p, f) && rep(p, f)!.availability !== 'excluded';

// V3.1 PERF: pure function of the (immutable) registry, called per post per day in trends/health — memoised.
const SUPPORTS = new Map<string, boolean>();
export function providerSupports(p: Provider, m: MeasureKey): boolean {
  const k = `${p}|${m}`;
  let v = SUPPORTS.get(k);
  if (v === undefined) { v = providerSupportsUncached(p, m); SUPPORTS.set(k, v); }
  return v;
}

function providerSupportsUncached(p: Provider, m: MeasureKey): boolean {
  const M = MEASURES[m];
  switch (M.kind) {
    case 'app': return true;
    case 'family': return supportsFamily(p, M.families[0]!);
    case 'engagements': return ENGAGEMENT_FAMILIES.some((f) => supportsFamily(p, f));
    case 'rate': return ENGAGEMENT_FAMILIES.some((f) => supportsFamily(p, f)) && supportsFamily(p, M.denominator!);
    case 'ratio': return supportsFamily(p, 'watch_time') && supportsFamily(p, 'views');
    case 'snapshot': return definitionsFor(p).some((d) => d.family === 'followers' && d.scope === 'account');
  }
}

function postHasData(s: PostState, m: MeasureKey): boolean {
  const M = MEASURES[m];
  const has = (f: string) => s.families.has(f);
  switch (M.kind) {
    case 'app': return true;
    case 'family': return has(M.families[0]!);
    case 'engagements': return ENGAGEMENT_FAMILIES.some(has);
    case 'rate': return ENGAGEMENT_FAMILIES.some(has) && has(M.denominator!);
    case 'ratio': return has('watch_time') && has('views');
    case 'snapshot': return false;
  }
}

function postMissingState(s: PostState, m: MeasureKey): FetchState | null {
  const M = MEASURES[m];
  const fams = M.kind === 'rate' ? [M.denominator!, ...ENGAGEMENT_FAMILIES] : M.kind === 'engagements' ? [...ENGAGEMENT_FAMILIES] : M.kind === 'ratio' ? ['watch_time', 'views'] : M.families;
  for (const f of fams) { const st = s.cov.get(f); if (st && st !== 'ok') return st; }
  if (s.any && s.any !== 'ok') return s.any;
  for (const f of fams) if (s.cov.get(f) === 'ok') return 'ok';
  return s.any;
}

interface MeasureValue { value: number | null; numerator: number | null; denominator: number | null; resources: number; minThrough: Date | null; minObserved: Date | null; maxObserved: Date | null }

function measureFromAggs(m: MeasureKey, aggs: Agg[], posts: number): MeasureValue {
  const M = MEASURES[m];
  const pick = (key: string) => aggs.filter((a) => a.metric_key === key);
  const fold = (rows: Agg[]) => ({
    sum: rows.reduce((a, r) => a + r.value, 0), n: rows.reduce((a, r) => a + r.resources, 0),
    mt: rows.reduce<Date | null>((a, r) => (r.min_through && (!a || r.min_through < a) ? r.min_through : a), null),
    mo: rows.reduce<Date | null>((a, r) => (r.min_observed && (!a || r.min_observed < a) ? r.min_observed : a), null),
    xo: rows.reduce<Date | null>((a, r) => (r.max_observed && (!a || r.max_observed > a) ? r.max_observed : a), null),
  });
  if (M.kind === 'app') return { value: posts, numerator: null, denominator: null, resources: posts, minThrough: null, minObserved: null, maxObserved: null };
  if (M.kind === 'rate' || M.kind === 'ratio') {
    const [nk, dk] = M.kind === 'ratio' ? [DERIVED.avdNum, DERIVED.avdDen] : M.denominator === 'views' ? [DERIVED.erViewsNum, DERIVED.erViewsDen] : [DERIVED.erImprNum, DERIVED.erImprDen];
    const num = fold(pick(nk)); const den = fold(pick(dk));
    if (!den.n) return { value: null, numerator: null, denominator: null, resources: 0, minThrough: null, minObserved: null, maxObserved: null };
    const r = ratioOfSums([{ numerator: num.sum, denominator: den.sum }]);
    return { value: r.value, numerator: num.sum, denominator: den.sum, resources: den.n, minThrough: den.mt, minObserved: den.mo, maxObserved: den.xo };
  }
  const key = M.kind === 'engagements' ? DERIVED.engagements : familyKey(M.families[0]!);
  const f = fold(pick(key));
  return { value: f.n ? f.sum : null, numerator: null, denominator: null, resources: f.n, minThrough: f.mt, minObserved: f.mo, maxObserved: f.xo };
}

function measureDefinition(m: MeasureKey, providers: Provider[]): MeasureDefinition {
  const M = MEASURES[m];
  const comps: MeasureComponent[] = [];
  const add = (fams: readonly string[], role?: 'numerator' | 'denominator') => {
    for (const p of providers) for (const d of fetchedPostDefinitions(p)) {
      if (fams.includes(d.family) && d.availability !== 'excluded') comps.push({ provider: p, metric_id: d.id, native_metric: d.nativeMetric, name: d.name, ...(role ? { role } : {}) });
    }
  };
  let definitionText: string; let combination: MeasureDefinition['combination'];
  const caveats: string[] = [];
  switch (M.kind) {
    case 'app':
      definitionText = 'Published deliveries (one per account) in the period, by publish time in the selected timezone. App-owned fact.';
      combination = 'app_fact'; break;
    case 'engagements':
      add(ENGAGEMENT_FAMILIES);
      definitionText = 'Likes/reactions + comments/replies + shares/reposts + quotes + saves/bookmarks as reported by each network (lifetime totals as last observed). Clicks, views and network composites are not engagements here. Components differ by network.';
      combination = 'sum_labelled'; break;
    case 'rate':
      add(ENGAGEMENT_FAMILIES, 'numerator'); add([M.denominator!], 'denominator');
      definitionText = `Σ engagements ÷ Σ ${M.denominator}, summed over posts that report both (ratio of sums; never an average of per-post rates).`;
      combination = 'ratio_of_sums'; break;
    case 'ratio':
      add(['watch_time'], 'numerator'); add(['views'], 'denominator');
      definitionText = 'Σ watch time (seconds) ÷ Σ views over videos that report both (ratio of sums).';
      combination = 'ratio_of_sums'; break;
    case 'snapshot':
      for (const p of providers) for (const d of definitionsFor(p)) if (d.family === 'followers') comps.push({ provider: p, metric_id: d.id, native_metric: d.nativeMetric, name: d.name });
      definitionText = 'Latest follower snapshot per account (point in time; never summed over dates). Accounts are added only as a labelled total; people may follow several accounts.';
      combination = 'latest'; break;
    default: {
      const fam = M.families[0]!;
      add([fam]);
      const F = FAMILIES[fam];
      definitionText = F.unique
        ? `${F.label}: unique accounts per post as reported by each network. Summed over posts it counts people more than once; never combined across accounts or networks.`
        : `${F.label} as reported by each network for posts published in the period (lifetime totals as last observed). Definitions differ by network; a cross-network total lists its components.`;
      combination = F.crossNetwork === 'never' ? 'per_network' : 'sum_labelled';
    }
  }
  const comps2 = comps.map((c) => definition(c.metric_id)!);
  if (comps2.some((d) => d?.paid === 'mixed')) caveats.push('Some network totals include paid distribution if a post was boosted or promoted; paid-only metrics are excluded.');
  if (comps2.some((d) => d?.availability === 'in_development')) caveats.push('Includes metrics the network marks as "in development".');
  const delayed = [...new Set(comps2.filter((d) => d && d.providerDelayHours >= 48).map((d) => PROVIDER_LABEL[d!.provider]))];
  if (delayed.length) caveats.push(`${delayed.join(', ')} report with a delay of 2–3 days.`);
  if (comps2.some((d) => d?.timeBasis === 'window')) caveats.push('Pinterest reports at most 90 days back; older Pins show a rolling 90-day total.');
  return { key: m, label: M.label, unit: M.unit, combination, definition: definitionText, components: comps, caveats };
}

function basisFor(m: MeasureKey): { basis: MeasureBasis; label: string } {
  if (MEASURES[m].kind === 'app') return { basis: 'app_fact', label: 'Published in this period (app records)' };
  if (MEASURES[m].kind === 'snapshot') return { basis: 'snapshot_latest', label: 'Latest snapshot per account (point in time)' };
  return { basis: 'lifetime_by_publish_date', label: LIFETIME_LABEL };
}

// ------------------------------------------------------------------ health helpers
interface CursorInfo { connection_id: string; status: string; stop_reason: string | null; last_success_at: Date | null; next_run_at: Date | null; created_at: Date }

async function cursors(scope: Scope): Promise<Map<string, CursorInfo>> {
  if (!scope.connections.length) return new Map();
  const rows = await many<CursorInfo>(getPool(),
    `SELECT connection_id, status, stop_reason, last_success_at, next_run_at, created_at FROM sync_cursors WHERE workspace_id=$1 AND connection_id = ANY($2::uuid[]) AND stream='post_metrics'`,
    [scope.workspaceId, scope.connections.map((c) => c.id)]);
  return new Map(rows.map((r) => [r.connection_id, r]));
}

function isStale(c: CursorInfo | undefined, now = Date.now()): boolean {
  if (!c || c.status !== 'active') return false;
  const ref = c.last_success_at ?? c.created_at;
  return now - ref.getTime() > STALE_HOURS * 3_600_000;
}

function freshness(tz: string, v: Pick<MeasureValue, 'minThrough' | 'minObserved' | 'maxObserved'>, cur: CursorInfo[]): Freshness {
  const last = cur.reduce<Date | null>((a, c) => (c.last_success_at && (!a || c.last_success_at > a) ? c.last_success_at : a), null);
  return {
    observed_from: v.minObserved?.toISOString() ?? null, observed_to: v.maxObserved?.toISOString() ?? null,
    through: v.minThrough?.toISOString() ?? null, through_date: v.minThrough ? localDate(v.minThrough, tz) : null, last_sync_at: last?.toISOString() ?? null,
  };
}

function seriesHealth(m: MeasureKey, posts: PostState[], v: MeasureValue, tz: string, cur: Map<string, CursorInfo>, connIds: Set<string>): SeriesHealth {
  const sel = posts.filter((p) => connIds.has(p.connection_id));
  const eligiblePosts = sel.filter((p) => providerSupports(p.provider, m));
  const withData = eligiblePosts.filter((p) => postHasData(p, m)).length;
  const missing = new Map<string, { state: FetchState | null; provider: Provider; count: number }>();
  for (const p of eligiblePosts) {
    if (postHasData(p, m)) continue;
    const st = postMissingState(p, m);
    const k = `${st}|${p.provider}`;
    const cur0 = missing.get(k); if (cur0) cur0.count++; else missing.set(k, { state: st === 'ok' ? null : st, provider: p.provider, count: 1 });
  }
  const unsupportedBy = new Map<Provider, number>();
  for (const p of sel) if (!providerSupports(p.provider, m)) unsupportedBy.set(p.provider, (unsupportedBy.get(p.provider) ?? 0) + 1);
  const cs = [...connIds].map((id) => cur.get(id)).filter((c): c is CursorInfo => !!c);
  const input: StatusInput = {
    selected: sel.length, eligible: eligiblePosts.length, withData: MEASURES[m].kind === 'app' ? sel.length : withData,
    unsupported: sel.length - eligiblePosts.length, value: v.value, missing: [...missing.values()],
    unsupportedBy: [...unsupportedBy].map(([provider, count]) => ({ provider, count })),
    staleAccounts: cs.filter((c) => isStale(c)).length,
  };
  const d = deriveStatus(input);
  return { status: d.status, reasons: d.reasons, coverage: coverage('posts', input.selected, input.eligible, input.withData, input.unsupported), freshness: freshness(tz, v, cs) };
}

// ------------------------------------------------------------------ measure evaluation (overall / per network / per connection)
interface Evaluated { value: number | null; health: SeriesHealth; by_network: Kpi['by_network']; combinedReason: string | null; mv: MeasureValue }

function evaluate(m: MeasureKey, scope: Scope, period: Period, aggs: Agg[], posts: PostState[], cur: Map<string, CursorInfo>): Evaluated {
  const tz = period.timezone;
  const allConn = new Set(scope.connections.map((c) => c.id));
  const providers = [...new Set(scope.connections.map((c) => c.provider))];
  const by_network: Kpi['by_network'] = [];
  const items: Array<{ def: MetricDefinition; value: number; connectionId?: string }> = [];
  const M = MEASURES[m];
  // V3.1 PERF: group once by connection (was a full pass over all aggs + posts per provider and per connection).
  const aggsByConn = groupBy(aggs, (a) => a.connection_id);
  const postsByConn = groupBy(posts, (x) => x.connection_id);
  for (const p of providers) {
    const conns = new Set(scope.connections.filter((c) => c.provider === p).map((c) => c.id));
    const pAggs = [...conns].flatMap((c) => aggsByConn.get(c) ?? []);
    const pPosts = [...conns].flatMap((c) => postsByConn.get(c) ?? []);
    const v = measureFromAggs(m, pAggs, pPosts.length);
    by_network.push({ provider: p, value: v.value, health: seriesHealth(m, pPosts, v, tz, cur, conns) });
    if (M.kind === 'family' && v.value !== null) {
      const def = rep(p, M.families[0]!);
      if (def) {
        if (FAMILIES[def.family].unique) {
          for (const c of conns) {
            const cv = measureFromAggs(m, aggsByConn.get(c) ?? [], 0);
            if (cv.value !== null) items.push({ def, value: cv.value, connectionId: c });
          }
        } else items.push({ def, value: v.value });
      }
    }
  }
  const mv = measureFromAggs(m, aggs, posts.length);
  let value = mv.value;
  let combinedReason: string | null = null;
  if (M.kind === 'family' && items.length) {
    try { value = sumCompatible(items).total; } catch (err) {
      if (!(err instanceof IncompatibleMetricsError)) throw err;
      value = null; combinedReason = err.message;
    }
  }
  return { value, health: seriesHealth(m, posts, mv, tz, cur, allConn), by_network, combinedReason, mv };
}

function sufficient(h: SeriesHealth): boolean {
  return h.coverage.selected > 0 && (h.coverage.ratio === null || h.coverage.ratio >= 0.5);
}

interface Bundle { aggs: Agg[]; posts: PostState[]; prevAggs: Agg[]; prevPosts: PostState[]; cur: Map<string, CursorInfo> }

/** Summary readiness, checked once per request scope + time zone. */
const zoneMemo = new WeakMap<Scope, Map<string, Promise<boolean>>>();
function zoneReady(scope: Scope, tz: string): Promise<boolean> {
  let m = zoneMemo.get(scope);
  if (!m) { m = new Map(); zoneMemo.set(scope, m); }
  let p = m.get(tz);
  if (!p) { p = summaryReady(scope.workspaceId, tz); m.set(tz, p); }
  return p;
}

/** Metric keys measureFromAggs reads for a measure (family/derived rollup keys). */
function measureKeys(m: MeasureKey): string[] {
  const M = MEASURES[m];
  switch (M.kind) {
    case 'family': return [familyKey(M.families[0]!)];
    case 'engagements': return [DERIVED.engagements];
    case 'rate': return M.denominator === 'views' ? [DERIVED.erViewsNum, DERIVED.erViewsDen] : [DERIVED.erImprNum, DERIVED.erImprDen];
    case 'ratio': return [DERIVED.avdNum, DERIVED.avdDen];
    default: return [];
  }
}

/**
 * V3.1 PERF bundle for the overview: period totals of the family/derived keys (KPIs, channels, per-network values —
 * measureFromAggs only sums them) + per-day rows only for the trend measure. Same results as bundle() with ~10× fewer
 * rows on long ranges. Filtered (per-post) scopes keep the full per-day rows for both.
 */
async function overviewBundle(scope: Scope, trend: MeasureKey): Promise<Bundle & { dayAggs: Agg[]; prevDayAggs: Agg[] }> {
  if (scope.perPost) { const b = await bundle(scope); return { ...b, dayAggs: b.aggs, prevDayAggs: b.prevAggs }; }
  const dayKeys = measureKeys(trend);
  const split = async (p: Period) => {
    const rows = await aggregate(scope, p, { totals: true, dayKeys });
    return [rows.filter((r) => r.local_date === ''), rows.filter((r) => r.local_date !== '')] as [Agg[], Agg[]];
  };
  const [[aggs, dayAggs], posts, cur] = await Promise.all([split(scope.period), postStates(scope, scope.period), cursors(scope)]);
  const [[prevAggs, prevDayAggs], prevPosts] = scope.previous
    ? await Promise.all([split(scope.previous), postStates(scope, scope.previous)]) : [[[], []] as [Agg[], Agg[]], [] as PostState[]];
  return { aggs, dayAggs, posts, prevAggs, prevDayAggs, prevPosts, cur };
}

async function bundle(scope: Scope, o: PostScopeOpts & { forceRollups?: boolean } = {}): Promise<Bundle> {
  const [aggs, posts, cur] = await Promise.all([aggregate(scope, scope.period, o), postStates(scope, scope.period, o), cursors(scope)]);
  const [prevAggs, prevPosts] = scope.previous ? await Promise.all([aggregate(scope, scope.previous, o), postStates(scope, scope.previous, o)]) : [[], []];
  return { aggs, posts, prevAggs, prevPosts, cur };
}

function kpi(m: MeasureKey, scope: Scope, b: Bundle): Kpi {
  const cur = evaluate(m, scope, scope.period, b.aggs, b.posts, b.cur);
  const prev = scope.previous ? evaluate(m, scope, scope.previous, b.prevAggs, b.prevPosts, b.cur) : null;
  const basis = basisFor(m);
  return {
    measure: m, label: MEASURES[m].label, value: cur.value, unit: MEASURES[m].unit, basis: basis.basis, basis_label: basis.label,
    comparison: compare(cur.value, prev?.value ?? null, { previousPeriod: scope.previous, previousSufficient: prev ? sufficient(prev.health) || MEASURES[m].kind === 'app' : false,
      currentSufficient: sufficient(cur.health) || MEASURES[m].kind === 'app' }),
    health: cur.health, definition: measureDefinition(m, [...new Set(scope.connections.map((c) => c.provider))]), by_network: cur.by_network,
  };
}

// ------------------------------------------------------------------ trend
function groupBy<T>(xs: T[], k: (x: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const x of xs) { const key = k(x); const a = m.get(key); if (a) a.push(x); else m.set(key, [x]); }
  return m;
}

function trendSeries(m: MeasureKey, key: string, label: string, provider: Provider | null, period: Period, aggs: Agg[], posts: PostState[], scope: Scope, cur: Map<string, CursorInfo>, connIds: Set<string>): TrendSeries {
  const myPosts = posts.filter((p) => connIds.has(p.connection_id));
  const myAggs = aggs.filter((a) => connIds.has(a.connection_id));
  const postsByDate = groupBy(myPosts, (p) => p.local_date);
  const aggsByDate = groupBy(myAggs, (a) => a.local_date);
  const points: TrendPoint[] = periodDates(period).map((date) => {
    const dayPosts = postsByDate.get(date) ?? [];
    const eligible = dayPosts.filter((p) => providerSupports(p.provider, m));
    const v = measureFromAggs(m, aggsByDate.get(date) ?? [], dayPosts.length);
    const withData = MEASURES[m].kind === 'app' ? dayPosts.length : eligible.filter((p) => postHasData(p, m)).length;
    let status: TrendPoint['status'];
    let value = v.value;
    if (MEASURES[m].kind === 'app') status = dayPosts.length ? 'ok' : 'zero';
    else if (!dayPosts.length) { status = 'no_posts'; value = null; }
    else if (!eligible.length || withData === 0 || value === null) { status = 'missing'; value = null; }
    else if (withData < eligible.length) status = 'partial';
    else status = value === 0 ? 'zero' : 'ok';
    return { date, value, status, with_data: withData, eligible: MEASURES[m].kind === 'app' ? dayPosts.length : eligible.length,
      ...(v.numerator !== null ? { numerator: v.numerator, denominator: v.denominator } : {}) };
  });
  const tot = measureFromAggs(m, myAggs, myPosts.length);
  return { key, label, provider, points, total: tot.value, health: seriesHealth(m, myPosts, tot, period.timezone, cur, connIds) };
}

function trendFor(m: MeasureKey, scope: Scope, period: Period, aggs: Agg[], posts: PostState[], cur: Map<string, CursorInfo>): { combined: TrendSeries | null; reason: string | null; by_network: TrendSeries[] } {
  const M = MEASURES[m];
  const unique = M.kind === 'family' && FAMILIES[M.families[0]!].unique;
  const groups: Array<{ key: string; label: string; provider: Provider; conns: Set<string> }> = [];
  if (unique) {
    for (const c of scope.connections) if (providerSupports(c.provider, m)) groups.push({ key: c.id, label: `${PROVIDER_LABEL[c.provider]} · ${c.display_name}`, provider: c.provider, conns: new Set([c.id]) });
  } else {
    for (const p of [...new Set(scope.connections.map((c) => c.provider))]) {
      if (!providerSupports(p, m)) continue;
      groups.push({ key: p, label: PROVIDER_LABEL[p], provider: p, conns: new Set(scope.connections.filter((c) => c.provider === p).map((c) => c.id)) });
    }
  }
  const by_network = groups.map((g) => trendSeries(m, g.key, g.label, g.provider, period, aggs, posts, scope, cur, g.conns));
  let combined: TrendSeries | null = null; let reason: string | null = null;
  if (unique && groups.length > 1) reason = `${FAMILIES[M.families[0]!].label} counts unique people per account; it is not combined across accounts or networks.`;
  else combined = trendSeries(m, 'all', groups.length > 1 && M.kind === 'family' ? `${M.label} (sum of network-reported values; definitions differ)` : M.label, null, period, aggs, posts, scope, cur, new Set(scope.connections.map((c) => c.id)));
  return { combined, reason, by_network };
}

function availableMeasures(scope: Scope): MeasureOption[] {
  const providers = [...new Set(scope.connections.map((c) => c.provider))];
  return MEASURE_KEYS.filter((k) => k !== 'followers').map((k) => {
    const ok = providers.some((p) => providerSupports(p, k));
    return { key: k, label: MEASURES[k].label, available: ok, reason: ok ? null : 'Not provided by the selected networks.' };
  });
}

// ------------------------------------------------------------------ followers (account snapshots)
interface FollowerPoint { connection_id: string; local_date: string; value: number; observed_at: Date }

async function followerSnapshots(scope: Scope, period: Period): Promise<{ inPeriod: FollowerPoint[]; latestBefore: Map<string, FollowerPoint> }> {
  if (!scope.connections.length) return { inPeriod: [], latestBefore: new Map() };
  const rows = await many<{ connection_id: string; observed_at: Date; value: string }>(getPool(),
    `SELECT f.connection_id, f.observed_at, f.value::text FROM metric_cumulative_facts f JOIN metric_definitions md ON md.metric_id = f.metric_id AND md.version = f.definition_version
      WHERE f.workspace_id=$1 AND f.resource_type='account' AND md.family='followers' AND f.connection_id = ANY($2::uuid[]) AND f.source = ANY($3::text[])
        AND f.observed_at < $4 ORDER BY f.observed_at`,
    [scope.workspaceId, scope.connections.map((c) => c.id), scope.sources, period.end_utc]);
  const start = new Date(period.start_utc);
  const inPeriod: FollowerPoint[] = []; const latestBefore = new Map<string, FollowerPoint>();
  for (const r of rows) {
    const p = { connection_id: r.connection_id, local_date: localDate(r.observed_at, period.timezone), value: Number(r.value), observed_at: r.observed_at };
    latestBefore.set(r.connection_id, p);
    if (r.observed_at >= start) inPeriod.push(p);
  }
  return { inPeriod, latestBefore };
}

function followersHealth(scope: Scope, latest: Map<string, FollowerPoint>, tz: string): SeriesHealth {
  const eligible = scope.connections.filter((c) => providerSupports(c.provider, 'followers'));
  const withData = eligible.filter((c) => latest.has(c.id)).length;
  const notFetched = eligible.filter((c) => !latest.has(c.id));
  const obs = [...latest.values()].map((p) => p.observed_at);
  const d = deriveStatus({ selected: scope.connections.length, eligible: eligible.length, withData, unsupported: scope.connections.length - eligible.length,
    value: withData ? 1 : null, missing: notFetched.length ? [{ state: null, provider: null, count: notFetched.length }] : [] });
  const minO = obs.length ? new Date(Math.min(...obs.map((o) => o.getTime()))) : null;
  const maxO = obs.length ? new Date(Math.max(...obs.map((o) => o.getTime()))) : null;
  return { status: d.status, reasons: d.reasons.map((r) => r.status === 'not_fetched' ? { ...r, message: 'Follower counts are not requested by the current network adapters.' } : r),
    coverage: coverage('accounts', scope.connections.length, eligible.length, withData, scope.connections.length - eligible.length),
    freshness: { observed_from: minO?.toISOString() ?? null, observed_to: maxO?.toISOString() ?? null, through: minO?.toISOString() ?? null, through_date: minO ? localDate(minO, tz) : null, last_sync_at: maxO?.toISOString() ?? null } };
}

async function followersKpi(scope: Scope): Promise<Kpi | null> {
  const cur = await followerSnapshots(scope, scope.period);
  if (!cur.latestBefore.size) return null;
  const prev = scope.previous ? await followerSnapshots(scope, scope.previous) : null;
  const sumLatest = (m: Map<string, FollowerPoint>) => {
    const items = [...m.values()].map((p) => {
      const c = scope.connections.find((x) => x.id === p.connection_id)!;
      return { def: definitionsFor(c.provider).find((d) => d.family === 'followers')!, value: p.value, connectionId: c.id };
    });
    return items.length ? sumLatestAcrossAccounts(items).total : null;
  };
  const h = followersHealth(scope, cur.latestBefore, scope.period.timezone);
  const value = sumLatest(cur.latestBefore);
  const prevValue = prev && prev.latestBefore.size === cur.latestBefore.size ? sumLatest(prev.latestBefore) : null;
  const providers = [...new Set(scope.connections.map((c) => c.provider))];
  return {
    measure: 'followers', label: MEASURES.followers.label, value, unit: 'count', basis: 'snapshot_latest', basis_label: 'Latest snapshot per account at the end of the period',
    comparison: compare(value, prevValue, { previousPeriod: scope.previous, previousSufficient: prevValue !== null }),
    health: h, definition: measureDefinition('followers', providers),
    by_network: providers.map((p) => {
      const ms = new Map([...cur.latestBefore].filter(([id]) => scope.connections.find((c) => c.id === id)?.provider === p));
      return { provider: p, value: ms.size ? sumLatest(ms) : null, health: followersHealth({ ...scope, connections: scope.connections.filter((c) => c.provider === p) }, ms, scope.period.timezone) };
    }),
  };
}

// ------------------------------------------------------------------ content rows
const SORT_SQL: Record<ContentSort, string> = {
  published_at: 'sp.published_at', engagements: 'agg.engagements', engagement_rate: 'engagement_rate', views: 'agg.views', impressions: 'agg.impressions',
  reach: 'agg.reach', likes: 'agg.likes', comments: 'agg.comments', shares: 'agg.shares', saves: 'agg.saves', clicks: 'agg.clicks',
};

interface ContentDbRow {
  id: string; post_id: string; brand_id: string; connection_id: string; provider: Provider; published_at: Date; provider_url: string | null; revision_id: string;
  variant_id: string; format: PostFormat | null; campaign_id: string | null; title: string | null; engagements: number | null; views: number | null;
  impressions: number | null; engagement_rate: number | null; total: string;
}

function syntheticThumb(seed: string, provider: Provider): Thumbnail {
  let h = 0; for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const hues = [18, 8, 38, 200, 160, 280];
  const hue = hues[h % hues.length]!;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160"><rect width="160" height="160" fill="hsl(${hue},70%,22%)"/><circle cx="${40 + (h % 80)}" cy="${40 + ((h >> 3) % 80)}" r="38" fill="hsl(${hue},85%,55%)" opacity="0.8"/><text x="10" y="148" font-family="Arial" font-size="13" fill="#fff">DEMO · ${PROVIDER_LABEL[provider]}</text></svg>`;
  return { kind: 'synthetic', url: `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`, alt: 'Synthetic demo thumbnail' };
}

async function contentRows(scope: Scope, period: Period, o: { sort: ContentSort; dir: 'asc' | 'desc'; limit: number; offset: number } & PostScopeOpts): Promise<{ rows: ContentRow[]; total: number }> {
  if (!scope.connections.length) return { rows: [], total: 0 };
  const q = new Params();
  const fam = q.p([...ENGAGEMENT_FAMILIES]);
  const scopeSql = postScopeSql(scope, period, q, o);
  const fsum = (f: string) => `sum(l.value) FILTER (WHERE md.family = '${f}')`;
  const rows = await many<ContentDbRow>(getPool(),
    `WITH sp AS (${scopeSql}),
     agg AS (
       SELECT l.resource_id, sum(l.value) FILTER (WHERE md.family = ANY(${fam}::text[]))::float8 AS engagements,
              ${fsum('views')}::float8 AS views, ${fsum('impressions')}::float8 AS impressions, ${fsum('reach')}::float8 AS reach, ${fsum('likes')}::float8 AS likes,
              ${fsum('comments')}::float8 AS comments, ${fsum('shares')}::float8 AS shares, ${fsum('saves')}::float8 AS saves, ${fsum('clicks')}::float8 AS clicks
         FROM metric_resource_latest l JOIN metric_definitions md ON md.metric_id = l.metric_id AND md.version = l.definition_version
        WHERE l.workspace_id = ${q.p(scope.workspaceId)} AND l.resource_type = 'post' AND l.source = ANY(${q.p(scope.sources)}::text[]) AND l.resource_id IN (SELECT id FROM sp)
        GROUP BY l.resource_id)
     SELECT sp.id, sp.post_id, sp.brand_id, sp.connection_id, sp.provider::text AS provider, sp.published_at, sp.provider_url, sp.revision_id, sp.variant_id, sp.format,
            sp.campaign_id, sp.title, agg.engagements, agg.views, agg.impressions,
            CASE WHEN agg.engagements IS NOT NULL AND agg.views > 0 THEN agg.engagements / agg.views
                 WHEN agg.engagements IS NOT NULL AND agg.impressions > 0 THEN agg.engagements / agg.impressions END AS engagement_rate,
            count(*) OVER () AS total
       FROM sp LEFT JOIN agg ON agg.resource_id = sp.id
      ORDER BY ${SORT_SQL[o.sort]} ${o.dir === 'asc' ? 'ASC' : 'DESC'} NULLS LAST, sp.published_at DESC, sp.id
      LIMIT ${q.p(o.limit)} OFFSET ${q.p(o.offset)}`, q.values);
  const total = rows.length ? Number(rows[0]!.total) : 0;
  return { rows: await hydrateRows(scope, period.timezone, rows), total };
}

async function hydrateRows(scope: Scope, tz: string, rows: ContentDbRow[]): Promise<ContentRow[]> {
  if (!rows.length) return [];
  const db = getPool();
  const ids = rows.map((r) => r.id);
  const [latest, cov, texts, campaigns, thumbs] = await Promise.all([
    many<{ resource_id: string; metric_id: string; definition_version: number; dimension: string; value: string; as_of_date: string; observed_at: Date; through_at: Date; basis: string }>(db,
      `SELECT resource_id, metric_id, definition_version, dimension, value::text, as_of_date::text, observed_at, through_at, basis FROM metric_resource_latest
        WHERE workspace_id=$1 AND resource_type='post' AND resource_id = ANY($2::uuid[]) AND source = ANY($3::text[])`, [scope.workspaceId, ids, scope.sources]),
    many<{ resource_id: string; metric_id: string; status: FetchState; reason: string | null }>(db,
      `SELECT resource_id, metric_id, status, reason FROM data_coverage WHERE workspace_id=$1 AND resource_type='post' AND resource_id = ANY($2::uuid[])`, [scope.workspaceId, ids]),
    many<{ id: string; base_text: string; rendered_text: string; inherit_text: boolean; asset_id: string | null }>(db,
      `SELECT d.id, r.base_text, v.rendered_text, v.inherit_text, coalesce(v.asset_ids[1], r.base_asset_ids[1]) AS asset_id
         FROM deliveries d JOIN post_revisions r ON r.id = d.revision_id JOIN variants v ON v.id = d.variant_id WHERE d.workspace_id=$1 AND d.id = ANY($2::uuid[])`, [scope.workspaceId, ids]),
    many<{ id: string; name: string }>(db, `SELECT id, name FROM campaigns WHERE workspace_id=$1 AND id = ANY($2::uuid[])`,
      [scope.workspaceId, [...new Set(rows.map((r) => r.campaign_id).filter(Boolean))]]),
    Promise.resolve(null),
  ]);
  void thumbs;
  const assetIds = [...new Set(texts.map((t) => t.asset_id).filter((x): x is string => !!x))];
  const derivs = assetIds.length ? await many<{ asset_id: string; object_key: string; mime: string; alt_text: string | null }>(db,
    `SELECT ad.asset_id, ad.object_key, ad.mime, a.alt_text FROM asset_derivatives ad JOIN assets a ON a.id = ad.asset_id
      WHERE ad.workspace_id=$1 AND ad.asset_id = ANY($2::uuid[]) AND ad.variant='thumb' ORDER BY ad.transform_version DESC`, [scope.workspaceId, assetIds]) : [];
  const thumbFor = new Map<string, { key: string; mime: string; alt: string | null }>();
  for (const d of derivs) if (!thumbFor.has(d.asset_id)) thumbFor.set(d.asset_id, { key: d.object_key, mime: d.mime, alt: d.alt_text });
  const textBy = new Map(texts.map((t) => [t.id, t]));
  const campBy = new Map(campaigns.map((c) => [c.id, c.name]));
  const connBy = new Map(scope.connections.map((c) => [c.id, c]));
  return Promise.all(rows.map(async (r): Promise<ContentRow> => {
    const conn = connBy.get(r.connection_id)!;
    const t = textBy.get(r.id);
    const text = t ? (t.inherit_text ? t.base_text : t.rendered_text || t.base_text) : '';
    const mine = latest.filter((l) => l.resource_id === r.id);
    const covMine = cov.filter((c) => c.resource_id === r.id);
    const any = covMine.find((c) => c.metric_id === '*')?.status ?? null;
    const metrics: MetricValue[] = [];
    for (const def of fetchedPostDefinitions(r.provider)) {
      const vals = mine.filter((l) => l.metric_id === def.id);
      const c = covMine.find((x) => x.metric_id === def.id);
      if (vals.length) {
        for (const v of vals) {
          const value = Number(v.value);
          metrics.push({ metric_id: def.id, native_metric: def.nativeMetric, name: def.name, family: def.family, unit: def.unit, dimension: v.dimension || null, value,
            status: value === 0 ? 'zero' : 'ok', status_message: c && c.status !== 'ok' ? `Last read: ${STATUS_MESSAGES[statusForFetchState(c.status)]}` : null,
            basis: v.basis as MetricValue['basis'], as_of_date: v.as_of_date, observed_at: v.observed_at.toISOString(), through: v.through_at.toISOString(), unique: FAMILIES[def.family].unique });
        }
      } else {
        const st = statusForFetchState(c?.status ?? (any && any !== 'ok' ? any : null));
        metrics.push({ metric_id: def.id, native_metric: def.nativeMetric, name: def.name, family: def.family, unit: def.unit, dimension: null, value: null, status: st,
          status_message: c?.reason ?? STATUS_MESSAGES[st], basis: def.timeBasis, as_of_date: null, observed_at: null, through: null, unique: FAMILIES[def.family].unique });
      }
    }
    const exposure = rep(r.provider, 'views') ? 'views' : rep(r.provider, 'impressions') ? 'impressions' : null;
    const thumb = conn.is_synthetic ? syntheticThumb(r.id, r.provider) : t?.asset_id && thumbFor.has(t.asset_id)
      ? { kind: 'asset' as const, url: await signedGetUrl(thumbFor.get(t.asset_id)!.key, PREVIEW_TTL, { contentType: thumbFor.get(t.asset_id)!.mime }), alt: thumbFor.get(t.asset_id)!.alt }
      : { kind: 'none' as const, url: null, alt: null };
    const hasAny = metrics.some((m) => m.value !== null);
    const rowStatus: SeriesStatus = hasAny ? (metrics.every((m) => m.value === null || m.value === 0) ? 'zero' : 'ok') : statusForFetchState(any && any !== 'ok' ? any : null);
    return {
      delivery_id: r.id, post_id: r.post_id, brand_id: r.brand_id, connection_id: r.connection_id, provider: r.provider, account: conn.display_name,
      title: r.title, excerpt: text ? text.slice(0, 160) : null, format: r.format, campaign: r.campaign_id ? { id: r.campaign_id, name: campBy.get(r.campaign_id) ?? '' } : null,
      published_at: r.published_at.toISOString(), published_local: localDateTime(r.published_at, tz), provider_url: r.provider_url, thumbnail: thumb,
      engagements: r.engagements === null ? null : Number(r.engagements),
      engagement_rate: { value: r.engagement_rate === null ? null : Number(r.engagement_rate), denominator: r.engagement_rate === null ? null : r.views !== null && Number(r.views) > 0 ? 'views' : 'impressions' },
      primary: exposure ? { measure: exposure, value: exposure === 'views' ? (r.views === null ? null : Number(r.views)) : (r.impressions === null ? null : Number(r.impressions)), label: rep(r.provider, exposure)!.name } : null,
      metrics, status: rowStatus, synthetic: conn.is_synthetic, simulated: conn.is_mock && !conn.is_synthetic,
    };
  }));
}

// ------------------------------------------------------------------ data health
function dataHealth(scope: Scope, b: Bundle, eng: SeriesHealth): DataHealth {
  const notes: string[] = [
    'Numbers are network-reported and refreshed in the background; they are not real-time.',
    'Views, impressions and reach are different measures and are never added together.',
  ];
  if (scope.synthetic) notes.unshift('Synthetic demo data — not network-reported.');
  if (scope.filters.dataset === 'simulated') notes.unshift('Simulated destinations — values are generated, not network-reported.');
  const reasons = new Map<string, StatusReason>();
  for (const r of eng.reasons) reasons.set(`${r.status}|${r.provider}`, r);
  return {
    coverage: eng.coverage, freshness: eng.freshness, statuses: [...reasons.values()], notes,
    accounts: scope.connections.map((c) => {
      const k = b.cur.get(c.id);
      return {
        connection_id: c.id, provider: c.provider, display_name: c.display_name,
        sync_status: k ? (k.status as 'active' | 'stopped') : 'never_synced', stop_reason: k?.stop_reason ?? (c.is_synthetic ? 'synthetic' : null),
        last_sync_at: k?.last_success_at?.toISOString() ?? null, next_sync_at: k?.status === 'active' ? k.next_run_at?.toISOString() ?? null : null,
        note: c.disconnected_at ? `Access ended ${c.disconnected_at.toISOString().slice(0, 10)}; data shown as last observed.` : !fetchedPostDefinitions(c.provider).length ? `${PROVIDER_LABEL[c.provider]} does not provide post statistics.` : isStale(k) ? 'Not refreshed in the last 48 hours.' : null,
      };
    }),
  };
}

// ------------------------------------------------------------------ views
const DEFAULT_TREND: MeasureKey = 'engagements';

export async function overview(ctx: Ctx, filters: AnalyticsFilters,
  opts: { measure?: string | null; /** verification only (tests/bench): pre-V3.1 data path — full per-day rows from the 15-minute rollups */ reference?: boolean } = {}): Promise<OverviewResponse> {
  const scope = await resolveScope(ctx, filters);
  const measure = (opts.measure && (MEASURE_KEYS as readonly string[]).includes(opts.measure) && opts.measure !== 'followers' ? opts.measure : DEFAULT_TREND) as MeasureKey;
  const b = opts.reference
    ? await (async () => { const x = await bundle(scope, { forceRollups: true }); return { ...x, dayAggs: x.aggs, prevDayAggs: x.prevAggs }; })()
    : await overviewBundle(scope, measure);
  const providers = [...new Set(scope.connections.map((c) => c.provider))];
  // KPIs (≤ 4, context-appropriate)
  const kpis: Kpi[] = [kpi('posts_published', scope, b)];
  if (providers.some((p) => providerSupports(p, 'engagements'))) kpis.push(kpi('engagements', scope, b));
  const views = b.posts.filter((p) => providerSupports(p.provider, 'engagement_rate_views')).length;
  const impr = b.posts.filter((p) => providerSupports(p.provider, 'engagement_rate_impressions')).length;
  if (views || impr) kpis.push(kpi(views >= impr ? 'engagement_rate_views' : 'engagement_rate_impressions', scope, b));
  const fk = await followersKpi(scope);
  if (fk) kpis.push(fk);
  else if (providers.length === 1 && providerSupports(providers[0]!, 'views')) kpis.push(kpi('views', scope, b));
  else if (providers.length === 1 && providerSupports(providers[0]!, 'impressions')) kpis.push(kpi('impressions', scope, b));
  else if (providers.some((p) => providerSupports(p, 'watch_time'))) kpis.push(kpi('watch_time', scope, b));
  // Trend
  const t = trendFor(measure, scope, scope.period, b.dayAggs, b.posts, b.cur);
  const prev = scope.previous ? trendFor(measure, scope, scope.previous, b.prevDayAggs, b.prevPosts, b.cur) : null;
  const basis = basisFor(measure);
  const trend: Trend = {
    measure, basis: basis.basis, basis_label: basis.label, definition: measureDefinition(measure, providers), available_measures: availableMeasures(scope),
    combined: t.combined, combined_reason: t.reason, by_network: t.by_network, previous: prev ? { combined: prev.combined, by_network: prev.by_network } : null,
  };
  const channels = channelComparison(measure === 'posts_published' ? 'engagements' : measure, scope, b);
  const top = await contentRows(scope, scope.period, { sort: 'engagements', dir: 'desc', limit: 5, offset: 0 });
  const engKpi = kpis.find((k) => k.measure === 'engagements');
  const engHealth = engKpi?.health ?? kpis[0]!.health;
  const insights: Insight[] = [];
  const cite = (m: MeasureKey | null) => ({ query_string: scope.queryString, period: scope.period, measure: m });
  const posts = kpis[0]!;
  insights.push({ id: 'posts', kind: 'calculated', measure: 'posts_published', basis: cite('posts_published'),
    text: `${posts.value ?? 0} posts were published from ${scope.period.from} to ${scope.period.to} (${scope.period.timezone}).` });
  if (engKpi && (engKpi.comparison.state === 'up' || engKpi.comparison.state === 'down') && engKpi.comparison.change_pct !== null) {
    insights.push({ id: 'engagements_change', kind: 'calculated', measure: 'engagements', basis: cite('engagements'),
      text: `Engagements on posts published in this period are ${Math.abs(Math.round(engKpi.comparison.change_pct * 100))}% ${engKpi.comparison.state === 'up' ? 'higher' : 'lower'} than for posts published in the previous ${scope.period.days} days (${engKpi.comparison.previous} → ${engKpi.comparison.current}).` });
  } else if (engKpi?.comparison.state === 'new') {
    insights.push({ id: 'engagements_new', kind: 'calculated', measure: 'engagements', basis: cite('engagements'), text: 'No engagements were recorded for the previous period, so no percentage change is shown.' });
  }
  const best = top.rows[0];
  if (best && best.engagements !== null) {
    insights.push({ id: 'top_post', kind: 'calculated', measure: 'engagements', basis: cite('engagements'),
      text: `Top post by engagements: "${(best.title ?? best.excerpt ?? 'Untitled').slice(0, 60)}" on ${PROVIDER_LABEL[best.provider]} (${best.engagements}).` });
  }
  if (engHealth.coverage.ratio !== null && engHealth.coverage.ratio < 1) {
    insights.push({ id: 'coverage', kind: 'calculated', measure: 'engagements', basis: cite('engagements'),
      text: `${engHealth.coverage.with_data} of ${engHealth.coverage.eligible} eligible posts have engagement data; totals cover only those posts.` });
  }
  return { meta: meta(scope), kpis: kpis.slice(0, 4), trend, channels, top_content: top.rows, insights, data_health: dataHealth(scope, b, engHealth) };
}

function channelComparison(m: MeasureKey, scope: Scope, b: Bundle): ChannelComparison {
  const M = MEASURES[m];
  const excluded: ChannelComparison['excluded'] = [];
  const aggsByConn = groupBy(b.aggs, (a) => a.connection_id);
  const postsByConn = groupBy(b.posts, (p) => p.connection_id);
  const rows = scope.connections.filter((c) => {
    if (providerSupports(c.provider, m)) return true;
    excluded.push({ connection_id: c.id, provider: c.provider, display_name: c.display_name, reason: `${PROVIDER_LABEL[c.provider]} does not report ${M.label.toLowerCase()}.` });
    return false;
  }).map((c) => {
    const cPosts = postsByConn.get(c.id) ?? [];
    const v = measureFromAggs(m, aggsByConn.get(c.id) ?? [], cPosts.length);
    return { connection_id: c.id, provider: c.provider, display_name: c.display_name, value: v.value, share: null as number | null,
      health: seriesHealth(m, cPosts, v, scope.period.timezone, b.cur, new Set([c.id])) };
  });
  const unique = M.kind === 'family' && FAMILIES[M.families[0]!].unique;
  const groupsBy = new Map<string, typeof rows>();
  for (const r of rows) { const k = unique ? r.provider : 'all'; if (!groupsBy.has(k)) groupsBy.set(k, []); groupsBy.get(k)!.push(r); }
  const groups = [...groupsBy].map(([k, rs]) => {
    const additive = M.kind === 'family' || M.kind === 'engagements' || M.kind === 'app';
    const total = rs.reduce((a, r) => a + (r.value ?? 0), 0);
    for (const r of rs) r.share = additive && !unique && total > 0 && r.value !== null ? r.value / total : null;
    const providersIn = new Set(rs.map((r) => r.provider));
    const label = k === 'all' ? (providersIn.size > 1 && M.kind !== 'app' ? `${M.label} (network-reported; definitions differ by network)` : M.label) : `${M.label} — ${PROVIDER_LABEL[k as Provider]} (per account; unique counts are not added)`;
    return { label, measure: m, rows: rs };
  });
  return { measure: m, groups, excluded };
}

export async function contentTable(ctx: Ctx, filters: AnalyticsFilters, o: { sort?: string | null; dir?: string | null; page?: number; page_size?: number } = {}): Promise<ContentTableResponse> {
  const scope = await resolveScope(ctx, filters);
  const sort = ((CONTENT_SORTS as readonly string[]).includes(o.sort ?? '') ? o.sort : 'published_at') as ContentSort;
  const dir = o.dir === 'asc' ? 'asc' : 'desc';
  const pageSize = Math.min(Math.max(Math.floor(o.page_size ?? 25), 1), 100);
  const page = Math.min(Math.max(Math.floor(o.page ?? 1), 1), 10_000);
  const [res, posts, cur] = await Promise.all([
    contentRows(scope, scope.period, { sort, dir, limit: pageSize, offset: (page - 1) * pageSize }), postStates(scope, scope.period), cursors(scope),
  ]);
  const sortMeasure: MeasureKey = sort === 'published_at' || sort === 'engagement_rate' ? 'engagements' : sort as MeasureKey;
  const aggs = await aggregate(scope, scope.period);
  const v = measureFromAggs(sortMeasure, aggs, posts.length);
  return { meta: meta(scope), basis_label: LIFETIME_LABEL, sort, dir, page, page_size: pageSize, total: res.total, rows: res.rows,
    health: seriesHealth(sortMeasure, posts, v, scope.period.timezone, cur, new Set(scope.connections.map((c) => c.id))) };
}

/** Post drilldown: media, caption, platform, source metrics, as-of history, observed changes, corrections and coverage. */
export async function contentDetail(ctx: Ctx, deliveryId: string, opts: { timezone?: string | null } = {}): Promise<ContentDetailResponse> {
  requireAction(ctx, 'analytics.read');
  assertUuid(deliveryId, 'Post');
  const db = getPool();
  const d = await maybeOne<{ id: string; brand_id: string; connection_id: string; published_at: Date | null; state: string; is_mock: boolean; is_synthetic: boolean; ws_demo: boolean; brand_tz: string }>(db,
    `SELECT d.id, d.brand_id, d.connection_id, d.published_at, d.state::text AS state, c.is_mock, c.is_synthetic, w.is_demo AS ws_demo, b.timezone AS brand_tz
       FROM deliveries d JOIN connections c ON c.id = d.connection_id JOIN workspaces w ON w.id = d.workspace_id JOIN brands b ON b.id = d.brand_id
      WHERE d.id=$1 AND d.workspace_id=$2`, [deliveryId, ctx.access.workspaceId]);
  if (!d || d.state !== 'published' || !d.published_at) throw notFound('Post');
  await brandForPermission(ctx, d.brand_id, 'analytics.read');
  if (!brandAllowed(ctx, d.brand_id)) throw notFound('Post');
  if (d.is_synthetic && !d.ws_demo) throw notFound('Post');
  const dataset = d.is_synthetic ? 'demo' : d.is_mock ? 'simulated' : 'live';
  const tz = opts.timezone && opts.timezone.length < 64 ? opts.timezone : d.brand_tz;
  const day = localDate(d.published_at, tz);
  const filters: AnalyticsFilters = { brand_ids: [d.brand_id], connection_ids: [d.connection_id], providers: [], campaign_ids: [], team_ids: [], formats: [],
    from: day, to: day, timezone: tz, compare: 'none', dataset };
  const scope = await resolveScope(ctx, filters);
  const { rows } = await contentRows(scope, scope.period, { sort: 'published_at', dir: 'desc', limit: 1, offset: 0, deliveryIds: [deliveryId] });
  const row = rows[0];
  if (!row) throw notFound('Post');
  const [texts, hist, changes, corr, cov] = await Promise.all([
    maybeOne<{ base_text: string; rendered_text: string; inherit_text: boolean; asset_ids: string[]; base_asset_ids: string[] }>(db,
      `SELECT r.base_text, v.rendered_text, v.inherit_text, v.asset_ids, r.base_asset_ids FROM deliveries d JOIN post_revisions r ON r.id = d.revision_id
         JOIN variants v ON v.id = d.variant_id WHERE d.id=$1`, [deliveryId]),
    many<{ metric_id: string; dimension: string; as_of_date: string; value: string; observed_at: Date; revision: number; basis: string }>(db,
      `SELECT metric_id, dimension, as_of_date::text, value::text, observed_at, revision, basis FROM metric_cumulative_facts
        WHERE workspace_id=$1 AND resource_type='post' AND resource_id=$2 AND source = ANY($3::text[]) ORDER BY metric_id, dimension, as_of_date`, [ctx.access.workspaceId, deliveryId, scope.sources]),
    many<{ metric_id: string; dimension: string; bucket_date: string; value: string; period_start: Date; period_end: Date }>(db,
      `SELECT metric_id, dimension, bucket_date::text, value::text, period_start, period_end FROM metric_daily_facts
        WHERE workspace_id=$1 AND resource_type='post' AND resource_id=$2 AND fact_kind='observed_change' AND source = ANY($3::text[]) ORDER BY metric_id, dimension, bucket_date`,
      [ctx.access.workspaceId, deliveryId, scope.sources]),
    maybeOne<{ n: number }>(db, `SELECT count(*)::int n FROM metric_observations WHERE workspace_id=$1 AND resource_id=$2 AND revision > 1`, [ctx.access.workspaceId, deliveryId]),
    many<{ metric_id: string; status: FetchState; reason: string | null; last_attempt_at: Date | null; last_success_at: Date | null }>(db,
      `SELECT metric_id, status, reason, last_attempt_at, last_success_at FROM data_coverage WHERE workspace_id=$1 AND resource_type='post' AND resource_id=$2 ORDER BY metric_id`,
      [ctx.access.workspaceId, deliveryId]),
  ]);
  const caption = texts ? (texts.inherit_text ? texts.base_text : texts.rendered_text || texts.base_text) : null;
  const assetIds = texts ? (texts.asset_ids.length ? texts.asset_ids : texts.base_asset_ids) : [];
  const media: ContentDetailResponse['media'] = [];
  if (row.synthetic) media.push({ asset_id: null, kind: 'synthetic', thumb_url: row.thumbnail.url, preview_url: row.thumbnail.url, alt: row.thumbnail.alt });
  else if (assetIds.length) {
    const ders = await many<{ asset_id: string; variant: string; object_key: string; mime: string; media_kind: string | null; alt_text: string | null }>(db,
      `SELECT ad.asset_id, ad.variant, ad.object_key, ad.mime, a.media_kind, a.alt_text FROM asset_derivatives ad JOIN assets a ON a.id = ad.asset_id
        WHERE ad.workspace_id=$1 AND ad.asset_id = ANY($2::uuid[]) AND ad.variant IN ('thumb','preview') AND a.brand_id = $3`, [ctx.access.workspaceId, assetIds, d.brand_id]).catch(() => []);
    for (const id of assetIds) {
      const mine = ders.filter((x) => x.asset_id === id);
      const th = mine.find((x) => x.variant === 'thumb'); const pv = mine.find((x) => x.variant === 'preview');
      media.push({ asset_id: id, kind: mine[0]?.media_kind === 'video' ? 'video' : 'image', thumb_url: th ? await signedGetUrl(th.object_key, PREVIEW_TTL, { contentType: th.mime }) : null,
        preview_url: pv ? await signedGetUrl(pv.object_key, PREVIEW_TTL, { contentType: pv.mime }) : null, alt: mine[0]?.alt_text ?? null });
    }
  }
  const series = new Map<string, ContentDetailResponse['history'][number]>();
  for (const h of hist) {
    const k = `${h.metric_id}|${h.dimension}`;
    if (!series.has(k)) series.set(k, { metric_id: h.metric_id, name: definition(h.metric_id)?.name ?? h.metric_id, dimension: h.dimension || null,
      basis_label: h.basis === 'window' ? 'Rolling window total as observed on each date' : 'Lifetime total as observed on each date (not daily activity)', points: [], observed_changes: [] });
    series.get(k)!.points.push({ as_of_date: h.as_of_date, value: Number(h.value), observed_at: h.observed_at.toISOString(), revision: h.revision });
  }
  for (const c of changes) {
    const s = series.get(`${c.metric_id}|${c.dimension}`);
    s?.observed_changes.push({ date: c.bucket_date, value: Number(c.value), period_start: c.period_start.toISOString(), period_end: c.period_end.toISOString() });
  }
  return {
    meta: { dataset, synthetic: d.is_synthetic, generated_at: new Date().toISOString(), timezone: tz },
    row, caption, media, history: [...series.values()], corrections: corr?.n ?? 0,
    coverage: cov.map((c) => ({ metric_id: c.metric_id, status: c.status === 'ok' ? 'ok' : statusForFetchState(c.status), message: c.reason,
      last_attempt_at: c.last_attempt_at?.toISOString() ?? null, last_success_at: c.last_success_at?.toISOString() ?? null })),
  };
}

export async function channels(ctx: Ctx, filters: AnalyticsFilters, opts: { measure?: string | null } = {}): Promise<ChannelsResponse> {
  const scope = await resolveScope(ctx, filters);
  const b = await bundle(scope);
  const follow = await followerSnapshots(scope, scope.period);
  const rows: ChannelRow[] = scope.connections.map((c) => {
    const aggs = b.aggs.filter((a) => a.connection_id === c.id && !a.metric_key.startsWith('_'));
    const posts = b.posts.filter((p) => p.connection_id === c.id);
    const metrics: ChannelRow['metrics'] = [];
    for (const def of fetchedPostDefinitions(c.provider)) {
      const mine = aggs.filter((a) => a.metric_key === def.id);
      const dims = mine.length ? [...new Set(mine.map((a) => a.dimension))] : [''];
      for (const dim of dims) {
        const rs = mine.filter((a) => a.dimension === dim);
        const n = rs.reduce((a, r) => a + r.resources, 0);
        const value = n ? rs.reduce((a, r) => a + r.value, 0) : null;
        const mt = rs.reduce<Date | null>((a, r) => (r.min_through && (!a || r.min_through < a) ? r.min_through : a), null);
        const xo = rs.reduce<Date | null>((a, r) => (r.max_observed && (!a || r.max_observed > a) ? r.max_observed : a), null);
        const ratio = def.aggregation === 'ratio_of_sums';
        metrics.push({ metric_id: def.id, native_metric: def.nativeMetric, name: def.name, family: def.family, unit: def.unit, dimension: dim || null,
          value: ratio ? null : value, status: ratio ? 'ok' : value === null ? (posts.length ? 'not_fetched' : 'ok') : value === 0 ? 'zero' : 'ok',
          status_message: ratio ? 'Ratio metric: see the video view (Σ watch time ÷ Σ views).' : null, basis: def.timeBasis, as_of_date: null,
          observed_at: xo?.toISOString() ?? null, through: mt?.toISOString() ?? null, unique: FAMILIES[def.family].unique, posts_with_data: n,
          label_note: FAMILIES[def.family].unique ? 'Sum of per-post unique counts (people can be counted more than once)' : null });
      }
    }
    const snaps = follow.inPeriod.filter((p) => p.connection_id === c.id);
    const latest = follow.latestBefore.get(c.id);
    const sumry = snapshotSummary(snaps.map((s) => ({ date: s.local_date, value: s.value })));
    const supportsF = providerSupports(c.provider, 'followers');
    const engV = measureFromAggs('engagements', b.aggs.filter((a) => a.connection_id === c.id), posts.length);
    return {
      connection_id: c.id, brand_id: c.brand_id, provider: c.provider, display_name: c.display_name, connection_status: c.disconnected_at ? 'disconnected' : c.status, is_mock: c.is_mock,
      posts_published: posts.length, metrics,
      followers: { latest: latest?.value ?? null, as_of_date: latest?.local_date ?? null, observed_change: sumry.observed_change,
        snapshots: snaps.map((s) => ({ as_of_date: s.local_date, value: s.value })),
        status: latest ? (latest.value === 0 ? 'zero' : 'ok') : supportsF ? 'not_fetched' : 'unsupported',
        message: latest ? (sumry.observed_change === null ? 'Fewer than two snapshots in this period: no change is shown.' : 'Observed change between the first and last snapshot in the period.')
          : supportsF ? 'Follower counts are not requested by the current network adapter.' : `${PROVIDER_LABEL[c.provider]} does not provide follower counts.` },
      health: seriesHealth('engagements', b.posts, engV, scope.period.timezone, b.cur, new Set([c.id])),
    };
  });
  const m = (opts.measure && (MEASURE_KEYS as readonly string[]).includes(opts.measure) && opts.measure !== 'followers' ? opts.measure : 'engagements') as MeasureKey;
  return { meta: meta(scope), basis_label: LIFETIME_LABEL, rows, comparison: channelComparison(m, scope, b) };
}

export async function video(ctx: Ctx, filters: AnalyticsFilters): Promise<VideoResponse> {
  const scope = await resolveScope(ctx, filters);
  const b = await bundle(scope, { videoOnly: true });
  const providers = [...new Set(scope.connections.map((c) => c.provider))];
  const totals = (['views', 'watch_time', 'avg_view_duration'] as const).map((m) => {
    const e = evaluate(m, scope, scope.period, b.aggs, b.posts, b.cur);
    return { measure: m as MeasureKey, label: MEASURES[m].label, value: e.value, definition: measureDefinition(m, providers), health: e.health };
  });
  const by_network = providers.filter((p) => b.posts.some((x) => x.provider === p)).map((p) => {
    const conns = new Set(scope.connections.filter((c) => c.provider === p).map((c) => c.id));
    const aggs = b.aggs.filter((a) => conns.has(a.connection_id));
    const posts = b.posts.filter((x) => conns.has(x.connection_id));
    const v = measureFromAggs('views', aggs, posts.length);
    const ret = definitionsFor(p).find((d) => d.family === 'retention');
    return {
      provider: p, videos: posts.length, views: v.value, watch_time_minutes: measureFromAggs('watch_time', aggs, posts.length).value,
      avg_view_duration_seconds: measureFromAggs('avg_view_duration', aggs, posts.length).value,
      retention: ret ? { status: 'not_fetched' as SeriesStatus, message: `${ret.name} is available from ${PROVIDER_LABEL[p]} but not requested by the current adapter.` }
        : { status: 'unsupported' as SeriesStatus, message: `${PROVIDER_LABEL[p]} does not provide retention curves through its API.` },
      health: seriesHealth('views', b.posts, v, scope.period.timezone, b.cur, conns),
    };
  });
  const q = new Params();
  const scopeSql = postScopeSql(scope, scope.period, q, { videoOnly: true });
  const fmt = scope.connections.length ? await many<{ format: PostFormat; provider: Provider; posts: number; views: number | null; with_data: number }>(getPool(),
    `WITH sp AS (${scopeSql})
     SELECT sp.format, sp.provider::text AS provider, count(*)::int AS posts, sum(v.views)::float8 AS views, count(v.views)::int AS with_data
       FROM sp LEFT JOIN (SELECT l.resource_id, sum(l.value) AS views FROM metric_resource_latest l JOIN metric_definitions md ON md.metric_id = l.metric_id AND md.version = l.definition_version
                           WHERE l.workspace_id = ${q.p(scope.workspaceId)} AND md.family = 'views' AND l.source = ANY(${q.p(scope.sources)}::text[]) AND l.resource_id IN (SELECT id FROM sp)
                           GROUP BY 1) v ON v.resource_id = sp.id
      GROUP BY 1,2 ORDER BY 2,1`, q.values) : [];
  const top = await contentRows(scope, scope.period, { sort: 'views', dir: 'desc', limit: 5, offset: 0, videoOnly: true });
  return { meta: meta(scope), basis_label: LIFETIME_LABEL, totals, by_network, formats: fmt.map((f) => ({ ...f, views: f.views === null ? null : Number(f.views) })), top_videos: top.rows };
}

const AUDIENCE_BUCKET_MIN = 10;

export async function audience(ctx: Ctx, filters: AnalyticsFilters): Promise<AudienceResponse> {
  const scope = await resolveScope(ctx, filters);
  const rows = scope.connections.length ? await many<{ connection_id: string; metric_id: string; dimension: string; value: string; as_of_date: string }>(getPool(),
    `SELECT DISTINCT ON (f.connection_id, f.metric_id, f.dimension) f.connection_id, f.metric_id, f.dimension, f.value::text, f.as_of_date::text
       FROM metric_cumulative_facts f JOIN metric_definitions md ON md.metric_id = f.metric_id AND md.version = f.definition_version
      WHERE f.workspace_id=$1 AND f.resource_type='account' AND md.family='audience' AND f.connection_id = ANY($2::uuid[]) AND f.source = ANY($3::text[]) AND f.observed_at < $4
      ORDER BY f.connection_id, f.metric_id, f.dimension, f.as_of_date DESC`, [scope.workspaceId, scope.connections.map((c) => c.id), scope.sources, scope.period.end_utc]) : [];
  const follow = await followerSnapshots(scope, scope.period);
  return {
    meta: meta(scope),
    accounts: scope.connections.map((c) => {
      const defs = definitionsFor(c.provider).filter((d) => d.family === 'audience');
      if (!defs.length) return { connection_id: c.id, provider: c.provider, display_name: c.display_name, state: 'unsupported' as const, threshold: null, breakdowns: [],
        message: `${PROVIDER_LABEL[c.provider]} does not provide aggregate audience data that Relay can request.` };
      const mine = rows.filter((r) => r.connection_id === c.id);
      if (!mine.length) return { connection_id: c.id, provider: c.provider, display_name: c.display_name, state: 'not_fetched' as const, threshold: defs[0]!.minThreshold ?? null, breakdowns: [],
        message: `${defs.map((d) => d.name).join(', ')} ${defs.length > 1 ? 'are' : 'is'} available from ${PROVIDER_LABEL[c.provider]} (aggregate, thresholded) but not requested by the current adapter.` };
      const threshold = defs[0]!.minThreshold ?? null;
      const followers = follow.latestBefore.get(c.id)?.value ?? null;
      if (threshold !== null && (followers === null || followers < threshold)) {
        return { connection_id: c.id, provider: c.provider, display_name: c.display_name, state: 'below_threshold' as const, threshold, breakdowns: [],
          message: `${PROVIDER_LABEL[c.provider]} reports audience breakdowns only for accounts with at least ${threshold} followers.` };
      }
      const breakdowns = defs.map((d) => {
        const rs = mine.filter((r) => r.metric_id === d.id);
        const total = rs.reduce((a, r) => a + Number(r.value), 0);
        const shown = rs.filter((r) => d.unit === 'percent' || Number(r.value) >= AUDIENCE_BUCKET_MIN).sort((a, b2) => Number(b2.value) - Number(a.value));
        const suppressed = rs.filter((r) => !shown.includes(r)).reduce((a, r) => a + Number(r.value), 0);
        return { metric_id: d.id, name: d.name, dimension_key: d.dimensionKey ?? 'key', as_of_date: rs[0]?.as_of_date ?? '', total,
          buckets: shown.map((r) => ({ key: r.dimension, value: Number(r.value), share: total ? Number(r.value) / total : 0 })), suppressed };
      }).filter((x) => x.buckets.length || x.suppressed);
      return { connection_id: c.id, provider: c.provider, display_name: c.display_name, state: 'available' as const, threshold, breakdowns,
        message: `Aggregate audience as reported by ${PROVIDER_LABEL[c.provider]}; buckets under ${AUDIENCE_BUCKET_MIN} are folded into “suppressed”.` };
    }),
  };
}

// ------------------------------------------------------------------ workflow (app-owned facts; no per-person scores)
export async function workflow(ctx: Ctx, filters: AnalyticsFilters): Promise<WorkflowResponse> {
  const scope = await resolveScope(ctx, filters);
  const db = getPool();
  const ws = scope.workspaceId;
  const brandIds = scope.brands.map((b) => b.id);
  const f = scope.filters;
  const pf = (alias: string, q: Params) => [
    f.campaign_ids.length ? `${alias}.campaign_id = ANY(${q.p(f.campaign_ids)}::uuid[])` : 'TRUE',
    f.team_ids.length ? `${alias}.team_id = ANY(${q.p(f.team_ids)}::uuid[])` : 'TRUE',
  ].join(' AND ');
  const connFilter = (alias: string, q: Params) => (f.connection_ids.length || f.providers.length ? `${alias}.connection_id = ANY(${q.p(scope.connections.map((c) => c.id))}::uuid[])` : 'TRUE');
  const start = scope.period.start_utc; const end = scope.period.end_utc;
  const q1 = new Params();
  const review = await maybeOne<{ n: number; p50: number | null; p90: number | null; approved: number; rejected: number; pending: number; invalidated: number }>(db,
    `SELECT count(*) FILTER (WHERE a.decided_at IS NOT NULL AND a.decision IN ('approved','rejected'))::int AS n,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM a.decided_at - a.requested_at) / 3600) FILTER (WHERE a.decided_at IS NOT NULL AND a.decision IN ('approved','rejected')) AS p50,
            percentile_cont(0.9) WITHIN GROUP (ORDER BY extract(epoch FROM a.decided_at - a.requested_at) / 3600) FILTER (WHERE a.decided_at IS NOT NULL AND a.decision IN ('approved','rejected')) AS p90,
            count(*) FILTER (WHERE a.decision='approved')::int approved, count(*) FILTER (WHERE a.decision='rejected')::int rejected,
            count(*) FILTER (WHERE a.decision='pending')::int pending, count(*) FILTER (WHERE a.decision='invalidated')::int invalidated
       FROM approvals a JOIN posts p ON p.id = a.post_id
      WHERE a.workspace_id = ${q1.p(ws)} AND a.brand_id = ANY(${q1.p(brandIds)}::uuid[]) AND a.requested_at >= ${q1.p(start)} AND a.requested_at < ${q1.p(end)} AND ${pf('p', q1)}`, q1.values);
  const q2 = new Params();
  const load = await many<{ team_id: string | null; team: string | null; created: number; submitted: number; scheduled: number; published: number; pending_reviews: number }>(db,
    `WITH p AS (SELECT p.* FROM posts p WHERE p.workspace_id = ${q2.p(ws)} AND p.brand_id = ANY(${q2.p(brandIds)}::uuid[]) AND ${pf('p', q2)}),
          s AS (SELECT ${q2.p(start)}::timestamptz AS st, ${q2.p(end)}::timestamptz AS en)
     SELECT p.team_id, t.name AS team,
            count(*) FILTER (WHERE p.created_at >= s.st AND p.created_at < s.en)::int AS created,
            count(DISTINCT p.id) FILTER (WHERE EXISTS (SELECT 1 FROM approvals a WHERE a.post_id = p.id AND a.requested_at >= s.st AND a.requested_at < s.en))::int AS submitted,
            count(DISTINCT p.id) FILTER (WHERE EXISTS (SELECT 1 FROM schedules sc WHERE sc.post_id = p.id AND sc.created_at >= s.st AND sc.created_at < s.en AND NOT sc.is_immediate))::int AS scheduled,
            count(DISTINCT p.id) FILTER (WHERE EXISTS (SELECT 1 FROM deliveries d WHERE d.post_id = p.id AND d.state = 'published' AND d.published_at >= s.st AND d.published_at < s.en AND ${connFilter('d', q2)}))::int AS published,
            count(DISTINCT p.id) FILTER (WHERE EXISTS (SELECT 1 FROM approvals a WHERE a.post_id = p.id AND a.decision = 'pending'))::int AS pending_reviews
       FROM p CROSS JOIN s LEFT JOIN teams t ON t.id = p.team_id GROUP BY p.team_id, t.name ORDER BY t.name NULLS LAST`, q2.values);
  const q3 = new Params();
  const overdue = await maybeOne<{ n: number }>(db,
    `SELECT count(*)::int n FROM posts p WHERE p.workspace_id = ${q3.p(ws)} AND p.brand_id = ANY(${q3.p(brandIds)}::uuid[]) AND ${pf('p', q3)}
        AND p.archived_at IS NULL AND p.due_at IS NOT NULL AND p.due_at < now()
        AND NOT EXISTS (SELECT 1 FROM deliveries d WHERE d.post_id = p.id AND d.state = 'published')`, q3.values);
  const q4 = new Params();
  const adh = await maybeOne<{ published: number; on_time: number; n: number; p50: number | null; p90: number | null }>(db,
    `SELECT count(*)::int published, count(*) FILTER (WHERE d.published_at - d.due_at <= interval '5 minutes')::int on_time, count(*)::int n,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY greatest(0, extract(epoch FROM d.published_at - d.due_at) / 60)) p50,
            percentile_cont(0.9) WITHIN GROUP (ORDER BY greatest(0, extract(epoch FROM d.published_at - d.due_at) / 60)) p90
       FROM deliveries d JOIN schedules s ON s.id = d.schedule_id JOIN posts p ON p.id = d.post_id
      WHERE d.workspace_id = ${q4.p(ws)} AND d.brand_id = ANY(${q4.p(brandIds)}::uuid[]) AND d.state = 'published' AND NOT s.is_immediate
        AND d.due_at >= ${q4.p(start)} AND d.due_at < ${q4.p(end)} AND ${pf('p', q4)} AND ${connFilter('d', q4)}`, q4.values);
  const q5 = new Params();
  const rel = await many<{ is_mock: boolean; state: string; n: number }>(db,
    `SELECT d.is_mock, d.state::text AS state, count(*)::int n FROM deliveries d JOIN posts p ON p.id = d.post_id JOIN connections c ON c.id = d.connection_id
      WHERE d.workspace_id = ${q5.p(ws)} AND d.brand_id = ANY(${q5.p(brandIds)}::uuid[]) AND NOT c.is_synthetic AND d.due_at >= ${q5.p(start)} AND d.due_at < ${q5.p(end)}
        AND d.state IN ('published','failed','unknown','expired') AND ${pf('p', q5)} AND ${connFilter('d', q5)}
      GROUP BY 1,2`, q5.values);
  const q6 = new Params();
  const errs = await many<{ code: string; count: number }>(db,
    `SELECT coalesce(d.last_error_code, 'unknown') AS code, count(*)::int AS count FROM deliveries d JOIN posts p ON p.id = d.post_id
      WHERE d.workspace_id = ${q6.p(ws)} AND d.brand_id = ANY(${q6.p(brandIds)}::uuid[]) AND d.state IN ('failed','expired') AND NOT d.is_mock
        AND d.due_at >= ${q6.p(start)} AND d.due_at < ${q6.p(end)} AND ${pf('p', q6)} AND ${connFilter('d', q6)}
      GROUP BY 1 ORDER BY 2 DESC LIMIT 5`, q6.values);
  const relFor = (mock: boolean) => {
    const g = (s: string) => rel.find((r) => r.is_mock === mock && r.state === s)?.n ?? 0;
    const published = g('published'); const failed = g('failed'); const unknown = g('unknown'); const expired = g('expired');
    const den = published + failed + unknown + expired;
    return { published, failed, unknown, expired, ratio: den ? published / den : null };
  };
  const num = (v: number | null | undefined) => (v === null || v === undefined ? null : Math.round(Number(v) * 100) / 100);
  return {
    meta: meta(scope),
    note: 'App-owned workflow facts for the selected scope. Reported per team and stage — never as individual performance scores.',
    review_turnaround: { count: review?.n ?? 0, median: num(review?.p50), p90: num(review?.p90), unit: 'hours', approved: review?.approved ?? 0, rejected: review?.rejected ?? 0,
      pending: review?.pending ?? 0, invalidated: review?.invalidated ?? 0 },
    workload: {
      created: load.reduce((a, r) => a + r.created, 0), submitted_for_review: load.reduce((a, r) => a + r.submitted, 0), scheduled: load.reduce((a, r) => a + r.scheduled, 0),
      published: load.reduce((a, r) => a + r.published, 0), pending_reviews_now: load.reduce((a, r) => a + r.pending_reviews, 0), overdue_now: overdue?.n ?? 0,
      by_team: load.map((r) => ({ team_id: r.team_id, team: r.team ?? 'No team', created: r.created, published: r.published, pending_reviews: r.pending_reviews })),
    },
    schedule_adherence: { published: adh?.published ?? 0, on_time: adh?.on_time ?? 0, on_time_ratio: adh?.published ? adh.on_time / adh.published : null, tolerance_minutes: 5,
      lateness: { count: adh?.n ?? 0, median: num(adh?.p50), p90: num(adh?.p90), unit: 'minutes' } },
    delivery_reliability: { live: relFor(false), simulated: relFor(true), top_errors: errs },
  };
}

// ------------------------------------------------------------------ best time (observational heuristic)
export const BEST_TIME_MIN_SAMPLE = 30;
export const BEST_TIME_MIN_PER_SLOT = 3;
const WEEKDAYS = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export async function bestTime(ctx: Ctx, filters: AnalyticsFilters): Promise<BestTimeResponse> {
  const scope = await resolveScope(ctx, filters);
  const caveat = 'Observational heuristic from your own posts: it shows when past posts in this scope did better on average, not why, and does not predict results. Audience, content and network changes matter more than timing.';
  const base = { meta: meta(scope), timezone: scope.period.timezone, required_sample: BEST_TIME_MIN_SAMPLE, min_per_slot: BEST_TIME_MIN_PER_SLOT, caveat };
  if (!scope.connections.length) return { ...base, status: 'insufficient_data', sample_size: 0, measure: 'engagement_rate_views', slots: [] };
  const q = new Params();
  const fam = q.p([...ENGAGEMENT_FAMILIES]);
  const tz = q.p(scope.period.timezone);
  const scopeSql = postScopeSql(scope, scope.period, q);
  const rows = await many<{ id: string; dow: number; hour: number; eng: number | null; views: number | null; impr: number | null }>(getPool(),
    `WITH sp AS (${scopeSql})
     SELECT sp.id, extract(isodow FROM sp.published_at AT TIME ZONE ${tz})::int AS dow, extract(hour FROM sp.published_at AT TIME ZONE ${tz})::int AS hour,
            sum(l.value) FILTER (WHERE md.family = ANY(${fam}::text[]))::float8 AS eng, sum(l.value) FILTER (WHERE md.family = 'views')::float8 AS views,
            sum(l.value) FILTER (WHERE md.family = 'impressions')::float8 AS impr
       FROM sp JOIN metric_resource_latest l ON l.resource_id = sp.id AND l.workspace_id = ${q.p(scope.workspaceId)} AND l.source = ANY(${q.p(scope.sources)}::text[])
       JOIN metric_definitions md ON md.metric_id = l.metric_id AND md.version = l.definition_version
      GROUP BY 1,2,3`, q.values);
  const byViews = rows.filter((r) => r.eng !== null && r.views !== null && Number(r.views) > 0);
  const byImpr = rows.filter((r) => r.eng !== null && r.impr !== null && Number(r.impr) > 0);
  const useViews = byViews.length >= byImpr.length;
  const sample = (useViews ? byViews : byImpr).map((r) => ({ dow: r.dow, hour: r.hour, rate: Number(r.eng) / Number(useViews ? r.views : r.impr) }));
  const measure = useViews ? 'engagement_rate_views' as const : 'engagement_rate_impressions' as const;
  if (sample.length < BEST_TIME_MIN_SAMPLE) return { ...base, status: 'insufficient_data', sample_size: sample.length, measure, slots: [] };
  const slots = new Map<string, number[]>();
  for (const s of sample) { const k = `${s.dow}|${s.hour}`; if (!slots.has(k)) slots.set(k, []); slots.get(k)!.push(s.rate); }
  const median = (xs: number[]) => { const s = [...xs].sort((a, b2) => a - b2); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2; };
  const ranked = [...slots].filter(([, v]) => v.length >= BEST_TIME_MIN_PER_SLOT).map(([k, v]) => {
    const [dow, hour] = k.split('|').map(Number) as [number, number];
    return { weekday: dow, hour, label: `${WEEKDAYS[dow]} ${String(hour).padStart(2, '0')}:00–${String((hour + 1) % 24).padStart(2, '0')}:00`, median_rate: median(v), posts: v.length };
  }).sort((a, b2) => b2.median_rate - a.median_rate).slice(0, 3);
  if (!ranked.length) return { ...base, status: 'insufficient_data', sample_size: sample.length, measure, slots: [] };
  return { ...base, status: 'available', sample_size: sample.length, measure, slots: ranked };
}

// ------------------------------------------------------------------ dictionary
export function metricDictionary(): MetricDefinitionDto[] {
  return METRIC_DEFINITIONS.map((d) => ({
    metric_id: d.id, version: d.version, provider: d.provider, native_metric: d.nativeMetric, name: d.name, description: d.description, unit: d.unit, scope: d.scope,
    family: d.family, aggregation: d.aggregation, time_basis: d.timeBasis, paid: d.paid, availability: d.availability, fetched: d.fetched,
    required_scopes: [...d.requiredScopes], retention_days: d.retentionDays, provider_delay_hours: d.providerDelayHours, unique: FAMILIES[d.family].unique,
  }));
}

/** Default filter timezone for a request: the single selected brand's timezone, else the workspace's. */
export async function defaultTimezone(ctx: Ctx, brandParam: string | null): Promise<string> {
  const db = getPool();
  if (brandParam && !brandParam.includes(',') && /^[0-9a-f-]{36}$/i.test(brandParam)) {
    const b = await maybeOne<{ timezone: string }>(db, `SELECT timezone FROM brands WHERE id=$1 AND workspace_id=$2`, [brandParam, ctx.access.workspaceId]);
    if (b) return b.timezone;
  }
  const w = await maybeOne<{ timezone: string }>(db, `SELECT timezone FROM workspaces WHERE id=$1`, [ctx.access.workspaceId]);
  return w?.timezone ?? 'Europe/London';
}

export { AppError };
