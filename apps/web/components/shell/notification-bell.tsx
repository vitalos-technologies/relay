'use client';
import Link from 'next/link';
import { useState } from 'react';
import { Bell, CheckCheck } from 'lucide-react';
import { api } from '@/lib/client/api';
import { useApi } from '@/lib/client/use-api';
import { fmtRelative } from '@/lib/client/format';
import type { AppNotification } from '@/lib/client/types';
import { Button, cn, ErrorState, Popover, PopoverContent, PopoverTrigger, Spinner, ToneIcon, useToast } from '@/components/ui';

function hrefFor(n: AppNotification): string | null {
  if (n.url && n.url.startsWith('/') && !n.url.startsWith('//')) return n.url;
  switch (n.reference_type) {
    case 'post': return n.reference_id ? `/posts/${n.reference_id}` : null;
    case 'approval': return n.reference_id ? `/approvals/${n.reference_id}` : null;
    case 'review': return n.reference_id ? `/review/${n.reference_id}` : null; // guest portal; the page re-checks the share
    case 'connection': return '/accounts';
    case 'delivery': return '/history';
    default: return null;
  }
}

export function NotificationBell() {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const { data, error, loading, refetch, setData } = useApi<{ items: AppNotification[]; unread_count: number }>('/api/notifications', { poll: 60_000 });
  const unread = data?.unread_count ?? 0;

  const markRead = async (n: AppNotification) => {
    if (n.read_at) return;
    setData((d) => d ? { items: d.items.map((x) => (x.id === n.id ? { ...x, read_at: new Date().toISOString() } : x)), unread_count: Math.max(0, d.unread_count - 1) } : d!);
    try {
      await api.post(`/api/notifications/${n.id}/read`, {});
    } catch {
      void refetch();
    }
  };
  const readAll = async () => {
    try {
      await api.post('/api/notifications/read-all', {});
      await refetch();
    } catch (e) {
      toast.error(e, 'Could not mark notifications as read');
    }
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={unread ? `Notifications, ${unread} unread` : 'Notifications'}
          className="touch-target relative inline-flex size-9 items-center justify-center rounded-lg text-muted hover:bg-raised hover:text-fg"
        >
          <Bell aria-hidden className="size-[18px]" />
          {unread ? (
            <span aria-hidden className="absolute right-1 top-1 min-w-4 rounded-full bg-[var(--text)] px-1 text-center text-[10px] font-semibold leading-4 text-bg tabular">
              {unread > 99 ? '99+' : unread}
            </span>
          ) : null}
        </button>
      </PopoverTrigger>
      <PopoverContent label="Notifications" align="end">
        <div className="flex items-center justify-between px-4 py-3">
          <h2 className="text-[13px] font-semibold">Notifications</h2>
          <Button size="sm" variant="quiet" icon={<CheckCheck aria-hidden className="size-4" />} onClick={readAll} disabled={!unread}>
            Read all<span className="sr-only"> — mark all notifications read</span>
          </Button>
        </div>
        <div className="max-h-[420px] overflow-y-auto">
          {loading ? <div className="p-4"><Spinner /></div> : error ? (
            <div className="p-4"><ErrorState error={error} onRetry={refetch} /></div>
          ) : !data?.items.length ? (
            <p className="px-4 py-8 text-center text-[13px] text-muted">All caught up</p>
          ) : (
            <ul>
              {data.items.map((n) => {
                const href = hrefFor(n);
                const tone = n.severity === 'critical' ? 'danger' : n.severity === 'warning' ? 'warn' : 'info';
                const body = (
                  <div className="flex gap-3 px-4 py-3">
                    <span className="mt-0.5"><ToneIcon tone={tone} /></span>
                    <div className="min-w-0 flex-1">
                      <p className={cn('text-[13px]', n.read_at ? 'text-muted' : 'font-medium text-fg')}>
                        {n.title}
                        {n.occurrences && n.occurrences > 1 ? <span className="ml-1 text-xs text-subtle">×{n.occurrences}</span> : null}
                      </p>
                      {n.body ? <p className="mt-0.5 line-clamp-2 text-xs text-muted">{n.body}</p> : null}
                      <p className="mt-1 text-[11px] text-subtle">
                        <span className="sr-only">{n.severity}. </span>
                        {fmtRelative(n.last_seen_at ?? n.created_at)}
                        {n.read_at ? null : <span className="ml-2 font-medium text-fg">Unread</span>}
                      </p>
                    </div>
                  </div>
                );
                return (
                  <li key={n.id} className="border-b border-border last:border-b-0">
                    {href ? (
                      <Link href={href} onClick={() => { void markRead(n); setOpen(false); }} className="focus-inset block hover:bg-surface">{body}</Link>
                    ) : (
                      <button type="button" onClick={() => void markRead(n)} className="focus-inset block w-full text-left hover:bg-surface">{body}</button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
