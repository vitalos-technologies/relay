'use client';
// Inbox: queues + filters (left, ≥1280; a select below), conversations (centre), selected conversation + customer
// context (right; context column ≥1536, drawer below). Phones (<768): one pane at a time — list → thread → details —
// driven by the URL (?c=<id>&panel=details), so back/forward and reloads keep position. Drafts persist per conversation.
import Link from 'next/link';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Inbox as InboxIcon, Search, Settings2 } from 'lucide-react';
import type { ConversationListItem, InboxChannelJson, InboxQueue } from '@social-lite/core/contracts/v35-inbox';
import { api } from '@/lib/client/api';
import { useApi } from '@/lib/client/use-api';
import { useBrandFilter, useDebouncedValue, useMediaQuery, useQueryState } from '@/lib/client/hooks';
import { useSession } from '@/lib/client/session';
import { Badge, Button, DetailDrawer, EmptyState, ErrorState, Input, LinkButton, PlatformIcon, Select, SkeletonRows, cn } from '@/components/ui';
import { InboxThread } from './thread';
import { InboxContextPanel } from './context-panel';
import { CHANNEL_LABEL, CHANNEL_PROVIDER, KIND_LABEL, PRIORITY_LABEL, QUEUES, QUEUE_LABEL, shortAgo } from './labels';

type Counts = Record<InboxQueue, number>;
interface ListResp { items: ConversationListItem[]; next_cursor: string | null }

export function InboxApp() {
  const { canV2 } = useSession();
  const [params, setParams] = useQueryState();
  const [brand] = useBrandFilter();
  const queue = (QUEUES as string[]).includes(params.get('queue') ?? '') ? (params.get('queue') as InboxQueue) : 'unassigned';
  const selected = params.get('c');
  const panel = params.get('panel');
  const kind = params.get('kind') ?? '';
  const priority = params.get('priority') ?? '';
  const [search, setSearch] = useState(params.get('q') ?? '');
  const q = useDebouncedValue(search, 300);
  const wide = useMediaQuery('(min-width: 1536px)');
  const [more, setMore] = useState<{ key: string; items: ConversationListItem[]; next: string | null } | null>(null);

  const qs = useMemo(() => new URLSearchParams({ queue, ...(brand ? { brand_id: brand } : {}), ...(kind ? { kind } : {}), ...(priority ? { priority } : {}), ...(q.trim() ? { q: q.trim() } : {}) }).toString(), [queue, brand, kind, priority, q]);
  const list = useApi<ListResp>(`/api/inbox/conversations?${qs}`, { keepPrevious: true, poll: 15_000 });
  const counts = useApi<Counts>('/api/inbox/counts', { poll: 30_000 });
  const channels = useApi<{ items: InboxChannelJson[] }>('/api/inbox/channels');
  useEffect(() => { setParams({ q: q.trim() || null }); }, [q]); // eslint-disable-line react-hooks/exhaustive-deps
  const extra = more?.key === qs ? more : null;
  const items = [...(list.data?.items ?? []), ...(extra?.items ?? [])];
  const next = extra ? extra.next : list.data?.next_cursor ?? null;
  const refresh = useCallback(() => { void list.refetch(); void counts.refetch(); }, [list, counts]);

  const open = (id: string) => setParams({ c: id, panel: null });
  // ≥768: the three panes fill the viewport below the shell (top bar + banners vary), each scrolling on its own.
  const frame = useRef<HTMLDivElement>(null);
  const [frameH, setFrameH] = useState<number | null>(null);
  useLayoutEffect(() => {
    const fit = () => { const el = frame.current; if (!el) return; setFrameH(window.innerWidth >= 768 ? Math.max(480, window.innerHeight - el.getBoundingClientRect().top - window.scrollY) : null); };
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, []);
  const noChannels = channels.data && !channels.data.items.length;

  const queueNav = (
    <nav aria-label="Queues" className="flex flex-col gap-0.5">
      {QUEUES.map((qq) => (
        <button key={qq} type="button" onClick={() => setParams({ queue: qq === 'unassigned' ? null : qq, c: null })}
          aria-current={qq === queue ? 'page' : undefined}
          className={cn('flex h-9 items-center justify-between rounded-md px-2.5 text-left text-[13px] transition-colors', qq === queue ? 'bg-raised font-medium text-fg' : 'text-muted hover:bg-raised hover:text-fg')}>
          <span>{QUEUE_LABEL[qq]}</span>
          {counts.data && qq !== 'all' && counts.data[qq] ? <span className="tabular text-xs text-muted">{counts.data[qq]}</span> : null}
        </button>
      ))}
    </nav>
  );
  const filters = (
    <div className="flex flex-col gap-2">
      <Select aria-label="Type" value={kind} onChange={(e) => setParams({ kind: e.target.value || null })}>
        <option value="">All types</option>
        {(['dm', 'comment', 'mention', 'review'] as const).map((k) => <option key={k} value={k}>{KIND_LABEL[k]}s</option>)}
      </Select>
      <Select aria-label="Priority" value={priority} onChange={(e) => setParams({ priority: e.target.value || null })}>
        <option value="">Any priority</option>
        {(['urgent', 'high', 'normal', 'low'] as const).map((p) => <option key={p} value={p}>{PRIORITY_LABEL[p]}</option>)}
      </Select>
    </div>
  );

  const listPane = (
    <section aria-label="Conversations" className={cn('flex min-h-0 flex-col border-border md:border-r', selected ? 'max-md:hidden' : '')}>
      <div className="flex flex-col gap-2 border-b border-border p-3">
        <div className="flex items-center gap-2 xl:hidden">
          <Select aria-label="Queue" className="flex-1" value={queue} onChange={(e) => setParams({ queue: e.target.value === 'unassigned' ? null : e.target.value, c: null })}>
            {QUEUES.map((qq) => <option key={qq} value={qq}>{QUEUE_LABEL[qq]}{counts.data && qq !== 'all' && counts.data[qq] ? ` (${counts.data[qq]})` : ''}</option>)}
          </Select>
          <Select aria-label="Type" className="w-28" value={kind} onChange={(e) => setParams({ kind: e.target.value || null })}>
            <option value="">All types</option>
            {(['dm', 'comment'] as const).map((k) => <option key={k} value={k}>{KIND_LABEL[k]}s</option>)}
          </Select>
        </div>
        <label className="relative block">
          <span className="sr-only">Search conversations</span>
          <Search aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-subtle" />
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search" className="pl-8" />
        </label>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {list.error && !list.data ? <ErrorState error={list.error} onRetry={list.refetch} /> : !list.data ? <SkeletonRows rows={6} className="p-3" /> : !items.length ? (
          <EmptyState compact icon={<InboxIcon aria-hidden />} title={noChannels ? 'No channels yet' : queue === 'mine' ? 'Nothing assigned to you' : 'All clear'}
            action={noChannels && canV2('inbox.manage') ? <LinkButton href="/settings/inbox/channels" variant="secondary">Add a channel</LinkButton> : undefined} />
        ) : (
          <ul>
            {items.map((it) => <li key={it.id}><Row it={it} active={it.id === selected} onOpen={() => open(it.id)} /></li>)}
          </ul>
        )}
        {next ? <div className="p-3"><Button variant="ghost" className="w-full" onClick={async () => { const r = await api.get<ListResp>(`/api/inbox/conversations?${qs}&cursor=${encodeURIComponent(next)}`); setMore({ key: qs, items: [...(extra?.items ?? []), ...r.items], next: r.next_cursor }); }}>Load more</Button></div> : null}
      </div>
    </section>
  );

  return (
    <div className="-mx-4 -mt-6 sm:-mx-6 md:-mx-8 md:-mb-16 md:-mt-8">
      <div ref={frame} style={frameH ? { height: frameH } : undefined} className="grid md:grid-cols-[300px_minmax(0,1fr)] xl:grid-cols-[200px_300px_minmax(0,1fr)]">
        <aside aria-label="Queues and filters" className="hidden min-h-0 flex-col gap-4 overflow-y-auto border-r border-border p-3 xl:flex">
          <div className="flex items-center justify-between px-1">
            <h1 className="text-[17px] font-semibold">Inbox</h1>
            {canV2('inbox.manage') ? <Link href="/settings/inbox/channels" aria-label="Inbox settings" className="rounded-md p-1 text-muted hover:bg-raised hover:text-fg"><Settings2 aria-hidden className="size-4" /></Link> : null}
          </div>
          {queueNav}
          <div className="border-t border-border pt-3">{filters}</div>
          {channels.data?.items.length ? (
            <div className="border-t border-border pt-3 text-xs text-muted">
              <p className="mb-1 font-medium text-subtle">Channels</p>
              {channels.data.items.map((ch) => (
                <p key={ch.id} className="flex min-w-0 items-center gap-1.5 py-0.5" title={`${CHANNEL_LABEL[ch.kind]} · ${ch.display_name}`}>
                  {CHANNEL_PROVIDER[ch.kind] ? <PlatformIcon provider={CHANNEL_PROVIDER[ch.kind]!} size="xs" /> : null}
                  <span className="min-w-0 truncate">{ch.display_name}</span>
                  {ch.status !== 'active' ? <span className="shrink-0 text-warn">· check</span> : null}
                </p>
              ))}
            </div>
          ) : null}
        </aside>
        <h1 className="sr-only xl:hidden">Inbox</h1>
        {listPane}
        <section aria-label="Conversation" className={cn('min-h-0', selected ? '' : 'max-md:hidden')}>
          {selected ? (
            <div className={cn('grid h-full min-h-0', wide ? 'grid-cols-[minmax(0,1fr)_280px]' : 'grid-cols-1')}>
              <InboxThread key={selected} id={selected} onBack={() => setParams({ c: null, panel: null })} onDetails={wide ? undefined : () => setParams({ panel: 'details' })} onChanged={refresh} />
              {wide ? <aside aria-label="Customer and case" className="min-h-0 overflow-y-auto border-l border-border p-4"><InboxContextPanel id={selected} onChanged={refresh} /></aside> : null}
            </div>
          ) : (
            <div className="hidden h-full items-center justify-center md:flex"><EmptyState icon={<InboxIcon aria-hidden />} title="Select a conversation" /></div>
          )}
        </section>
      </div>
      {selected && !wide ? (
        <DetailDrawer open={panel === 'details'} onOpenChange={(o) => setParams({ panel: o ? 'details' : null })} title="Customer and case">
          <InboxContextPanel id={selected} onChanged={refresh} />
        </DetailDrawer>
      ) : null}
    </div>
  );
}

function Row({ it, active, onOpen }: { it: ConversationListItem; active: boolean; onOpen: () => void }) {
  return (
    <button type="button" onClick={onOpen} aria-current={active ? 'true' : undefined}
      className={cn('flex w-full flex-col gap-1 border-b border-border px-3 py-3 text-left transition-colors', active ? 'bg-raised' : 'hover:bg-raised/60')}>
      <span className="flex items-start gap-2">
        <span className={cn('min-w-0 flex-1 truncate text-[13px]', it.unanswered_since ? 'font-semibold' : 'font-medium')}>{it.contact.name ?? it.contact.handle ?? 'Customer'}</span>
        <span className="flex shrink-0 flex-col items-end text-xs leading-tight">
          <span className="text-subtle">{shortAgo(it.last_message_at)}</span>
          {it.unanswered_since ? <span className="text-warn" title="Waiting for a reply">waiting {shortAgo(it.unanswered_since)}</span> : null}
        </span>
      </span>
      <span className="line-clamp-2 text-[13px] text-muted">{it.preview || '—'}</span>
      <span className="flex min-w-0 items-center gap-1.5 whitespace-nowrap text-[11px] text-subtle">
        <span className="shrink-0">{CHANNEL_LABEL[it.channel.kind]} · {KIND_LABEL[it.kind]}</span>
        {it.priority === 'urgent' || it.priority === 'high' ? <Badge tone="warn" className="h-5 shrink-0 px-1.5 text-[11px]">{PRIORITY_LABEL[it.priority]}</Badge> : null}
        {it.case ? <Badge tone="info" className="h-5 shrink-0 px-1.5 text-[11px]">Case #{it.case.number}</Badge> : null}
        {it.assignee ? <span className="min-w-0 truncate">· {it.assignee.name ?? it.assignee.email}</span> : null}
      </span>
    </button>
  );
}
