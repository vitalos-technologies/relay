'use client';
// Notification centre: read/unread, categories, direct links to the thread / task / review, mark read or unread.
// Only items you can still open are listed (access is re-checked on every load).
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { AtSign, Bell, CalendarClock, CheckCheck, LifeBuoy, ListTodo, MessageSquare, Send, ShieldCheck } from 'lucide-react';
import { api } from '@/lib/client/api';
import { useApi } from '@/lib/client/use-api';
import { useQueryState } from '@/lib/client/hooks';
import { fmtRelative } from '@/lib/client/format';
import { Button, EmptyState, ErrorState, FilterBar, LinkButton, PageHeader, SkeletonRows, Switch, cn, useToast } from '@/components/ui';

interface Item {
  id: string; severity: 'info' | 'warning' | 'critical'; kind: string; category: string; title: string; context: string | null; body: string | null; url: string | null; actor: string | null;
  occurrences: number; created_at: string; last_seen_at: string; read_at: string | null;
}
interface Feed { items: Item[]; unread_count: number; next_cursor: string | null }

const CATS = [
  { value: 'mentions', label: 'Mentions' }, { value: 'discussion', label: 'Discussions' }, { value: 'tasks', label: 'Tasks' },
  { value: 'reviews', label: 'Reviews' }, { value: 'reminders', label: 'Reminders' }, { value: 'publishing', label: 'Publishing' },
  { value: 'support', label: 'Support' },
];
const ICON: Record<string, typeof Bell> = { mentions: AtSign, discussion: MessageSquare, tasks: ListTodo, reviews: ShieldCheck, reminders: CalendarClock, publishing: Send, support: LifeBuoy };

export default function NotificationsPage() {
  const toast = useToast();
  const [params, setParams] = useQueryState();
  const unread = params.get('unread') === '1';
  const category = params.get('category') ?? '';
  const path = `/api/notifications?${new URLSearchParams({ ...(unread ? { unread: '1' } : {}), ...(category ? { category } : {}) }).toString()}`;
  const { data, error, loading, refetch, setData } = useApi<Feed>(path, { keepPrevious: true, poll: 30_000 });
  const [extra, setExtra] = useState<Item[]>([]);
  const [next, setNext] = useState<string | null>(null);
  useEffect(() => { if (data) { setExtra([]); setNext(data.next_cursor); } }, [data]);
  const items = [...(data?.items ?? []), ...extra];
  const setRead = async (n: Item, read: boolean) => {
    const upd = (x: Item) => (x.id === n.id ? { ...x, read_at: read ? new Date().toISOString() : null } : x);
    setData((d) => d ? { ...d, items: d.items.map(upd), unread_count: Math.max(0, d.unread_count + (read ? -1 : 1)) } : d!);
    setExtra((l) => l.map(upd));
    try { await api.post(`/api/notifications/${n.id}/${read ? 'read' : 'unread'}`, {}); } catch (e) { toast.error(e, 'Couldn’t update'); void refetch(); }
  };
  return (
    <>
      <PageHeader title="Notifications" meta={data ? <span className="tabular">{data.unread_count} unread</span> : null}
        actions={<>
          <LinkButton href="/settings/personal/notifications" variant="ghost">Settings</LinkButton>
          <Button variant="secondary" icon={<CheckCheck aria-hidden className="size-4" />} disabled={!data?.unread_count}
            onClick={async () => { await api.post('/api/notifications/read-all', {}); await refetch(); }}>Mark all read</Button>
        </>} />
      <FilterBar label="Notification filters">
        <div className="flex max-w-full gap-1 overflow-x-auto" role="group" aria-label="Type (choose one; choose again to show every type)">
          {CATS.map((c) => (
            <button key={c.value} type="button" aria-pressed={category === c.value} onClick={() => setParams({ category: category === c.value ? null : c.value })}
              className={cn('touch-target shrink-0 rounded-full border px-3 py-1 text-[13px]', category === c.value ? 'border-[var(--accent)] bg-accent-soft font-medium' : 'border-border text-muted hover:bg-raised')}>{c.label}</button>
          ))}
        </div>
        <Switch label="Unread only" checked={unread} onCheckedChange={(v) => setParams({ unread: v ? '1' : null })} />
      </FilterBar>
      {error && !data ? <ErrorState error={error} onRetry={refetch} /> : loading && !data ? <SkeletonRows rows={6} /> : !items.length ? (
        <EmptyState icon={<Bell aria-hidden />} title={unread ? 'All caught up' : 'No notifications'} />
      ) : (
        <ul className="flex flex-col divide-y divide-border rounded-[var(--radius-card)] border border-border bg-surface" aria-label="Notifications">
          {items.map((n) => {
            const Icon = ICON[n.category] ?? Bell;
            return (
              <li key={n.id} className="flex items-start gap-3 px-4 py-3">
                <span className={cn('mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full', n.severity === 'critical' ? 'bg-danger-soft text-danger' : n.severity === 'warning' ? 'bg-warn-soft text-warn' : 'bg-raised text-muted')}><Icon aria-hidden className="size-4" /></span>
                <div className="min-w-0 flex-1">
                  {n.url ? (
                    <Link href={n.url} onClick={() => { if (!n.read_at) void setRead(n, true); }} className={cn('text-[13px] underline-offset-2 hover:underline', n.read_at ? 'text-muted' : 'font-medium text-fg')}>{n.title}</Link>
                  ) : <p className={cn('text-[13px]', n.read_at ? 'text-muted' : 'font-medium text-fg')}>{n.title}</p>}
{detailLine(n) ? <p className="mt-0.5 line-clamp-2 text-xs text-muted">{detailLine(n)}</p> : null}
                  <p className="mt-1 text-[11px] text-subtle">{fmtRelative(n.last_seen_at)}{n.occurrences > 1 ? ` · ×${n.occurrences}` : ''}{n.read_at ? '' : <span className="ml-2 font-medium text-fg">Unread</span>}</p>
                </div>
                <Button size="sm" variant="quiet" onClick={() => void setRead(n, !n.read_at)}>{n.read_at ? 'Mark unread' : 'Mark read'}</Button>
              </li>
            );
          })}
        </ul>
      )}
      {next ? <Button className="mt-3" variant="ghost" onClick={async () => { const r = await api.get<Feed>(`${path}${path.includes('?') ? '&' : '?'}cursor=${encodeURIComponent(next)}`); setExtra((l) => [...l, ...r.items]); setNext(r.next_cursor); }}>Load more</Button> : null}
    </>
  );
}

/** One line of context: "Check image alt text · Spring menu launch · due Sat 7 Nov, 08:03 GMT". */
function detailLine(n: { context?: string | null; body: string | null }): string {
  // Publishing bodies start with "Post: <title>", which repeats the context line — show it once.
  const body = n.body ? n.body.split('\n').filter((l) => !(n.context && l.trim() === `Post: ${n.context}`)).join(' ').trim() : '';
  return [n.context, body ? body.replace(/^Due /, 'due ') : null].filter(Boolean).join(' · ');
}
