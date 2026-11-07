'use client';
// Analytics → Audience (GET /api/analytics/audience): per-account breakdowns; small buckets folded by the server, never shown.
import { PROVIDER_LABEL } from '@social-lite/core';
import type { AudienceResponse } from '@social-lite/core/contracts/analytics';
import { useApi } from '@/lib/client/use-api';
import { BarList, Badge, EmptyState, ErrorState, IntegrationCard, PlatformIcon, SkeletonRows } from '@/components/ui';
import { AnalyticsFilters, DatasetNotice, fmtDay, useAnalyticsQuery } from '@/components/analytics/v3/shared';

const STATE: Record<AudienceResponse['accounts'][number]['state'], string> = {
  available: 'Available', below_threshold: 'Below privacy threshold', not_fetched: 'Not fetched yet', unsupported: 'Not provided by this network', permission_missing: 'Missing permission',
};

export default function AnalyticsAudiencePage() {
  const { qs } = useAnalyticsQuery();
  const { data, error, loading, refetch, refreshing } = useApi<AudienceResponse>(`/api/analytics/audience?${qs}`, { keepPrevious: true });
  const available = data?.accounts.filter((a) => a.state === 'available' && a.breakdowns.length) ?? [];
  const other = data?.accounts.filter((a) => !(a.state === 'available' && a.breakdowns.length)) ?? [];
  return (
    <div aria-busy={refreshing || undefined}>
      <AnalyticsFilters meta={data?.meta} showFormat={false} />
      <DatasetNotice meta={data?.meta} />
      {error && !data ? <ErrorState error={error} onRetry={refetch} /> : loading && !data ? <SkeletonRows rows={6} /> : !data?.accounts.length ? (
        <EmptyState title="No accounts in this scope" />
      ) : (
        <>
          {!available.length ? <EmptyState compact title="No audience breakdowns available" /> : (
            <ul className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              {available.map((a) => (
                <IntegrationCard as="li" key={a.connection_id} icon={<PlatformIcon provider={a.provider} size="md" />} name={a.display_name} detail={PROVIDER_LABEL[a.provider]}>
                  <div className="mt-4 flex flex-col gap-5">
                    {a.breakdowns.slice(0, 3).map((b) => (
                      <div key={`${b.metric_id}:${b.dimension_key}`}>
                        <p className="mb-2 flex justify-between text-xs text-muted"><span>{b.name}</span><span>as of {fmtDay(b.as_of_date)}</span></p>
                        <BarList label={b.name} unit="count" rows={b.buckets.slice(0, 6).map((k) => ({ key: k.key, value: k.value, label: <span className="truncate">{k.key} <span className="text-xs text-muted">{Math.round(k.share * 100)}%</span></span> }))} />
                        {b.suppressed ? <p className="mt-1.5 text-[11px] text-subtle">{b.suppressed.toLocaleString('en-GB')} in small groups (hidden for privacy)</p> : null}
                      </div>
                    ))}
                  </div>
                </IntegrationCard>
              ))}
            </ul>
          )}
          {other.length ? (
            <section aria-labelledby="h-noaud" className="mt-8">
              <h2 id="h-noaud" className="mb-3 text-[13px] font-medium text-muted">Without audience data</h2>
              <ul className="flex flex-wrap gap-2">
                {other.map((a) => (
                  <li key={a.connection_id} className="inline-flex items-center gap-2 rounded-full border border-border bg-surface py-1 pl-1 pr-3 text-xs" title={a.message}>
                    <PlatformIcon provider={a.provider} size="xs" decorative />{a.display_name}<Badge className="h-5 px-1.5 text-[11px]">{STATE[a.state]}</Badge>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </>
      )}
    </div>
  );
}
