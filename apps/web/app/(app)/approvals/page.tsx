'use client';
import Link from 'next/link';
import { useState } from 'react';
import { ArrowRight, CheckCheck } from 'lucide-react';
import { useSession } from '@/lib/client/session';
import { useApi } from '@/lib/client/use-api';
import { useQueryState } from '@/lib/client/hooks';
import { fmtRelative, postTitle } from '@/lib/client/format';
import type { ApprovalSummary } from '@/lib/client/types';
import {
  Badge, EmptyState, ErrorState, PageHeader, Pagination, PlatformStack, Segmented, SkeletonRows, TimeWithZone, ToneIcon,
} from '@/components/ui';

const DECISION: Record<string, { label: string; tone: 'info' | 'success' | 'danger' | 'neutral' }> = {
  pending: { label: 'Waiting', tone: 'info' },
  approved: { label: 'Approved', tone: 'success' },
  rejected: { label: 'Changes requested', tone: 'danger' },
  invalidated: { label: 'Superseded', tone: 'neutral' },
};

export default function ApprovalsPage() {
  const { session } = useSession();
  const [params, setParams] = useQueryState();
  const status = params.get('status') === 'decided' ? 'decided' : 'pending';
  const [cursors, setCursors] = useState<Array<string | null>>([null]);
  const cursor = cursors[cursors.length - 1];
  const brandFilter = params.get('brand') ?? '';
  const { data, error, loading, refetch } = useApi<{ items: ApprovalSummary[]; next_cursor?: string | null }>(
    `/api/approvals?status=${status}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
    { poll: status === 'pending' ? 30_000 : false },
  );
  const brandName = (a: ApprovalSummary) => a.brand?.name ?? a.brand_name ?? session.brands.find((b) => b.id === a.brand_id)?.name;
  const items = (data?.items ?? []).filter((a) => !brandFilter || (a.brand_id ?? a.brand?.id) === brandFilter || (!a.brand_id && !a.brand));

  return (
    <>
      <PageHeader
        title="Approvals"
        actions={
          <Segmented
            label="Approval status"
            value={status}
            onChange={(v) => { setCursors([null]); setParams({ status: v === 'pending' ? null : v }); }}
            options={[{ value: 'pending', label: 'Waiting' }, { value: 'decided', label: 'Decided' }]}
          />
        }
      />
      {error && !data ? <ErrorState error={error} onRetry={refetch} /> : loading ? <SkeletonRows rows={4} /> : !items.length ? (
        <EmptyState icon={<CheckCheck aria-hidden />} title={status === 'pending' ? 'All caught up' : 'No decisions yet'} />
      ) : (
        <>
          <ul className="flex flex-col divide-y divide-border rounded-xl border border-border bg-surface">
            {items.map((a) => {
              const d = DECISION[a.decision ?? 'pending'] ?? DECISION.pending!;
              const due = a.due_at ?? a.schedule?.due_at ?? null;
              const tz = a.schedule?.input_timezone ?? session.workspace?.timezone ?? 'Europe/London';
              const requested = a.requested_at ?? a.created_at;
              return (
                <li key={a.id}>
                  <Link href={`/approvals/${a.id}`} className="focus-inset flex items-center gap-4 px-4 py-4 hover:bg-raised/50">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{postTitle({ title: a.post_title ?? a.title, excerpt: a.excerpt })}</p>
                      <p className="mt-1 truncate text-xs text-muted">
                        {due ? <TimeWithZone instant={due} tz={tz} /> : 'On approval'}
                        {brandName(a) ? <> · {brandName(a)}</> : null}
                        {a.requested_by_email ? <> · {a.requested_by_email}</> : null}
                        {requested ? <> · {fmtRelative(requested)}</> : null}
                      </p>
                    </div>
                    {a.destinations?.length ? <span className="hidden sm:block"><PlatformStack providers={a.destinations.map((x) => x.provider)} size="sm" /></span> : null}
                    <Badge tone={d.tone} className="shrink-0" icon={<ToneIcon tone={d.tone === 'neutral' ? 'neutral' : d.tone} className="size-3.5" />}>{d.label}</Badge>
                    <ArrowRight aria-hidden className="hidden size-4 shrink-0 text-subtle sm:block" />
                  </Link>
                </li>
              );
            })}
          </ul>
          {data?.next_cursor || cursors.length > 1 ? (
            <Pagination
              page={cursors.length}
              hasPrev={cursors.length > 1}
              hasNext={!!data?.next_cursor}
              onPrev={() => setCursors((c) => c.slice(0, -1))}
              onNext={() => data?.next_cursor && setCursors((c) => [...c, data.next_cursor!])}
            />
          ) : null}
        </>
      )}
    </>
  );
}
