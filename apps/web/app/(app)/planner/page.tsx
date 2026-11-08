'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState, type DragEvent } from 'react';
import { CalendarClock, CalendarDays, ChevronLeft, ChevronRight, Copy, Ellipsis, FileClock, LayoutGrid, List, ListOrdered, PanelRight, Plus, SquareArrowOutUpRight, TriangleAlert, Undo2 } from 'lucide-react';
import { resolveWallTime, toLocalInput, type PostAggregateStatus } from '@social-lite/core';
import { api } from '@/lib/client/api';
import { useSession } from '@/lib/client/session';
import { useApi } from '@/lib/client/use-api';
import { useBrandFilter, useHrefWithBrand, useMediaQuery, useQueryState } from '@/lib/client/hooks';
import { fmtDateTime, fmtTime, localDateKey, postTitle, zoneAbbr } from '@/lib/client/format';
import type { Connection, PlannerItem, PostDetail } from '@/lib/client/types';
import {
  Banner, Button, cn, EmptyState, ErrorState, FilterBar, FilterSelect, IconButton, InfoTip, LinkButton, Menu, MenuContent, MenuItem, MenuTrigger, PageHeader,
  POST_STATUS_LABEL, Segmented, SkeletonRows, Thumb, useToast,
} from '@/components/ui';
import { AgendaItem, DestinationDots, OwnerMeta } from '@/components/planner/agenda-item';
import { RescheduleDialog, type RescheduleResult } from '@/components/planner/reschedule-dialog';
import { PostDrawer } from '@/components/planner/post-drawer';
import { AssistantButton } from '@/components/assistant/assistant-panel'; // V3.5 stream E
import { BulkBar, useSelection, type Selection } from '@/components/bulk/bulk';
import { useFlag } from '@/lib/client/flags';

/** Same destination within 15 minutes of another post: shown as a conflict (text + icon, never colour alone). */
function findConflicts(items: PlannerItem[]): Set<string> {
  const out = new Set<string>();
  const live = items.filter((i) => i.status !== 'cancelled');
  for (let a = 0; a < live.length; a++) for (let b = a + 1; b < live.length; b++) {
    const x = live[a]!, y = live[b]!;
    if (Math.abs(new Date(x.due_at).getTime() - new Date(y.due_at).getTime()) > 15 * 60_000) continue;
    if (x.destinations.some((d) => y.destinations.some((e) => e.connection_id === d.connection_id))) { out.add(x.schedule_id); out.add(y.schedule_id); }
  }
  return out;
}

type View = 'week' | 'month' | 'agenda';
const DAY_MS = 86_400_000;
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

// ---- calendar date arithmetic on plain YYYY-MM-DD strings (zone-independent)
function addDays(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1, d) + n * DAY_MS);
  return t.toISOString().slice(0, 10);
}
function weekday(date: string): number {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7; // Monday = 0
}
function diffDays(a: string, b: string): number {
  const p = (s: string) => { const [y, m, d] = s.split('-').map(Number) as [number, number, number]; return Date.UTC(y, m - 1, d); };
  return Math.round((p(a) - p(b)) / DAY_MS);
}
/** UTC instant of local midnight (or the first valid minute after a midnight gap). */
function startOfLocalDay(date: string, tz: string): Date {
  for (const hm of ['00:00', '01:00', '02:00']) {
    const r = resolveWallTime(`${date}T${hm}`, tz);
    if (r.kind === 'ok') return r.instant;
    if (r.kind === 'ambiguous') return r.options[0]!.instant;
  }
  return new Date(`${date}T00:00:00Z`);
}
function labelDate(date: string, opts: Intl.DateTimeFormatOptions) {
  return new Intl.DateTimeFormat('en-GB', { ...opts, timeZone: 'UTC' }).format(new Date(`${date}T12:00:00Z`));
}

const RESCHEDULABLE_STATUSES: PostAggregateStatus[] = ['scheduled', 'pending_approval'];
function canMove(i: PlannerItem) {
  return (i.schedule_status === 'active' || i.schedule_status === 'pending_approval') && RESCHEDULABLE_STATUSES.includes(i.status) && new Date(i.due_at).getTime() > Date.now();
}

export default function PlannerPage() {
  const { session, can } = useSession();
  const router = useRouter();
  const toast = useToast();
  const [brand] = useBrandFilter();
  const withBrand = useHrefWithBrand();
  const [params, setParams] = useQueryState();
  const desktop = useMediaQuery('(min-width: 768px)');

  const viewTz = session.brands.find((b) => b.id === brand)?.timezone ?? session.workspace?.timezone ?? 'Europe/London';
  const today = localDateKey(new Date(), viewTz);
  const view: View = (params.get('view') as View | null) ?? (desktop ? 'week' : 'agenda');
  const anchor = /^\d{4}-\d{2}-\d{2}$/.test(params.get('date') ?? '') ? params.get('date')! : today;
  const connectionFilter = params.get('account') ?? '';
  const statusFilter = params.get('status') ?? '';
  const ownerFilter = params.get('owner') ?? '';
  const campaignFilter = params.get('campaign') ?? '';
  const conflictOnly = params.get('conflicts') === '1';
  const [drawer, setDrawer] = useState<PlannerItem | null>(null);
  const sel = useSelection<{ id: string; brand_id: string; title: string | null }>();
  const listView = view === 'agenda' || !desktop;
  const queueOn = useFlag('v31.content_queue');

  // Visible range in the view zone
  const range = useMemo(() => {
    if (view === 'week') {
      const start = addDays(anchor, -weekday(anchor));
      return { start, days: 7 };
    }
    if (view === 'month') {
      const first = `${anchor.slice(0, 8)}01`;
      const start = addDays(first, -weekday(first));
      return { start, days: 42 };
    }
    return { start: anchor, days: 14 };
  }, [view, anchor]);
  const from = startOfLocalDay(range.start, viewTz).toISOString();
  const to = startOfLocalDay(addDays(range.start, range.days), viewTz).toISOString();

  const qs = new URLSearchParams({ from, to });
  if (brand) qs.set('brand_id', brand);
  if (connectionFilter) qs.set('connection_id', connectionFilter);
  if (statusFilter) qs.set('status', statusFilter);
  // Bounded payload (V3.1 PERF): the visible range only, capped; the server reports `truncated` when there is more.
  const limit = view === 'month' ? 400 : 200;
  qs.set('limit', String(limit));
  const { data, error, loading, refetch, refreshing } = useApi<{ items: PlannerItem[]; truncated?: boolean }>(`/api/planner?${qs.toString()}`, { keepPrevious: true, poll: 30_000 });
  const conns = useApi<{ items: Connection[] }>(brand ? `/api/brands/${brand}/connections` : null);

  const conflictIds = useMemo(() => findConflicts(data?.items ?? []), [data]);
  const byDay = useMemo(() => {
    const m = new Map<string, PlannerItem[]>();
    for (const i of (data?.items ?? []).filter((x) => (!ownerFilter || (ownerFilter === `team:${x.team?.id}`) || (ownerFilter === `user:${x.assignee?.id}`)) && (!campaignFilter || x.campaign?.id === campaignFilter) && (!conflictOnly || conflictIds.has(x.schedule_id)))) {
      const k = localDateKey(i.due_at, viewTz);
      const arr = m.get(k) ?? [];
      arr.push(i);
      m.set(k, arr);
    }
    for (const arr of m.values()) arr.sort((a, b) => a.due_at.localeCompare(b.due_at));
    return m;
  }, [data, viewTz, ownerFilter, campaignFilter, conflictOnly, conflictIds]);
  const conflicts = conflictIds;
  const campaigns = useMemo(() => {
    const m = new Map<string, string>();
    for (const i of data?.items ?? []) if (i.campaign) m.set(i.campaign.id, i.campaign.name ?? 'Untitled campaign');
    return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [data]);
  // V2 calendar ownership filter options (teams/assignees present in the visible, already-scoped items).
  const owners = useMemo(() => {
    const m = new Map<string, string>();
    for (const i of data?.items ?? []) {
      if (i.team) m.set(`team:${i.team.id}`, `Team · ${i.team.name ?? ''}`);
      if (i.assignee) m.set(`user:${i.assignee.id}`, i.assignee.name || i.assignee.email || 'Someone');
    }
    return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [data]);

  const brandName = (id: string) => session.brands.find((b) => b.id === id)?.name ?? '';
  const mayReschedule = can('drafts.edit') || can('schedule.publish');

  // Reschedule state
  const [target, setTarget] = useState<{ item: PlannerItem; local: string | null } | null>(null);
  const [lastMove, setLastMove] = useState<(RescheduleResult & { title: string }) | null>(null);
  const [undoing, setUndoing] = useState(false);
  useEffect(() => {
    if (!lastMove) return;
    const t = setTimeout(() => setLastMove(null), 30_000);
    return () => clearTimeout(t);
  }, [lastMove]);

  const onDropDay = (day: string, e: DragEvent) => {
    e.preventDefault();
    const id = e.dataTransfer.getData('text/x-schedule-id');
    const item = data?.items.find((i) => i.schedule_id === id);
    if (!item) return;
    const from = localDateKey(item.due_at, viewTz);
    const delta = diffDays(day, from);
    if (delta === 0) return;
    const original = (item.input_local_time ?? toLocalInput(new Date(item.due_at), item.input_timezone)).slice(0, 16);
    const moved = `${addDays(original.slice(0, 10), delta)}T${original.slice(11, 16)}`;
    setTarget({ item, local: moved });
  };

  const duplicate = async (i: PlannerItem) => {
    try {
      const p = await api.post<PostDetail>(`/api/posts/${i.post_id}/duplicate`, {}, { idempotent: true });
      router.push(`/posts/${p.id}`);
    } catch (e) {
      toast.error(e, 'Could not duplicate the post');
    }
  };

  const undo = async () => {
    if (!lastMove) return;
    setUndoing(true);
    try {
      await api.post(`/api/schedules/${lastMove.schedule.id}/reschedule`, {
        input_local_time: lastMove.previous.local, timezone: lastMove.previous.tz, expected_generation: lastMove.schedule.generation,
      }, { idempotent: true });
      toast.success('Move undone');
      setLastMove(null);
      void refetch();
    } catch (e) {
      toast.error(e, 'Could not undo the move');
    } finally {
      setUndoing(false);
    }
  };

  const nav = (dir: -1 | 1) => {
    let next: string;
    if (view === 'week') next = addDays(anchor, dir * 7);
    else if (view === 'agenda') next = addDays(anchor, dir * 14);
    else {
      const [y, m] = anchor.split('-').map(Number) as [number, number];
      const d = new Date(Date.UTC(y, m - 1 + dir, 1));
      next = d.toISOString().slice(0, 10);
    }
    setParams({ date: next });
  };

  const title =
    view === 'month' ? labelDate(`${anchor.slice(0, 8)}01`, { month: 'long', year: 'numeric' })
      : view === 'week' ? `${labelDate(range.start, { day: 'numeric', month: 'short' })} – ${labelDate(addDays(range.start, 6), { day: 'numeric', month: 'short', year: 'numeric' })}`
        : `${labelDate(range.start, { day: 'numeric', month: 'short' })} – ${labelDate(addDays(range.start, 13), { day: 'numeric', month: 'short', year: 'numeric' })}`;

  const preferredZones = [
    ...(brand ? [{ tz: viewTz, label: `${viewTz} (brand)` }] : []),
    ...(session.workspace ? [{ tz: session.workspace.timezone, label: `${session.workspace.timezone} (workspace)` }] : []),
  ];

  const itemMenu = (i: PlannerItem) => (
    <Menu>
      <MenuTrigger asChild>
        <IconButton size="sm" label={`Actions for ${postTitle(i)}`} icon={<Ellipsis aria-hidden className="size-4" />} />
      </MenuTrigger>
      <MenuContent>
        <MenuItem icon={<PanelRight aria-hidden />} onSelect={() => setDrawer(i)}>Details</MenuItem>
        <MenuItem icon={<SquareArrowOutUpRight aria-hidden />} onSelect={() => router.push(`/posts/${i.post_id}`)}>Open post</MenuItem>
        {mayReschedule ? (
          <MenuItem icon={<CalendarClock aria-hidden />} disabled={!canMove(i)} onSelect={() => setTarget({ item: i, local: null })}>
            Reschedule…
          </MenuItem>
        ) : null}
        {can('drafts.edit') ? <MenuItem icon={<Copy aria-hidden />} onSelect={() => void duplicate(i)}>Duplicate</MenuItem> : null}
      </MenuContent>
    </Menu>
  );

  return (
    <>
      <PageHeader
        title="Planner"
        meta={<span className="truncate">{viewTz.replace(/_/g, ' ')} · {zoneAbbr(new Date(), viewTz)}</span>}
        actions={<>
          <AssistantButton surface="planner" size="md" brandId={brand || null} />
          {queueOn ? <LinkButton href={withBrand('/queue')} variant="ghost" icon={<ListOrdered aria-hidden className="size-4" />}>Queue</LinkButton> : null}
          {can('history.read') ? <LinkButton href={withBrand('/history')} variant="ghost" icon={<FileClock aria-hidden className="size-4" />}>History</LinkButton> : null}
          {can('drafts.edit') && session.brands.length ? <LinkButton href={withBrand('/compose')} variant="primary" icon={<Plus aria-hidden className="size-4" />}>Create post</LinkButton> : null}
        </>}
      />

      <div className="mb-4 flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex items-center gap-2">
          <IconButton label={`Previous ${view === 'agenda' ? 'two weeks' : view}`} icon={<ChevronLeft aria-hidden className="size-4" />} onClick={() => nav(-1)} />
          <IconButton label={`Next ${view === 'agenda' ? 'two weeks' : view}`} icon={<ChevronRight aria-hidden className="size-4" />} onClick={() => nav(1)} />
          <Button variant="ghost" size="sm" onClick={() => setParams({ date: null })} disabled={anchor === today}>Today</Button>
          <h2 className="ml-2 min-w-0 truncate text-[15px] font-semibold tabular" aria-live="polite">{title}</h2>
          {view !== 'agenda' && desktop && mayReschedule ? <InfoTip label="How to reschedule">Drag a post to another day, or use its ⋯ menu.</InfoTip> : null}
          {refreshing ? <span className="text-xs text-subtle">Updating…</span> : null}
        </div>
        <Segmented
          label="View"
          value={view}
          onChange={(v) => setParams({ view: v })}
          options={[
            { value: 'week', label: 'Week', icon: <CalendarDays aria-hidden className="size-3.5" />, disabled: !desktop },
            { value: 'month', label: 'Month', icon: <LayoutGrid aria-hidden className="size-3.5" />, disabled: !desktop },
            { value: 'agenda', label: 'List', icon: <List aria-hidden className="size-3.5" /> },
          ]}
        />
      </div>

      <FilterBar>
        <FilterSelect id="pl-account" label="Account" className="w-[180px]" value={connectionFilter} onChange={(v) => setParams({ account: v })} disabled={!brand} title={!brand ? 'Pick a brand first' : undefined}>
          <option value="">All accounts</option>
          {conns.data?.items.map((c) => <option key={c.id} value={c.id}>{c.display_name}{c.is_mock ? ' (Simulated)' : ''}</option>)}
        </FilterSelect>
        {campaigns.length || campaignFilter ? (
          <FilterSelect id="pl-campaign" label="Campaign" className="w-[170px]" value={campaignFilter} onChange={(v) => setParams({ campaign: v })}>
            <option value="">All campaigns</option>
            {campaigns.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
          </FilterSelect>
        ) : null}
        {owners.length || ownerFilter ? (
          <FilterSelect id="pl-owner" label="Team or owner" className="w-[170px]" value={ownerFilter} onChange={(v) => setParams({ owner: v })}>
            <option value="">All teams</option>
            {owners.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
          </FilterSelect>
        ) : null}
        <FilterSelect id="pl-status" label="Status" className="w-[160px]" value={statusFilter} onChange={(v) => setParams({ status: v })}>
          <option value="">All statuses</option>
          {(['scheduled', 'pending_approval', 'publishing', 'published', 'partial', 'needs_attention', 'failed', 'expired', 'cancelled'] as PostAggregateStatus[]).map((s) => (
            <option key={s} value={s}>{POST_STATUS_LABEL[s]}</option>
          ))}
        </FilterSelect>
        {conflicts.size || conflictOnly ? (
          <button type="button" aria-pressed={conflictOnly} onClick={() => setParams({ conflicts: conflictOnly ? null : '1' })}
            className={cn('inline-flex h-9 items-center gap-1.5 rounded-lg border px-3 text-[13px] font-medium text-warn transition-colors', conflictOnly ? 'border-[color-mix(in_srgb,var(--warn)_45%,transparent)] bg-warn-soft' : 'border-transparent hover:bg-warn-soft')}>
            <TriangleAlert aria-hidden className="size-3.5" />{conflicts.size} in conflict{conflictOnly ? <span className="text-muted"> · show all</span> : null}
          </button>
        ) : null}
      </FilterBar>

      {data?.truncated ? (
        <Banner tone="info" className="mb-4" role="status" title={`Showing the first ${data.items.length} posts`}>
          {brand ? 'Narrow by account or status to see the rest.' : 'Pick a brand to see the rest.'}
        </Banner>
      ) : null}

      {lastMove ? (
        <Banner
          tone="success"
          className="mb-4"
          role="status"
          title={`Moved “${lastMove.title}”`}
          actions={<Button size="sm" variant="secondary" icon={<Undo2 aria-hidden className="size-4" />} loading={undoing} onClick={undo}>Undo</Button>}
        >
          Now {fmtDateTime(lastMove.schedule.due_at, lastMove.schedule.input_timezone)} {zoneAbbr(lastMove.schedule.due_at, lastMove.schedule.input_timezone)}.
        </Banner>
      ) : null}

      {error && !data ? (
        <ErrorState error={error} onRetry={refetch} />
      ) : loading ? (
        <SkeletonRows rows={5} />
      ) : view === 'agenda' || !desktop ? (
        <Agenda start={range.start} days={range.days} byDay={byDay} today={today} brandName={brand ? undefined : brandName} menu={itemMenu} empty={!data?.items.length} canCreate={can('drafts.edit')} withBrand={withBrand} onOpen={setDrawer}
          selection={can('drafts.edit') ? sel : undefined} />
      ) : (
        <CalendarGrid
          view={view}
          start={range.start}
          days={range.days}
          anchorMonth={anchor.slice(0, 7)}
          byDay={byDay}
          today={today}
          draggable={mayReschedule}
          onDropDay={onDropDay}
          menu={itemMenu}
          onMore={(d) => setParams({ view: 'agenda', date: d })}
          onOpen={setDrawer}
          conflicts={conflicts}
          viewTz={viewTz}
        />
      )}

      {listView && can('drafts.edit') ? (
        <BulkBar targetKind="post" selection={sel} actions={['reschedule', 'assign', 'set_campaign', 'add_tags', 'remove_tags', 'duplicate', 'archive']} onDone={() => { sel.clear(); void refetch(); }}
          describe={(id) => { const it = data?.items.find((x) => x.post_id === id); return it ? POST_STATUS_LABEL[it.status] ?? null : null; }} />
      ) : null}
      <PostDrawer
        item={drawer}
        onOpenChange={(o) => !o && setDrawer(null)}
        brandName={drawer && !brand ? brandName(drawer.brand_id) : undefined}
        onReschedule={mayReschedule && drawer && canMove(drawer) ? (i) => { setDrawer(null); setTarget({ item: i, local: null }); } : undefined}
        onDuplicate={can('drafts.edit') ? (i) => void duplicate(i) : undefined}
      />

      <RescheduleDialog
        open={!!target}
        onOpenChange={(o) => !o && setTarget(null)}
        item={target?.item ?? null}
        initialLocal={target?.local ?? null}
        preferredZones={preferredZones}
        onDone={(r) => {
          setLastMove({ ...r, title: target ? postTitle(target.item) : 'post' });
          void refetch();
        }}
      />
    </>
  );
}

function Agenda({
  start, days, byDay, today, brandName, menu, empty, canCreate, withBrand, onOpen, selection,
}: {
  start: string; days: number; byDay: Map<string, PlannerItem[]>; today: string; brandName?: (id: string) => string;
  menu: (i: PlannerItem) => React.ReactNode; empty: boolean; canCreate: boolean; withBrand: (h: string) => string; onOpen: (i: PlannerItem) => void;
  selection?: Selection<{ id: string; brand_id: string; title: string | null }>;
}) {
  if (empty) {
    return (
      <EmptyState icon={<CalendarDays aria-hidden />} title="Nothing scheduled" action={canCreate ? <LinkButton href={withBrand('/compose')} variant="secondary">New post</LinkButton> : null} />
    );
  }
  const list = Array.from({ length: days }, (_, i) => addDays(start, i)).filter((d) => byDay.has(d));
  return (
    <div className="flex flex-col gap-6">
      {list.map((d) => (
        <section key={d} aria-labelledby={`ag-${d}`}>
          <h3 id={`ag-${d}`} className="mb-2 flex items-baseline gap-2 text-[13px] font-semibold">
            {labelDate(d, { weekday: 'long', day: 'numeric', month: 'long' })}
            {d === today ? <span className="rounded-full bg-raised px-2 text-[11px] font-medium text-muted">Today</span> : null}
          </h3>
          <ul className="flex flex-col">
            {byDay.get(d)!.map((i) => (
              <li key={i.schedule_id} className="flex items-center gap-1">
                {selection ? (
                  <input type="checkbox" aria-label={`Select ${postTitle(i)}`} className="ml-1 size-4 shrink-0 accent-[var(--text)]"
                    checked={selection.has(i.post_id)} onChange={() => selection.toggle({ id: i.post_id, brand_id: i.brand_id, title: postTitle(i) })} />
                ) : null}
                <div className="min-w-0 flex-1"><AgendaItem item={i} brandName={brandName?.(i.brand_id)} actions={menu(i)} onOpen={() => onOpen(i)} /></div>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function CalendarGrid({
  view, start, days, anchorMonth, byDay, today, draggable, onDropDay, menu, onMore, onOpen, conflicts, viewTz,
}: {
  view: View; start: string; days: number; anchorMonth: string; byDay: Map<string, PlannerItem[]>; today: string; draggable: boolean;
  onDropDay: (day: string, e: DragEvent) => void; menu: (i: PlannerItem) => React.ReactNode; onMore: (day: string) => void;
  onOpen: (i: PlannerItem) => void; conflicts: Set<string>; viewTz: string;
}) {
  const [over, setOver] = useState<string | null>(null);
  const cells = Array.from({ length: days }, (_, i) => addDays(start, i));
  const max = view === 'month' ? 3 : 50;
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-surface">
      <div className="grid grid-cols-7 border-b border-border" aria-hidden>
        {WEEKDAYS.map((w) => <div key={w} className="px-3 py-2 text-xs font-medium text-muted">{w}</div>)}
      </div>
      <div className="grid grid-cols-7" role="list" aria-label="Calendar days">
        {cells.map((d, idx) => {
          const items = byDay.get(d) ?? [];
          const outside = view === 'month' && d.slice(0, 7) !== anchorMonth;
          return (
            <div
              key={d}
              role="listitem"
              aria-label={`${labelDate(d, { weekday: 'long', day: 'numeric', month: 'long' })}, ${items.length} post${items.length === 1 ? '' : 's'}`}
              onDragOver={(e) => { if (draggable && d >= today) { e.preventDefault(); setOver(d); } }}
              onDragLeave={() => setOver((o) => (o === d ? null : o))}
              onDrop={(e) => { setOver(null); onDropDay(d, e); }}
              className={cn(
                'flex flex-col gap-1 border-border p-2',
                idx % 7 !== 6 && 'border-r',
                idx < days - 7 && 'border-b',
                view === 'week' ? 'min-h-[420px]' : 'min-h-[120px]',
                outside && 'bg-sunken/70 [&>*:not(:first-child)]:opacity-55',
                over === d && 'bg-raised outline-2 outline-dashed outline-[var(--focus)] -outline-offset-2',
              )}
            >
              <div className={cn('flex items-center justify-between text-xs tabular', outside ? 'text-subtle' : 'text-muted')}>
                <span className={cn(d === today && 'inline-flex size-6 items-center justify-center rounded-full bg-[var(--text)] font-semibold text-bg')}>
                  {Number(d.slice(8))}
                </span>
                {d === today ? <span className="sr-only">Today</span> : null}
              </div>
              {items.slice(0, max).map((i) => <CalendarItem key={i.schedule_id} item={i} draggable={draggable && canMove(i)} menu={menu(i)} compact={view === 'month'} onOpen={() => onOpen(i)} conflict={conflicts.has(i.schedule_id)} viewTz={viewTz} />)}
              {items.length > max ? (
                <button type="button" onClick={() => onMore(d)} className="rounded px-1 text-left text-xs font-medium text-muted hover:text-fg">
                  +{items.length - max} more
                </button>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function CalendarItem({ item, draggable, menu, compact, onOpen, conflict, viewTz }: {
  item: PlannerItem; draggable: boolean; menu: React.ReactNode; compact: boolean; onOpen: () => void; conflict: boolean; viewTz: string;
}) {
  const due = new Date(item.due_at);
  // Show the post's own zone only when its wall-clock time differs from the planner's zone.
  const otherZone = fmtTime(due, item.input_timezone) !== fmtTime(due, viewTz);
  const bad = item.status === 'needs_attention' || item.status === 'failed' || item.status === 'partial' || item.status === 'expired';
  const allMock = item.destinations.length > 0 && item.destinations.every((d) => d.is_mock);
  return (
    <div
      draggable={draggable}
      onDragStart={(e) => {
        e.dataTransfer.setData('text/x-schedule-id', item.schedule_id);
        e.dataTransfer.effectAllowed = 'move';
      }}
      className={cn(
        'group relative rounded-lg border border-transparent bg-raised/70 p-1.5 text-xs transition-colors hover:border-border-strong',
        draggable && 'cursor-grab active:cursor-grabbing',
        bad && 'border-l-2 border-l-[var(--danger)]',
        item.status === 'pending_approval' && 'border-l-2 border-l-[var(--info)]',
        item.status === 'cancelled' && 'opacity-60',
      )}
    >
      <div className="flex items-start gap-1">
        <button type="button" onClick={onOpen} className="min-w-0 flex-1 rounded text-left">
          <span className="block font-semibold tabular">
            {fmtTime(due, item.input_timezone)}{otherZone ? <span className="font-normal text-muted"> {zoneAbbr(due, item.input_timezone)}</span> : null}
          </span>
          <span className={cn('block text-fg', compact ? 'truncate' : 'line-clamp-2')}>{postTitle(item)}</span>
          <span className="sr-only">{item.overdue ? 'Overdue' : item.status === 'published' && allMock ? 'Simulated · delivered' : POST_STATUS_LABEL[item.status]}</span>
        </button>
        <span className="-mr-1 -mt-0.5 opacity-70 group-hover:opacity-100 group-focus-within:opacity-100">{menu}</span>
      </div>
      {!compact ? (
        <div className="mt-1.5 flex min-w-0 items-center gap-1.5">
          {item.thumb_url ? <Thumb src={item.thumb_url} kind={item.media_kind} className="size-7 rounded-md" /> : null}
          <DestinationDots destinations={item.destinations} />
        </div>
      ) : null}
      {!compact && (item.team || item.assignee || item.campaign || item.review) ? <div className="mt-1 truncate text-[11px]"><OwnerMeta item={item} /></div> : null}
      {conflict || item.status === 'expired' || item.overdue ? (
        <p className={cn('mt-1 flex items-center gap-1 text-[11px] font-medium', item.status === 'expired' ? 'text-danger' : 'text-warn')}>
          <TriangleAlert aria-hidden className="size-3" />{item.status === 'expired' ? 'Expired' : item.overdue ? 'Overdue' : 'Conflict'}
        </p>
      ) : null}
    </div>
  );
}
