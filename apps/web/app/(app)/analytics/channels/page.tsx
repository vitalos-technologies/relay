'use client';
// Analytics → Channels (GET /api/analytics/channels): one row per account with posts, followers (latest + observed
// change) and native metric totals; comparison only inside comparable groups.
import { PROVIDER_LABEL } from '@social-lite/core';
import { CHANNEL_TABLE_MEASURES, type ChannelsResponse, type ChannelTableMeasure } from '@social-lite/core/contracts/analytics';
import { useApi } from '@/lib/client/use-api';
import { BarList, Card, CardHeader, EmptyState, ErrorState, fmtMetric, PlatformIcon, SkeletonRows, Table, Td, Th, THead, Tr } from '@/components/ui';
import { AnalyticsFilters, DatasetNotice, HealthFooter, useAnalyticsQuery } from '@/components/analytics/v3/shared';

// Fix H6: the columns are measures from the API (engagements is a measure, not a metric family) — same totals as the
// comparison cards below.
const COLUMN_LABEL: Record<ChannelTableMeasure, string> = { engagements: 'Engagements', views: 'Views', impressions: 'Impressions', reach: 'Reach' };

export default function AnalyticsChannelsPage() {
  const { qs } = useAnalyticsQuery(['measure']);
  const { data, error, loading, refetch, refreshing } = useApi<ChannelsResponse>(`/api/analytics/channels?${qs}`, { keepPrevious: true });
  const measure = (r: ChannelsResponse['rows'][number], k: ChannelTableMeasure) => r.measures?.find((m) => m.measure === k);
  return (
    <div aria-busy={refreshing || undefined}>
      <AnalyticsFilters meta={data?.meta} showFormat={false} />
      <DatasetNotice meta={data?.meta} />
      {error && !data ? <ErrorState error={error} onRetry={refetch} /> : loading && !data ? <SkeletonRows rows={6} /> : !data?.rows.length ? (
        <EmptyState title="No accounts in this scope" />
      ) : (
        <>
          <p className="mb-2 text-xs text-muted">{data.basis_label}</p>
          <Table caption="Channels">
            <THead>
              <tr>
                <Th>Account</Th>
                <Th className="text-right">Posts</Th>
                <Th className="text-right">Followers</Th>
                <Th className="hidden text-right sm:table-cell">Change</Th>
                {CHANNEL_TABLE_MEASURES.map((k) => <Th key={k} className="hidden text-right lg:table-cell">{COLUMN_LABEL[k]}</Th>)}
              </tr>
            </THead>
            <tbody>
              {data.rows.map((r) => (
                <Tr key={r.connection_id}>
                  <Td className="min-w-[200px]">
                    <span className="flex min-w-0 items-center gap-2.5">
                      <PlatformIcon provider={r.provider} size="sm" />
                      <span className="min-w-0"><span className="block truncate font-medium">{r.display_name}</span><span className="block text-xs text-muted">{PROVIDER_LABEL[r.provider]}</span></span>
                    </span>
                  </Td>
                  <Td className="text-right tabular">{r.posts_published.toLocaleString('en-GB')}</Td>
                  <Td className="text-right tabular">{r.followers.latest === null ? <span className="text-muted">—</span> : fmtMetric(r.followers.latest)}</Td>
                  <Td className="hidden text-right tabular sm:table-cell">{r.followers.observed_change === null ? <span className="text-muted">—</span> : <span className={r.followers.observed_change > 0 ? 'text-success' : r.followers.observed_change < 0 ? 'text-danger' : 'text-muted'}>{r.followers.observed_change > 0 ? '+' : ''}{fmtMetric(r.followers.observed_change)}</span>}</Td>
                  {CHANNEL_TABLE_MEASURES.map((k) => { const m = measure(r, k); return <Td key={k} className="hidden text-right tabular lg:table-cell" data-measure={k}>{m && m.value !== null ? fmtMetric(m.value) : <span className="text-muted">—</span>}</Td>; })}
                </Tr>
              ))}
            </tbody>
          </Table>
          {data.comparison.groups.length ? (
            <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-2">
              {data.comparison.groups.map((g) => (
                <Card key={g.label}>
                  <CardHeader title={g.label} />
                  <div className="px-4 pb-4">
                    <BarList label={g.label} rows={g.rows.map((r) => ({ key: r.connection_id, value: r.value, label: <><PlatformIcon provider={r.provider} size="xs" decorative /><span className="truncate">{r.display_name}</span>{r.share !== null ? <span className="text-xs text-muted">{Math.round(r.share * 100)}%</span> : null}</> }))} />
                  </div>
                </Card>
              ))}
            </div>
          ) : null}
          {data.comparison.excluded.length ? <p className="mt-3 text-xs text-muted">Not comparable: {data.comparison.excluded.map((e) => `${e.display_name} (${PROVIDER_LABEL[e.provider]})`).join(', ')}</p> : null}
          <p className="mt-6 text-xs text-muted">— = not provided by that network, not fetched, or no data in the period. Reach adds up per-post unique counts.</p>
        </>
      )}
    </div>
  );
}
