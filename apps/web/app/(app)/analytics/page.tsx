'use client';
import { useEffect, useState } from 'react';
import { ChartColumn } from 'lucide-react';
import { PROVIDERS, PROVIDER_LABEL } from '@social-lite/core';
import { useSession } from '@/lib/client/session';
import { useApi } from '@/lib/client/use-api';
import { useBrandFilter, useQueryState } from '@/lib/client/hooks';
import { Card, EmptyState, ErrorState, Field, InfoTip, PageHeader, Pagination, Select, SkeletonRows } from '@/components/ui';
import { AnalyticsRow, type AnalyticsItem } from '@/components/analytics/analytics-item';

export default function AnalyticsPage() {
  const { session, can } = useSession();
  const [brand] = useBrandFilter();
  const [params, setParams] = useQueryState();
  const provider = params.get('provider') ?? '';
  const tz = session.brands.find((b) => b.id === brand)?.timezone ?? session.workspace?.timezone ?? 'Europe/London';
  const [cursors, setCursors] = useState<Array<string | null>>([null]);
  const filterKey = `${brand}|${provider}`;
  useEffect(() => setCursors([null]), [filterKey]);
  const q = new URLSearchParams();
  if (brand) q.set('brand_id', brand);
  if (provider) q.set('provider', provider);
  const cursor = cursors[cursors.length - 1];
  if (cursor) q.set('cursor', cursor);
  q.set('limit', '20');
  const { data, error, loading, refetch, refreshing, setData } = useApi<{ items: AnalyticsItem[]; next_cursor: string | null }>(
    can('history.read') ? `/api/analytics?${q}` : null, { keepPrevious: true });

  if (!can('history.read')) return <><PageHeader title="Analytics" /><EmptyState icon={<ChartColumn aria-hidden />} title="No access" /></>;
  return (
    <>
      <PageHeader
        title="Analytics"
        meta={<span className="inline-flex items-center gap-1">Network-reported<InfoTip>Each network counts differently, so numbers are shown per post and never added up across networks. Refreshed daily; refresh a post at most every 15 minutes.</InfoTip></span>}
      />
      <div className="mb-6 grid max-w-xs grid-cols-1 gap-4">
        <Field label="Network">
          <Select value={provider} onChange={(e) => setParams({ provider: e.target.value })}>
            <option value="">All networks</option>
            {PROVIDERS.map((p) => <option key={p} value={p}>{PROVIDER_LABEL[p]}</option>)}
          </Select>
        </Field>
      </div>
      {error && !data ? <ErrorState error={error} onRetry={refetch} /> : loading ? <SkeletonRows rows={5} /> : !data?.items.length ? (
        <EmptyState icon={<ChartColumn aria-hidden />} title="No published posts yet" />
      ) : (
        <>
          {refreshing ? <p className="mb-2 text-xs text-subtle" role="status">Updating…</p> : null}
          <Card>
            <ul className="divide-y divide-border" aria-label="Published posts with metrics">
              {data.items.map((i) => (
                <AnalyticsRow key={i.delivery_id} item={i} tz={tz}
                  onUpdated={(n) => setData((prev) => ({ ...prev!, items: prev!.items.map((x) => (x.delivery_id === n.delivery_id ? n : x)) }))} />
              ))}
            </ul>
          </Card>
          <Pagination
            page={cursors.length}
            hasPrev={cursors.length > 1}
            hasNext={!!data.next_cursor}
            loading={refreshing}
            onPrev={() => setCursors((c) => c.slice(0, -1))}
            onNext={() => data.next_cursor && setCursors((c) => [...c, data.next_cursor!])}
          />
        </>
      )}
    </>
  );
}
