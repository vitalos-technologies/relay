'use client';
// Analytics → Workflow (GET /api/analytics/workflow): app-owned operational facts — review turnaround, workload by team,
// schedule adherence and delivery reliability (live and simulated kept apart). No per-person scores.
import type { DistributionStat, WorkflowResponse } from '@social-lite/core/contracts/analytics';
import { useApi } from '@/lib/client/use-api';
import { Card, CardHeader, ErrorState, Facts, fmtMetric, MetricCard, SkeletonRows, Table, Td, Th, THead, Tr } from '@/components/ui';
import { AnalyticsFilters, useAnalyticsQuery } from '@/components/analytics/v3/shared';

const dur = (d: DistributionStat, v: number | null) => (v === null ? '—' : d.unit === 'hours' ? `${v < 10 ? v.toFixed(1) : Math.round(v)} h` : `${Math.round(v)} min`);
const pct = (r: number | null) => (r === null ? '—' : `${Math.round(r * 100)}%`);

export default function AnalyticsWorkflowPage() {
  const { qs } = useAnalyticsQuery();
  const { data, error, loading, refetch, refreshing } = useApi<WorkflowResponse>(`/api/analytics/workflow?${qs}`, { keepPrevious: true });
  return (
    <div aria-busy={refreshing || undefined}>
      <AnalyticsFilters meta={data?.meta} showFormat={false} />
      {error && !data ? <ErrorState error={error} onRetry={refetch} /> : loading && !data ? <SkeletonRows rows={6} /> : !data ? null : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4 lg:gap-4">
            <MetricCard label="Review turnaround" value={dur(data.review_turnaround, data.review_turnaround.median)} foot={`Median · p90 ${dur(data.review_turnaround, data.review_turnaround.p90)}`} />
            <MetricCard label="On time" value={pct(data.schedule_adherence.on_time_ratio)} foot={`Within ${data.schedule_adherence.tolerance_minutes} min · ${data.schedule_adherence.published} published`} />
            <MetricCard label="Delivered (live)" value={pct(data.delivery_reliability.live.ratio)} foot={`${data.delivery_reliability.live.published} published · ${data.delivery_reliability.live.failed} failed`} />
            <MetricCard label="In review now" value={data.workload.pending_reviews_now} foot={data.workload.overdue_now ? `${data.workload.overdue_now} overdue` : 'None overdue'} tone={data.workload.overdue_now ? 'warn' : null} />
          </div>
          <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-2">
            <Card>
              <CardHeader title="Workload" />
              <div className="px-4 pb-4">
                <Facts items={[['Created', fmtMetric(data.workload.created)], ['Submitted for review', fmtMetric(data.workload.submitted_for_review)], ['Scheduled', fmtMetric(data.workload.scheduled)], ['Published', fmtMetric(data.workload.published)]]} />
                {data.workload.by_team.length ? (
                  <Table caption="Workload by team" className="mt-4">
                    <THead><tr><Th>Team</Th><Th className="text-right">Created</Th><Th className="text-right">Published</Th><Th className="text-right">In review</Th></tr></THead>
                    <tbody>{data.workload.by_team.map((t) => <Tr key={t.team_id ?? 'none'}><Td>{t.team}</Td><Td className="text-right tabular">{t.created}</Td><Td className="text-right tabular">{t.published}</Td><Td className="text-right tabular">{t.pending_reviews}</Td></Tr>)}</tbody>
                  </Table>
                ) : null}
              </div>
            </Card>
            <Card>
              <CardHeader title="Delivery reliability" />
              <div className="px-4 pb-4">
                <Table caption="Delivery outcomes">
                  <THead><tr><Th>Destinations</Th><Th className="text-right">Published</Th><Th className="text-right">Failed</Th><Th className="text-right">Unknown</Th><Th className="text-right">Expired</Th></tr></THead>
                  <tbody>
                    {(['live', 'simulated'] as const).map((k) => {
                      const r = data.delivery_reliability[k];
                      return <Tr key={k}><Td>{k === 'live' ? 'Live networks' : 'Simulated'}</Td><Td className="text-right tabular">{r.published}</Td><Td className="text-right tabular">{r.failed}</Td><Td className="text-right tabular">{r.unknown}</Td><Td className="text-right tabular">{r.expired}</Td></Tr>;
                    })}
                  </tbody>
                </Table>
                {data.delivery_reliability.top_errors.length ? (
                  <p className="mt-3 text-xs text-muted">Top errors: {data.delivery_reliability.top_errors.slice(0, 4).map((e) => `${e.code} (${e.count})`).join(', ')}</p>
                ) : null}
              </div>
            </Card>
          </div>
          <p className="mt-6 text-xs text-muted">{data.note}</p>
        </>
      )}
    </div>
  );
}
