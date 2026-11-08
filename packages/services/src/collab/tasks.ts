// Tasks + editorial deadlines. A task is staff-only work linked to a post, campaign or review request: title,
// description, assignee, creator, due date + time zone, priority, status, followers and an immutable activity history.
//  - Completing a task never approves or publishes anything; a task's deadline is NOT the publication time (moving it
//    never touches a schedule).
//  - Assignees must be active staff with content.read on the brand at assign time; the worker re-checks (offboarding)
//    and flags or unassigns tasks whose assignee lost access (workspace policy), so admins can reassign.
//  - Optimistic concurrency on every update (expected_version).
import { randomUUID } from 'node:crypto';
import {
  AppError, OPEN_TASK_STATUSES, TASK_PRIORITIES, TASK_STATUSES, isValidTimeZone, notFound, reminderDue, toLocalInput, type TaskPriority, type TaskStatus,
} from '@social-lite/core';
import { getPool, many, maybeOne, one, withTx, type Queryable } from '@social-lite/db';
import type { Ctx } from '../context.js';
import { audit } from '../audit.js';
import { writeOutbox } from '../outbox.js';
import { loadUserAuthz, type AuthzState } from '../authz.js';
import { log } from '../log.js';
import { assertUuid, authorizeCtx, brandAllowed, isUuid, requireAction } from '../tenancy.js';
import { staffAllowed } from './access.js';
import { deliverNotification } from './notifications.js';
import { emitCollabEvent } from './events.js';
import { collabSettings } from './settings.js';

export interface TaskRow {
  id: string; workspace_id: string; brand_id: string; post_id: string | null; campaign_id: string | null; approval_id: string | null;
  title: string; description: string | null; assignee_id: string | null; created_by: string | null; due_at: Date | null; due_timezone: string;
  priority: TaskPriority; status: TaskStatus; blocked_reason: string | null; needs_reassignment: boolean; reassign_reason: string | null; version: number;
  reminded_soon_for: Date | null; overdue_reminders: number; last_reminded_at: Date | null; created_at: Date; updated_at: Date; closed_at: Date | null; closed_by: string | null;
}

type TaskListRow = TaskRow & { assignee_name: string | null; assignee_email: string | null; creator_name: string | null; creator_email: string | null;
  brand_name: string; post_title: string | null; campaign_name: string | null; follower_count: number; following: boolean };

const isOpen = (s: TaskStatus) => OPEN_TASK_STATUSES.includes(s);

/** "Sat 7 Nov, 08:03 GMT" in the task's own time zone (same style as the rest of the app). */
export function friendlyDue(at: Date, tz: string): string {
  const zone = isValidTimeZone(tz) ? tz : 'UTC';
  const d = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: zone }).format(at);
  const abbr = new Intl.DateTimeFormat('en-GB', { timeZone: zone, timeZoneName: 'short' }).formatToParts(at).find((p) => p.type === 'timeZoneName')?.value ?? zone;
  return `${d.replace(' at ', ', ')} ${abbr}`;
}

function nextAction(t: TaskRow, me: string, now = Date.now()): string {
  if (!isOpen(t.status)) return t.status === 'completed' ? 'Done' : 'Cancelled';
  if (t.needs_reassignment) return 'Needs a new assignee';
  if (!t.assignee_id) return 'Assign someone';
  if (t.assignee_id !== me) return t.status === 'blocked' ? 'Blocked' : 'Waiting on assignee';
  if (t.status === 'blocked') return 'Unblock or ask for help';
  if (t.due_at && t.due_at.getTime() < now) return 'Overdue — finish or move the deadline';
  if (t.approval_id) return t.status === 'open' ? 'Start the review' : 'Finish the review';
  return t.status === 'open' ? 'Start' : 'Finish';
}

function taskJson(t: TaskListRow, ctx: Ctx) {
  const now = Date.now();
  return {
    id: t.id, brand: { id: t.brand_id, name: t.brand_name }, title: t.title, description: t.description,
    reference: t.approval_id ? { type: 'review' as const, id: t.approval_id, post_id: t.post_id } : t.post_id ? { type: 'post' as const, id: t.post_id, title: t.post_title }
      : t.campaign_id ? { type: 'campaign' as const, id: t.campaign_id, name: t.campaign_name } : null,
    post_id: t.post_id, campaign_id: t.campaign_id, approval_id: t.approval_id,
    assignee: t.assignee_id ? { id: t.assignee_id, name: t.assignee_name, email: t.assignee_email } : null,
    creator: t.created_by ? { id: t.created_by, name: t.creator_name, email: t.creator_email } : null,
    due_at: t.due_at?.toISOString() ?? null, due_timezone: t.due_timezone, due_local: t.due_at ? toLocalInput(t.due_at, isValidTimeZone(t.due_timezone) ? t.due_timezone : 'UTC') : null,
    overdue: !!t.due_at && isOpen(t.status) && t.due_at.getTime() < now,
    priority: t.priority, status: t.status, blocked_reason: t.blocked_reason, needs_reassignment: t.needs_reassignment,
    version: t.version, created_at: t.created_at.toISOString(), updated_at: t.updated_at.toISOString(), closed_at: t.closed_at?.toISOString() ?? null,
    follower_count: Number(t.follower_count ?? 0), following: !!t.following,
    next_action: nextAction(t, ctx.actor.userId, now),
    can: {
      edit: canManageTask(ctx, t),
      change_status: canManageTask(ctx, t) || t.assignee_id === ctx.actor.userId,
    },
  };
}
export type TaskDto = ReturnType<typeof taskJson>;

const TASK_SELECT = `t.*, au.name AS assignee_name, au.email AS assignee_email, cu.name AS creator_name, cu.email AS creator_email, b.name AS brand_name,
  p.title AS post_title, cp.name AS campaign_name,
  (SELECT count(*)::int FROM collab_task_followers f WHERE f.task_id=t.id) AS follower_count,
  EXISTS (SELECT 1 FROM collab_task_followers f WHERE f.task_id=t.id AND f.user_id=$ME) AS following`;
const TASK_FROM = `collab_tasks t JOIN brands b ON b.id=t.brand_id LEFT JOIN users au ON au.id=t.assignee_id LEFT JOIN users cu ON cu.id=t.created_by
  LEFT JOIN posts p ON p.id=t.post_id LEFT JOIN campaigns cp ON cp.id=t.campaign_id`;

function contributor(ctx: Ctx, brandId: string): boolean {
  return ['content.edit', 'content.submit', 'content.approve', 'brands.manage'].some((p) => authorizeCtx(ctx, p as 'content.edit', { brandId }).allowed);
}

function canManageTask(ctx: Ctx, t: Pick<TaskRow, 'brand_id' | 'created_by'>): boolean {
  return t.created_by === ctx.actor.userId || authorizeCtx(ctx, 'brands.manage', { brandId: t.brand_id }).allowed;
}

async function assigneeEntitled(db: Queryable, workspaceId: string, userId: string, brandId: string, state?: AuthzState): Promise<boolean> {
  const s = state ?? await loadUserAuthz(userId, workspaceId, null, db);
  return s.subject.status === 'active' && staffAllowed(s, 'content.read', brandId);
}

async function assertAssignee(db: Queryable, ctx: Ctx, userId: string, brandId: string): Promise<void> {
  if (!isUuid(userId)) throw new AppError('validation_failed', 'Unknown person', { assignee_id: 'Unknown person' });
  if (!(await assigneeEntitled(db, ctx.access.workspaceId, userId, brandId))) {
    throw new AppError('validation_failed', 'This person can’t see this brand', { assignee_id: 'No access to this brand' });
  }
  if (userId !== ctx.actor.userId) {
    const s = await collabSettings(db, ctx.access.workspaceId);
    if (s.task_assign === 'managers' && !authorizeCtx(ctx, 'brands.manage', { brandId }).allowed) {
      throw new AppError('forbidden', 'Only brand managers can assign tasks to others in this workspace');
    }
  }
}

function parseDue(v: unknown, field = 'due_at'): Date | null | undefined {
  if (v === undefined) return undefined;
  if (v === null || v === '') return null;
  const d = new Date(String(v));
  if (Number.isNaN(d.getTime())) throw new AppError('validation_failed', 'Invalid date', { [field]: 'Use an ISO date' });
  return d;
}

async function event(tx: Queryable, ctx: Ctx | null, t: Pick<TaskRow, 'id' | 'workspace_id' | 'brand_id' | 'post_id'>, kind: string, detail: Record<string, unknown> = {}, service?: string) {
  await tx.query(`INSERT INTO collab_task_events(workspace_id, task_id, actor_id, actor_service, kind, detail) VALUES ($1,$2,$3,$4,$5,$6)`,
    [t.workspace_id, t.id, ctx?.actor.userId ?? null, service ?? null, kind, JSON.stringify(detail)]);
  await emitCollabEvent(tx, { workspaceId: t.workspace_id, brandId: t.brand_id, postId: t.post_id, audience: 'staff', kind: kind === 'created' ? 'task.created' : 'task.updated', refId: t.id, actorId: ctx?.actor.userId ?? null });
}

async function loadTaskRow(db: Queryable, ctx: Ctx, id: string, lock = false): Promise<TaskRow> {
  assertUuid(id, 'Task');
  const t = await maybeOne<TaskRow>(db, `SELECT * FROM collab_tasks WHERE id=$1 AND workspace_id=$2 ${lock ? 'FOR UPDATE' : ''}`, [id, ctx.access.workspaceId]);
  if (!t || !brandAllowed(ctx, t.brand_id) || !(ctx.access.authz ? staffAllowed(ctx.access.authz, 'content.read', t.brand_id) : true)) throw notFound('Task');
  return t;
}

async function taskDto(db: Queryable, ctx: Ctx, id: string) {
  const r = await one<TaskListRow>(db, `SELECT ${TASK_SELECT.replace(/\$ME/g, '$2')} FROM ${TASK_FROM} WHERE t.id=$1`, [id, ctx.actor.userId]);
  return taskJson(r, ctx);
}

export interface TaskInput {
  brand_id?: string | null; post_id?: string | null; campaign_id?: string | null; approval_id?: string | null;
  title: string; description?: string | null; assignee_id?: string | null; due_at?: string | null; due_timezone?: string | null;
  priority?: TaskPriority; follower_ids?: string[];
}

/** Create a task. The brand comes from the reference when there is one (never trusted from the payload alone). */
export async function createTask(ctx: Ctx, input: TaskInput) {
  requireAction(ctx, 'content.read');
  const title = String(input.title ?? '').trim();
  if (!title || title.length > 200) throw new AppError('validation_failed', 'Give the task a title (1–200 characters)', { title: 'Required' });
  if (input.description && input.description.length > 4000) throw new AppError('validation_failed', 'Description is too long', { description: 'Max 4000 characters' });
  const priority = input.priority ?? 'normal';
  if (!TASK_PRIORITIES.includes(priority)) throw new AppError('validation_failed', 'Unknown priority', { priority: 'Invalid' });
  const tz = input.due_timezone ?? 'UTC';
  if (!isValidTimeZone(tz)) throw new AppError('validation_failed', 'Unknown time zone', { due_timezone: 'Use an IANA time zone' });
  const due = parseDue(input.due_at) ?? null;
  const id = await withTx(async (tx) => {
    let brandId = input.brand_id ?? null;
    let postId = input.post_id ?? null;
    if (input.approval_id) {
      assertUuid(input.approval_id, 'Review');
      const a = await maybeOne<{ brand_id: string; post_id: string }>(tx, `SELECT brand_id, post_id FROM approvals WHERE id=$1 AND workspace_id=$2`, [input.approval_id, ctx.access.workspaceId]);
      if (!a || (postId && postId !== a.post_id)) throw notFound('Review');
      brandId = a.brand_id; postId = a.post_id;
    }
    if (postId) {
      assertUuid(postId, 'Post');
      const p = await maybeOne<{ brand_id: string }>(tx, `SELECT brand_id FROM posts WHERE id=$1 AND workspace_id=$2 AND deleted_at IS NULL`, [postId, ctx.access.workspaceId]);
      if (!p || (brandId && brandId !== p.brand_id)) throw notFound('Post');
      brandId = p.brand_id;
    }
    if (input.campaign_id) {
      assertUuid(input.campaign_id, 'Campaign');
      const c = await maybeOne<{ brand_id: string }>(tx, `SELECT brand_id FROM campaigns WHERE id=$1 AND workspace_id=$2 AND archived_at IS NULL`, [input.campaign_id, ctx.access.workspaceId]);
      if (!c || (brandId && brandId !== c.brand_id)) throw notFound('Campaign');
      brandId = c.brand_id;
    }
    if (!brandId || !isUuid(brandId) || !brandAllowed(ctx, brandId)) throw notFound('Brand');
    if (!contributor(ctx, brandId)) throw new AppError('forbidden', 'You can’t create tasks for this brand');
    if (input.assignee_id) await assertAssignee(tx, ctx, input.assignee_id, brandId);
    const t = await one<TaskRow>(tx,
      `INSERT INTO collab_tasks(workspace_id, brand_id, post_id, campaign_id, approval_id, title, description, assignee_id, created_by, due_at, due_timezone, priority)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [ctx.access.workspaceId, brandId, postId, input.campaign_id ?? null, input.approval_id ?? null, title, input.description?.trim() || null,
        input.assignee_id ?? null, ctx.actor.userId, due, tz, priority]);
    for (const f of [...new Set(input.follower_ids ?? [])].slice(0, 20)) {
      if (isUuid(f) && (await assigneeEntitled(tx, ctx.access.workspaceId, f, brandId))) {
        await tx.query(`INSERT INTO collab_task_followers(workspace_id, task_id, user_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [ctx.access.workspaceId, t.id, f]);
      }
    }
    await event(tx, ctx, t, 'created', { assignee_id: t.assignee_id, due_at: due?.toISOString() ?? null, priority });
    if (t.assignee_id && t.assignee_id !== ctx.actor.userId) await notifyOutbox(tx, t, 'assigned', t.assignee_id);
    await audit(tx, { workspaceId: ctx.access.workspaceId, brandId, actorUserId: ctx.actor.userId, action: 'task.created', resourceType: 'task', resourceId: t.id,
      diff: { post_id: postId, campaign_id: input.campaign_id ?? null, approval_id: input.approval_id ?? null, assignee_id: t.assignee_id, due_at: due?.toISOString() ?? null }, correlationId: ctx.correlationId });
    return t.id;
  });
  return taskDto(getPool(), ctx, id);
}

async function notifyOutbox(tx: Queryable, t: Pick<TaskRow, 'id' | 'workspace_id' | 'brand_id'>, kind: string, userId?: string | null) {
  await writeOutbox(tx, { workspaceId: t.workspace_id, aggregateType: 'task', aggregateId: t.id, eventType: 'task.changed',
    payload: { kind, userId: userId ?? null, brandId: t.brand_id, eventId: randomUUID() } });
}

export interface TaskPatch {
  expected_version: number; title?: string; description?: string | null; assignee_id?: string | null; due_at?: string | null; due_timezone?: string;
  priority?: TaskPriority; status?: TaskStatus; blocked_reason?: string | null;
}

/** Update fields / status / assignee with optimistic concurrency. Status changes never approve or publish anything. */
export async function updateTask(ctx: Ctx, taskId: string, patch: TaskPatch) {
  if (!Number.isInteger(patch.expected_version)) throw new AppError('validation_failed', 'expected_version is required', { expected_version: 'Required' });
  const id = await withTx(async (tx) => {
    const t = await loadTaskRow(tx, ctx, taskId, true);
    if (t.version !== patch.expected_version) {
      throw new AppError('version_conflict', 'Someone else changed this task. Reload to see the latest.', undefined, { current_version: t.version });
    }
    const manage = canManageTask(ctx, t);
    const isAssignee = t.assignee_id === ctx.actor.userId;
    const fieldEdit = ['title', 'description', 'due_at', 'due_timezone', 'priority'].some((k) => (patch as unknown as Record<string, unknown>)[k] !== undefined);
    if (fieldEdit && !manage && !isAssignee) throw new AppError('forbidden', 'Only the creator, the assignee or a brand manager can edit this task');
    if (patch.status !== undefined && !manage && !isAssignee) throw new AppError('forbidden', 'Only the creator, the assignee or a brand manager can change the status');
    if (patch.assignee_id !== undefined && !manage && !isAssignee) throw new AppError('forbidden', 'Only the creator, the assignee or a brand manager can reassign');
    const next = { ...t };
    const changes: Record<string, unknown> = {};
    if (patch.title !== undefined) {
      const v = patch.title.trim();
      if (!v || v.length > 200) throw new AppError('validation_failed', 'Give the task a title (1–200 characters)', { title: 'Required' });
      if (v !== t.title) { next.title = v; changes.title = true; }
    }
    if (patch.description !== undefined) {
      const v = patch.description?.trim() || null;
      if (v && v.length > 4000) throw new AppError('validation_failed', 'Description is too long', { description: 'Max 4000 characters' });
      if (v !== t.description) { next.description = v; changes.description = true; }
    }
    if (patch.priority !== undefined) {
      if (!TASK_PRIORITIES.includes(patch.priority)) throw new AppError('validation_failed', 'Unknown priority', { priority: 'Invalid' });
      if (patch.priority !== t.priority) { next.priority = patch.priority; changes.priority = patch.priority; }
    }
    if (patch.due_timezone !== undefined) {
      if (!isValidTimeZone(patch.due_timezone)) throw new AppError('validation_failed', 'Unknown time zone', { due_timezone: 'Use an IANA time zone' });
      if (patch.due_timezone !== t.due_timezone) { next.due_timezone = patch.due_timezone; changes.due_timezone = patch.due_timezone; }
    }
    const due = parseDue(patch.due_at);
    if (due !== undefined && (due?.getTime() ?? null) !== (t.due_at?.getTime() ?? null)) {
      next.due_at = due; changes.due_at = due?.toISOString() ?? null;
      // A new deadline gets its own (bounded) reminders. Never touches any schedule.
      next.reminded_soon_for = null; next.overdue_reminders = 0; next.last_reminded_at = null;
    }
    if (patch.assignee_id !== undefined && patch.assignee_id !== t.assignee_id) {
      if (patch.assignee_id) await assertAssignee(tx, ctx, patch.assignee_id, t.brand_id);
      next.assignee_id = patch.assignee_id; changes.assignee_id = patch.assignee_id;
      next.needs_reassignment = false; next.reassign_reason = null;
    }
    if (patch.status !== undefined && patch.status !== t.status) {
      if (!TASK_STATUSES.includes(patch.status)) throw new AppError('validation_failed', 'Unknown status', { status: 'Invalid' });
      next.status = patch.status; changes.status = { from: t.status, to: patch.status };
      if (!isOpen(patch.status)) { next.closed_at = new Date(); next.closed_by = ctx.actor.userId; } else { next.closed_at = null; next.closed_by = null; }
      if (patch.status !== 'blocked') next.blocked_reason = null;
    }
    if (patch.blocked_reason !== undefined) {
      if (patch.blocked_reason && patch.blocked_reason.length > 500) throw new AppError('validation_failed', 'Keep the reason short', { blocked_reason: 'Max 500 characters' });
      if (next.status === 'blocked') next.blocked_reason = patch.blocked_reason?.trim() || null;
    }
    if (!Object.keys(changes).length && next.blocked_reason === t.blocked_reason) return t.id;
    await tx.query(
      `UPDATE collab_tasks SET title=$2, description=$3, assignee_id=$4, due_at=$5, due_timezone=$6, priority=$7, status=$8, blocked_reason=$9,
         needs_reassignment=$10, reassign_reason=$11, reminded_soon_for=$12, overdue_reminders=$13, last_reminded_at=$14, closed_at=$15, closed_by=$16,
         version=version+1, updated_at=now() WHERE id=$1`,
      [t.id, next.title, next.description, next.assignee_id, next.due_at, next.due_timezone, next.priority, next.status, next.blocked_reason,
        next.needs_reassignment, next.reassign_reason, next.reminded_soon_for, next.overdue_reminders, next.last_reminded_at, next.closed_at, next.closed_by]);
    if (changes.assignee_id !== undefined) await event(tx, ctx, t, 'reassigned', { from: t.assignee_id, to: next.assignee_id });
    if (changes.status) await event(tx, ctx, t, 'status', changes.status as Record<string, unknown>);
    if (changes.due_at !== undefined) await event(tx, ctx, t, 'due_changed', { from: t.due_at?.toISOString() ?? null, to: changes.due_at });
    const other = Object.keys(changes).filter((k) => !['assignee_id', 'status', 'due_at'].includes(k));
    if (other.length) await event(tx, ctx, t, 'edited', { fields: other });
    if (changes.assignee_id && next.assignee_id && next.assignee_id !== ctx.actor.userId) await notifyOutbox(tx, t, 'assigned', next.assignee_id);
    if (changes.status && (next.status === 'completed' || next.status === 'cancelled' || next.status === 'blocked')) await notifyOutbox(tx, { ...t }, next.status);
    if (changes.due_at !== undefined && next.assignee_id && next.assignee_id !== ctx.actor.userId) await notifyOutbox(tx, t, 'due_changed', next.assignee_id);
    await audit(tx, { workspaceId: ctx.access.workspaceId, brandId: t.brand_id, actorUserId: ctx.actor.userId, action: 'task.updated', resourceType: 'task', resourceId: t.id,
      diff: { post_id: t.post_id, ...changes }, correlationId: ctx.correlationId });
    return t.id;
  });
  return taskDto(getPool(), ctx, id);
}

export async function setTaskFollowing(ctx: Ctx, taskId: string, follow: boolean) {
  await withTx(async (tx) => {
    const t = await loadTaskRow(tx, ctx, taskId);
    if (follow) await tx.query(`INSERT INTO collab_task_followers(workspace_id, task_id, user_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [ctx.access.workspaceId, t.id, ctx.actor.userId]);
    else await tx.query(`DELETE FROM collab_task_followers WHERE task_id=$1 AND user_id=$2`, [t.id, ctx.actor.userId]);
  });
  return taskDto(getPool(), ctx, taskId);
}

export async function getTask(ctx: Ctx, taskId: string) {
  const db = getPool();
  const t = await loadTaskRow(db, ctx, taskId);
  const dto = await taskDto(db, ctx, t.id);
  const events = await many<{ id: string; kind: string; detail: Record<string, unknown>; actor_id: string | null; actor_service: string | null; name: string | null; email: string | null; created_at: Date }>(db,
    `SELECT e.id::text, e.kind, e.detail, e.actor_id, e.actor_service, u.name, u.email, e.created_at FROM collab_task_events e LEFT JOIN users u ON u.id=e.actor_id
      WHERE e.task_id=$1 ORDER BY e.id DESC LIMIT 50`, [t.id]);
  const followers = await many<{ user_id: string; name: string | null; email: string }>(db,
    `SELECT f.user_id, u.name, u.email FROM collab_task_followers f JOIN users u ON u.id=f.user_id WHERE f.task_id=$1 ORDER BY f.created_at LIMIT 50`, [t.id]);
  return {
    ...dto,
    followers: followers.map((f) => ({ id: f.user_id, name: f.name, email: f.email })),
    history: events.map((e) => ({ id: e.id, kind: e.kind, detail: e.detail, actor: e.actor_id ? { id: e.actor_id, name: e.name, email: e.email } : e.actor_service ? { id: null, name: 'Relay', email: null } : null, at: e.created_at.toISOString() })),
  };
}

export interface TaskQuery { view?: string | null; status?: string | null; due?: string | null; brand_id?: string | null; post_id?: string | null; approval_id?: string | null; assignee_id?: string | null; cursor?: string | null; limit?: number | null }

/** Assigned to me / Created by me / Team (visible brands), with overdue / upcoming filters; keyset-paginated. */
export async function listTasks(ctx: Ctx, q: TaskQuery = {}) {
  requireAction(ctx, 'content.read');
  const db = getPool();
  const limit = Math.min(Math.max(q.limit ?? 30, 1), 100);
  const view = q.view === 'created' ? 'created' : q.view === 'team' ? 'team' : q.view === 'all' ? 'all' : 'mine';
  const status = q.status === 'done' ? 'done' : q.status === 'all' ? 'all' : 'open';
  const params: unknown[] = [ctx.access.workspaceId, ctx.actor.userId];
  const where: string[] = ['t.workspace_id=$1'];
  if (ctx.access.brandIds !== null) { params.push(ctx.access.brandIds); where.push(`t.brand_id = ANY($${params.length}::uuid[])`); }
  if (ctx.access.authz) {
    // staff only (guest grants never see tasks)
    const brands = (await many<{ id: string }>(db, `SELECT id FROM brands WHERE workspace_id=$1 AND archived_at IS NULL`, [ctx.access.workspaceId]))
      .map((b) => b.id).filter((b) => staffAllowed(ctx.access.authz!, 'content.read', b));
    params.push(brands); where.push(`t.brand_id = ANY($${params.length}::uuid[])`);
  }
  if (view === 'mine') where.push('t.assignee_id=$2');
  if (view === 'created') where.push('t.created_by=$2');
  if (status === 'open') where.push(`t.status IN ('open','in_progress','blocked')`);
  if (status === 'done') where.push(`t.status IN ('completed','cancelled')`);
  if (q.due === 'overdue') where.push(`t.due_at < now() AND t.status IN ('open','in_progress','blocked')`);
  if (q.due === 'upcoming') where.push(`t.due_at >= now() AND t.due_at < now() + interval '7 days'`);
  if (q.due === 'none') where.push('t.due_at IS NULL');
  if (q.due === 'reassign') where.push('t.needs_reassignment');
  for (const [k, col] of [['brand_id', 'brand_id'], ['post_id', 'post_id'], ['approval_id', 'approval_id'], ['assignee_id', 'assignee_id']] as const) {
    const v = q[k];
    if (v) { assertUuid(v, k); params.push(v); where.push(`t.${col}=$${params.length}`); }
  }
  const doneOrder = status === 'done';
  const sortKey = doneOrder ? `t.closed_at` : `coalesce(t.due_at, 'infinity'::timestamptz)`;
  if (q.cursor) {
    const [k, id] = Buffer.from(q.cursor, 'base64url').toString().split('|');
    if (!k || !isUuid(id)) throw new AppError('validation_failed', 'Invalid cursor');
    params.push(k, id);
    where.push(doneOrder ? `(${sortKey}, t.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)` : `(${sortKey}, t.id) > ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
  }
  params.push(limit + 1);
  const rows = await many<TaskListRow & { sort_key: Date | string }>(db,
    `SELECT ${TASK_SELECT.replace(/\$ME/g, '$2')}, ${sortKey} AS sort_key FROM ${TASK_FROM} WHERE ${where.join(' AND ')}
      ORDER BY ${sortKey} ${doneOrder ? 'DESC' : 'ASC'}, t.id ${doneOrder ? 'DESC' : 'ASC'} LIMIT $${params.length}`, params);
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  const keyOf = (r: TaskListRow & { sort_key: Date | string }) => (r.sort_key instanceof Date ? r.sort_key.toISOString() : String(r.sort_key));
  return {
    items: page.map((r) => taskJson(r, ctx)),
    next_cursor: rows.length > limit && last ? Buffer.from(`${keyOf(last)}|${last.id}`).toString('base64url') : null,
  };
}

/** Counts for the "My work" header + team workload (open / overdue / due this week per assignee). */
export async function taskWorkload(ctx: Ctx, q: { brand_id?: string | null } = {}) {
  requireAction(ctx, 'content.read');
  const db = getPool();
  const brands = (await many<{ id: string }>(db, `SELECT id FROM brands WHERE workspace_id=$1 AND archived_at IS NULL`, [ctx.access.workspaceId]))
    .map((b) => b.id).filter((b) => brandAllowed(ctx, b) && (!ctx.access.authz || staffAllowed(ctx.access.authz, 'content.read', b)))
    .filter((b) => !q.brand_id || b === q.brand_id);
  const mine = await one<{ open: number; overdue: number; due_soon: number; created_open: number }>(db,
    `SELECT count(*) FILTER (WHERE assignee_id=$2 AND status IN ('open','in_progress','blocked'))::int AS open,
            count(*) FILTER (WHERE assignee_id=$2 AND status IN ('open','in_progress','blocked') AND due_at < now())::int AS overdue,
            count(*) FILTER (WHERE assignee_id=$2 AND status IN ('open','in_progress','blocked') AND due_at >= now() AND due_at < now() + interval '7 days')::int AS due_soon,
            count(*) FILTER (WHERE created_by=$2 AND status IN ('open','in_progress','blocked'))::int AS created_open
       FROM collab_tasks WHERE workspace_id=$1 AND brand_id = ANY($3::uuid[])`, [ctx.access.workspaceId, ctx.actor.userId, brands]);
  const people = await many<{ user_id: string | null; name: string | null; email: string | null; open: number; overdue: number; due_soon: number; blocked: number }>(db,
    `SELECT t.assignee_id AS user_id, u.name, u.email, count(*)::int AS open, count(*) FILTER (WHERE t.due_at < now())::int AS overdue,
            count(*) FILTER (WHERE t.due_at >= now() AND t.due_at < now() + interval '7 days')::int AS due_soon,
            count(*) FILTER (WHERE t.status='blocked')::int AS blocked
       FROM collab_tasks t LEFT JOIN users u ON u.id=t.assignee_id
      WHERE t.workspace_id=$1 AND t.brand_id = ANY($2::uuid[]) AND t.status IN ('open','in_progress','blocked')
      GROUP BY t.assignee_id, u.name, u.email ORDER BY count(*) FILTER (WHERE t.due_at < now()) DESC, count(*) DESC LIMIT 100`, [ctx.access.workspaceId, brands]);
  return { mine, people: people.map((p) => ({ ...p, user_id: p.user_id, unassigned: !p.user_id })) };
}

/** People who can be assigned on a brand (bounded search; entitlement checked per candidate). */
export async function taskAssignees(ctx: Ctx, brandId: string, q = '') {
  requireAction(ctx, 'content.read');
  const db = getPool();
  if (!isUuid(brandId) || !brandAllowed(ctx, brandId)) throw notFound('Brand');
  const term = q.trim().replace(/[%_\\]/g, '').slice(0, 40);
  const members = await many<{ user_id: string; email: string; name: string | null }>(db,
    `SELECT m.user_id, u.email, u.name FROM memberships m JOIN users u ON u.id=m.user_id
      WHERE m.workspace_id=$1 AND m.status='active' AND m.removed_at IS NULL
        AND ($2 = '' OR u.name ILIKE $2 || '%' OR u.email ILIKE $2 || '%' OR u.name ILIKE '% ' || $2 || '%')
      ORDER BY (m.user_id = $3) DESC, u.name NULLS LAST, u.email LIMIT 40`, [ctx.access.workspaceId, term, ctx.actor.userId]);
  const out: Array<{ id: string; name: string | null; email: string; me: boolean }> = [];
  for (const m of members) {
    if (out.length >= 10) break;
    if (await assigneeEntitled(db, ctx.access.workspaceId, m.user_id, brandId)) out.push({ id: m.user_id, name: m.name, email: m.email, me: m.user_id === ctx.actor.userId });
  }
  return { items: out };
}

// ------------------------------------------------------------------ outbox + sweeps
/** Outbox 'task.changed': assignment / due change → assignee; completion, cancellation, blocking → creator + followers. */
export async function onTaskChanged(db: Queryable, evt: { workspace_id: string; aggregate_id: string; payload: Record<string, unknown> }) {
  const t = await maybeOne<TaskRow>(db, `SELECT * FROM collab_tasks WHERE id=$1 AND workspace_id=$2`, [evt.aggregate_id, evt.workspace_id]);
  if (!t) return;
  const kind = String(evt.payload.kind ?? '');
  const eventId = String(evt.payload.eventId ?? '');
  const base = { workspaceId: t.workspace_id, referenceType: 'task', referenceId: t.id, linkPath: `/tasks?task=${t.id}`, requirement: { brandId: t.brand_id, permission: 'content.read' as const } };
  if (kind === 'assigned' || kind === 'due_changed') {
    const uid = String(evt.payload.userId ?? '');
    if (!isUuid(uid) || uid !== t.assignee_id) return; // reassigned again since: the newer event notifies
    await deliverNotification(db, { ...base, userId: uid, event: 'assignment', kind: kind === 'assigned' ? 'task.assigned' : 'task.due_changed',
      title: kind === 'assigned' ? 'A task was assigned to you' : 'A task deadline changed', body: t.due_at ? `Due ${friendlyDue(t.due_at, t.due_timezone)}` : null, dedupeKey: `task:${t.id}:${kind}:${eventId}` });
    return;
  }
  if (kind === 'completed' || kind === 'cancelled' || kind === 'blocked') {
    const followers = await many<{ user_id: string }>(db, `SELECT user_id FROM collab_task_followers WHERE task_id=$1 LIMIT 50`, [t.id]);
    const who = new Set([t.created_by, ...followers.map((f) => f.user_id)].filter((x): x is string => !!x && x !== t.closed_by));
    if (kind === 'blocked') who.delete(t.assignee_id ?? '');
    const title = kind === 'completed' ? 'A task you follow was completed' : kind === 'cancelled' ? 'A task you follow was cancelled' : 'A task you follow is blocked';
    for (const uid of who) await deliverNotification(db, { ...base, userId: uid, event: 'assignment', kind: `task.${kind}`, title, body: null, dedupeKey: `task:${t.id}:${kind}:${eventId}` });
  }
}

/** Worker: bounded, timezone-aware deadline reminders (one "due soon" per deadline, ≤ N overdue, ≥ 24 h apart). */
export async function runTaskReminders(db: Queryable = getPool(), now = new Date(), limit = 200): Promise<number> {
  const rows = await many<TaskRow & { lead: number; max_over: number }>(db,
    `SELECT t.*, coalesce(s.reminder_lead_hours, 24) AS lead, coalesce(s.max_overdue_reminders, 3) AS max_over
       FROM collab_tasks t LEFT JOIN workspace_collab_settings s ON s.workspace_id=t.workspace_id
      WHERE t.status IN ('open','in_progress','blocked') AND t.due_at IS NOT NULL AND t.assignee_id IS NOT NULL AND NOT t.needs_reassignment
        AND t.due_at <= $1::timestamptz + make_interval(hours => coalesce(s.reminder_lead_hours, 24))
        AND (t.last_reminded_at IS NULL OR t.last_reminded_at < $1::timestamptz - interval '1 hour')
      ORDER BY t.due_at LIMIT $2`, [now, limit]);
  let sent = 0;
  for (const t of rows) {
    const d = reminderDue({ now, dueAt: t.due_at!, leadHours: t.lead, maxOverdue: t.max_over, remindedSoonFor: t.reminded_soon_for, overdueReminders: t.overdue_reminders, lastRemindedAt: t.last_reminded_at });
    if (!d) continue;
    const r = await deliverNotification(db, {
      workspaceId: t.workspace_id, userId: t.assignee_id!, event: 'reminder', kind: d.kind === 'soon' ? 'task.reminder.soon' : 'task.reminder.overdue',
      severity: d.kind === 'overdue' ? 'warning' : 'info',
      title: d.kind === 'soon' ? 'A task is due soon' : 'A task is overdue', body: `Due ${friendlyDue(t.due_at!, t.due_timezone)}`,
      referenceType: 'task', referenceId: t.id, linkPath: `/tasks?task=${t.id}`,
      dedupeKey: d.kind === 'soon' ? `task:${t.id}:soon:${t.due_at!.getTime()}` : `task:${t.id}:overdue:${t.due_at!.getTime()}:${d.n}`,
      requirement: { brandId: t.brand_id, permission: 'content.read' },
    }, now);
    if (d.kind === 'soon') await db.query(`UPDATE collab_tasks SET reminded_soon_for=due_at, last_reminded_at=$2 WHERE id=$1`, [t.id, now]);
    else await db.query(`UPDATE collab_tasks SET overdue_reminders=$2, last_reminded_at=$3 WHERE id=$1`, [t.id, d.n, now]);
    if (r === 'created') sent++;
  }
  return sent;
}

/**
 * Worker: offboarding. Open tasks whose assignee lost access (membership removed/suspended, grant revoked or expired)
 * are flagged for reassignment, or unassigned when the workspace policy says so. The creator is told.
 */
export async function runOffboardingSweep(db: Queryable = getPool(), limit = 500): Promise<number> {
  const rows = await many<{ id: string; workspace_id: string; brand_id: string; post_id: string | null; assignee_id: string; created_by: string | null; title: string; policy: string }>(db,
    `SELECT t.id, t.workspace_id, t.brand_id, t.post_id, t.assignee_id, t.created_by, t.title, coalesce(s.offboarding, 'flag') AS policy
       FROM collab_tasks t LEFT JOIN workspace_collab_settings s ON s.workspace_id=t.workspace_id
      WHERE t.status IN ('open','in_progress','blocked') AND t.assignee_id IS NOT NULL AND NOT t.needs_reassignment
      ORDER BY t.updated_at LIMIT $1`, [limit]);
  const cache = new Map<string, AuthzState>();
  let flagged = 0;
  for (const t of rows) {
    const key = `${t.workspace_id}:${t.assignee_id}`;
    let s = cache.get(key);
    if (!s) { s = await loadUserAuthz(t.assignee_id, t.workspace_id, null, db); cache.set(key, s); }
    if (s.subject.status === 'active' && staffAllowed(s, 'content.read', t.brand_id)) continue;
    const unassign = t.policy === 'unassign';
    await db.query(`UPDATE collab_tasks SET needs_reassignment=true, reassign_reason='access_removed', assignee_id=CASE WHEN $2 THEN NULL ELSE assignee_id END,
                      version=version+1, updated_at=now() WHERE id=$1`, [t.id, unassign]);
    await event(db, null, t, 'needs_reassignment', { previous_assignee: t.assignee_id, unassigned: unassign }, 'offboarding');
    await audit(db, { workspaceId: t.workspace_id, brandId: t.brand_id, actorService: 'worker:offboarding', action: 'task.flagged_for_reassignment', resourceType: 'task', resourceId: t.id,
      diff: { post_id: t.post_id, previous_assignee: t.assignee_id, unassigned: unassign } });
    if (t.created_by && t.created_by !== t.assignee_id) {
      await deliverNotification(db, { workspaceId: t.workspace_id, userId: t.created_by, event: 'assignment', kind: 'task.needs_reassignment', title: 'A task needs a new assignee',
        body: null, referenceType: 'task', referenceId: t.id, linkPath: `/tasks?task=${t.id}`, dedupeKey: `task:${t.id}:offboard:${t.assignee_id}`,
        requirement: { brandId: t.brand_id, permission: 'content.read' } }).catch((err) => log.warn('offboarding_notify_failed', { err: err as Error }));
    }
    flagged++;
  }
  return flagged;
}
