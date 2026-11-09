// Report rendering (CSV + HTML) for exports. Pure: takes the SAME authorized view responses the API returns, so an
// export reproduces exactly what the filters/permissions allowed. Every export starts with a manifest: title, view,
// scope (brands/accounts), filters (canonical query string), timezone and period, dataset (synthetic flag), measure
// definitions, observation timestamps, through-date and coverage.
// CSV: numbers verbatim; text cells formula-injection-safe (semantics.csvCell). HTML: every value escaped.
import { PROVIDER_LABEL } from '@social-lite/core';
import type {
  AnalyticsView, AudienceResponse, ChannelsResponse, ContentRow, ContentTableResponse, Coverage, MeasureDefinition, OverviewResponse, ReportManifest, ResponseMeta,
  VideoResponse, WorkflowResponse,
} from '@social-lite/core/contracts/analytics';
import type { ChannelTableMeasure } from '@social-lite/core/contracts/analytics';
import { csvLine } from './semantics.js';

const CHANNEL_MEASURE_LABEL: Record<ChannelTableMeasure, string> = { engagements: 'Engagements', views: 'Views', impressions: 'Impressions', reach: 'Reach' };

export type ViewData =
  | { view: 'overview'; data: OverviewResponse }
  | { view: 'content'; data: ContentTableResponse & { all_rows: ContentRow[] } }
  | { view: 'channels'; data: ChannelsResponse }
  | { view: 'video'; data: VideoResponse }
  | { view: 'audience'; data: AudienceResponse }
  | { view: 'workflow'; data: WorkflowResponse };

const VIEW_TITLE: Record<AnalyticsView, string> = {
  overview: 'Analytics overview', content: 'Content performance', channels: 'Channels', video: 'Video', audience: 'Audience', workflow: 'Team & workflow',
};

function metaOf(v: ViewData): ResponseMeta { return v.data.meta; }

const emptyCoverage: Coverage = { unit: 'posts', selected: 0, eligible: 0, with_data: 0, unsupported: 0, ratio: null };

export function buildManifest(v: ViewData, opts: { title?: string | null; requestedBy: string }): ReportManifest {
  const m = metaOf(v);
  let measures: MeasureDefinition[] = [];
  let coverage: Coverage = emptyCoverage;
  let observedFrom: string | null = null; let observedTo: string | null = null; let through: string | null = null;
  const fold = (f: { observed_from: string | null; observed_to: string | null; through: string | null }) => {
    if (f.observed_from && (!observedFrom || f.observed_from < observedFrom)) observedFrom = f.observed_from;
    if (f.observed_to && (!observedTo || f.observed_to > observedTo)) observedTo = f.observed_to;
    if (f.through && (!through || f.through < through)) through = f.through;
  };
  switch (v.view) {
    case 'overview':
      measures = [...v.data.kpis.map((k) => k.definition), v.data.trend.definition];
      v.data.kpis.forEach((k) => fold(k.health.freshness));
      coverage = v.data.data_health.coverage; break;
    case 'content': fold(v.data.health.freshness); coverage = v.data.health.coverage; break;
    case 'channels': v.data.rows.forEach((r) => fold(r.health.freshness)); coverage = v.data.rows.reduce((a, r) => ({ ...a, selected: a.selected + r.health.coverage.selected,
      eligible: a.eligible + r.health.coverage.eligible, with_data: a.with_data + r.health.coverage.with_data, unsupported: a.unsupported + r.health.coverage.unsupported }), { ...emptyCoverage });
      coverage.ratio = coverage.eligible ? coverage.with_data / coverage.eligible : null; break;
    case 'video': measures = v.data.totals.map((t) => t.definition); v.data.totals.forEach((t) => fold(t.health.freshness)); coverage = v.data.totals[0]?.health.coverage ?? emptyCoverage; break;
    default: break;
  }
  const uniq = new Map(measures.map((x) => [x.key, x]));
  return {
    title: opts.title?.trim() || VIEW_TITLE[v.view], view: v.view, filters: m.filters, query_string: m.query_string, period: m.period, timezone: m.period.timezone,
    dataset: m.dataset, synthetic: m.synthetic, scope: m.scope, measures: [...uniq.values()], observed_from: observedFrom, observed_to: observedTo, through,
    coverage, generated_at: m.generated_at, requested_by: opts.requestedBy,
  };
}

function manifestRows(mf: ReportManifest): unknown[][] {
  const rows: unknown[][] = [
    ['report', 'title', mf.title], ['report', 'view', mf.view], ['report', 'generated_at_utc', mf.generated_at],
    ['report', 'dataset', mf.dataset + (mf.synthetic ? ' (SYNTHETIC demo data — not network-reported)' : mf.dataset === 'simulated' ? ' (simulated destinations)' : '')],
    ['report', 'timezone', mf.timezone], ['report', 'period', `${mf.period.from} to ${mf.period.to} (inclusive, local dates)`],
    ['report', 'period_utc', `${mf.period.start_utc} to ${mf.period.end_utc} (end exclusive)`], ['report', 'filters', mf.query_string],
    ['report', 'brands', mf.scope.brands.map((b) => b.name).join('; ')],
    ['report', 'accounts', mf.scope.accounts.map((a) => `${PROVIDER_LABEL[a.provider]}: ${a.display_name}`).join('; ')],
    ['report', 'observations_from_utc', mf.observed_from ?? ''], ['report', 'observations_to_utc', mf.observed_to ?? ''], ['report', 'data_complete_through_utc', mf.through ?? ''],
    ['report', 'coverage', `${mf.coverage.with_data} of ${mf.coverage.eligible} eligible ${mf.coverage.unit} have data (${mf.coverage.selected} selected, ${mf.coverage.unsupported} on networks without the measure)`],
    ['report', 'basis', 'Lifetime performance of posts published in this period (network-reported totals as last observed); missing values are blank, never 0'],
  ];
  for (const d of mf.measures) rows.push(['measure', `${d.label} [${d.key}]`, `${d.definition} Components: ${d.components.map((c) => `${c.provider}:${c.native_metric}${c.role ? ` (${c.role})` : ''}`).join(', ') || 'none in scope'}`]);
  return rows;
}

const FAMILY_COLS = ['views', 'impressions', 'reach', 'likes', 'comments', 'shares', 'quotes', 'saves', 'clicks', 'link_clicks', 'watch_time'] as const;

function familySum(r: ContentRow, fam: string): number | null {
  const ms = r.metrics.filter((m) => m.family === fam && m.value !== null);
  return ms.length ? ms.reduce((a, m) => a + (m.value ?? 0), 0) : null;
}

function contentTable(rows: ContentRow[]): { header: string[]; body: unknown[][] } {
  const header = ['delivery_id', 'published_at_utc', 'published_local', 'network', 'account', 'title', 'format', 'campaign', 'engagements', 'engagement_rate',
    'engagement_rate_denominator', ...FAMILY_COLS, 'status', 'last_observed_at_utc', 'data_through_utc', 'provider_url'];
  const body = rows.map((r) => {
    const obs = r.metrics.map((m) => m.observed_at).filter((x): x is string => !!x).sort();
    const thr = r.metrics.map((m) => m.through).filter((x): x is string => !!x).sort();
    return [r.delivery_id, r.published_at, r.published_local, r.provider, r.account, r.title ?? r.excerpt ?? '', r.format ?? '', r.campaign?.name ?? '',
      r.engagements, r.engagement_rate.value, r.engagement_rate.denominator ?? '', ...FAMILY_COLS.map((f) => familySum(r, f)), r.status,
      obs[obs.length - 1] ?? '', thr[0] ?? '', r.provider_url ?? ''];
  });
  return { header, body };
}

/** Sections of a report as plain tables (shared by CSV and HTML). */
export function reportTables(v: ViewData): Array<{ title: string; header: string[]; body: unknown[][] }> {
  switch (v.view) {
    case 'overview': {
      const d = v.data;
      const kpis = { title: 'KPIs', header: ['measure', 'label', 'value', 'unit', 'basis', 'previous_value', 'change_pct', 'comparison', 'status', 'posts_with_data', 'eligible_posts', 'observed_to_utc', 'through_utc'],
        body: d.kpis.map((k) => [k.measure, k.label, k.value, k.unit, k.basis_label, k.comparison.previous, k.comparison.change_pct, k.comparison.state, k.health.status,
          k.health.coverage.with_data, k.health.coverage.eligible, k.health.freshness.observed_to ?? '', k.health.freshness.through ?? '']) };
      const series = [...(d.trend.combined ? [d.trend.combined] : []), ...d.trend.by_network];
      const trend = { title: `Trend — ${d.trend.definition.label} (${d.trend.basis_label})`, header: ['date', 'series', 'value', 'status', 'posts_with_data', 'eligible_posts'],
        body: series.flatMap((s) => s.points.map((p) => [p.date, s.label, p.value, p.status, p.with_data, p.eligible])) };
      const ch = { title: `Channels — ${d.channels.measure}`, header: ['group', 'account', 'network', 'value', 'share', 'status'],
        body: d.channels.groups.flatMap((g) => g.rows.map((r) => [g.label, r.display_name, r.provider, r.value, r.share, r.health.status])) };
      const top = { title: 'Top content (by engagements)', ...contentTable(d.top_content) };
      const ins = { title: 'Observations (calculated from this dataset)', header: ['text'], body: d.insights.map((i) => [i.text]) };
      return [kpis, trend, ch, top, ins];
    }
    case 'content': return [{ title: `Content (${v.data.total} posts, sorted by ${v.data.sort} ${v.data.dir})`, ...contentTable(v.data.all_rows) }];
    case 'channels': {
      const body: unknown[][] = [];
      for (const r of v.data.rows) {
        for (const m of r.metrics) body.push([r.display_name, r.provider, r.posts_published, m.metric_id, m.native_metric, m.name, m.dimension ?? '', m.value, m.status, m.posts_with_data, m.label_note ?? '', m.observed_at ?? '', m.through ?? '']);
        body.push([r.display_name, r.provider, r.posts_published, 'followers.latest', '', 'Followers (latest snapshot)', '', r.followers.latest, r.followers.status, '', r.followers.message ?? '', r.followers.as_of_date ?? '', '']);
        // Fix H6: the table's measure columns (engagements added up across the network's engagement metrics).
        for (const m of r.measures ?? []) body.push([r.display_name, r.provider, r.posts_published, `measure.${m.measure}`, '', CHANNEL_MEASURE_LABEL[m.measure], '', m.value, m.status, m.posts_with_data, m.measure === 'reach' ? 'Sum of per-post unique counts' : '', '', '']);
      }
      return [{ title: 'Channels — native metrics (lifetime of posts published in this period)', header: ['account', 'network', 'posts_published', 'metric_id', 'native_metric', 'name', 'dimension', 'value', 'status', 'posts_with_data', 'note', 'observed_at_utc', 'through_utc'], body }];
    }
    case 'video': return [
      { title: 'Video totals', header: ['measure', 'label', 'value', 'status', 'with_data', 'eligible'], body: v.data.totals.map((t) => [t.measure, t.label, t.value, t.health.status, t.health.coverage.with_data, t.health.coverage.eligible]) },
      { title: 'By network', header: ['network', 'videos', 'views', 'watch_time_minutes', 'avg_view_duration_seconds', 'retention_status', 'retention_note'],
        body: v.data.by_network.map((n) => [n.provider, n.videos, n.views, n.watch_time_minutes, n.avg_view_duration_seconds, n.retention.status, n.retention.message]) },
      { title: 'Formats', header: ['format', 'network', 'posts', 'views', 'with_data'], body: v.data.formats.map((f) => [f.format, f.provider, f.posts, f.views, f.with_data]) },
    ];
    case 'audience': return [{ title: 'Audience', header: ['account', 'network', 'state', 'breakdown', 'bucket', 'value', 'share', 'suppressed', 'as_of_date', 'note'],
      body: v.data.accounts.flatMap((a): unknown[][] => a.breakdowns.length ? a.breakdowns.flatMap((b) => b.buckets.map((k) => [a.display_name, a.provider, a.state, b.name, k.key, k.value, k.share, b.suppressed, b.as_of_date, a.message]))
        : [[a.display_name, a.provider, a.state, '', '', null, null, null, '', a.message]]) }];
    case 'workflow': {
      const w = v.data;
      return [{ title: 'Team & workflow (app-owned facts; no individual scores)', header: ['section', 'metric', 'value'], body: [
        ['review_turnaround', 'decided_reviews', w.review_turnaround.count], ['review_turnaround', 'median_hours', w.review_turnaround.median], ['review_turnaround', 'p90_hours', w.review_turnaround.p90],
        ['review_turnaround', 'approved', w.review_turnaround.approved], ['review_turnaround', 'rejected', w.review_turnaround.rejected], ['review_turnaround', 'pending', w.review_turnaround.pending],
        ['workload', 'created', w.workload.created], ['workload', 'submitted_for_review', w.workload.submitted_for_review], ['workload', 'scheduled', w.workload.scheduled],
        ['workload', 'published', w.workload.published], ['workload', 'pending_reviews_now', w.workload.pending_reviews_now], ['workload', 'overdue_now', w.workload.overdue_now],
        ...w.workload.by_team.map((t) => [`team:${t.team}`, 'created/published/pending_reviews', `${t.created}/${t.published}/${t.pending_reviews}`]),
        ['schedule_adherence', 'published', w.schedule_adherence.published], ['schedule_adherence', `on_time (≤ ${w.schedule_adherence.tolerance_minutes} min)`, w.schedule_adherence.on_time],
        ['schedule_adherence', 'median_lateness_minutes', w.schedule_adherence.lateness.median],
        ['delivery_reliability', 'live_published', w.delivery_reliability.live.published], ['delivery_reliability', 'live_failed', w.delivery_reliability.live.failed],
        ['delivery_reliability', 'live_ratio', w.delivery_reliability.live.ratio],
      ] }];
    }
  }
}

export function renderCsv(v: ViewData, mf: ReportManifest): string {
  const lines: string[] = [csvLine(['section', 'key', 'value']), ...manifestRows(mf).map(csvLine)];
  for (const t of reportTables(v)) {
    lines.push('', csvLine([`# ${t.title}`]), csvLine(t.header), ...t.body.map(csvLine));
  }
  return lines.join('\r\n') + '\r\n';
}

export function escapeHtml(v: unknown): string {
  if (v === null || v === undefined) return '';
  return String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const fmtCell = (v: unknown) => (v === null || v === undefined || v === '' ? '<span class="missing">—</span>' : typeof v === 'number' ? escapeHtml(Number.isInteger(v) ? v.toLocaleString('en-GB') : v.toFixed(4)) : escapeHtml(v));

export function renderHtml(v: ViewData, mf: ReportManifest): string {
  const meta = manifestRows(mf).map((r) => `<tr><th>${escapeHtml(r[1])}</th><td>${escapeHtml(r[2])}</td></tr>`).join('');
  const tables = reportTables(v).map((t) => `<h2>${escapeHtml(t.title)}</h2><table><thead><tr>${t.header.map((h) => `<th>${escapeHtml(h)}</th>`).join('')}</tr></thead>
    <tbody>${t.body.map((r) => `<tr>${r.map((c) => `<td>${fmtCell(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`).join('\n');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(mf.title)}</title>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">
<style>body{font:12px/1.45 Inter,Helvetica,Arial,sans-serif;color:#121416;margin:24px}h1{font-size:20px;margin:0 0 4px}h2{font-size:14px;margin:20px 0 6px;color:#FD6701}
table{border-collapse:collapse;width:100%;margin-bottom:8px}th,td{border-bottom:1px solid #EBEDEE;padding:3px 6px;text-align:left;vertical-align:top}th{background:#f6f7f8}
.meta th{width:220px}.missing{color:#9aa1a9}.synthetic{background:#FDA602;color:#121416;padding:4px 8px;display:inline-block;font-weight:600}</style></head><body>
<h1>${escapeHtml(mf.title)}</h1>${mf.synthetic ? '<p class="synthetic">SYNTHETIC DEMO DATA — not network-reported</p>' : ''}
<table class="meta">${meta}</table>
${tables}
<p class="missing">Generated by Relay. Missing values are shown as “—”, never as 0.</p></body></html>`;
}
