'use client';
// Platform health (V3.1 Admin §4): installation-wide aggregates only — no customer content, credentials or post text.
import { duration } from '@/components/admin/ui';
import { useState } from 'react';
import { CircleCheck, OctagonX, Power, RefreshCw } from 'lucide-react';
import { PROVIDER_LABEL } from '@social-lite/core';
import type { PlatformOverview } from '@social-lite/core/contracts/v31-admin';
import { api } from '@/lib/client/api';
import { useApi } from '@/lib/client/use-api';
import { useSession } from '@/lib/client/session';
import { Badge, Banner, Button, Card, CardHeader, ErrorState, PageHeader, PlatformIcon, SkeletonRows, useToast } from '@/components/ui';
import { Ago, ReasonDialog } from '@/components/admin/ui';

const secs = (s: number) => duration(s);

export default function PlatformHealthPage() {
  const { session } = useSession();
  const toast = useToast();
  const { data, error, loading, refetch, refreshing } = useApi<PlatformOverview>('/api/platform/overview', { poll: 30_000 });
  const [dispatch, setDispatch] = useState(false);
  const operator = session.platform_role === 'operator';
  const stat = (label: string, value: number | string, sub?: string) => (
    <div className="rounded-[var(--radius-card)] border border-border bg-surface p-4"><span className="block text-[13px] text-muted">{label}</span><span className="mt-2 block text-[22px] font-semibold tabular">{value}</span>{sub ? <span className="mt-1 block text-xs text-muted">{sub}</span> : null}</div>
  );
  return (
    <>
      <PageHeader title="Platform health" meta={data ? <>Updated <Ago at={data.generated_at} /></> : undefined}
        actions={<>
          <Button size="sm" icon={<RefreshCw aria-hidden className="size-4" />} loading={refreshing} onClick={() => void refetch()}>Refresh</Button>
          {operator && data ? <Button size="sm" variant={data.dispatch_enabled ? 'danger' : 'primary'} icon={<Power aria-hidden className="size-4" />} onClick={() => setDispatch(true)}>{data.dispatch_enabled ? 'Stop dispatch' : 'Start dispatch'}</Button> : null}
        </>} />
      {error && !data ? <ErrorState error={error} onRetry={refetch} /> : loading || !data ? <SkeletonRows rows={6} /> : (
        <div className="flex flex-col gap-6">
          {data.alerts.map((a) => <Banner key={a.message} tone={a.severity === 'critical' ? 'danger' : 'warn'} title={a.message} />)}
          {!data.alerts.length ? <Banner tone="success" title="No platform alerts" /> : null}
          <section aria-label="Totals" className="grid grid-cols-2 gap-3 md:grid-cols-4">
            {stat('Workspaces', data.workspaces.active, `${data.workspaces.suspended} suspended · ${data.workspaces.demo} demo`)}
            {stat('Accounts', data.users.total, `${data.users.signed_in_24h} signed in · 24 h`)}
            {stat('Live results · 24 h', Object.values(data.deliveries_24h.live).reduce((a, b) => a + b, 0), `${data.deliveries_24h.live.published ?? 0} published · ${(data.deliveries_24h.live.failed ?? 0) + (data.deliveries_24h.live.unknown ?? 0)} failed/unknown`)}
            {stat('Support access', data.support.active, `${data.support.requested} waiting for approval`)}
          </section>
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <Card>
              <CardHeader title="Dispatch and workers" actions={data.dispatch_enabled ? <Badge tone="success">Dispatch on</Badge> : <Badge tone="danger">Dispatch off</Badge>} />
              <ul className="divide-y divide-border px-4 pb-2 text-[13px]">
                {data.workers.filter((w) => w.age_seconds < 900).map((w) => <li key={w.worker_id} className="flex items-center gap-2 py-2">{w.age_seconds < 60 && !w.stopped ? <CircleCheck aria-hidden className="size-4 text-success" /> : <OctagonX aria-hidden className="size-4 text-danger" />}<code className="min-w-0 flex-1 truncate text-[12px]">{w.worker_id}</code><span className="text-muted">{secs(w.age_seconds)} ago</span></li>)}
                {data.workers.some((w) => w.age_seconds >= 900) ? <li className="py-2 text-xs text-muted">{data.workers.filter((w) => w.age_seconds >= 900).length} stopped earlier today</li> : null}
              </ul>
            </Card>
            <Card>
              <CardHeader title="Queues" />
              <ul className="divide-y divide-border px-4 pb-2 text-[13px]">
                {data.queues.map((q) => <li key={q.queue} className="flex items-center gap-2 py-2"><span className="flex-1">{q.queue}</span><span className="tabular">{q.waiting} waiting</span><span className="text-muted">oldest {secs(q.oldest_age_seconds)}</span></li>)}
                <li className="flex items-center gap-2 py-2"><span className="flex-1">Outbox</span><span className="tabular">{data.outbox.pending} pending</span>{data.outbox.dead ? <Badge tone="warn">{data.outbox.dead} dead</Badge> : null}</li>
              </ul>
              {!data.jobs_visible ? <p className="px-4 pb-4 text-xs text-muted">Job queues (pg-boss) aren’t readable by the web role; deliveries and outbox shown.</p> : null}
            </Card>
          </div>
          <Card className="overflow-hidden">
            <CardHeader title="Networks" actions={<span className="text-xs text-muted">{data.analytics.succeeded_runs_24h} syncs ok · {data.analytics.failed_runs_24h} failed · {data.analytics.stale_connections} stale</span>} />
            <ul className="grid grid-cols-1 gap-x-6 px-4 pb-4 sm:grid-cols-2 lg:grid-cols-3">
              {data.connections.map((c) => {
                const circuit = data.circuits.find((x) => x.provider === c.provider);
                return (
                  <li key={c.provider} className="flex items-center gap-2 border-b border-border py-2 text-[13px]">
                    <PlatformIcon provider={c.provider} size="sm" /><span className="flex-1">{PROVIDER_LABEL[c.provider]}</span>
                    <span className="tabular text-muted">{c.total - c.simulated} live · {c.simulated} sim</span>
                    {c.problems ? <Badge tone="warn">{c.problems}</Badge> : null}{circuit?.state === 'open' ? <Badge tone="danger">Circuit open</Badge> : null}
                  </li>
                );
              })}
            </ul>
          </Card>
        </div>
      )}
      <ReasonDialog open={dispatch} onOpenChange={setDispatch} title={data?.dispatch_enabled ? 'Stop dispatch for every workspace?' : 'Start dispatch?'}
        description={data?.dispatch_enabled ? 'No new publication starts anywhere until dispatch is started again. Sends in progress finish.' : 'Due publications start again; past-deadline ones expire.'}
        confirmLabel={data?.dispatch_enabled ? 'Stop dispatch' : 'Start dispatch'} confirmVariant={data?.dispatch_enabled ? 'danger' : 'primary'}
        onConfirm={async (reason) => { await api.post('/api/platform/dispatch', { enabled: !data?.dispatch_enabled, reason }); toast.success('Saved'); await refetch(); }} />
    </>
  );
}
