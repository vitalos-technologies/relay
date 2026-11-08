// In-app notification centre (bell + /notifications page): keyset-paginated feed with read/unread and category filters,
// deep links (thread / task / review), mark unread. Every row is re-checked against the caller's CURRENT access before it
// is shown (filterReadable), so revoked access hides old notifications too.
import { AppError } from '@social-lite/core';
import { getPool, many, type Queryable } from '@social-lite/db';
import type { Ctx } from '../context.js';
import { assertUuid, isUuid } from '../tenancy.js';
import { filterReadable, safeLinkPath } from './notifications.js';

export const NOTIFICATION_CATEGORIES = ['mentions', 'discussion', 'tasks', 'reviews', 'reminders', 'publishing', 'support'] as const;
export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];

const CATEGORY_SQL: Record<NotificationCategory, string> = {
  mentions: `n.event_type = 'mention'`,
  discussion: `n.event_type = 'comment'`,
  tasks: `(n.kind LIKE 'task.%' AND n.kind NOT LIKE 'task.reminder%') OR n.kind = 'assignment'`,
  reviews: `n.event_type IN ('review_requested','review_decided') OR (n.kind LIKE 'approval.%' AND n.kind <> 'approval.overdue')`,
  reminders: `n.event_type = 'reminder' OR n.kind LIKE 'task.reminder%' OR n.kind = 'approval.overdue'`,
  publishing: `n.event_type IN ('publishing_problem','account_health','budget') OR n.kind LIKE 'delivery.%' OR n.kind LIKE 'connection.%' OR n.kind IN ('budget','security')`,
  // V4: Relay support replies and support-access requests (support/notify.ts).
  support: `n.kind LIKE 'support.%'`,
};

export function categoryOfNotification(n: { kind: string; event_type: string | null }): NotificationCategory {
  if (n.kind.startsWith('support.')) return 'support';
  if (n.event_type === 'mention') return 'mentions';
  if (n.event_type === 'reminder' || n.kind.startsWith('task.reminder') || n.kind === 'approval.overdue') return 'reminders';
  if (n.event_type === 'comment') return 'discussion';
  if (n.kind.startsWith('task.') || n.kind === 'assignment') return 'tasks';
  if (n.event_type === 'review_requested' || n.event_type === 'review_decided' || n.kind.startsWith('approval.')) return 'reviews';
  return 'publishing';
}

function hrefOf(r: { link_path: string | null; reference_type: string | null; reference_id: string | null }): string | null {
  const p = safeLinkPath(r.link_path);
  if (p) return p;
  switch (r.reference_type) {
    case 'post': return r.reference_id ? `/posts/${r.reference_id}` : null;
    case 'approval': return r.reference_id ? `/approvals/${r.reference_id}` : null;
    case 'review': return r.reference_id ? `/review/${r.reference_id}` : null;
    case 'task': return r.reference_id ? `/tasks?task=${r.reference_id}` : null;
    case 'connection': return '/accounts';
    default: return null;
  }
}

interface FeedRow {
  id: string; severity: 'info' | 'warning' | 'critical'; kind: string; event_type: string | null; title: string; body: string | null; reference_type: string | null;
  reference_id: string | null; link_path: string | null; occurrences: number; created_at: Date; last_seen_at: Date; read_at: Date | null; brand_id: string | null;
  required_permission: string | null; actor_name: string | null;
}

export async function listNotificationFeed(ctx: Ctx, q: { unread?: boolean; category?: string | null; cursor?: string | null; limit?: number | null } = {}, db: Queryable = getPool()) {
  const limit = Math.min(Math.max(q.limit ?? 30, 1), 100);
  const params: unknown[] = [ctx.access.workspaceId, ctx.actor.userId];
  const where = ['n.workspace_id=$1', 'n.user_id=$2', 'n.in_app'];
  if (q.unread) where.push('n.read_at IS NULL');
  if (q.category) {
    if (!(NOTIFICATION_CATEGORIES as readonly string[]).includes(q.category)) throw new AppError('validation_failed', 'Unknown category', { category: 'Invalid' });
    where.push(`(${CATEGORY_SQL[q.category as NotificationCategory]})`);
  }
  if (q.cursor) {
    const [ts, id] = Buffer.from(q.cursor, 'base64url').toString().split('|');
    if (!ts || !isUuid(id)) throw new AppError('validation_failed', 'Invalid cursor');
    params.push(ts, id); where.push(`(n.last_seen_at, n.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
  }
  // Over-fetch a little: rows the caller may no longer read are dropped after the access re-check.
  params.push(limit + 1);
  const rows = await many<FeedRow>(db,
    `SELECT n.id, n.severity, n.kind, n.event_type, n.title, n.body, n.reference_type, n.reference_id, n.link_path, n.occurrences, n.created_at, n.last_seen_at,
            n.read_at, n.brand_id, n.required_permission, au.name AS actor_name
       FROM notifications n LEFT JOIN users au ON au.id=n.actor_id
      WHERE ${where.join(' AND ')} ORDER BY n.last_seen_at DESC, n.id DESC LIMIT $${params.length}`, params);
  const page = rows.slice(0, limit);
  const visible = await filterReadable(ctx, page, db);
  const unread = await many<{ id: string; brand_id: string | null; required_permission: string | null }>(db,
    `SELECT id, brand_id, required_permission FROM notifications WHERE workspace_id=$1 AND user_id=$2 AND in_app AND read_at IS NULL ORDER BY last_seen_at DESC LIMIT 500`,
    [ctx.access.workspaceId, ctx.actor.userId]);
  const last = page[page.length - 1];
  const ctxOf = await contextFor(db, ctx.access.workspaceId, visible);
  return {
    items: visible.map((r) => ({
      id: r.id, severity: r.severity, kind: r.kind, category: categoryOfNotification(r), title: headline(r), context: ctxOf.get(r.id) ?? null, body: r.body,
      reference_type: r.reference_type, reference_id: r.reference_id, url: hrefOf(r), actor: r.actor_name,
      occurrences: r.occurrences, created_at: r.created_at.toISOString(), last_seen_at: r.last_seen_at.toISOString(), read_at: r.read_at?.toISOString() ?? null,
    })),
    unread_count: (await filterReadable(ctx, unread, db)).length,
    next_cursor: rows.length > limit && last ? Buffer.from(`${last.last_seen_at.toISOString()}|${last.id}`).toString('base64url') : null,
  };
}

export async function markNotificationUnread(ctx: Ctx, id: string, db: Queryable = getPool()): Promise<{ ok: true }> {
  assertUuid(id, 'Notification');
  const r = await db.query(`UPDATE notifications SET read_at=NULL WHERE id=$1 AND workspace_id=$2 AND user_id=$3`, [id, ctx.access.workspaceId, ctx.actor.userId]);
  if (!r.rowCount) throw new AppError('not_found', 'Notification not found');
  return { ok: true };
}

/** Actor-led headline for the in-app feed ("Eden Editor mentioned you"). Emails keep the generic stored title. */
export function headline(r: { kind: string; title: string; actor_name: string | null }): string {
  const a = r.actor_name;
  if (!a) return r.title;
  switch (r.kind) {
    case 'mention': return `${a} mentioned you${/internal/i.test(r.title) ? ' in an internal note' : ''}`;
    case 'comment.reply': return `${a} replied${/internal/i.test(r.title) ? ' in an internal discussion' : ' in a discussion'}`;
    case 'comment.client': return `${a} commented on a review`;
    default: return r.title;
  }
}

/**
 * What a notification is about, resolved at READ time (never stored in the notification, never emailed): the post
 * title for posts and reviews (staff), the task title for tasks; guests only see the brand name (internal titles stay internal).
 */
async function contextFor(db: Queryable, workspaceId: string, rows: Array<{ id: string; reference_type: string | null; reference_id: string | null }>): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const ids = (t: string) => [...new Set(rows.filter((r) => r.reference_type === t && isUuid(r.reference_id)).map((r) => r.reference_id!))];
  const posts = ids('post'); const approvals = ids('approval'); const reviews = ids('review'); const tasks = ids('task');
  const label = (title: string | null, text: string | null) => (title?.trim() || (text ?? '').replace(/\s+/g, ' ').slice(0, 60) || 'Untitled post');
  if (posts.length) for (const p of await many<{ id: string; title: string | null; t: string | null }>(db, `SELECT id, title, draft->>'baseText' AS t FROM posts WHERE workspace_id=$1 AND id = ANY($2::uuid[])`, [workspaceId, posts])) {
    for (const r of rows) if (r.reference_type === 'post' && r.reference_id === p.id) out.set(r.id, label(p.title, p.t));
  }
  if (approvals.length) for (const a of await many<{ id: string; title: string | null; t: string | null }>(db, `SELECT a.id, p.title, p.draft->>'baseText' AS t FROM approvals a JOIN posts p ON p.id=a.post_id WHERE a.workspace_id=$1 AND a.id = ANY($2::uuid[])`, [workspaceId, approvals])) {
    for (const r of rows) if (r.reference_type === 'approval' && r.reference_id === a.id) out.set(r.id, `Review · ${label(a.title, a.t)}`);
  }
  if (reviews.length) for (const a of await many<{ id: string; brand: string }>(db, `SELECT a.id, b.name AS brand FROM approvals a JOIN brands b ON b.id=a.brand_id WHERE a.workspace_id=$1 AND a.id = ANY($2::uuid[])`, [workspaceId, reviews])) {
    for (const r of rows) if (r.reference_type === 'review' && r.reference_id === a.id) out.set(r.id, `Review · ${a.brand}`);
  }
  if (tasks.length) for (const t of await many<{ id: string; title: string; post_title: string | null }>(db, `SELECT t.id, t.title, p.title AS post_title FROM collab_tasks t LEFT JOIN posts p ON p.id=t.post_id WHERE t.workspace_id=$1 AND t.id = ANY($2::uuid[])`, [workspaceId, tasks])) {
    for (const r of rows) if (r.reference_type === 'task' && r.reference_id === t.id) out.set(r.id, t.post_title ? `${t.title} · ${t.post_title}` : t.title);
  }
  return out;
}
