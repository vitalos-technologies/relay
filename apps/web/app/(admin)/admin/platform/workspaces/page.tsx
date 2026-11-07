'use client';
// Platform → Workspaces: searchable, filtered, paginated metadata (counts only; no names of posts, brands or files).
import Link from 'next/link';
import { useState } from 'react';
import { Search } from 'lucide-react';
import type { PlatformWorkspaceItem } from '@social-lite/core/contracts/v31-admin';
import { useApi } from '@/lib/client/use-api';
import { useQueryState } from '@/lib/client/hooks';
import { Badge, Button, Card, EmptyState, ErrorState, FilterBar, FilterSelect, Input, PageHeader, SkeletonRows } from '@/components/ui';
import { Ago, RecordList } from '@/components/admin/ui';
import { WsState } from '@/components/admin/badges';
import { useRouter } from 'next/navigation';

export default function PlatformWorkspacesPage() {
  const router = useRouter();
  const [params, setParams] = useQueryState();
  const [q, setQ] = useState(params.get('q') ?? '');
  const [cursors, setCursors] = useState<string[]>([]);
  const qs = new URLSearchParams(['q', 'state', 'demo'].flatMap((k) => (params.get(k) ? [[k, params.get(k)!]] : [])));
  const cursor = cursors[cursors.length - 1];
  if (cursor) qs.set('cursor', cursor);
  const { data, error, loading, refetch } = useApi<{ items: PlatformWorkspaceItem[]; next_cursor: string | null; total: number }>(`/api/platform/workspaces?${qs}`, { keepPrevious: true });
  return (
    <>
      <PageHeader title="Workspaces" meta={data ? `${data.total}` : undefined} />
      <FilterBar>
        <form role="search" className="relative min-w-[180px] flex-1" onSubmit={(e) => { e.preventDefault(); setCursors([]); setParams({ q: q.trim() || null }); }}>
          <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-subtle" />
          <Input aria-label="Search workspaces" placeholder="Search by name" value={q} onChange={(e) => setQ(e.target.value)} className="pl-9" />
        </form>
        <FilterSelect id="w-state" label="State" value={params.get('state') ?? ''} onChange={(v) => { setCursors([]); setParams({ state: v || null }); }}>
          <option value="">Any state</option><option value="active">Active</option><option value="suspended">Suspended</option>
        </FilterSelect>
        <FilterSelect id="w-demo" label="Type" value={params.get('demo') ?? ''} onChange={(v) => { setCursors([]); setParams({ demo: v || null }); }}>
          <option value="">Live and demo</option><option value="false">Live only</option><option value="true">Demo only</option>
        </FilterSelect>
      </FilterBar>
      {error && !data ? <ErrorState error={error} onRetry={refetch} /> : loading || !data ? <SkeletonRows rows={6} /> : !data.items.length ? <EmptyState title="No workspaces match" /> : (
        <Card className="overflow-hidden">
          <RecordList caption="Workspaces" rows={data.items} rowKey={(w) => w.id} onOpen={(w) => router.push(`/admin/platform/workspaces/${w.id}`)}
            columns={[
              { key: 'n', label: 'Workspace', cell: (w) => <Link href={`/admin/platform/workspaces/${w.id}`} onClick={(e) => e.stopPropagation()} className="font-medium hover:underline">{w.name}</Link> },
              { key: 's', label: 'State', cell: (w) => <WsState w={w} /> },
              { key: 'm', label: 'Members', cell: (w) => <span className="tabular">{w.members}</span> },
              { key: 'c', label: 'Accounts', secondary: true, cell: (w) => <span className="tabular">{w.connections}</span> },
              { key: 'sc', label: 'Scheduled', secondary: true, cell: (w) => <span className="tabular">{w.scheduled}</span> },
              { key: 'f', label: 'Failed · 7 d', cell: (w) => w.failed_7d ? <Badge tone="warn">{w.failed_7d}</Badge> : <span className="text-subtle">0</span> },
              { key: 'a', label: 'Last activity', cell: (w) => <Ago at={w.last_activity_at} className="text-muted" /> },
            ]}
            card={(w) => <span className="flex flex-col gap-1"><span className="flex items-center gap-2"><span className="min-w-0 flex-1 truncate font-medium">{w.name}</span><WsState w={w} /></span><span className="text-xs text-muted">{w.members} members · {w.connections} accounts · {w.failed_7d} failed · <Ago at={w.last_activity_at} /></span></span>} />
          <div className="flex justify-between gap-2 border-t border-border p-3">
            <Button size="sm" disabledReason={!cursors.length ? 'First page' : null} onClick={() => setCursors((c) => c.slice(0, -1))}>Previous</Button>
            <Button size="sm" disabledReason={!data.next_cursor ? 'Last page' : null} onClick={() => data.next_cursor && setCursors((c) => [...c, data.next_cursor!])}>Next</Button>
          </div>
        </Card>
      )}
    </>
  );
}
