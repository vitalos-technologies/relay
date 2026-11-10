'use client';
// Platform → Billing → Subscriptions (operator / billing staff): every workspace's billing status, filtered. Metadata only.
import Link from 'next/link';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Search } from 'lucide-react';
import type { PlatformBillingListItem } from '@social-lite/core/contracts/v4-billing-dto';
import { useApi } from '@/lib/client/use-api';
import { humanize, plural } from '@/lib/client/format';
import { useQueryState } from '@/lib/client/hooks';
import { Badge, Card, EmptyState, ErrorState, FilterBar, FilterSelect, Input, PageHeader, SkeletonRows } from '@/components/ui';
import { RecordList } from '@/components/admin/ui';
import { ACCESS_TONE, STATUS_LABEL, STATUS_TONE, day } from '@/components/billing/format';

const STATUSES = ['attention', 'free', 'trialing', 'active', 'past_due', 'payment_action_required', 'incomplete', 'cancel_scheduled', 'cancelled', 'expired', 'legacy'] as const;

export default function PlatformBillingPage() {
  const router = useRouter();
  const [params, setParams] = useQueryState();
  const [q, setQ] = useState(params.get('q') ?? '');
  const qs = new URLSearchParams(['q', 'status'].flatMap((k) => (params.get(k) ? [[k, params.get(k)!]] : [])));
  const { data, error, loading, refetch } = useApi<{ items: PlatformBillingListItem[]; counts: Record<string, number> }>(`/api/platform/billing?${qs}`, { keepPrevious: true });
  const when = (w: PlatformBillingListItem) => w.status === 'free' ? 'No subscription' : w.status === 'trialing' ? `Trial ends ${day(w.trial_ends_at)}` : w.grace_ends_at ? `Grace ends ${day(w.grace_ends_at)}` : w.cancel_at ? `Ends ${day(w.cancel_at)}` : w.current_period_end ? `Renews ${day(w.current_period_end)}` : '—';
  return (
    <>
      <PageHeader title="Subscriptions" meta={data ? Object.entries(data.counts).map(([k, v]) => `${v} ${STATUS_LABEL[k]?.toLowerCase() ?? k}`).join(' · ') : undefined} />
      <FilterBar>
        <form role="search" className="relative min-w-[180px] flex-1" onSubmit={(e) => { e.preventDefault(); setParams({ q: q.trim() || null }); }}>
          <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-subtle" />
          <Input aria-label="Search workspaces" placeholder="Search by workspace" value={q} onChange={(e) => setQ(e.target.value)} className="pl-9" />
        </form>
        <FilterSelect id="b-status" label="Status" value={params.get('status') ?? ''} onChange={(v) => setParams({ status: v || null })}>
          <option value="">Any status</option>
          {STATUSES.map((s) => <option key={s} value={s}>{s === 'attention' ? 'Needs attention' : STATUS_LABEL[s]}</option>)}
        </FilterSelect>
      </FilterBar>
      {error && !data ? <ErrorState error={error} onRetry={refetch} /> : loading || !data ? <SkeletonRows rows={6} /> : !data.items.length ? <EmptyState title="Nothing matches" /> : (
        <Card className="overflow-hidden" data-testid="platform-billing-list">
          <RecordList caption="Subscriptions" rows={data.items} rowKey={(w) => w.workspace_id} onOpen={(w) => router.push(`/admin/platform/workspaces/${w.workspace_id}`)}
            columns={[
              { key: 'n', label: 'Workspace', cell: (w) => <Link href={`/admin/platform/workspaces/${w.workspace_id}`} onClick={(e) => e.stopPropagation()} className="font-medium hover:underline">{w.name}</Link> },
              { key: 'p', label: 'Plan', cell: (w) => <span className="capitalize">{w.plan_id ?? '—'}</span> },
              { key: 's', label: 'Status', cell: (w) => <Badge tone={STATUS_TONE[w.status]}>{STATUS_LABEL[w.status]}</Badge> },
              { key: 'a', label: 'Access', secondary: true, cell: (w) => <Badge tone={ACCESS_TONE[w.access]}>{humanize(w.access)}</Badge> },
              { key: 'seats', label: 'Seats', secondary: true, cell: (w) => <span className="tabular">{w.seats}</span> },
              { key: 'w', label: 'Next date', cell: (w) => <span className="text-muted">{when(w)}</span> },
            ]}
            card={(w) => <span className="flex flex-col gap-1"><span className="flex items-center gap-2"><span className="min-w-0 flex-1 truncate font-medium">{w.name}</span><Badge tone={STATUS_TONE[w.status]}>{STATUS_LABEL[w.status]}</Badge></span><span className="text-xs text-muted"><span className="capitalize">{w.plan_id}</span> · {plural(w.seats, 'seat')} · {when(w)}</span></span>} />
        </Card>
      )}
    </>
  );
}
