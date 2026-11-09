'use client';
import { ListTodo, MessageSquare } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { PROVIDER_LABEL, DELIVERY_STATE_LABEL } from '@social-lite/core';
import { fmtTime, postTitle, zoneAbbr } from '@/lib/client/format';
import type { PlannerItem } from '@/lib/client/types';
import { cn, PlatformIcon, PostStatusBadge, Thumb } from '@/components/ui';

/** A scheduled post in list form: local time in the schedule's own zone, destinations and status. */
export function AgendaItem({ item, brandName, actions, href, onOpen }: { item: PlannerItem; brandName?: string; actions?: ReactNode; href?: string; onOpen?: () => void }) {
  const due = new Date(item.due_at);
  const allMock = item.destinations.length > 0 && item.destinations.every((d) => d.is_mock);
  return (
    <div className="group flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-raised/60">
      <Thumb src={item.thumb_url} kind={item.media_kind} provider={item.destinations[0]?.provider} className="size-11" />
      <div className="w-12 shrink-0 tabular">
        <div className="text-sm font-semibold leading-tight">{fmtTime(due, item.input_timezone)}</div>
        <div className="text-[11px] text-subtle" title={item.input_timezone}>{zoneAbbr(due, item.input_timezone)}</div>
      </div>
      <div className="min-w-0 flex-1">
        {onOpen ? (
          <button type="button" onClick={onOpen} className="block max-w-full truncate text-left text-sm font-medium hover:underline">{postTitle(item)}</button>
        ) : (
          <Link href={href ?? `/posts/${item.post_id}`} className="block truncate text-sm font-medium hover:underline">
            {postTitle(item)}
          </Link>
        )}
        <div className="mt-1 flex min-w-0 items-center gap-2 text-xs text-muted">
          {brandName ? <span className="min-w-0 truncate">{brandName}</span> : null}
          <DestinationDots destinations={item.destinations} />
          <OwnerMeta item={item} />
        </div>
      </div>
      <span className="hidden shrink-0 sm:block"><PostStatusBadge status={item.status} simulated={allMock} overdue={item.overdue} size="sm" /></span>
      {actions}
    </div>
  );
}

/** Calendar ownership: team · assignee · review stage (text, never colour alone). */
export function OwnerMeta({ item }: { item: PlannerItem }) {
  const parts = [item.team?.name, item.assignee ? (item.assignee.name || item.assignee.email) : null,
    item.review && item.review.decision === 'pending' ? `Review ${item.review.stage_count > 1 ? `${item.review.stage}/${item.review.stage_count}` : 'pending'}` : null,
    item.campaign?.name].filter(Boolean);
  const unread = item.unread_threads ?? 0;
  const tasks = item.open_tasks ?? 0;
  if (!parts.length && !unread && !tasks) return null;
  return (
    <span className="flex min-w-0 items-center gap-2 text-subtle">
      {parts.length ? <span className="min-w-0 truncate">{parts.join(' · ')}</span> : null}
      {unread ? <span className="inline-flex shrink-0 items-center gap-0.5 font-medium text-fg" title={`${unread} unread discussion${unread === 1 ? '' : 's'}`}><MessageSquare aria-hidden className="size-3" />{unread}<span className="sr-only"> unread discussion{unread === 1 ? '' : 's'}</span></span> : null}
      {tasks ? <span className="inline-flex shrink-0 items-center gap-0.5" title={`${tasks} open task${tasks === 1 ? '' : 's'}`}><ListTodo aria-hidden className="size-3" />{tasks}<span className="sr-only"> open task{tasks === 1 ? '' : 's'}</span></span> : null}
    </span>
  );
}

const DOT: Record<string, string> = {
  published: 'bg-[var(--success)]', failed: 'bg-[var(--danger)]', expired: 'bg-[var(--danger)]',
  unknown: 'bg-[var(--warn)]', blocked: 'bg-[var(--warn)]', retry_wait: 'bg-[var(--warn)]', handoff: 'bg-[var(--warn)]',
};

/** Platform tiles with a tiny state marker; state is also in the accessible label (never colour alone). */
export function DestinationDots({ destinations, size = 'xs' }: { destinations: PlannerItem['destinations']; size?: 'xs' | 'sm' }) {
  return (
    <ul className="flex shrink-0 items-center gap-1" aria-label="Destinations">
      {destinations.map((d) => {
        const label = `${PROVIDER_LABEL[d.provider]}${d.is_mock ? ' (simulated)' : ''}: ${d.overdue ? 'Overdue' : d.state === 'published' && d.is_mock ? 'Simulated · delivered' : DELIVERY_STATE_LABEL[d.state] ?? 'Not scheduled yet'}`;
        return (
          <li key={d.connection_id} className="relative" title={label}>
            <span className="sr-only">{label}</span>
            <PlatformIcon provider={d.provider} size={size} decorative />
            {(d.overdue ? DOT.retry_wait : DOT[d.state]) ? <span aria-hidden className={cn('absolute -bottom-0.5 -right-0.5 size-2 rounded-full ring-2 ring-[var(--surface)]', d.overdue ? DOT.retry_wait : DOT[d.state])} /> : null}
          </li>
        );
      })}
    </ul>
  );
}
