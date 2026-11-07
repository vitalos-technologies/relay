'use client';
// Content and media administration (V3.1 Admin §10): import/export/writeback/report/bulk/media job history with safe
// errors, storage use and trash. Recovery stays where the record lives (Content hub item, Trash, report export), so
// linked-document vs snapshot rules and asset-reference checks are never bypassed from here.
import Link from 'next/link';
import { RefreshCw } from 'lucide-react';
import { useApi } from '@/lib/client/use-api';
import { useQueryState } from '@/lib/client/hooks';
import { fmtBytes } from '@/lib/client/format';
import { Badge, Button, Card, CardHeader, EmptyState, ErrorState, FilterBar, FilterSelect, PageHeader, SkeletonRows } from '@/components/ui';
import { useAdminTopics } from '@/components/admin/sync';
import { Ago, RecordList } from '@/components/admin/ui';
import type { AdminJob, JobKind } from '@social-lite/services/admin/reads';

const KIND: Record<JobKind, string> = { import: 'Import', export: 'Export', writeback: 'Writeback', report: 'Report', bulk: 'Bulk change', media: 'Media' };
const WHERE: Record<JobKind, { href: string; label: string }> = {
  import: { href: '/library?tab=sources', label: 'Content hub' }, export: { href: '/library?tab=sources', label: 'Content hub' },
  writeback: { href: '/library?tab=sources', label: 'Content hub' }, report: { href: '/analytics', label: 'Analytics' },
  bulk: { href: '/history', label: 'History' }, media: { href: '/library', label: 'Library' },
};

export default function AdminContentPage() {
  const [params, setParams] = useQueryState();
  const kind = params.get('kind') ?? '';
  const status = params.get('status') ?? '';
  const qs = new URLSearchParams(Object.entries({ kind, status }).filter(([, v]) => v)).toString();
  const { data, error, loading, refetch, refreshing } = useApi<{ items: AdminJob[]; kinds: JobKind[]; storage: { bytes: number; assets: number; trashed_assets: number; trashed_posts: number; held: number } | null }>(`/api/admin/jobs${qs ? `?${qs}` : ''}`, { keepPrevious: true });
  useAdminTopics(['jobs', 'content'], refetch);
  return (
    <>
      <PageHeader title="Jobs and storage" actions={<Button size="sm" icon={<RefreshCw aria-hidden className="size-4" />} loading={refreshing} onClick={() => void refetch()}>Refresh</Button>} />
      {data?.storage ? (
        <section aria-label="Storage" className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4">
          {[['Media stored', fmtBytes(data.storage.bytes), `${data.storage.assets} files`, '/library'],
            ['Files in trash', String(data.storage.trashed_assets), data.storage.held ? `${data.storage.held} kept (in use)` : 'Purged after retention', '/trash?kind=asset'],
            ['Posts in trash', String(data.storage.trashed_posts), 'Restorable until purge', '/trash?kind=post'],
          ].map(([l, v, d, h]) => (
            <Link key={l} href={h!} className="rounded-[var(--radius-card)] border border-border bg-surface p-4 hover:border-border-strong">
              <span className="block text-[13px] text-muted">{l}</span>
              <span className="mt-2 block text-[22px] font-semibold tabular">{v}</span>
              <span className="mt-1 block truncate text-xs text-muted">{d}</span>
            </Link>
          ))}
        </section>
      ) : null}
      <FilterBar>
        <FilterSelect id="j-kind" label="Kind" value={kind} onChange={(v) => setParams({ kind: v || null })}>
          <option value="">All kinds</option>{(data?.kinds ?? []).map((k) => <option key={k} value={k}>{KIND[k]}</option>)}
        </FilterSelect>
        <FilterSelect id="j-status" label="Status" value={status} onChange={(v) => setParams({ status: v || null })}>
          <option value="">Any status</option><option value="failed">Failed</option><option value="running">Queued or running</option>
        </FilterSelect>
      </FilterBar>
      {error && !data ? <ErrorState error={error} onRetry={refetch} /> : loading ? <SkeletonRows rows={6} /> : !data?.items.length ? <EmptyState title={status === 'failed' ? 'No failures' : 'No jobs yet'} /> : (
        <Card className="overflow-hidden">
          <CardHeader title={`${data.items.length} recent`} />
          <RecordList caption="Jobs" rows={data.items} rowKey={(j) => `${j.kind}-${j.id}`}
            columns={[
              { key: 'k', label: 'Kind', cell: (j) => <span className="whitespace-nowrap">{KIND[j.kind]}</span> },
              { key: 't', label: 'Item', cell: (j) => <span className="block max-w-[260px] truncate">{j.title}</span> },
              { key: 's', label: 'Status', cell: (j) => <Badge tone={j.failed ? 'danger' : ['completed', 'ready', 'written', 'succeeded'].includes(j.status) ? 'success' : 'neutral'}>{j.status.replace(/_/g, ' ')}</Badge> },
              { key: 'e', label: 'Error', secondary: true, cell: (j) => <span className="block max-w-[280px] truncate text-xs text-muted" title={j.error ?? ''}>{j.error ?? '—'}</span> },
              { key: 'by', label: 'By', secondary: true, cell: (j) => <span className="text-muted">{j.by ?? 'system'}</span> },
              { key: 'at', label: 'Started', cell: (j) => <Ago at={j.created_at} className="text-muted" /> },
              { key: 'go', label: <span className="sr-only">Open</span>, cell: (j) => <Link className="text-[13px] font-medium text-accent-text hover:underline" href={WHERE[j.kind].href}>{WHERE[j.kind].label}</Link> },
            ]}
            card={(j) => (
              <span className="flex flex-col gap-1">
                <span className="flex items-center gap-2"><span className="min-w-0 flex-1 truncate font-medium">{j.title}</span><Badge tone={j.failed ? 'danger' : 'neutral'}>{j.status.replace(/_/g, ' ')}</Badge></span>
                <span className="text-xs text-muted">{KIND[j.kind]} · <Ago at={j.created_at} />{j.error ? ` · ${j.error}` : ''}</span>
                <Link className="text-[13px] font-medium text-accent-text" href={WHERE[j.kind].href}>Open in {WHERE[j.kind].label}</Link>
              </span>
            )} />
        </Card>
      )}
    </>
  );
}
