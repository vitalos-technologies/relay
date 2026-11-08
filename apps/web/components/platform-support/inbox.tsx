'use client';
// Platform → Support inbox (V4 SUP). Relay staff ↔ customers; separate from the customers' social inbox. Queues are views
// over status + assignee; counts come from the server. A content-free change feed triggers refetches.
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { Bell, Inbox, Lock, Search } from 'lucide-react';
import {
  SUPPORT_CATEGORY_LABEL, SUPPORT_PRIORITIES, SUPPORT_TICKET_CATEGORIES, type PlatformNotificationDto, type StaffTicketsResponse, type SupportPriority, type SupportQueue,
  type SupportTicketStatus,
} from '@social-lite/core/contracts/v4-support';
import { api } from '@/lib/client/api';
import { useApi } from '@/lib/client/use-api';
import { Badge, Button, Card, EmptyState, ErrorState, FilterSelect, Input, PageHeader, Popover, PopoverContent, PopoverTrigger, SkeletonRows, cn } from '@/components/ui';
import { Ago } from '@/components/admin/ui';

export const STAFF_STATUS: Record<SupportTicketStatus, { label: string; tone: 'info' | 'warn' | 'success' | 'neutral' }> = {
  new: { label: 'New', tone: 'info' },
  waiting_on_relay: { label: 'Waiting on Relay', tone: 'warn' },
  waiting_on_customer: { label: 'Waiting on customer', tone: 'neutral' },
  resolved: { label: 'Resolved', tone: 'success' },
  archived: { label: 'Archived', tone: 'neutral' },
};
export const PRIORITY_TONE: Record<SupportPriority, 'danger' | 'warn' | 'neutral'> = { urgent: 'danger', high: 'warn', normal: 'neutral', low: 'neutral' };

const QUEUES: Array<{ value: SupportQueue; label: string }> = [
  { value: 'unassigned', label: 'New and unassigned' },
  { value: 'mine', label: 'Assigned to me' },
  { value: 'waiting_on_relay', label: 'Waiting for Relay' },
  { value: 'waiting_on_customer', label: 'Waiting for customer' },
  { value: 'resolved', label: 'Resolved' },
  { value: 'archived', label: 'Archived' },
  { value: 'open', label: 'All open' },
];

/** Polls the staff change feed; calls `onChange` when anything changed. */
export function useStaffFeed(onChange: () => void, ms = 8000) {
  const cursor = useRef(0);
  const cb = useRef(onChange);
  useEffect(() => { cb.current = onChange; }, [onChange]);
  useEffect(() => {
    let stop = false;
    const tick = async () => {
      if (stop || document.hidden) return;
      try {
        const r = await api.get<{ items: unknown[]; cursor: number }>('/api/platform/support/events', { after: cursor.current });
        const changed = cursor.current > 0 && r.items.length > 0;
        cursor.current = r.cursor;
        if (changed) cb.current();
      } catch { /* show last data */ }
    };
    void tick();
    const t = setInterval(() => void tick(), ms);
    return () => { stop = true; clearInterval(t); };
  }, [ms]);
}

export function StaffNotifications() {
  const router = useRouter();
  const { data, refetch } = useApi<{ items: PlatformNotificationDto[]; unread_count: number }>('/api/platform/support/notifications', { poll: 30_000 });
  const n = data?.unread_count ?? 0;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" aria-label={`Support updates${n ? `, ${n} unread` : ''}`} className="touch-target relative inline-flex size-9 items-center justify-center rounded-lg border border-border hover:bg-raised">
          <Bell aria-hidden className="size-4" />
          {n ? <span className="absolute -right-1 -top-1 min-w-4 rounded-full bg-accent px-1 text-center text-[10px] font-semibold leading-4 text-on-accent">{n > 99 ? '99+' : n}</span> : null}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[min(360px,calc(100vw-32px))] p-0">
        <div className="flex items-center justify-between border-b border-border px-3 py-2">
          <p className="text-[13px] font-semibold">Updates</p>
          {n ? <Button size="sm" variant="ghost" onClick={async () => { await api.post('/api/platform/support/notifications/read-all', {}); await refetch(); }}>Mark all read</Button> : null}
        </div>
        {!data?.items.length ? <p className="px-3 py-6 text-center text-[13px] text-muted">Nothing new</p> : (
          <ul className="max-h-[60dvh] overflow-y-auto">
            {data.items.map((i) => (
              <li key={i.id}>
                <button type="button" className={cn('flex w-full items-start gap-2 px-3 py-2.5 text-left hover:bg-raised', !i.read_at && 'font-medium')}
                  onClick={async () => { await api.post(`/api/platform/support/notifications/${i.id}`, { read: true }).catch(() => undefined); void refetch(); if (i.url) router.push(i.url); }}>
                  <span aria-hidden className={cn('mt-1.5 size-2 shrink-0 rounded-full', i.read_at ? 'bg-transparent' : 'bg-accent')} />
                  <span className="min-w-0 flex-1"><span className="block truncate text-[13px]">{i.title}</span><span className="text-xs font-normal text-muted"><Ago at={i.created_at} /></span></span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </PopoverContent>
    </Popover>
  );
}

export function SupportInbox() {
  const params = useSearchParams();
  const router = useRouter();
  const queue = (params.get('queue') as SupportQueue | null) ?? 'unassigned';
  const category = params.get('category') ?? '';
  const priority = params.get('priority') ?? '';
  const [q, setQ] = useState(params.get('q') ?? '');
  const [query, setQuery] = useState(q);
  useEffect(() => { const t = setTimeout(() => setQuery(q.trim()), 300); return () => clearTimeout(t); }, [q]);
  const set = (k: string, v: string | null) => {
    const next = new URLSearchParams(params.toString());
    if (v) next.set(k, v); else next.delete(k);
    router.replace(`/admin/platform/support?${next.toString()}`, { scroll: false });
  };
  const path = `/api/platform/support/tickets?${new URLSearchParams({ queue, ...(category ? { category } : {}), ...(priority ? { priority } : {}), ...(query ? { q: query } : {}) }).toString()}`;
  const { data, error, loading, refetch } = useApi<StaffTicketsResponse>(path, { keepPrevious: true, poll: 60_000 });
  useStaffFeed(() => void refetch());
  return (
    <>
      <PageHeader title="Support" actions={<StaffNotifications />} />
      <nav aria-label="Queues" className="-mx-1 mb-4 flex gap-1.5 overflow-x-auto px-1 pb-1">
        {QUEUES.map((x) => (
          <button key={x.value} type="button" aria-pressed={queue === x.value} onClick={() => set('queue', x.value)}
            className={cn('touch-target inline-flex h-9 shrink-0 items-center gap-2 rounded-full border px-3 text-[13px]', queue === x.value ? 'border-[var(--accent)] bg-accent-soft font-medium' : 'border-border text-muted hover:bg-raised')}>
            {x.label}<span className="tabular text-xs text-subtle">{data?.counts[x.value] ?? ''}</span>
          </button>
        ))}
      </nav>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="relative min-w-0 flex-1 basis-[220px]">
          <Search aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-subtle" />
          <Input type="search" aria-label="Search tickets" placeholder="Search text, RLY-…, email or workspace" value={q} onChange={(e) => { setQ(e.target.value); }} onBlur={() => set('q', q.trim() || null)} className="h-9 pl-8" />
        </div>
        <FilterSelect id="sup-cat" label="Category" value={category} onChange={(v) => set('category', v || null)}>
          <option value="">All categories</option>
          {SUPPORT_TICKET_CATEGORIES.map((c) => <option key={c} value={c}>{SUPPORT_CATEGORY_LABEL[c]}</option>)}
        </FilterSelect>
        <FilterSelect id="sup-pri" label="Priority" value={priority} onChange={(v) => set('priority', v || null)}>
          <option value="">Any priority</option>
          {SUPPORT_PRIORITIES.map((p) => <option key={p} value={p}>{p[0]!.toUpperCase() + p.slice(1)}</option>)}
        </FilterSelect>
      </div>
      {error && !data ? <ErrorState error={error} onRetry={refetch} /> : loading && !data ? <SkeletonRows rows={6} /> : !data?.items.length ? (
        <EmptyState icon={<Inbox aria-hidden />} title={query ? 'No matches' : 'Nothing here'} />
      ) : (
        <Card as="div" className="overflow-hidden">
          <ul className="divide-y divide-border" data-testid="support-inbox">
            {data.items.map((t) => (
              <li key={t.id}>
                <Link href={`/admin/platform/support/${t.reference}`} className="flex min-h-[68px] items-start gap-3 px-4 py-3 hover:bg-raised/50">
                  <span className="min-w-0 flex-1">
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="truncate text-[14px] font-medium">{t.subject}</span>
                      {t.restricted ? <Lock aria-label="Restricted" className="size-3.5 shrink-0 text-subtle" /> : null}
                    </span>
                    <span className="mt-0.5 block truncate text-xs text-muted">
                      {t.reference} · {t.workspace?.name ?? (t.requester_kind === 'visitor' ? 'Visitor' : '—')} · {t.requester.name || t.requester.email || '—'} · {SUPPORT_CATEGORY_LABEL[t.category]}
                    </span>
                  </span>
                  <span className="flex shrink-0 flex-col items-end gap-1">
                    <span className="flex flex-wrap justify-end gap-1">
                      {t.priority === 'urgent' || t.priority === 'high' ? <Badge tone={PRIORITY_TONE[t.priority]}>{t.priority}</Badge> : null}
                      <Badge tone={STAFF_STATUS[t.status].tone}>{STAFF_STATUS[t.status].label}</Badge>
                    </span>
                    <span className="text-xs text-muted">{t.assignee ? (t.assignee.name ?? t.assignee.email).split(' ')[0] : 'Unassigned'} · <Ago at={t.updated_at} /></span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </>
  );
}
