'use client';
// Analytics → Content: sortable, paginated post table with thumbnails (GET /api/analytics/content) and a detail drawer
// (GET /api/analytics/content/:id) with source metrics, as-of history and an on-demand refresh for live posts.
import { useState } from 'react';
import { ExternalLink, RefreshCw } from 'lucide-react';
import { PROVIDER_LABEL } from '@social-lite/core';
import type { ContentDetailResponse, ContentSort, ContentTableResponse } from '@social-lite/core/contracts/analytics';
import { api } from '@/lib/client/api';
import { useApi } from '@/lib/client/use-api';
import {
  Badge, Button, DetailDrawer, DrawerSection, EmptyState, ErrorState, fmtMetric, LineChart, Pagination, PlatformIcon, SkeletonRows, SortTh,
  Table, Td, Th, THead, Thumb, Tr, useToast,
} from '@/components/ui';
import { AnalyticsFilters, DatasetNotice, fmtDay, HealthFooter, useAnalyticsQuery } from '@/components/analytics/v3/shared';

const COLS: Array<{ key: ContentSort; label: string }> = [
  { key: 'engagements', label: 'Engagements' },
  { key: 'engagement_rate', label: 'Eng. rate' },
  { key: 'views', label: 'Views' },
  { key: 'impressions', label: 'Impressions' },
];

export default function AnalyticsContentPage() {
  const { qs, params, setParams } = useAnalyticsQuery(['sort', 'dir', 'page']);
  const sort = (params.get('sort') as ContentSort | null) ?? 'published_at';
  const dir = (params.get('dir') as 'asc' | 'desc' | null) ?? 'desc';
  const page = Math.max(1, Number(params.get('page') ?? 1) || 1);
  const { data, error, loading, refetch, refreshing } = useApi<ContentTableResponse>(`/api/analytics/content?${qs}&page_size=25`, { keepPrevious: true });
  const open = params.get('open');

  const onSort = (k: ContentSort) => setParams({ sort: k, dir: sort === k && dir === 'desc' ? 'asc' : 'desc', page: null });
  const metric = (r: ContentTableResponse['rows'][number], k: ContentSort) => {
    if (k === 'engagements') return fmtMetric(r.engagements);
    if (k === 'engagement_rate') return fmtMetric(r.engagement_rate.value, 'percent');
    const m = r.metrics.find((x) => x.family === k || x.native_metric === k);
    return m ? fmtMetric(m.value) : '—';
  };

  return (
    <div aria-busy={refreshing || undefined}>
      <AnalyticsFilters meta={data?.meta} />
      <DatasetNotice meta={data?.meta} />
      {error && !data ? <ErrorState error={error} onRetry={refetch} /> : loading && !data ? <SkeletonRows rows={8} /> : !data?.rows.length ? (
        <EmptyState title="No published posts in this period" />
      ) : (
        <>
          <p className="mb-2 text-xs text-muted">{data.total.toLocaleString('en-GB')} posts · {data.basis_label}</p>
          <Table caption="Published content">
            <THead>
              <tr>
                <Th>Content</Th>
                <SortTh active={sort === 'published_at'} dir={dir} onSort={() => onSort('published_at')}>Published</SortTh>
                {COLS.map((c) => <SortTh key={c.key} align="right" className="hidden md:table-cell" active={sort === c.key} dir={dir} onSort={() => onSort(c.key)}>{c.label}</SortTh>)}
              </tr>
            </THead>
            <tbody>
              {data.rows.map((r) => (
                <Tr key={r.delivery_id} onClick={() => setParams({ open: r.delivery_id })} className="focus-within:bg-raised">
                  <Td className="min-w-[220px] max-w-[420px]">
                    <button type="button" className="flex w-full min-w-0 items-center gap-3 text-left" onClick={(e) => { e.stopPropagation(); setParams({ open: r.delivery_id }); }}>
                      <Thumb src={r.thumbnail.url} alt={r.thumbnail.alt} provider={r.provider} kind={r.format === 'video' || r.format === 'reel' ? 'video' : r.format === 'album' ? 'album' : null} className="size-10" />
                      <span className="min-w-0">
                        <span className="block truncate font-medium">{r.title || r.excerpt || 'Untitled'}</span>
                        <span className="flex items-center gap-1.5 truncate text-xs text-muted"><PlatformIcon provider={r.provider} size="xs" decorative className="size-4 rounded-[4px] [&>svg]:size-2.5" />{r.account}{r.campaign ? ` · ${r.campaign.name}` : ''}</span>
                      </span>
                    </button>
                  </Td>
                  <Td className="whitespace-nowrap tabular text-muted">{fmtDay(r.published_local.slice(0, 10))} {r.published_local.slice(11, 16)}</Td>
                  {COLS.map((c) => <Td key={c.key} className="hidden text-right tabular md:table-cell">{metric(r, c.key)}</Td>)}
                </Tr>
              ))}
            </tbody>
          </Table>
          <Pagination page={page} hasPrev={page > 1} hasNext={page * data.page_size < data.total} loading={refreshing}
            onPrev={() => setParams({ page: page - 1 > 1 ? String(page - 1) : null })} onNext={() => setParams({ page: String(page + 1) })} />
          <HealthFooter health={data.health} />
        </>
      )}
      <ContentDrawer id={open} tz={data?.meta.period.timezone} onClose={() => setParams({ open: null })} />
    </div>
  );
}

function ContentDrawer({ id, tz, onClose }: { id: string | null; tz?: string; onClose: () => void }) {
  const toast = useToast();
  const { data, error, loading, refetch } = useApi<ContentDetailResponse>(id ? `/api/analytics/content/${id}${tz ? `?tz=${encodeURIComponent(tz)}` : ''}` : null);
  const [busy, setBusy] = useState(false);
  const r = data?.row;
  const live = r && !r.synthetic && !r.simulated;
  const refresh = async () => {
    if (!id) return;
    setBusy(true);
    try {
      await api.post(`/api/analytics/${id}/refresh`, {});
      toast.success('Refresh requested');
      await refetch();
    } catch (e) {
      toast.error(e, 'Couldn’t refresh');
    } finally {
      setBusy(false);
    }
  };
  const hist = data?.history.find((h) => h.points.length > 1) ?? data?.history[0];
  return (
    <DetailDrawer
      open={!!id}
      onOpenChange={(o) => !o && onClose()}
      wide
      title={r ? (r.title || r.excerpt || 'Untitled') : 'Content'}
      meta={r ? <><PlatformIcon provider={r.provider} size="xs" decorative />{PROVIDER_LABEL[r.provider]} · {r.account} · {fmtDay(r.published_local.slice(0, 10), { day: 'numeric', month: 'short', year: 'numeric' })}
        {r.synthetic ? <Badge className="h-5 px-1.5 text-[11px]">Demo data</Badge> : r.simulated ? <Badge className="h-5 px-1.5 text-[11px]">Simulated</Badge> : null}</> : null}
      footer={r ? <>
        {r.provider_url ? <a className="inline-flex h-9 items-center gap-2 rounded-lg px-3 text-sm font-medium hover:bg-raised" href={r.provider_url} target="_blank" rel="noreferrer"><ExternalLink aria-hidden className="size-4" />Open on {PROVIDER_LABEL[r.provider]}</a> : null}
        {live ? <Button icon={<RefreshCw aria-hidden className="size-4" />} loading={busy} onClick={refresh}>Refresh</Button> : null}
      </> : null}
    >
      {error && !data ? <ErrorState error={error} onRetry={refetch} /> : loading || !data || !r ? <SkeletonRows rows={5} /> : (
        <>
          {data.media.length ? (
            <div className="mb-4 flex gap-2 overflow-x-auto">
              {data.media.slice(0, 4).map((m, i) => <Thumb key={i} src={m.thumb_url} alt={m.alt} kind={m.kind === 'video' ? 'video' : null} className="size-24 rounded-xl" />)}
            </div>
          ) : null}
          {data.caption ? <DrawerSection title="Caption"><p className="line-clamp-5 whitespace-pre-wrap text-[13px]">{data.caption}</p></DrawerSection> : null}
          <DrawerSection title="Metrics">
            <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3">
              {r.metrics.map((m) => (
                <div key={`${m.metric_id}:${m.dimension ?? ''}`} className="min-w-0">
                  <dt className="truncate text-xs text-muted" title={m.native_metric}>{m.name}{m.unique ? ' (unique)' : ''}</dt>
                  <dd className="text-[16px] font-semibold tabular">{m.value === null ? <span className="text-[13px] font-normal text-muted">{m.status_message ?? 'No data'}</span> : fmtMetric(m.value, m.unit, false)}</dd>
                </div>
              ))}
            </dl>
          </DrawerSection>
          {hist && hist.points.length > 1 ? (
            <DrawerSection title={`${hist.name} over time`}>
              <LineChart
                ariaLabel={`${hist.name}, lifetime total as observed on each date`}
                labels={hist.points.map((p) => p.as_of_date)}
                xLabel={(d) => fmtDay(d)}
                series={[{ key: 'h', label: hist.name, color: 'var(--chart-1)', values: hist.points.map((p) => p.value) }]}
                height={160}
              />
              <p className="mt-2 text-xs text-muted">{hist.basis_label}{data.corrections ? ` · ${data.corrections} later corrections` : ''}</p>
            </DrawerSection>
          ) : null}
        </>
      )}
    </DetailDrawer>
  );
}
