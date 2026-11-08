'use client';
// Review status in the composer + requested reviewers. Decisions happen on the review page (exact outgoing versions), by
// people the approval policy makes eligible. Requesting a reviewer only notifies them; it never grants approval rights.
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { ArrowRight, UserPlus } from 'lucide-react';
import { api } from '@/lib/client/api';
import { useApi } from '@/lib/client/use-api';
import { fmtRelative } from '@/lib/client/format';
import { Badge, Banner, Button, EmptyState, ErrorNotice, Input, Skeleton, ToneIcon, useToast } from '@/components/ui';
import { StageProgressList } from './stage-progress';
import { INELIGIBLE, type ReviewState } from './types';

interface Detail {
  id: string; decision: 'pending' | 'approved' | 'rejected' | 'invalidated'; reason: string | null; reviewer_email: string | null; decided_at: string | null;
  schedule: { revision_number: number }; review: ReviewState; can_decide: boolean; post_id: string;
}

const DECISION: Record<Detail['decision'], { label: string; tone: 'info' | 'success' | 'danger' | 'warn' }> = {
  pending: { label: 'Waiting for review', tone: 'info' }, approved: { label: 'Approved', tone: 'success' },
  rejected: { label: 'Changes requested', tone: 'danger' }, invalidated: { label: 'Reset — the post changed', tone: 'warn' },
};

export function ReviewPanel({ approvalId, approvalRequired, version, refreshKey = 0 }: { approvalId: string | null; approvalRequired: boolean; version: number; refreshKey?: number }) {
  const { data, error, loading, refetch } = useApi<Detail>(approvalId ? `/api/approvals/${approvalId}` : null);
  useEffect(() => { if (refreshKey && approvalId) void refetch(); }, [refreshKey, approvalId, refetch]);
  if (!approvalId) {
    return <EmptyState compact title={approvalRequired ? 'Not submitted yet' : 'No review needed'} />;
  }
  if (error && !data) return <ErrorNotice error={error} />;
  if (loading || !data) return <Skeleton className="h-32 w-full rounded-lg" />;
  const d = DECISION[data.decision];
  const r = data.review;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={d.tone}>{d.label}</Badge>
        <span className="text-xs text-muted">Revision r{data.schedule.revision_number} · draft v{version}</span>
      </div>
      {data.decision === 'rejected' && data.reason ? (
        <Banner tone="danger" icon={<ToneIcon tone="danger" />} title={`Changes requested${data.reviewer_email ? ` by ${data.reviewer_email}` : ''}`}>“{data.reason}”</Banner>
      ) : null}
      {data.decision === 'invalidated' ? <p className="text-xs text-muted">Edits after submission reset the review. Submit again when ready.</p> : null}
      <StageProgressList stages={r.stages} current={r.current_stage} />
      {data.decision === 'pending' && !data.can_decide && r.me.reason ? <p className="text-xs text-muted">{INELIGIBLE[r.me.reason] ?? 'Not your review'}</p> : null}
      {r.decisions.length ? (
        <ul className="flex flex-col gap-1 border-t border-border pt-3 text-xs" aria-label="Decisions">
          {r.decisions.map((x, i) => (
            <li key={i} className="flex items-center gap-2">
              <ToneIcon tone={x.decision === 'approved' ? 'success' : 'danger'} className="size-3.5" />
              <span className="min-w-0 flex-1 truncate">{x.by}{x.as_guest ? ' (client)' : ''}</span>
              <span className="text-subtle">{fmtRelative(x.at)}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {data.decision === 'pending' ? <RequestedReviewers approvalId={data.id} /> : null}
      <Link href={`/approvals/${data.id}`} className="inline-flex items-center gap-1 self-start text-[13px] font-medium text-[var(--accent-text)] underline-offset-2 hover:underline">
        {data.can_decide && data.decision === 'pending' ? 'Review and decide' : 'Open review'} <ArrowRight aria-hidden className="size-4" />
      </Link>
    </div>
  );
}

interface Requested { id: string; name: string | null; email: string; requested_at: string; decision: string | null }
interface Option { id: string; name: string | null; email: string; guest: boolean; requested: boolean }

/** Ask specific eligible people to review (they get a notification). */
export function RequestedReviewers({ approvalId, bare }: { approvalId: string; bare?: boolean }) {
  const toast = useToast();
  const { data, refetch } = useApi<{ items: Requested[]; can_request: boolean }>(`/api/approvals/${approvalId}/reviewers`);
  const [adding, setAdding] = useState(false);
  const [q, setQ] = useState('');
  const opts = useApi<{ items: Option[] }>(adding ? `/api/approvals/${approvalId}/reviewer-options?q=${encodeURIComponent(q)}` : null, { keepPrevious: true });
  if (!data) return null;
  return (
    <section aria-label="Requested reviewers" className={bare ? 'flex flex-col gap-2' : 'flex flex-col gap-2 border-t border-border pt-3'}>
      <div className="flex items-center justify-between gap-2">
        <h3 className={bare ? 'sr-only' : 'text-xs font-medium text-muted'}>Requested reviewers</h3>
        {bare ? <span className="text-xs text-muted">Asked to review</span> : null}
        {data.can_request ? <Button size="sm" variant="quiet" icon={<UserPlus aria-hidden className="size-4" />} onClick={() => setAdding((a) => !a)}>{adding ? 'Done' : 'Request'}</Button> : null}
      </div>
      {data.items.length ? (
        <ul className="flex flex-col gap-1 text-[13px]">
          {data.items.map((p) => (
            <li key={p.id} className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate">{p.name || p.email}</span>
              <span className="text-xs text-muted">{p.decision === 'approved' ? 'Approved' : p.decision === 'rejected' ? 'Requested changes' : 'Waiting'}</span>
            </li>
          ))}
        </ul>
      ) : <p className="text-xs text-muted">Nobody yet. Eligible reviewers are still notified.</p>}
      {adding ? (
        <div className="flex flex-col gap-1.5">
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search eligible reviewers" aria-label="Search eligible reviewers" />
          <ul className="flex max-h-48 flex-col overflow-y-auto">
            {(opts.data?.items ?? []).map((o) => (
              <li key={o.id}>
                <button type="button" disabled={o.requested} className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-[13px] hover:bg-raised disabled:opacity-60"
                  onClick={async () => {
                    try { await api.post(`/api/approvals/${approvalId}/reviewers`, { user_ids: [o.id] }); toast.success(`Asked ${o.name || o.email} to review`); await refetch(); await opts.refetch(); }
                    catch (e) { toast.error(e, 'Couldn’t request this reviewer'); }
                  }}>
                  <span className="min-w-0 flex-1 truncate">{o.name || o.email}<span className="ml-1 text-xs text-muted">{o.email}</span></span>
                  {o.guest ? <Badge tone="info">Client</Badge> : null}
                  {o.requested ? <span className="text-xs text-muted">Requested</span> : null}
                </button>
              </li>
            ))}
            {opts.data && !opts.data.items.length ? <li className="px-2 py-1.5 text-xs text-muted">No eligible reviewers match</li> : null}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

export function ActivityPanel({ postId, refreshKey = 0 }: { postId: string; refreshKey?: number }) {
  const { data, error, loading, refetch } = useApi<{ items: Array<{ id: string; label: string; actor: string; at: string; detail: string | null }>; next_cursor: string | null }>(`/api/posts/${postId}/activity`);
  const [extra, setExtra] = useState<NonNullable<typeof data>['items']>([]);
  const [next, setNext] = useState<string | null>(null);
  useEffect(() => { if (refreshKey) void refetch(); }, [refreshKey, refetch]);
  useEffect(() => { if (data) { setExtra([]); setNext(data.next_cursor); } }, [data]);
  if (error && !data) return <ErrorNotice error={error} />;
  if (loading || !data) return <Skeleton className="h-32 w-full rounded-lg" />;
  const items = [...data.items, ...extra];
  if (!items.length) return <EmptyState compact title="No activity yet" />;
  return (
    <div className="flex flex-col gap-2">
      <ol className="flex flex-col gap-2" aria-label="Activity">
        {items.map((a) => (
          <li key={a.id} className="flex gap-2 text-[13px]">
            <span aria-hidden className="mt-1.5 size-1.5 shrink-0 rounded-full bg-[var(--subtle)]" />
            <span className="min-w-0 flex-1"><span className="font-medium">{a.actor}</span> <span className="text-muted">{a.label.charAt(0).toLowerCase() + a.label.slice(1)}{a.detail ? ` · ${a.detail}` : ''}</span></span>
            <time dateTime={a.at} className="shrink-0 text-xs text-subtle">{fmtRelative(a.at)}</time>
          </li>
        ))}
      </ol>
      {next ? <Button size="sm" variant="ghost" className="self-center" onClick={async () => { const r = await api.get<NonNullable<typeof data>>(`/api/posts/${postId}/activity?cursor=${next}`); setExtra((l) => [...l, ...r.items]); setNext(r.next_cursor); }}>Load more</Button> : null}
    </div>
  );
}
