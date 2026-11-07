'use client';
// Workspace operations (V3.1 Admin §8, §17): emergency pause scopes (workspace / brand; connections on Social accounts),
// queue age vs dispatch delay vs processing (workload classes), workers, dead-lettered events with safe requeue, and
// read-only diagnostics. Pauses are enforced at dispatch time by the engine gate; in-flight sends are shown, not hidden.
import { useState } from 'react';
import { CircleCheck, OctagonX, Pause, Play, RefreshCw, RotateCcw } from 'lucide-react';
import { api } from '@/lib/client/api';
import { useApi } from '@/lib/client/use-api';
import { useSession } from '@/lib/client/session';
import type { DeadLetterItem } from '@social-lite/core/contracts/v31-admin';
import type { WorkloadResponse } from '@social-lite/core/contracts/v31-perf';
import { Badge, Banner, Button, Card, CardHeader, ErrorState, PageHeader, SkeletonRows, useToast } from '@/components/ui';
import { EmergencyPause } from '@/components/shell/emergency-pause';
import { useAdminTopics } from '@/components/admin/sync';
import { Ago, ReasonDialog } from '@/components/admin/ui';

interface Ops {
  dispatch_enabled: boolean; queue: { due_now: number; oldest_due_age_seconds: number }; outbox: { pending: number; dead: number; oldest_age_seconds: number };
  workers: Array<{ worker_id: string; last_seen_at: string; age_seconds: number; version: string | null; stopped: boolean }>;
  dispatch_lateness_seconds: { p50: number | null; p95: number | null; sample: number; target_p95: number };
  alerts: Array<{ severity: string; message: string }>;
}
const secs = (s: number | null | undefined) => (s === null || s === undefined ? '—' : s < 90 ? `${Math.round(s)} s` : s < 5400 ? `${Math.round(s / 60)} min` : `${Math.round(s / 3600)} h`);
const ms = (v: number | null) => (v === null ? '—' : v < 1000 ? `${v} ms` : `${(v / 1000).toFixed(1)} s`);

export default function AdminOperationsPage() {
  const { session, canOn, refresh } = useSession();
  const toast = useToast();
  const ops = useApi<Ops>('/api/ops');
  const work = useApi<WorkloadResponse>('/api/ops/workload');
  const dead = useApi<{ items: DeadLetterItem[] }>('/api/admin/dead-letters');
  const diag = useApi<{ checks: Array<{ name: string; ok: boolean; detail?: string | null }> }>('/api/diagnostics');
  const reload = () => Promise.all([ops.refetch(), work.refetch(), dead.refetch()]);
  useAdminTopics(['publishing', 'jobs', 'access'], reload);
  const [brandPause, setBrandPause] = useState<{ id: string; name: string; paused: boolean } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const requeue = async (id: string) => {
    setBusy(id);
    try { const r = await api.post<{ requeued: boolean }>(`/api/admin/dead-letters/${id}/requeue`, {}); toast.success(r.requeued ? 'Requeued' : 'Already requeued'); await dead.refetch(); }
    catch (e) { toast.error(e, 'Not requeued'); } finally { setBusy(null); }
  };

  return (
    <>
      <PageHeader title="Queues and workers" actions={<Button size="sm" icon={<RefreshCw aria-hidden className="size-4" />} loading={ops.refreshing || work.refreshing} onClick={() => void reload()}>Refresh</Button>} />
      <div className="flex flex-col gap-6">
        {ops.data && !ops.data.dispatch_enabled ? <Banner tone="danger" title="Dispatch is off for the installation — nothing is sending" /> : null}
        {ops.data?.alerts.filter((a) => !/Dispatch is disabled/.test(a.message)).map((a) => <Banner key={a.message} tone={a.severity === 'critical' ? 'danger' : 'warn'} title={a.message} />)}

        <Card aria-labelledby="h-pause">
          <CardHeader id="h-pause" title="Pause publishing" />
          <div className="flex flex-col gap-4 px-4 pb-4">
            <div className="max-w-[280px]"><EmergencyPause variant="sidebar" /></div>
            <ul className="divide-y divide-border rounded-lg border border-border">
              {session.brands.map((b) => {
                const may = canOn(b.id, b.publishing_paused ? 'publishing.resume' : 'publishing.pause');
                return (
                  <li key={b.id} className="flex flex-wrap items-center gap-3 px-3 py-2.5">
                    <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{b.name}</span>
                    {b.publishing_paused ? <Badge icon={<Pause aria-hidden className="size-3.5" />}>Paused</Badge> : <Badge tone="success">Publishing</Badge>}
                    <Button size="sm" variant={b.publishing_paused ? 'secondary' : 'ghost'} icon={b.publishing_paused ? <Play aria-hidden className="size-4" /> : <Pause aria-hidden className="size-4" />}
                      disabledReason={!may ? 'Not allowed for this brand' : null} onClick={() => setBrandPause({ id: b.id, name: b.name, paused: !b.publishing_paused })}>
                      {b.publishing_paused ? 'Resume' : 'Pause'}<span className="sr-only"> {b.name}</span>
                    </Button>
                  </li>
                );
              })}
            </ul>
            <p className="text-xs text-muted">Checked when each post is about to send. Posts already sending finish; provider-scheduled releases are cancelled at the provider where it supports it.</p>
          </div>
        </Card>

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <Card aria-labelledby="h-q">
            <CardHeader id="h-q" title="Publishing queue" />
            <div className="px-4 pb-4">
              {ops.error && !ops.data ? <ErrorState error={ops.error} onRetry={ops.refetch} /> : !ops.data ? <SkeletonRows rows={3} /> : (
                <dl className="grid grid-cols-2 gap-3 text-[13px]">
                  {[['Due now', ops.data.queue.due_now], ['Oldest due', secs(ops.data.queue.oldest_due_age_seconds)], ['Dispatch delay p95', `${secs(ops.data.dispatch_lateness_seconds.p95)} (n=${ops.data.dispatch_lateness_seconds.sample})`],
                    ['Outbox pending', ops.data.outbox.pending]].map(([k, v]) => <div key={k} className="rounded-lg bg-sunken p-3"><dt className="text-xs text-muted">{k}</dt><dd className="mt-1 text-[16px] font-semibold tabular">{v}</dd></div>)}
                </dl>
              )}
            </div>
          </Card>
          <Card aria-labelledby="h-w">
            <CardHeader id="h-w" title="Workers" />
            <ul className="divide-y divide-border px-4 pb-2">
              {!ops.data ? <SkeletonRows rows={2} /> : !ops.data.workers.some((w) => w.age_seconds < 900) ? <li className="py-3 text-[13px] text-muted">No worker seen in 15 min</li> : ops.data.workers.filter((w) => w.age_seconds < 900).map((w) => (
                <li key={w.worker_id} className="flex flex-wrap items-center gap-2 py-2.5 text-[13px]">
                  {w.age_seconds < 60 && !w.stopped ? <CircleCheck aria-hidden className="size-4 text-success" /> : <OctagonX aria-hidden className="size-4 text-danger" />}
                  <code className="min-w-0 flex-1 truncate text-[12px]">{w.worker_id}</code><span className="text-muted">{w.version ?? '—'}</span><span className="text-muted">{secs(w.age_seconds)} ago</span>
                </li>
              ))}
              {ops.data && ops.data.workers.some((w) => w.age_seconds >= 900) ? <li className="py-2 text-xs text-muted">{ops.data.workers.filter((w) => w.age_seconds >= 900).length} stopped earlier today</li> : null}
            </ul>
          </Card>
        </div>

        <Card aria-labelledby="h-wl" className="overflow-hidden">
          <CardHeader id="h-wl" title={`Workload · last ${work.data?.window_minutes ?? 60} min`} actions={work.data?.publishing_pressure.active ? <Badge tone="warn">Publishing pressure: bulk work deferred</Badge> : null} />
          {work.error && !work.data ? <div className="px-4 pb-4"><ErrorState error={work.error} onRetry={work.refetch} /></div> : !work.data ? <div className="px-4 pb-4"><SkeletonRows rows={4} /></div> : (
            <div className="relative overflow-x-auto">
              <table className="w-full min-w-[560px] text-[13px]">
                <caption className="sr-only">Workload classes</caption>
                <thead><tr className="border-b border-border text-left text-xs text-muted"><th scope="col" className="px-4 py-2 font-medium">Class</th><th scope="col" className="px-3 py-2 font-medium">Done</th><th scope="col" className="px-3 py-2 font-medium">Failed</th><th scope="col" className="px-3 py-2 font-medium">Delay p95</th><th scope="col" className="px-3 py-2 font-medium">Processing p95</th><th scope="col" className="px-3 py-2 font-medium">Provider p95</th></tr></thead>
                <tbody>
                  {work.data.classes.map((c) => (
                    <tr key={c.class} className="border-b border-border last:border-0">
                      <th scope="row" className="px-4 py-2 text-left font-medium">{c.class.replace(/_/g, ' ')}</th><td className="px-3 py-2 tabular">{c.finished}</td>
                      <td className="px-3 py-2 tabular">{c.failed || '—'}</td><td className="px-3 py-2 tabular">{ms(c.dispatch_delay.p95_ms)}</td><td className="px-3 py-2 tabular">{ms(c.processing.p95_ms)}</td><td className="px-3 py-2 tabular">{c.provider ? ms(c.provider.p95_ms) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="px-4 py-3 text-xs text-muted">Queues: {work.data.queues.map((q) => `${q.queue} ${q.waiting} waiting (oldest ${secs(q.oldest_age_seconds)})`).join(' · ')}</p>
            </div>
          )}
        </Card>

        <Card aria-labelledby="h-dl">
          <CardHeader id="h-dl" title="Dead-lettered events" />
          <div className="px-4 pb-4">
            {dead.error && !dead.data ? <ErrorState error={dead.error} onRetry={dead.refetch} /> : !dead.data ? <SkeletonRows rows={2} /> : !dead.data.items.length ? <p className="text-[13px] text-muted">None</p> : (
              <ul className="divide-y divide-border">
                {dead.data.items.map((d) => (
                  <li key={d.id} className="flex flex-wrap items-center gap-2 py-2.5 text-[13px]">
                    <code className="text-[12px]">{d.event_type}</code><span className="text-muted">{d.attempts} attempts</span><Ago at={d.created_at} className="text-xs text-muted" />
                    <span className="min-w-0 flex-1 truncate text-xs text-muted">{d.last_error}</span>
                    <Button size="sm" icon={<RotateCcw aria-hidden className="size-4" />} loading={busy === d.id} disabledReason={d.requeue_allowed ? null : d.reason} onClick={() => void requeue(d.id)}>Requeue</Button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Card>

        <Card aria-labelledby="h-diag">
          <CardHeader id="h-diag" title="Diagnostics" />
          <ul className="grid grid-cols-1 gap-x-6 px-4 pb-4 md:grid-cols-2">
            {!diag.data ? <SkeletonRows rows={3} /> : diag.data.checks.map((c) => (
              <li key={c.name} className="flex items-start gap-2 py-1.5 text-[13px]">
                {c.ok ? <CircleCheck aria-hidden className="mt-0.5 size-4 text-success" /> : <OctagonX aria-hidden className="mt-0.5 size-4 text-danger" />}
                <span className="min-w-0"><span className="font-medium">{c.name.replace(/_/g, ' ')}</span>{c.detail ? <span className="block break-words text-xs text-muted">{c.detail}</span> : null}</span>
              </li>
            ))}
          </ul>
        </Card>
      </div>
      <ReasonDialog open={!!brandPause} onOpenChange={(o) => !o && setBrandPause(null)} min={brandPause?.paused ? 3 : 0}
        title={brandPause ? `${brandPause.paused ? 'Pause' : 'Resume'} ${brandPause.name}?` : ''}
        description={brandPause?.paused ? 'Scheduled posts for this brand hold at send time until resumed. Past-deadline posts expire.' : 'Held posts that are still on time are queued again.'}
        confirmLabel={brandPause?.paused ? 'Pause brand' : 'Resume brand'} confirmVariant={brandPause?.paused ? 'danger' : 'primary'}
        onConfirm={async (reason) => { if (!brandPause) return; await api.post(`/api/brands/${brandPause.id}/pause`, { paused: brandPause.paused, reason: reason || null }); toast.success(brandPause.paused ? 'Brand paused' : 'Brand resumed'); await refresh(); }} />
    </>
  );
}
