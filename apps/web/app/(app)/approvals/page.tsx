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
  pending: { label: 'Waiting for review', tone: 'info' },
  approved: { label: 'Approved', tone: 'success' },
  rejected: { label: 'Changes requested', tone: 'danger' },
  invalidated: { label: 'Superseded', tone: 'neutral' },
};

export default function ApprovalsPage() {
  const { session, can } = useSession();
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
        description={can('approvals.decide') ? 'Review the exact content each destination will receive, then approve or request changes.' : 'Posts waiting for review. Approvers and admins can decide.'}
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
        <EmptyState icon={<CheckCheck aria-hidden />} title={status === 'pending' ? 'Nothing waiting for review' : 'No decisions yet'}>
          {status === 'pending' ? 'When someone submits a post for review, it appears here.' : 'Approved and rejected posts will be listed here.'}
        </EmptyState>
      ) : (
        <>
          <ul className="flex flex-col gap-2">
            {items.map((a) => {
              const d = DECISION[a.decision ?? 'pending'] ?? DECISION.pending!;
              const due = a.due_at ?? a.schedule?.due_at ?? null;
              const tz = a.schedule?.input_timezone ?? session.workspace?.timezone ?? 'Europe/London';
              const requested = a.requested_at ?? a.created_at;
              return (
                <li key={a.id}>
                  <Link href={`/approvals/${a.id}`} className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-border bg-surface px-4 py-3.5 hover:border-border-strong">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{postTitle({ title: a.post_title ?? a.title, excerpt: a.excerpt })}</p>
                      <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-muted">
                        {brandName(a) ? <span>{brandName(a)}</span> : null}
                        {a.requested_by_email ? <span>· by {a.requested_by_email}</span> : null}
                        {requested ? <span>· {fmtRelative(requested)}</span> : null}
                      </p>
                    </div>
                    {a.destinations?.length ? <PlatformStack providers={a.destinations.map((x) => x.provider)} size="sm" /> : null}
                    <div className="text-right text-xs">
                      <span className="block text-muted">{due ? 'Publishes' : 'Publishes on approval'}</span>
                      {due ? <TimeWithZone instant={due} tz={tz} /> : null}
                    </div>
                    <Badge tone={d.tone} icon={<ToneIcon tone={d.tone === 'neutral' ? 'neutral' : d.tone} className="size-3.5" />}>{d.label}</Badge>
                    <ArrowRight aria-hidden className="size-4 text-muted" />
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
