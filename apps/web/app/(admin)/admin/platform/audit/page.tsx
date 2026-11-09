'use client';
// Platform audit (append-only for the app's database roles): operator actions, support access, lifecycle, rollouts.
import { useState } from 'react';
import type { PlatformAuditItem } from '@social-lite/core/contracts/v31-admin';
import { useApi } from '@/lib/client/use-api';
import { humanize } from '@/lib/client/format';
import { useQueryState } from '@/lib/client/hooks';
import { Badge, Button, Card, DetailDrawer, DrawerSection, EmptyState, ErrorState, Facts, FilterBar, FilterSelect, PageHeader, SkeletonRows } from '@/components/ui';
import { Ago, RecordList } from '@/components/admin/ui';

const ACTIONS = ['workspace', 'support_access', 'feature_flag', 'dispatch', 'operator', 'account'];

export default function PlatformAuditPage() {
  const [params, setParams] = useQueryState();
  const [cursors, setCursors] = useState<string[]>([]);
  const qs = new URLSearchParams(['workspace_id', 'action'].flatMap((k) => (params.get(k) ? [[k, params.get(k)!]] : [])));
  if (cursors.length) qs.set('cursor', cursors[cursors.length - 1]!);
  const { data, error, loading, refetch } = useApi<{ items: PlatformAuditItem[]; next_cursor: string | null }>(`/api/platform/audit?${qs}`, { keepPrevious: true });
  const open = data?.items.find((a) => a.id === params.get('event')) ?? null;
  return (
    <>
      <PageHeader title="Platform audit" />
      <FilterBar>
        <FilterSelect id="a-action" label="Area" value={params.get('action') ?? ''} onChange={(v) => { setCursors([]); setParams({ action: v || null }); }}>
          <option value="">All areas</option>{ACTIONS.map((a) => <option key={a} value={a}>{humanize(a)}</option>)}
        </FilterSelect>
        {params.get('workspace_id') ? <Button size="sm" variant="ghost" onClick={() => setParams({ workspace_id: null })}>Clear workspace</Button> : null}
      </FilterBar>
      {error && !data ? <ErrorState error={error} onRetry={refetch} /> : loading || !data ? <SkeletonRows rows={6} /> : !data.items.length ? <EmptyState title="No events" /> : (
        <Card className="overflow-hidden">
          <RecordList caption="Platform audit" rows={data.items} rowKey={(a) => a.id} onOpen={(a) => setParams({ event: a.id })} selected={open?.id}
            columns={[
              { key: 'a', label: 'Action', cell: (a) => <code className="text-[12px]">{a.action}</code> },
              { key: 'w', label: 'Workspace', cell: (a) => <span className="block max-w-[200px] truncate">{a.workspace_name ?? '—'}</span> },
              { key: 'u', label: 'Actor', secondary: true, cell: (a) => <span className="text-muted">{a.actor ?? 'system'}</span> },
              { key: 'o', label: 'Outcome', cell: (a) => <Badge tone={a.outcome === 'success' ? 'success' : 'danger'}>{humanize(a.outcome)}</Badge> },
              { key: 't', label: 'When', cell: (a) => <Ago at={a.at} className="text-muted" /> },
            ]}
            card={(a) => <span className="flex flex-col gap-1"><code className="text-[12px]">{a.action}</code><span className="text-xs text-muted">{a.workspace_name ?? 'Installation'} · {a.actor ?? 'system'} · <Ago at={a.at} /></span></span>} />
          <div className="flex justify-between border-t border-border p-3">
            <Button size="sm" disabledReason={!cursors.length ? 'Newest' : null} onClick={() => setCursors((c) => c.slice(0, -1))}>Newer</Button>
            <Button size="sm" disabledReason={!data.next_cursor ? 'Oldest' : null} onClick={() => data.next_cursor && setCursors((c) => [...c, data.next_cursor!])}>Older</Button>
          </div>
        </Card>
      )}
      <DetailDrawer open={!!open} onOpenChange={(o) => !o && setParams({ event: null })} title={open?.action ?? ''}>
        {open ? (
          <>
            <DrawerSection title="Event"><Facts items={[['When', new Date(open.at).toLocaleString('en-GB')], ['Actor', open.actor ?? 'system'], ['Target', `${open.target_type}${open.target_id ? ` · ${open.target_id}` : ''}`],
              ['Workspace', open.workspace_name ?? '—'], ['Reason', open.reason ?? '—'], ['Outcome', humanize(open.outcome)], ['Reference', open.correlation_id ?? '—']]} /></DrawerSection>
            <DrawerSection title="Change"><pre className="overflow-x-auto whitespace-pre-wrap break-all rounded-lg bg-sunken p-3 text-[12px]">{JSON.stringify(open.diff, null, 2)}</pre></DrawerSection>
          </>
        ) : null}
      </DetailDrawer>
    </>
  );
}
