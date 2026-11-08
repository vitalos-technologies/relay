'use client';
// Analytics → Overview (V3 AN contract: GET /api/analytics/overview). KPIs with comparison, trend with previous period
// (dashed, neutral) or per-network lines, channel comparison inside comparable groups, top content, calculated insights.
import { useMemo } from 'react';
import { Lightbulb } from 'lucide-react';
import { PROVIDER_LABEL } from '@social-lite/core';
import type { OverviewResponse, TrendSeries } from '@social-lite/core/contracts/analytics';
import { useApi } from '@/lib/client/use-api';
import {
  BarList, Card, CardHeader, ChartPanel, ContentCard, ErrorState, FilterSelect, fmtMetric, Legend, LineChart, MetricCard, PlatformIcon, Segmented,
  Skeleton, Table, Td, Th, THead, Thumb, Tr, useSeriesStyles,
} from '@/components/ui';
import { AnalyticsFilters, DatasetNotice, fmtDay, HealthFooter, useAnalyticsQuery } from '@/components/analytics/v3/shared';

export default function AnalyticsOverviewPage() {
  const { qs, params, setParams } = useAnalyticsQuery(['measure']);
  const { data, error, loading, refetch, refreshing } = useApi<OverviewResponse>(`/api/analytics/overview?${qs}`, { keepPrevious: true });
  const mode = params.get('series') === 'network' ? 'network' : 'combined';

  if (error && !data) return <><AnalyticsFilters /><ErrorState error={error} onRetry={refetch} /></>;
  return (
    <div aria-busy={refreshing || undefined}>
      <AnalyticsFilters meta={data?.meta} />
      <DatasetNotice meta={data?.meta} />
      {loading && !data ? <OverviewSkeleton /> : data ? (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4 lg:gap-4">
            {data.kpis.slice(0, 4).map((k) => (
              <MetricCard
                key={k.measure}
                label={k.label.replace(/ \(.*\)$/, '')}
                value={k.value}
                unit={k.unit}
                delta={data.meta.previous_period ? { state: k.comparison.state, pct: k.comparison.change_pct } : null}
                info={<>{k.definition.definition}<br /><span className="text-muted">{k.basis_label}</span></>}
                foot={k.health.coverage.eligible && k.health.coverage.with_data < k.health.coverage.eligible
                  ? `${k.health.coverage.with_data}/${k.health.coverage.eligible} ${k.health.coverage.unit} with data`
                  : k.basis === 'snapshot_latest' ? 'Latest snapshot' : k.basis === 'app_fact' ? 'App records' : 'Lifetime of posts in period'}
              />
            ))}
          </div>

          <TrendPanel data={data} mode={mode} onMode={(m) => setParams({ series: m === 'network' ? 'network' : null })} onMeasure={(m) => setParams({ measure: m })} />

          <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-2">
            <Card aria-labelledby="h-chan">
              <CardHeader id="h-chan" title="Channels" />
              <div className="flex flex-col gap-5 px-4 pb-4">
                {data.channels.groups.length ? data.channels.groups.map((g) => (
                  <div key={g.label}>
                    <p className="mb-2 text-xs text-muted">{g.label}</p>
                    <BarList
                      label={g.label}
                      rows={g.rows.map((r) => ({ key: r.connection_id, value: r.value, label: <><PlatformIcon provider={r.provider} size="xs" decorative /><span className="truncate">{PROVIDER_LABEL[r.provider]} · {r.display_name}</span></> }))}
                    />
                  </div>
                )) : <p className="text-[13px] text-muted">No comparable channels</p>}
                {data.channels.excluded.length ? (
                  <p className="text-xs text-muted">Not comparable: {data.channels.excluded.map((e) => `${PROVIDER_LABEL[e.provider]} (${e.reason.replace(/\.$/, '').toLowerCase()})`).join(', ')}</p>
                ) : null}
              </div>
            </Card>
            <Card aria-labelledby="h-top">
              <CardHeader id="h-top" title="Top content" />
              <ul className="flex flex-col px-2 pb-3">
                {data.top_content.length ? data.top_content.map((r) => (
                  <li key={r.delivery_id}>
                    <ContentCard
                      href={`/analytics/content?${qs}${qs ? '&' : ''}open=${r.delivery_id}`}
                      thumb={<Thumb src={r.thumbnail.url} alt={r.thumbnail.alt} kind={r.format === 'video' || r.format === 'reel' ? 'video' : r.format === 'album' ? 'album' : null} provider={r.provider} className="size-12" />}
                      title={r.title || r.excerpt || 'Untitled'}
                      meta={<><PlatformIcon provider={r.provider} size="xs" decorative /><span className="truncate">{r.account} · {fmtDay(r.published_local.slice(0, 10))}</span></>}
                      trailing={<span className="text-right"><span className="block text-[14px] font-semibold tabular">{fmtMetric(r.engagements)}</span><span className="block text-[11px] text-muted">engagements</span></span>}
                    />
                  </li>
                )) : <li className="px-2 py-4 text-[13px] text-muted">No published posts in this period</li>}
              </ul>
            </Card>
          </div>

          {data.insights.length ? (
            <section aria-labelledby="h-ins" className="mt-6">
              <h2 id="h-ins" className="mb-3 flex items-center gap-2 text-[15px] font-semibold"><Lightbulb aria-hidden className="size-4 text-accent-text" />Calculated from this data</h2>
              <ul className="grid grid-cols-1 gap-3 md:grid-cols-2">
                {data.insights.map((i) => <li key={i.id} className="rounded-xl border border-border bg-surface px-4 py-3 text-[13px]">{i.text}</li>)}
              </ul>
            </section>
          ) : null}

          <HealthFooter health={data.data_health} />
        </>
      ) : null}
    </div>
  );
}

function TrendPanel({ data, mode, onMode, onMeasure }: { data: OverviewResponse; mode: 'combined' | 'network'; onMode: (m: string) => void; onMeasure: (m: string) => void }) {
  const t = data.trend;
  const effective = !t.combined ? 'network' : mode;
  const networks = t.by_network.filter((s) => s.points.some((p) => p.value !== null));
  const styles = useSeriesStyles(networks.map((s) => s.key));
  const labels = (t.combined ?? t.by_network[0])?.points.map((p) => p.date) ?? [];
  const drawn: TrendSeries[] = effective === 'combined' && t.combined ? [t.combined] : networks.slice(0, 5);
  const series = drawn.map((s) => ({
    key: s.key, label: s.key === 'all' ? t.definition.label : s.label,
    color: s.key === 'all' ? 'var(--chart-1)' : styles.get(s.key)?.color ?? 'var(--chart-1)', dash: s.key === 'all' ? undefined : styles.get(s.key)?.dash,
    values: s.points.map((p) => p.value),
  }));
  const prev = effective === 'combined' && t.previous?.combined
    ? { key: 'prev', label: 'Previous period', color: 'var(--chart-prev)', dash: '4 4', values: t.previous.combined.points.map((p) => p.value) } : null;
  const total = t.combined?.total ?? null;
  const summary = useMemo(() => {
    const vals = series[0]?.values.filter((v): v is number => v !== null) ?? [];
    if (!vals.length) return `${t.definition.label}: no data in this period.`;
    return `${t.definition.label} per day from ${fmtDay(data.meta.period.from)} to ${fmtDay(data.meta.period.to)}. ${effective === 'combined' ? `Total ${fmtMetric(total, t.definition.unit, false)}. Peak ${fmtMetric(Math.max(...vals), t.definition.unit, false)}.` : `${series.length} networks shown.`}`;
  }, [series, t, data.meta.period, effective, total]);

  return (
    <ChartPanel
      className="mt-6"
      title={<>{t.definition.label}{total !== null && effective === 'combined' ? <span className="ml-2 font-normal text-muted tabular">{fmtMetric(total, t.definition.unit)}</span> : null}</>}
      info={<>{t.definition.definition}<br /><span className="text-muted">{t.basis_label}</span></>}
      summary={summary}
      actions={<>
        <FilterSelect id="an-measure" label="Measure" className="w-[190px]" value={t.measure} onChange={onMeasure}>
          {t.available_measures.map((m) => <option key={m.key} value={m.key} disabled={!m.available}>{m.label}{m.available ? '' : ' — n/a'}</option>)}
        </FilterSelect>
        <Segmented size="sm" label="Series" value={effective} onChange={onMode}
          options={[{ value: 'combined', label: 'Total', disabled: !t.combined }, { value: 'network', label: 'By network' }]} />
      </>}
      chart={
        <>
          {!t.combined && t.combined_reason ? <p className="mb-2 text-xs text-muted">{t.combined_reason}</p> : null}
          <LineChart
            ariaLabel={summary}
            labels={labels}
            xLabel={(d) => fmtDay(d)}
            series={series}
            previous={prev}
            unit={t.definition.unit}
            height={260}
          />
          <Legend className="mt-3" items={[...series, ...(prev ? [prev] : [])]} />
          {effective === 'network' && networks.length > 5 ? <p className="mt-1 text-xs text-muted">{networks.length - 5} more networks in the table view</p> : null}
        </>
      }
      table={
        <Table caption={`${t.definition.label} per day`}>
          <THead>
            <tr><Th>Date</Th>{(effective === 'combined' ? drawn : networks).map((s) => <Th key={s.key} className="text-right">{s.key === 'all' ? 'Total' : s.label}</Th>)}{prev ? <Th className="text-right">Previous</Th> : null}</tr>
          </THead>
          <tbody>
            {labels.map((d, i) => (
              <Tr key={d}>
                <Td className="tabular">{fmtDay(d, { weekday: 'short', day: 'numeric', month: 'short' })}</Td>
                {(effective === 'combined' ? drawn : networks).map((s) => <Td key={s.key} className="text-right tabular">{fmtMetric(s.points[i]?.value ?? null, t.definition.unit, false)}</Td>)}
                {prev ? <Td className="text-right tabular text-muted">{fmtMetric(prev.values[i] ?? null, t.definition.unit, false)}</Td> : null}
              </Tr>
            ))}
          </tbody>
        </Table>
      }
    />
  );
}

function OverviewSkeleton() {
  return (
    <div className="flex flex-col gap-6" role="status" aria-label="Loading">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-28 rounded-[14px]" />)}</div>
      <Skeleton className="h-80 rounded-[14px]" />
    </div>
  );
}
