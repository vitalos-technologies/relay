'use client';
// Analytics → Video (GET /api/analytics/video): totals, per-network views / watch time / average duration, formats, top videos.
import { PROVIDER_LABEL } from '@social-lite/core';
import type { VideoResponse } from '@social-lite/core/contracts/analytics';
import { useApi } from '@/lib/client/use-api';
import { Card, CardHeader, ContentCard, EmptyState, ErrorState, fmtMetric, MetricCard, PlatformIcon, SkeletonRows, Table, Td, Th, THead, Thumb, Tr } from '@/components/ui';
import { AnalyticsFilters, DatasetNotice, fmtDay, useAnalyticsQuery } from '@/components/analytics/v3/shared';

export default function AnalyticsVideoPage() {
  const { qs } = useAnalyticsQuery();
  const { data, error, loading, refetch, refreshing } = useApi<VideoResponse>(`/api/analytics/video?${qs}`, { keepPrevious: true });
  return (
    <div aria-busy={refreshing || undefined}>
      <AnalyticsFilters meta={data?.meta} showFormat={false} />
      <DatasetNotice meta={data?.meta} />
      {error && !data ? <ErrorState error={error} onRetry={refetch} /> : loading && !data ? <SkeletonRows rows={6} /> : !data ? null : !data.by_network.length ? (
        <EmptyState title="No videos in this period" />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4 lg:gap-4">
            {data.totals.slice(0, 4).map((t) => <MetricCard key={t.measure} label={t.label} value={t.value} unit={t.definition.unit} info={t.definition.definition} />)}
          </div>
          <div className="mt-6 grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
            <section aria-labelledby="h-vnet">
              <h2 id="h-vnet" className="mb-3 text-[15px] font-semibold">By network</h2>
              <Table caption="Video by network">
                <THead><tr><Th>Network</Th><Th className="text-right">Videos</Th><Th className="text-right">Views</Th><Th className="hidden text-right sm:table-cell">Watch time</Th><Th className="hidden text-right sm:table-cell">Avg. duration</Th></tr></THead>
                <tbody>
                  {data.by_network.map((n) => (
                    <Tr key={n.provider}>
                      <Td><span className="flex items-center gap-2"><PlatformIcon provider={n.provider} size="xs" decorative />{PROVIDER_LABEL[n.provider]}</span></Td>
                      <Td className="text-right tabular">{n.videos}</Td>
                      <Td className="text-right tabular">{fmtMetric(n.views)}</Td>
                      <Td className="hidden text-right tabular sm:table-cell">{fmtMetric(n.watch_time_minutes, 'minutes')}</Td>
                      <Td className="hidden text-right tabular sm:table-cell">{fmtMetric(n.avg_view_duration_seconds, 'seconds')}</Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
              {data.by_network.some((n) => n.retention.status !== 'ok') ? <p className="mt-2 text-xs text-muted">Retention: {[...new Set(data.by_network.map((n) => n.retention.message))].join(' ')}</p> : null}
            </section>
            <Card aria-labelledby="h-topv">
              <CardHeader id="h-topv" title="Top videos" />
              <ul className="flex flex-col px-2 pb-3">
                {data.top_videos.map((r) => (
                  <li key={r.delivery_id}>
                    <ContentCard
                      href={`/analytics/content?${qs}${qs ? '&' : ''}open=${r.delivery_id}`}
                      thumb={<Thumb src={r.thumbnail.url} alt={r.thumbnail.alt} kind="video" provider={r.provider} className="size-12" />}
                      title={r.title || r.excerpt || 'Untitled'}
                      meta={<><PlatformIcon provider={r.provider} size="xs" decorative /><span className="truncate">{r.account} · {fmtDay(r.published_local.slice(0, 10))}</span></>}
                      trailing={r.primary ? <span className="text-right"><span className="block text-[14px] font-semibold tabular">{fmtMetric(r.primary.value)}</span><span className="block text-[11px] text-muted">{r.primary.label.toLowerCase()}</span></span> : null}
                    />
                  </li>
                ))}
              </ul>
            </Card>
          </div>
          <p className="mt-6 text-xs text-muted">{data.basis_label}. Views are counted differently by each network.</p>
        </>
      )}
    </div>
  );
}
