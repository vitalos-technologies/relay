'use client';
// Analytics ingestion (V3.1 Admin §11): OPERATIONAL analytics only — per-account sync state per stream, last success,
// failures, backfill progress and a throttled resync request (the worker calls providers; this page never does).
// Product analytics stay in Analytics. Missing ≠ zero: no successful sync shows "—", never 0.
import Link from 'next/link';
import { useState } from 'react';
import { RefreshCw } from 'lucide-react';
import type { Provider } from '@social-lite/core';
import { api } from '@/lib/client/api';
import { useApi } from '@/lib/client/use-api';
import { Badge, Button, Card, CardHeader, EmptyState, ErrorState, PageHeader, PlatformIcon, SkeletonRows, useToast } from '@/components/ui';
import { useAdminTopics } from '@/components/admin/sync';
import { Ago, RecordList } from '@/components/admin/ui';
import type { IngestionRow } from '@social-lite/services/admin/reads';

interface Ops {
  generated_at: string; accounts: IngestionRow[];
  failed_runs: Array<{ id: string; display_name: string; stream: string; error_code: string | null; error_message: string | null; started_at: string; trigger: string }>;
  backfills: Array<{ connection_id: string; display_name: string; status: string; items_planned: number | null; items_processed: number; started_at: string; finished_at: string | null }>;
}

export default function AdminAnalyticsPage() {
  const toast = useToast();
  const { data, error, loading, refetch, refreshing } = useApi<Ops>('/api/admin/analytics');
  useAdminTopics(['jobs', 'connections'], refetch);
  const [busy, setBusy] = useState<string | null>(null);
  const resync = async (id: string) => {
    setBusy(id);
    try { await api.post('/api/analytics/sync', { connection_id: id }); toast.success('Sync requested'); await refetch(); } catch (e) { toast.error(e, 'Couldn’t request a sync'); } finally { setBusy(null); }
  };
  const live = data?.accounts.filter((a) => a.dataset === 'live') ?? [];
  return (
    <>
      <PageHeader title="Analytics ingestion" meta={data ? <>Updated <Ago at={data.generated_at} /></> : undefined}
        actions={<><Link href="/analytics" className="text-[13px] font-medium text-accent-text hover:underline">Open Analytics</Link><Button size="sm" icon={<RefreshCw aria-hidden className="size-4" />} loading={refreshing} onClick={() => void refetch()}>Refresh</Button></>} />
      {error && !data ? <ErrorState error={error} onRetry={refetch} /> : loading || !data ? <SkeletonRows rows={6} /> : (
        <div className="flex flex-col gap-6">
          <section aria-label="Coverage" className="grid grid-cols-2 gap-3 md:grid-cols-4">
            {[['Live accounts', live.length], ['Stale (48 h)', live.filter((a) => a.stale).length], ['Failed runs · 7 days', data.failed_runs.length], ['Simulated', data.accounts.length - live.length]].map(([l, v]) => (
              <div key={l} className="rounded-[var(--radius-card)] border border-border bg-surface p-4"><span className="block text-[13px] text-muted">{l}</span><span className="mt-2 block text-[22px] font-semibold tabular">{v}</span></div>
            ))}
          </section>
          <Card className="overflow-hidden">
            <CardHeader title="Accounts" />
            {!data.accounts.length ? <EmptyState compact title="No accounts" /> : (
              <RecordList caption="Analytics sync by account" rows={data.accounts} rowKey={(a) => a.connection_id}
                columns={[
                  { key: 'a', label: 'Account', cell: (a) => <span className="flex items-center gap-2"><PlatformIcon provider={a.provider as Provider} size="sm" /><span className="min-w-0"><span className="block max-w-[200px] truncate">{a.display_name}</span><span className="block truncate text-xs text-muted">{a.brand_name}</span></span></span> },
                  { key: 'd', label: 'Data', cell: (a) => <Badge tone={a.dataset === 'live' ? 'info' : 'neutral'}>{a.dataset === 'live' ? 'Live' : 'Simulated'}</Badge> },
                  { key: 's', label: 'Streams', secondary: true, cell: (a) => <span className="flex flex-wrap gap-1">{a.stream_states.length ? a.stream_states.map((s) => <Badge key={s.stream} tone={s.status === 'active' || s.status === 'idle' ? 'success' : s.stop_reason ? 'neutral' : 'warn'}>{s.stream.replace(/_/g, ' ')} · {s.stop_reason ?? s.status}</Badge>) : <span className="text-muted">Not started</span>}</span> },
                  { key: 'ok', label: 'Last success', cell: (a) => { const t = a.stream_states.map((s) => s.last_success_at).filter(Boolean).sort().pop(); return <span className="inline-flex items-center gap-1"><Ago at={t ?? null} className="text-muted" />{a.stale && a.dataset === 'live' ? <Badge tone="warn">Stale</Badge> : null}</span>; } },
                  { key: 'r', label: 'Last run', secondary: true, cell: (a) => a.last_run ? <span className="text-xs text-muted">{a.last_run.status} · {a.last_run.trigger}{a.last_run.error_code ? ` · ${a.last_run.error_code}` : ''}</span> : <span className="text-muted">—</span> },
                  { key: 'x', label: <span className="sr-only">Action</span>, cell: (a) => <Button size="sm" variant="ghost" loading={busy === a.connection_id} disabledReason={a.dataset !== 'live' ? 'Simulated data isn’t synced' : null} onClick={() => void resync(a.connection_id)}>Resync</Button> },
                ]}
                card={(a) => (
                  <span className="flex flex-col gap-1">
                    <span className="flex items-center gap-2"><PlatformIcon provider={a.provider as Provider} size="sm" /><span className="min-w-0 flex-1 truncate font-medium">{a.display_name}</span><Badge tone={a.dataset === 'live' ? 'info' : 'neutral'}>{a.dataset === 'live' ? 'Live' : 'Simulated'}</Badge></span>
                    <span className="text-xs text-muted">{a.last_run ? `${a.last_run.status} · ` : ''}{a.stale && a.dataset === 'live' ? 'Stale' : ''}</span>
                  </span>
                )} />
            )}
          </Card>
          <Card>
            <CardHeader title="Failed runs · 7 days" />
            {!data.failed_runs.length ? <p className="px-4 pb-4 text-[13px] text-muted">None</p> : (
              <ul className="divide-y divide-border px-4 pb-2 text-[13px]">
                {data.failed_runs.map((f) => <li key={f.id} className="flex flex-wrap gap-x-3 py-2"><span className="font-medium">{f.display_name}</span><span className="text-muted">{f.stream}</span><code className="text-[12px]">{f.error_code ?? 'error'}</code><span className="min-w-0 flex-1 truncate text-muted">{f.error_message}</span><Ago at={f.started_at} className="text-xs text-muted" /></li>)}
              </ul>
            )}
          </Card>
          <Card>
            <CardHeader title="Backfills" />
            {!data.backfills.length ? <p className="px-4 pb-4 text-[13px] text-muted">None</p> : (
              <ul className="divide-y divide-border px-4 pb-2 text-[13px]">
                {data.backfills.map((b, i) => (
                  <li key={i} className="flex flex-wrap items-center gap-x-3 py-2"><span className="font-medium">{b.display_name}</span><Badge>{b.status}</Badge>
                    <span className="tabular text-muted">{b.items_processed}{b.items_planned ? ` / ${b.items_planned}` : ''} items</span><Ago at={b.started_at} className="ml-auto text-xs text-muted" /></li>
                ))}
              </ul>
            )}
          </Card>
          <Definitions />
          <p className="text-xs text-muted">Report and export history: <Link href="/admin/content?kind=report" className="text-accent-text hover:underline">Jobs</Link>.</p>
        </div>
      )}
    </>
  );
}

interface MetricDef { metric_id: string; provider: string; name: string; description: string; unit: string; aggregation: string; time_basis: string; availability: string; unique: boolean; provider_delay_hours: number | null }

function Definitions() {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const { data, error, refetch } = useApi<{ items: MetricDef[] }>(open ? '/api/analytics/metrics' : null);
  const rows = (data?.items ?? []).filter((m) => !q || `${m.name} ${m.provider} ${m.metric_id}`.toLowerCase().includes(q.toLowerCase()));
  return (
    <Card>
      <CardHeader title="Metric definitions" actions={<Button size="sm" aria-expanded={open} onClick={() => setOpen((o) => !o)}>{open ? 'Hide' : 'Show'}</Button>} />
      {open ? (
        <div className="px-4 pb-4">
          {error ? <ErrorState error={error} onRetry={refetch} /> : !data ? <SkeletonRows rows={3} /> : (
            <>
              <input aria-label="Filter metrics" placeholder="Filter" value={q} onChange={(e) => setQ(e.target.value)} className="mb-3 h-9 w-full rounded-lg border border-border bg-surface px-3 text-[13px]" />
              <ul className="max-h-[420px] divide-y divide-border overflow-y-auto text-[13px]">
                {rows.slice(0, 200).map((m) => (
                  <li key={m.metric_id} className="py-2">
                    <p className="flex flex-wrap items-center gap-2"><span className="font-medium">{m.name}</span><span className="text-muted">{m.provider}</span>
                      <Badge tone={m.availability === 'available' ? 'success' : 'neutral'}>{m.availability.replace(/_/g, ' ')}</Badge>{m.unique ? <Badge>Unique · not additive</Badge> : null}</p>
                    <p className="mt-0.5 text-xs text-muted">{m.description} · {m.aggregation}, {m.time_basis}{m.provider_delay_hours ? `, ~${m.provider_delay_hours} h delay` : ''}</p>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      ) : null}
    </Card>
  );
}
