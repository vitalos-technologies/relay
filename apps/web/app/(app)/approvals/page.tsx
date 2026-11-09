'use client';
import { useAreaHref } from '@/lib/client/hooks';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { ArrowRight, CheckCheck, ChevronDown, ChevronRight } from 'lucide-react';
import { useSession } from '@/lib/client/session';
import { useApi } from '@/lib/client/use-api';
import { useQueryState } from '@/lib/client/hooks';
import { fmtRelative, postTitle } from '@/lib/client/format';
import type { ApprovalDetail, Asset } from '@/lib/client/types';
import {
  Badge, EmptyState, ErrorState, IconButton, PageHeader, PlatformStack, Segmented, Skeleton, SkeletonRows, TimeWithZone, ToneIcon,
} from '@/components/ui';
import { VariantPreview } from '@/components/composer/preview';
import type { InboxItem } from '@/components/collab/types';

const DECISION: Record<string, { label: string; tone: 'info' | 'success' | 'danger' | 'neutral' }> = {
  pending: { label: 'Waiting', tone: 'info' },
  approved: { label: 'Approved', tone: 'success' },
  rejected: { label: 'Changes requested', tone: 'danger' },
  invalidated: { label: 'Superseded', tone: 'neutral' },
};

type GroupBy = 'due' | 'brand' | 'assignee';

function dueBucket(iso: string | null, now = Date.now()): string {
  if (!iso) return 'No date';
  const t = new Date(iso).getTime();
  const day = 86_400_000;
  const startOfToday = new Date(); startOfToday.setHours(0, 0, 0, 0);
  if (t < now) return 'Overdue';
  if (t < startOfToday.getTime() + day) return 'Today';
  if (t < startOfToday.getTime() + 7 * day) return 'This week';
  return 'Later';
}
const DUE_ORDER = ['Overdue', 'Today', 'This week', 'Later', 'No date'];

export default function ApprovalsPage() {
  const { session } = useSession();
  const [params, setParams] = useQueryState();
  const status = params.get('status') === 'decided' ? 'decided' : 'pending';
  const group = (['due', 'brand', 'assignee'].includes(params.get('group') ?? '') ? params.get('group') : 'due') as GroupBy;
  const mine = params.get('mine') === '1';
  const brandFilter = params.get('brand') ?? '';
  const { data, error, loading, refetch } = useApi<{ items: InboxItem[] }>(`/api/approvals?status=${status}${brandFilter ? `&brand_id=${brandFilter}` : ''}`,
    { poll: status === 'pending' ? 30_000 : false });
  const [open, setOpen] = useState<string | null>(null);

  const items = (data?.items ?? []).filter((a) => !mine || a.can_decide || a.assignee?.id === session.user.id);
  const groups = useMemo(() => {
    const m = new Map<string, InboxItem[]>();
    for (const a of items) {
      const k = group === 'brand' ? a.brand_name : group === 'assignee' ? (a.assignee ? (a.assignee.id === session.user.id ? 'You' : a.assignee.name || a.assignee.email || 'Someone') : 'Unassigned')
        : dueBucket(a.review_due_at ?? a.due_at);
      m.set(k, [...(m.get(k) ?? []), a]);
    }
    const keys = [...m.keys()].sort((x, y) => group === 'due' ? DUE_ORDER.indexOf(x) - DUE_ORDER.indexOf(y) : x === 'You' ? -1 : y === 'You' ? 1 : x.localeCompare(y));
    return keys.map((k) => ({ key: k, items: m.get(k)! }));
  }, [items, group, session.user.id]);
  const myTurn = (data?.items ?? []).filter((a) => a.can_decide).length;

  return (
    <>
      <PageHeader
        title="Approvals"
        meta={status === 'pending' && myTurn ? <span>{myTurn} waiting for you</span> : undefined}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Segmented label="Approval status" size="sm" value={status} onChange={(v) => setParams({ status: v === 'pending' ? null : v })}
              options={[{ value: 'pending', label: 'Waiting' }, { value: 'decided', label: 'Decided' }]} />
            <Segmented label="Group by" size="sm" value={group} onChange={(v) => setParams({ group: v === 'due' ? null : v })}
              options={[{ value: 'due', label: 'Due' }, { value: 'brand', label: 'Brand' }, { value: 'assignee', label: 'Assignee' }]} />
            <Segmented label="Whose" size="sm" value={mine ? 'mine' : 'all'} onChange={(v) => setParams({ mine: v === 'mine' ? '1' : null })}
              options={[{ value: 'all', label: 'All' }, { value: 'mine', label: 'Mine' }]} />
          </div>
        }
      />
      {error && !data ? <ErrorState error={error} onRetry={refetch} /> : loading ? <SkeletonRows rows={4} /> : !items.length ? (
        <EmptyState icon={<CheckCheck aria-hidden />} title={status === 'pending' ? 'All caught up' : 'No decisions yet'} />
      ) : (
        <div className="flex flex-col gap-6">
          {groups.map((g) => (
            <section key={g.key} aria-labelledby={`g-${g.key}`}>
              <h2 id={`g-${g.key}`} className="mb-2 flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted">
                {g.key}<span className="tabular font-normal text-subtle">{g.items.length}</span>
              </h2>
              <ul className="flex flex-col divide-y divide-border rounded-xl border border-border bg-surface">
                {g.items.map((a) => <InboxRow key={a.id} a={a} tz={a.input_timezone ?? session.workspace?.timezone ?? 'UTC'} expanded={open === a.id} onToggle={() => setOpen(open === a.id ? null : a.id)} />)}
              </ul>
            </section>
          ))}
        </div>
      )}
    </>
  );
}

function InboxRow({ a, tz, expanded, onToggle }: { a: InboxItem; tz: string; expanded: boolean; onToggle: () => void }) {
  const area = useAreaHref();
  const d = DECISION[a.decision] ?? DECISION.pending!;
  const reviewDue = a.review_due_at;
  return (
    <li>
      <div className="flex items-center gap-2 px-2 py-3 sm:gap-3 sm:px-3">
        <IconButton size="sm" label={expanded ? 'Hide preview' : 'Preview what will be sent'} aria-expanded={expanded}
          icon={expanded ? <ChevronDown aria-hidden className="size-4" /> : <ChevronRight aria-hidden className="size-4" />} onClick={onToggle} />
        <Link href={area(`/approvals/${a.id}`, `/admin/approvals/${a.id}`)} className="focus-inset flex min-w-0 flex-1 items-center gap-3 rounded-md py-1 hover:bg-raised/50">
          <div className="min-w-0 flex-1">
            <p className="flex items-center gap-2 text-sm font-medium">
              <span className="truncate">{postTitle({ title: a.title, excerpt: a.excerpt })}</span>
              {a.can_decide ? <Badge tone="info" className="shrink-0">Your turn</Badge> : null}
            </p>
            <p className="mt-1 truncate text-xs text-muted">
              {a.due_at ? <TimeWithZone instant={a.due_at} tz={tz} /> : 'On approval'}
              {' · '}{a.brand_name}
              {a.campaign_name ? <> · {a.campaign_name}</> : null}
              {a.assignee ? <> · {a.assignee.name || a.assignee.email}</> : null}
              {reviewDue ? <> · review by <TimeWithZone instant={reviewDue} tz={tz} /></> : null}
              {a.requested_by_email ? <> · {a.requested_by_email} {fmtRelative(a.requested_at)}</> : null}
            </p>
          </div>
          {a.decision === 'pending' && a.stage.count > 0 ? (
            <span className="hidden shrink-0 text-xs text-muted md:block" title={a.stage.name ?? undefined}>
              {a.stage.count > 1 ? `Stage ${a.stage.current}/${a.stage.count} · ` : ''}{a.stage.approvals ?? 0}/{a.stage.quorum ?? 1}
            </span>
          ) : null}
          {a.destinations.length ? <span className="hidden sm:block"><PlatformStack providers={a.destinations.map((x) => x.provider)} size="sm" /></span> : null}
          {/* Waiting rows sit under the Waiting filter; the badge would only repeat it. */}
          {a.decision !== 'pending' ? <Badge tone={d.tone} className="shrink-0" icon={<ToneIcon tone={d.tone === 'neutral' ? 'neutral' : d.tone} className="size-3.5" />}>{d.label}</Badge> : null}
          <ArrowRight aria-hidden className="hidden size-4 shrink-0 text-subtle sm:block" />
        </Link>
      </div>
      {expanded ? <InlinePreview id={a.id} /> : null}
    </li>
  );
}

/** Exact outgoing variants of the submitted revision (what each destination will receive). */
function InlinePreview({ id }: { id: string }) {
  const { data, error } = useApi<ApprovalDetail>(`/api/approvals/${id}`);
  if (error) return <p className="px-4 pb-4 text-xs text-danger">Couldn’t load the preview.</p>;
  if (!data) return <div className="px-4 pb-4"><Skeleton className="h-40 w-full rounded-lg" /></div>;
  const assets = new Map<string, Asset>(data.variants.flatMap((v) => v.assets.map((x) => [x.id, x] as [string, Asset])));
  return (
    <div className="grid grid-cols-1 gap-3 border-t border-border bg-sunken/40 p-3 sm:grid-cols-2 xl:grid-cols-3">
      {data.variants.map((v) => <div key={v.connectionId} className="min-w-0"><VariantPreview variant={v} connection={v.connection} assets={assets} /></div>)}
    </div>
  );
}
