'use client';
// Tasks: list rows, create form, detail drawer. A task's deadline is an editorial date — it never moves a schedule, and
// completing a task never approves or publishes anything.
import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { AlertTriangle, CalendarClock, Check, CircleDot, ListTodo, Plus, UserRound } from 'lucide-react';
import { resolveWallTime, toLocalInput } from '@social-lite/core';
import { api, isApiError } from '@/lib/client/api';
import { useApi } from '@/lib/client/use-api';
import { fmtDateTime, fmtRelative, zoneAbbr } from '@/lib/client/format';
import {
  Badge, Button, DetailDrawer, DrawerSection, EmptyState, ErrorNotice, Field, Input, Select, Skeleton, Textarea, cn, useToast,
} from '@/components/ui';
import type { TaskDto, TaskPriority, TaskStatus } from './types';

export const STATUS_LABEL: Record<TaskStatus, string> = { open: 'To do', in_progress: 'In progress', blocked: 'Blocked', completed: 'Done', cancelled: 'Cancelled' };
const STATUS_TONE: Record<TaskStatus, 'neutral' | 'info' | 'warn' | 'success'> = { open: 'neutral', in_progress: 'info', blocked: 'warn', completed: 'success', cancelled: 'neutral' };
const PRIORITY_LABEL: Record<TaskPriority, string> = { low: 'Low', normal: 'Normal', high: 'High', urgent: 'Urgent' };

function browserTz(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; }
}

export function TaskStatusBadge({ status }: { status: TaskStatus }) {
  return <Badge tone={STATUS_TONE[status]} icon={status === 'completed' ? <Check aria-hidden className="size-3" /> : status === 'blocked' ? <AlertTriangle aria-hidden className="size-3" /> : <CircleDot aria-hidden className="size-3" />}>{STATUS_LABEL[status]}</Badge>;
}

export function DueLabel({ t }: { t: Pick<TaskDto, 'due_at' | 'due_timezone' | 'overdue' | 'status'> }) {
  if (!t.due_at) return <span className="text-xs text-subtle">No deadline</span>;
  const open = t.status !== 'completed' && t.status !== 'cancelled';
  return (
    <span className={cn('inline-flex items-center gap-1 text-xs', t.overdue && open ? 'font-medium text-danger' : 'text-muted')}>
      <CalendarClock aria-hidden className="size-3.5" />
      {t.overdue && open ? 'Overdue · ' : ''}{fmtDateTime(t.due_at, t.due_timezone)} {zoneAbbr(t.due_at, t.due_timezone)}
    </span>
  );
}

export function TaskRow({ t, onOpen, showReference = true }: { t: TaskDto; onOpen: (t: TaskDto) => void; showReference?: boolean }) {
  return (
    <button type="button" onClick={() => onOpen(t)} className="flex w-full flex-col gap-1 rounded-lg border border-border px-3 py-2.5 text-left hover:bg-raised/60" data-testid="task-row">
      <div className="flex items-start gap-2">
        <span className="min-w-0 flex-1 text-[13px] font-medium">{t.title}</span>
        <TaskStatusBadge status={t.status} />
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <DueLabel t={t} />
        <span className="inline-flex items-center gap-1 text-xs text-muted"><UserRound aria-hidden className="size-3.5" />{t.assignee ? (t.assignee.name || t.assignee.email) : 'Unassigned'}</span>
        {t.priority === 'high' || t.priority === 'urgent' ? <Badge tone={t.priority === 'urgent' ? 'danger' : 'warn'}>{PRIORITY_LABEL[t.priority]}</Badge> : null}
        {t.needs_reassignment ? <Badge tone="warn">Needs a new assignee</Badge> : null}
        {showReference && t.reference ? <span className="truncate text-xs text-subtle">{t.brand.name} · {t.reference.type === 'review' ? 'Review' : t.reference.type === 'post' ? (t.reference.title || 'Post') : (t.reference.name || 'Campaign')}</span> : null}
      </div>
      <span className="text-xs text-[var(--accent-text)]">{t.next_action}</span>
    </button>
  );
}

interface Assignee { id: string; name: string | null; email: string; me: boolean }

export function AssigneePicker({ brandId, value, onChange, id }: { brandId: string; value: string | null; onChange: (id: string | null, label: string) => void; id?: string }) {
  const [q, setQ] = useState('');
  const { data } = useApi<{ items: Assignee[] }>(brandId ? `/api/tasks/assignees?brand_id=${brandId}&q=${encodeURIComponent(q)}` : null, { keepPrevious: true });
  const items = data?.items ?? [];
  return (
    <div className="flex flex-col gap-1.5">
      <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search people" aria-label="Search people to assign" />
      <Select id={id} aria-label={id ? undefined : 'Assignee'} value={value ?? ''} onChange={(e) => { const it = items.find((x) => x.id === e.target.value); onChange(e.target.value || null, it ? (it.name || it.email) : ''); }}>
        <option value="">Unassigned</option>
        {items.map((p) => <option key={p.id} value={p.id}>{p.me ? `Me (${p.name || p.email})` : `${p.name || p.email} · ${p.email}`}</option>)}
        {value && !items.some((x) => x.id === value) ? <option value={value}>Current assignee</option> : null}
      </Select>
    </div>
  );
}

export interface NewTaskInput { brandId: string; postId?: string | null; approvalId?: string | null; campaignId?: string | null; defaultTz?: string }

export function TaskForm({ ctx, onCreated, onCancel }: { ctx: NewTaskInput; onCreated: (t: TaskDto) => void; onCancel?: () => void }) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [assignee, setAssignee] = useState<string | null>(null);
  const [due, setDue] = useState('');
  const [tz, setTz] = useState(ctx.defaultTz ?? browserTz());
  const [priority, setPriority] = useState<TaskPriority>('normal');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  useEffect(() => { titleRef.current?.focus(); }, []);
  const dueRes = due ? resolveWallTime(due, tz) : null;
  const dueError = dueRes && dueRes.kind !== 'ok' ? dueRes.message : undefined;
  const submit = async () => {
    setBusy(true); setErr(null);
    try {
      const t = await api.post<TaskDto>('/api/tasks', {
        brand_id: ctx.brandId, post_id: ctx.postId ?? null, approval_id: ctx.approvalId ?? null, campaign_id: ctx.campaignId ?? null,
        title: title.trim(), description: description.trim() || null, assignee_id: assignee, priority,
        due_at: dueRes?.kind === 'ok' ? dueRes.instant.toISOString() : dueRes?.kind === 'ambiguous' ? dueRes.options[0]!.instant.toISOString() : null, due_timezone: tz,
      }, { idempotent: true });
      onCreated(t);
    } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  return (
    <form className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <Field label="Task" required><Input ref={titleRef} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} placeholder="e.g. Check the caption" /></Field>
      <Field label="Details" optional><Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} maxLength={4000} /></Field>
      <Field label="Assignee" optional><AssigneePicker brandId={ctx.brandId} value={assignee} onChange={(id) => setAssignee(id)} /></Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Deadline" optional error={dueError} info="Editorial deadline. It never changes when the post publishes.">
          <Input type="datetime-local" value={due} onChange={(e) => setDue(e.target.value)} />
        </Field>
        <Field label="Time zone"><Input value={tz} onChange={(e) => setTz(e.target.value)} list="tz-list" autoComplete="off" /></Field>
      </div>
      <Field label="Priority">
        <Select value={priority} onChange={(e) => setPriority(e.target.value as TaskPriority)}>
          {(['low', 'normal', 'high', 'urgent'] as const).map((p) => <option key={p} value={p}>{PRIORITY_LABEL[p]}</option>)}
        </Select>
      </Field>
      <TzList />
      {err ? <ErrorNotice error={err} /> : null}
      <div className="flex justify-end gap-2">
        {onCancel ? <Button variant="ghost" onClick={onCancel}>Cancel</Button> : null}
        <Button type="submit" variant="primary" loading={busy} disabledReason={!title.trim() ? 'Give the task a title.' : dueError ?? null}>Create task</Button>
      </div>
    </form>
  );
}

function TzList() {
  const zones = useMemo(() => {
    try { return (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.('timeZone') ?? []; } catch { return []; }
  }, []);
  return <datalist id="tz-list">{zones.map((z) => <option key={z} value={z} />)}</datalist>;
}

/** Task detail drawer: status, assignee, deadline, priority, follow, history. */
export function TaskDrawer({ taskId, onClose, onChanged }: { taskId: string | null; onClose: () => void; onChanged?: (t: TaskDto) => void }) {
  const toast = useToast();
  const { data, error, loading, refetch, setData } = useApi<TaskDto>(taskId ? `/api/tasks/${taskId}` : null);
  const [busy, setBusy] = useState(false);
  const [due, setDue] = useState<string | null>(null);
  useEffect(() => { setDue(null); }, [taskId]);
  const update = async (patch: Record<string, unknown>) => {
    if (!data) return;
    setBusy(true);
    try {
      await api.patch<TaskDto>(`/api/tasks/${data.id}`, { expected_version: data.version, ...patch });
      const fresh = await refetch();
      if (fresh) onChanged?.(fresh);
    } catch (e) {
      if (isApiError(e) && e.code === 'version_conflict') { toast.info('Someone else changed this task', 'Showing the latest.'); await refetch(); }
      else toast.error(e, 'Couldn’t update the task');
    } finally { setBusy(false); }
  };
  const t = data;
  const dueLocal = due ?? (t?.due_at ? toLocalInput(new Date(t.due_at), t.due_timezone) : '');
  return (
    <DetailDrawer open={!!taskId} onOpenChange={(o) => !o && onClose()} title={t?.title ?? 'Task'} meta={t ? `${t.brand.name}${t.reference ? ` · ${t.reference.type === 'review' ? 'Review request' : t.reference.type === 'post' ? (t.reference.title || 'Post') : (t.reference.name || 'Campaign')}` : ''}` : undefined}>
      {error && !t ? <ErrorNotice error={error} /> : loading || !t ? <Skeleton className="h-60 w-full rounded-lg" /> : (
        <div className="flex flex-col gap-5">
          <DrawerSection title="Status">
            <div className="flex flex-wrap items-center gap-2">
              <TaskStatusBadge status={t.status} />
              <span className="text-xs text-[var(--accent-text)]">{t.next_action}</span>
            </div>
            {t.can.change_status ? (
              <div className="mt-3 flex flex-wrap gap-2">
                {t.status !== 'in_progress' && t.status !== 'completed' && t.status !== 'cancelled' ? <Button size="sm" variant="secondary" disabled={busy} onClick={() => void update({ status: 'in_progress' })}>Start</Button> : null}
                {t.status !== 'completed' && t.status !== 'cancelled' ? <Button size="sm" variant="primary" icon={<Check aria-hidden className="size-4" />} disabled={busy} onClick={() => void update({ status: 'completed' })}>Mark done</Button> : null}
                {t.status !== 'blocked' && t.status !== 'completed' && t.status !== 'cancelled' ? <Button size="sm" variant="ghost" disabled={busy} onClick={() => void update({ status: 'blocked' })}>Blocked</Button> : null}
                {t.status === 'completed' || t.status === 'cancelled' ? <Button size="sm" variant="secondary" disabled={busy} onClick={() => void update({ status: 'open' })}>Reopen</Button> : null}
                {t.can.edit && t.status !== 'cancelled' && t.status !== 'completed' ? <Button size="sm" variant="ghost" disabled={busy} onClick={() => void update({ status: 'cancelled' })}>Cancel task</Button> : null}
              </div>
            ) : null}
            <p className="mt-2 text-xs text-muted">Completing a task never approves or publishes the post.</p>
          </DrawerSection>
          {t.description ? <DrawerSection title="Details"><p className="whitespace-pre-wrap text-[13px]">{t.description}</p></DrawerSection> : null}
          <DrawerSection title="Assignee">
            {t.can.edit || t.can.change_status ? (
              <AssigneePicker brandId={t.brand.id} value={t.assignee?.id ?? null} onChange={(id) => void update({ assignee_id: id })} />
            ) : <p className="text-[13px]">{t.assignee ? (t.assignee.name || t.assignee.email) : 'Unassigned'}</p>}
            {t.needs_reassignment ? <p className="mt-2 text-xs text-warn">The previous assignee lost access. Choose someone else.</p> : null}
          </DrawerSection>
          <DrawerSection title="Deadline">
            {t.can.edit || t.can.change_status ? (
              <div className="flex flex-wrap items-end gap-2">
                <Field label={`Local time (${t.due_timezone})`} className="min-w-0 flex-1"><Input type="datetime-local" value={dueLocal} onChange={(e) => setDue(e.target.value)} /></Field>
                <Button size="sm" variant="secondary" disabled={busy || due === null} onClick={() => {
                  const r = due ? resolveWallTime(due, t.due_timezone) : null;
                  if (r && r.kind !== 'ok' && r.kind !== 'ambiguous') { toast.error(new Error(r.message), 'Invalid time'); return; }
                  void update({ due_at: r ? (r.kind === 'ok' ? r.instant : r.options[0]!.instant).toISOString() : null }).then(() => setDue(null));
                }}>Save</Button>
                {t.due_at ? <Button size="sm" variant="ghost" disabled={busy} onClick={() => void update({ due_at: null })}>Clear</Button> : null}
              </div>
            ) : <DueLabel t={t} />}
          </DrawerSection>
          <DrawerSection title="Priority">
            {t.can.edit ? (
              <Select aria-label="Priority" value={t.priority} onChange={(e) => void update({ priority: e.target.value })}>
                {(['low', 'normal', 'high', 'urgent'] as const).map((p) => <option key={p} value={p}>{PRIORITY_LABEL[p]}</option>)}
              </Select>
            ) : <p className="text-[13px]">{PRIORITY_LABEL[t.priority]}</p>}
          </DrawerSection>
          <DrawerSection title="Links">
            <div className="flex flex-wrap gap-2">
              {t.post_id ? <Link className="text-[13px] text-[var(--accent-text)] underline-offset-2 hover:underline" href={`/posts/${t.post_id}?panel=tasks`}>Open post</Link> : null}
              {t.approval_id ? <Link className="text-[13px] text-[var(--accent-text)] underline-offset-2 hover:underline" href={`/approvals/${t.approval_id}`}>Open review</Link> : null}
              <Button size="sm" variant="ghost" onClick={async () => { const r = await api[t.following ? 'del' : 'post']<TaskDto>(`/api/tasks/${t.id}/follow`); setData({ ...t, ...r }); }}>{t.following ? 'Unfollow' : 'Follow'}</Button>
              <span className="text-xs text-muted">{t.follower_count} follower{t.follower_count === 1 ? '' : 's'}</span>
            </div>
          </DrawerSection>
          <DrawerSection title="History">
            <ol className="flex flex-col gap-1.5">
              {(t.history ?? []).map((h) => (
                <li key={h.id} className="text-xs text-muted"><span className="font-medium text-fg">{h.actor?.name || h.actor?.email || 'Someone'}</span> {historyText(h)} · {fmtRelative(h.at)}</li>
              ))}
            </ol>
          </DrawerSection>
        </div>
      )}
    </DetailDrawer>
  );
}

function historyText(h: NonNullable<TaskDto['history']>[number]): string {
  const d = h.detail as Record<string, unknown>;
  switch (h.kind) {
    case 'created': return 'created the task';
    case 'reassigned': return d.to ? 'reassigned it' : 'unassigned it';
    case 'status': return `set it to ${STATUS_LABEL[(d.to as TaskStatus) ?? 'open'] ?? d.to}`;
    case 'due_changed': return d.to ? 'moved the deadline' : 'cleared the deadline';
    case 'needs_reassignment': return 'flagged it: the assignee lost access';
    case 'edited': return 'edited it';
    default: return h.kind.replace(/_/g, ' ');
  }
}

/** Tasks of one post / review (composer panel). */
export function PostTasks({ postId, brandId, approvalId, tz, refreshKey = 0, onCount }: { postId: string; brandId: string; approvalId?: string | null; tz: string; refreshKey?: number; onCount?: (n: number) => void }) {
  const { data, error, loading, refetch } = useApi<{ items: TaskDto[] }>(`/api/tasks?view=all&status=all&post_id=${postId}&limit=50`);
  const [creating, setCreating] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => { if (refreshKey) void refetch(); }, [refreshKey, refetch]);
  useEffect(() => { if (data) onCount?.(data.items.filter((t) => t.status !== 'completed' && t.status !== 'cancelled').length); }, [data, onCount]);
  if (error && !data) return <ErrorNotice error={error} />;
  if (loading || !data) return <Skeleton className="h-24 w-full rounded-lg" />;
  const openItems = data.items.filter((t) => t.status !== 'completed' && t.status !== 'cancelled');
  const done = data.items.filter((t) => !openItems.includes(t));
  return (
    <div className="flex flex-col gap-3">
      {creating ? (
        <div className="rounded-lg border border-border p-3"><TaskForm ctx={{ brandId, postId, approvalId, defaultTz: tz }} onCancel={() => setCreating(false)} onCreated={() => { setCreating(false); void refetch(); }} /></div>
      ) : <Button size="sm" variant="secondary" className="self-start" icon={<Plus aria-hidden className="size-4" />} onClick={() => setCreating(true)}>New task</Button>}
      {!data.items.length ? <EmptyState compact icon={<ListTodo aria-hidden />} title="No tasks" /> : (
        <ul className="flex flex-col gap-2" aria-label="Tasks">
          {openItems.map((t) => <li key={t.id}><TaskRow t={t} onOpen={(x) => setOpen(x.id)} showReference={false} /></li>)}
          {done.length ? <li className="pt-1 text-xs font-medium text-muted">Done</li> : null}
          {done.map((t) => <li key={t.id} className="opacity-80"><TaskRow t={t} onOpen={(x) => setOpen(x.id)} showReference={false} /></li>)}
        </ul>
      )}
      <TaskDrawer taskId={open} onClose={() => setOpen(null)} onChanged={() => void refetch()} />
    </div>
  );
}
