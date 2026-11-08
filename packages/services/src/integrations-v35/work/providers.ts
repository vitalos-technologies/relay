// Task providers for external work items (Asana tasks, monday.com items) behind one small interface so the sync logic
// (work/tasks.ts) is shared and identical for both.
import { BizApiError } from '@social-lite/providers/biz/transport';
import {
  asanaCreateTask, asanaFindByMarker, asanaGetTask, asanaUpdateTask, type AsanaTask,
} from '@social-lite/providers/asana/client';
import {
  mondayCreateItem, mondayFindByMarker, mondayGetItem, mondayLabelFor, mondayStatusFromLabel, mondayUpdateItem, type MondayItem,
} from '@social-lite/providers/monday/client';
import type { TaskPriority, TaskStatus } from '@social-lite/core/contracts/v35-integrations';
import type { Conn } from '../core/types.js';

export interface ExtTask { id: string; url: string | null; title: string; due_on: string | null; status: TaskStatus; status_label: string | null; assignee: string | null; modified_at: string | null }
/** relay field → provider field (monday column id; Asana uses fixed fields). */
export type ColumnMap = Partial<Record<'title' | 'due_on' | 'status' | 'priority', string>>;

export interface TaskProvider {
  create(c: Conn, p: { resource: string; group?: string | null; title: string; description: string; dueOn: string | null; priority: TaskPriority; status: TaskStatus; assignee: string | null; marker: string; columns: ColumnMap }): Promise<ExtTask>;
  get(c: Conn, id: string, columns: ColumnMap): Promise<ExtTask>;
  update(c: Conn, id: string, resource: string, fields: Partial<{ title: string; due_on: string | null; status: TaskStatus; priority: TaskPriority }>, columns: ColumnMap): Promise<ExtTask>;
  findByMarker(c: Conn, resource: string, marker: string, columns: ColumnMap): Promise<ExtTask | null>;
  /** Accepts a provider URL or id; returns the external id or null. */
  parseRef(ref: string): string | null;
}

const asanaView = (t: AsanaTask): ExtTask => ({ id: t.gid, url: t.permalink_url, title: t.name, due_on: t.due_on, status: t.completed ? 'done' : 'open', status_label: t.completed ? 'Completed' : 'Incomplete', assignee: t.assignee?.name ?? null, modified_at: t.modified_at });

export const asanaTasks: TaskProvider = {
  async create(c, p) {
    const notes = `${p.description}\n\nPriority: ${p.priority}`;
    const t = await asanaCreateTask(c, { projectGid: p.resource, name: p.title, notes, dueOn: p.dueOn, assigneeGid: p.assignee, originMarker: p.marker });
    return asanaView(p.status === 'done' ? await asanaUpdateTask(c, t.gid, { completed: true }) : t);
  },
  async get(c, id) { return asanaView(await asanaGetTask(c, id)); },
  async update(c, id, _r, f) {
    const body: { name?: string; due_on?: string | null; completed?: boolean } = {};
    if (f.title !== undefined) body.name = f.title;
    if (f.due_on !== undefined) body.due_on = f.due_on;
    if (f.status !== undefined) body.completed = f.status === 'done';
    return asanaView(Object.keys(body).length ? await asanaUpdateTask(c, id, body) : await asanaGetTask(c, id));
  },
  async findByMarker(c, resource, marker) { const t = await asanaFindByMarker(c, resource, marker); return t ? asanaView(t) : null; },
  parseRef(ref) {
    const s = ref.trim();
    if (/^\d{6,20}$/.test(s) || /^mock_task_[\w]+$/.test(s)) return s;
    const m = /app\.asana\.com\/(?:0\/\d+\/|1\/\d+\/(?:project\/\d+\/)?task\/)(\d{6,20}|mock_task_\w+)/.exec(s) ?? /\/(\d{6,20})(?:\/f)?$/.exec(s);
    return m?.[1] ?? null;
  },
};

function mondayView(i: MondayItem, cols: ColumnMap): ExtTask {
  const col = (id?: string) => (id ? i.column_values.find((v) => v.id === id) : undefined);
  const st = col(cols.status);
  const due = col(cols.due_on);
  return { id: i.id, url: i.url, title: i.name, due_on: due?.text ? due.text.slice(0, 10) : null, status: mondayStatusFromLabel(st?.text), status_label: st?.text ?? null, assignee: null, modified_at: i.updated_at };
}

function mondayColumns(f: Partial<{ title: string; due_on: string | null; status: TaskStatus; priority: TaskPriority }>, cols: ColumnMap): Record<string, unknown> {
  const v: Record<string, unknown> = {};
  if (f.title !== undefined) v.name = f.title;
  if (f.due_on !== undefined && cols.due_on) v[cols.due_on] = f.due_on ? { date: f.due_on } : '';
  if (f.status !== undefined && cols.status) { const l = mondayLabelFor(f.status); v[cols.status] = l ? { label: l } : ''; }
  if (f.priority !== undefined && cols.priority) v[cols.priority] = { label: f.priority === 'urgent' ? 'Critical' : f.priority[0]!.toUpperCase() + f.priority.slice(1) };
  return v;
}

export const mondayTasks: TaskProvider = {
  async create(c, p) {
    const apiVersion = typeof c.settings.api_version === 'string' ? c.settings.api_version : undefined;
    const cols = mondayColumns({ due_on: p.dueOn, status: p.status, priority: p.priority }, p.columns);
    const i = await mondayCreateItem({ ...c, apiVersion }, { boardId: p.resource, groupId: p.group ?? null, name: p.title, columnValues: cols, summary: `${p.description}\n\nPriority: ${p.priority}`, originMarker: p.marker });
    return mondayView(i, p.columns);
  },
  async get(c, id, cols) { return mondayView(await mondayGetItem(c, id), cols); },
  async update(c, id, resource, f, cols) {
    const v = mondayColumns(f, cols);
    if (!Object.keys(v).length) return mondayView(await mondayGetItem(c, id), cols);
    return mondayView(await mondayUpdateItem(c, { boardId: resource, itemId: id, columnValues: v }), cols);
  },
  async findByMarker(c, resource, marker, cols) { const i = await mondayFindByMarker(c, resource, marker); return i ? mondayView(i, cols) : null; },
  parseRef(ref) {
    const s = ref.trim();
    if (/^\d{6,20}$/.test(s) || /^mock_item_\w+$/.test(s)) return s;
    return /\/pulses\/(\d{6,20}|mock_item_\w+)/.exec(s)?.[1] ?? null;
  },
};

export const TASK_PROVIDERS = { asana: asanaTasks, monday: mondayTasks } as const;
export const isNotFound = (e: unknown) => e instanceof BizApiError && e.kind === 'not_found';
