'use client';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { PROVIDER_LABEL, DELIVERY_STATE_LABEL } from '@social-lite/core';
import { fmtTime, postTitle, zoneAbbr } from '@/lib/client/format';
import type { PlannerItem } from '@/lib/client/types';
import { cn, PlatformIcon, PostStatusBadge } from '@/components/ui';

/** A scheduled post in list form: local time in the schedule's own zone, destinations and status. */
export function AgendaItem({ item, brandName, actions, href }: { item: PlannerItem; brandName?: string; actions?: ReactNode; href?: string }) {
  const due = new Date(item.due_at);
  const allMock = item.destinations.length > 0 && item.destinations.every((d) => d.is_mock);
  return (
    <div className="group flex items-center gap-3 rounded-xl border border-border bg-surface px-3 py-3 hover:border-border-strong sm:gap-4 sm:px-4">
      <div className="w-[64px] shrink-0 text-right tabular">
        <div className="text-[15px] font-semibold leading-tight">{fmtTime(due, item.input_timezone)}</div>
        <div className="text-[11px] text-muted" title={item.input_timezone}>{zoneAbbr(due, item.input_timezone)}</div>
      </div>
      <div className="h-9 w-px shrink-0 bg-border" aria-hidden />
      <div className="min-w-0 flex-1">
        <Link href={href ?? `/posts/${item.post_id}`} className="block truncate text-sm font-medium hover:underline">
          {postTitle(item)}
        </Link>
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
          {brandName ? <span className="truncate">{brandName}</span> : null}
          <DestinationDots destinations={item.destinations} />
        </div>
      </div>
      <PostStatusBadge status={item.status} simulated={allMock} className="hidden sm:inline-flex" />
      {actions}
    </div>
  );
}

const DOT: Record<string, string> = {
  published: 'bg-[var(--success)]', failed: 'bg-[var(--danger)]', expired: 'bg-[var(--danger)]',
  unknown: 'bg-[var(--warn)]', blocked: 'bg-[var(--warn)]', retry_wait: 'bg-[var(--warn)]',
};

/** Platform tiles with a tiny state marker; state is also in the accessible label (never colour alone). */
export function DestinationDots({ destinations, size = 'xs' }: { destinations: PlannerItem['destinations']; size?: 'xs' | 'sm' }) {
  return (
    <ul className="flex items-center gap-1" aria-label="Destinations">
      {destinations.map((d) => {
        const label = `${PROVIDER_LABEL[d.provider]}${d.is_mock ? ' (simulated)' : ''}: ${d.state === 'published' && d.is_mock ? 'Simulated · delivered' : DELIVERY_STATE_LABEL[d.state]}`;
        return (
          <li key={d.connection_id} className="relative" title={label}>
            <span className="sr-only">{label}</span>
            <PlatformIcon provider={d.provider} size={size} decorative />
            {DOT[d.state] ? <span aria-hidden className={cn('absolute -bottom-0.5 -right-0.5 size-2 rounded-full ring-2 ring-[var(--surface)]', DOT[d.state])} /> : null}
          </li>
        );
      })}
    </ul>
  );
}
