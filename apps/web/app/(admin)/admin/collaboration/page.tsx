'use client';
// Admin → Collaboration overview: overdue tasks, review backlog, work needing reassignment and notification delivery.
// Same services and permissions as the main app; no discussion text is shown here.
import Link from 'next/link';
import { useApi } from '@/lib/client/use-api';
import { Badge, Card, CardHeader, ErrorState, InfoTip, PageHeader, SkeletonRows } from '@/components/ui';
import { ChevronRight, CircleCheck, TriangleAlert } from 'lucide-react';
import { Ago } from '@/components/admin/ui';

/** Count tile with plain wording ("Needs attention" / "On track") instead of the system-health vocabulary. */
function StatTile({ label, state, value, detail, href }: { label: string; state: string; value: number; detail: string; href: string }) {
  const attention = state === 'degraded' || state === 'failed';
  const setup = state === 'awaiting_setup';
  return (
    <Link href={href} className="group flex min-h-[132px] min-w-0 flex-col rounded-[var(--radius-card)] border border-border bg-surface p-4 hover:border-[color-mix(in_srgb,var(--accent-text)_40%,var(--border))]">
      <div className="flex items-start justify-between gap-2">
        <span className="min-w-0 text-[13px] font-medium text-muted">{label}</span>
        <Badge tone={attention ? 'warn' : setup ? 'info' : 'success'} icon={attention ? <TriangleAlert aria-hidden className="size-3.5" /> : <CircleCheck aria-hidden className="size-3.5" />}>
          {attention ? 'Needs attention' : setup ? 'In-app only' : 'On track'}
        </Badge>
      </div>
      <span className="mt-3 text-[26px] font-semibold leading-none tabular">{value.toLocaleString()}</span>
      <span className="mt-auto flex items-center gap-1 pt-3 text-xs text-muted"><span className="min-w-0 flex-1 truncate">{detail}</span><ChevronRight aria-hidden className="size-3.5 shrink-0 text-subtle" /></span>
    </Link>
  );
}

interface Overview {
  tasks: { open: number; overdue: number; blocked: number; unassigned: number; reassign: number; due_soon: number };
  reviews: { pending: number; overdue: number; by_brand: Array<{ brand_id: string; brand: string; pending: number; overdue: number; unassigned: number; oldest_requested_at: string | null }> };
  overdue_tasks: Array<{ id: string; title: string; brand: string; assignee: string | null; due_at: string; status: string }>;
  reassignment: { tasks: number; reviews: number; posts: number };
  delivery: { window_days: number; created: number; emailed: number; pending: number; digest: number; failed: number; not_configured: number; skipped: number; email_configured: boolean } | null;
  can: { manage: boolean; reassign: boolean };
}

export default function AdminCollaborationPage() {
  const { data, error, loading, refetch } = useApi<Overview>('/api/admin/collaboration', { poll: 60_000 });
  return (
    <>
      <PageHeader title="Collaboration" meta={<InfoTip label="About this page">Counts come from the same tasks, reviews and notifications people use in Relay. Discussion text is never shown here.</InfoTip>} />
      {error && !data ? <ErrorState error={error} onRetry={refetch} /> : loading || !data ? <SkeletonRows rows={6} /> : (
        <div className="flex flex-col gap-6">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <StatTile label="Overdue tasks" state={data.tasks.overdue ? 'degraded' : 'healthy'} value={data.tasks.overdue} detail={`${data.tasks.open} open · ${data.tasks.due_soon} due in 2 days`} href="/tasks?view=team&due=overdue" />
            <StatTile label="Reviews waiting" state={data.reviews.overdue ? 'degraded' : 'healthy'} value={data.reviews.pending} detail={`${data.reviews.overdue} past their review date`} href="/admin/approvals" />
            <StatTile label="Needs a new owner" state={data.reassignment.tasks + data.reassignment.reviews + data.reassignment.posts ? 'degraded' : 'healthy'}
              value={data.reassignment.tasks + data.reassignment.reviews + data.reassignment.posts} detail={`${data.reassignment.tasks} tasks · ${data.reassignment.reviews} reviews · ${data.reassignment.posts} posts`} href="/admin/collaboration/reassign" />
            {data.delivery ? (
              <StatTile label="Email delivery (7 days)" state={data.delivery.failed ? 'failed' : !data.delivery.email_configured ? 'awaiting_setup' : 'healthy'}
                value={data.delivery.emailed} detail={data.delivery.email_configured ? `${data.delivery.failed} failed · ${data.delivery.pending} waiting` : 'Email not set up · in-app only'} href="/admin/collaboration/notifications" />
            ) : null}
          </div>
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <Card aria-labelledby="h-od">
              <CardHeader id="h-od" title="Overdue tasks" actions={<Link href="/tasks?view=team&due=overdue" className="text-[13px] text-[var(--accent-text)]">All</Link>} />
              <ul className="flex flex-col px-2 pb-2">
                {data.overdue_tasks.map((t) => (
                  <li key={t.id}>
                    <Link href={`/tasks?task=${t.id}&view=team`} className="flex flex-col gap-0.5 rounded-md px-2 py-2 hover:bg-raised">
                      <span className="truncate text-[13px] font-medium">{t.title}</span>
                      <span className="text-xs text-muted">{t.brand} · {t.assignee ?? 'Unassigned'} · due <Ago at={t.due_at} /></span>
                    </Link>
                  </li>
                ))}
                {!data.overdue_tasks.length ? <li className="px-2 py-3 text-[13px] text-muted">No overdue tasks</li> : null}
              </ul>
            </Card>
            <Card aria-labelledby="h-rb">
              <CardHeader id="h-rb" title="Review backlog" actions={<Link href="/admin/collaboration/settings#reviewers" className="text-[13px] text-[var(--accent-text)]">Eligible reviewers</Link>} />
              <ul className="flex flex-col px-2 pb-2">
                {data.reviews.by_brand.map((b) => (
                  <li key={b.brand_id} className="flex items-center gap-2 rounded-md px-2 py-2 text-[13px]">
                    <span className="min-w-0 flex-1 truncate font-medium">{b.brand}</span>
                    <span className="tabular text-muted">{b.pending} waiting</span>
                    {b.overdue ? <Badge tone="warn">{b.overdue} overdue</Badge> : null}
                    {b.unassigned ? <Badge tone="neutral">{b.unassigned} unassigned</Badge> : null}
                  </li>
                ))}
                {!data.reviews.by_brand.length ? <li className="px-2 py-3 text-[13px] text-muted">Nothing waiting for review</li> : null}
              </ul>
            </Card>
          </div>
          <p className="text-xs text-muted">Collaboration changes (comments, visibility changes, tasks, reviews, reassignments) are in the <Link className="underline" href="/admin/security/audit">audit log</Link>.</p>
        </div>
      )}
    </>
  );
}
