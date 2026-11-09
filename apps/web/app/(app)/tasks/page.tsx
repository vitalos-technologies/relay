'use client';
// Tasks: Assigned to me · Created by me · Team (workload). Filters live in the URL. ?task=<id> opens the task.
import { useEffect, useState } from 'react';
import { ListTodo, Plus } from 'lucide-react';
import { api } from '@/lib/client/api';
import { useApi } from '@/lib/client/use-api';
import { useBrandFilter, useQueryState } from '@/lib/client/hooks';
import { useSession } from '@/lib/client/session';
import { Button, Card, Dialog, EmptyState, ErrorState, Field, FilterBar, FilterSelect, InfoTip, MetricCard, PageHeader, Select, SkeletonRows } from '@/components/ui';
import { TaskDrawer, TaskForm, TaskRow } from '@/components/collab/tasks';
import type { TaskDto } from '@/components/collab/types';

type View = 'mine' | 'created' | 'team';
interface Workload { mine: { open: number; overdue: number; due_soon: number; created_open: number }; people: Array<{ user_id: string | null; name: string | null; email: string | null; open: number; overdue: number; due_soon: number; blocked: number }> }

export default function TasksPage() {
  const { session } = useSession();
  const [params, setParams] = useQueryState();
  const [brand] = useBrandFilter();
  const view = (['mine', 'created', 'team'].includes(params.get('view') ?? '') ? params.get('view') : 'mine') as View;
  const status = params.get('status') === 'done' ? 'done' : 'open';
  const due = params.get('due') ?? '';
  const taskId = params.get('task');
  const qs = new URLSearchParams({ view, status, ...(due ? { due } : {}), ...(brand ? { brand_id: brand } : {}) }).toString();
  const { data, error, loading, refetch } = useApi<{ items: TaskDto[]; next_cursor: string | null }>(`/api/tasks?${qs}`, { keepPrevious: true, poll: 60_000 });
  const workload = useApi<Workload>(`/api/tasks/workload${brand ? `?brand_id=${brand}` : ''}`);
  const [extra, setExtra] = useState<TaskDto[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newBrand, setNewBrand] = useState(brand || session.brands[0]?.id || '');
  useEffect(() => { if (data) { setExtra([]); setNext(data.next_cursor); } }, [data]);
  const items = [...(data?.items ?? []), ...extra];
  const w = workload.data;

  return (
    <>
      <PageHeader title="Tasks" meta={<InfoTip label="About tasks">Task deadlines never change when a post publishes, and finishing a task never approves anything.</InfoTip>}
        actions={<Button variant="primary" icon={<Plus aria-hidden className="size-4" />} onClick={() => setCreating(true)} disabledReason={!session.brands.length ? 'No brands yet.' : null}>New task</Button>} />
      {w ? (
        <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
          <MetricCard label="Assigned to me" value={w.mine.open} />
          <MetricCard label="Overdue" value={w.mine.overdue} />
          <MetricCard label="Due this week" value={w.mine.due_soon} />
          <MetricCard label="Created by me" value={w.mine.created_open} />
        </div>
      ) : null}
      <FilterBar label="Task filters">
        <FilterSelect id="tv" label="Show" value={view} onChange={(v) => setParams({ view: v === 'mine' ? null : v })}>
          <option value="mine">Assigned to me</option><option value="created">Created by me</option><option value="team">Team</option>
        </FilterSelect>
        <FilterSelect id="ts" label="Status" value={status} onChange={(v) => setParams({ status: v === 'open' ? null : v })}>
          <option value="open">Open</option><option value="done">Done</option>
        </FilterSelect>
        <FilterSelect id="td" label="Due" value={due} onChange={(v) => setParams({ due: v || null })}>
          <option value="">Any time</option><option value="overdue">Overdue</option><option value="upcoming">Next 7 days</option><option value="none">No deadline</option><option value="reassign">Needs a new assignee</option>
        </FilterSelect>
      </FilterBar>
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <section aria-label="Tasks" className="min-w-0">
          {error && !data ? <ErrorState error={error} onRetry={refetch} /> : loading && !data ? <SkeletonRows rows={5} /> : !items.length ? (
            <EmptyState icon={<ListTodo aria-hidden />} title={view === 'mine' ? 'Nothing assigned to you' : 'No tasks here'} action={<Button variant="secondary" onClick={() => setCreating(true)}>New task</Button>} />
          ) : (
            <ul className="flex flex-col gap-2">
              {items.map((t) => <li key={t.id}><TaskRow t={t} onOpen={(x) => setParams({ task: x.id })} /></li>)}
            </ul>
          )}
          {next ? <Button className="mt-3" variant="ghost" onClick={async () => { const r = await api.get<{ items: TaskDto[]; next_cursor: string | null }>(`/api/tasks?${qs}&cursor=${encodeURIComponent(next)}`); setExtra((l) => [...l, ...r.items]); setNext(r.next_cursor); }}>Load more</Button> : null}
        </section>
        {view === 'team' && w ? (
          <Card aria-labelledby="h-workload" className="self-start">
            <h2 id="h-workload" className="px-4 pt-4 text-[15px] font-semibold">Team workload</h2>
            <ul className="flex flex-col p-2">
              {w.people.map((p) => (
                <li key={p.user_id ?? 'none'} className="flex items-center gap-2 rounded-md px-2 py-2 text-[13px]">
                  <span className="min-w-0 flex-1 truncate">{p.user_id ? (p.name || p.email) : 'Unassigned'}</span>
                  <span className="tabular text-muted">{p.open} open</span>
                  {p.overdue ? <span className="tabular text-danger">{p.overdue} overdue</span> : null}
                </li>
              ))}
              {!w.people.length ? <li className="px-2 py-2 text-[13px] text-muted">No open tasks</li> : null}
            </ul>
          </Card>
        ) : null}
      </div>
      <TaskDrawer taskId={taskId} onClose={() => setParams({ task: null })} onChanged={() => { void refetch(); void workload.refetch(); }} />
      <Dialog open={creating} onOpenChange={setCreating} title="New task">
        {session.brands.length > 1 ? (
          <Field label="Brand" className="mb-3"><Select value={newBrand} onChange={(e) => setNewBrand(e.target.value)}>{session.brands.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</Select></Field>
        ) : null}
        {newBrand ? <TaskForm key={newBrand} ctx={{ brandId: newBrand, defaultTz: session.brands.find((b) => b.id === newBrand)?.timezone }} onCancel={() => setCreating(false)}
          onCreated={(t) => { setCreating(false); void refetch(); void workload.refetch(); setParams({ task: t.id }); }} /> : null}
      </Dialog>
    </>
  );
}
