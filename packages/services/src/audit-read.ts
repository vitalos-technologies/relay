// Read APIs for the audit log (owner/admin) and the caller's in-app notifications.
// Notification rows are written by the engine (notifications/**); this module only reads/marks them.
import { AppError } from '@social-lite/core';
import { getPool, many, maybeOne, type Queryable } from '@social-lite/db';
import type { Ctx } from './context.js';
import { assertUuid, requireAction } from './tenancy.js';
import { filterReadable } from './collab/notifications.js';

export interface AuditEventDto {
  id: string; action: string; resource_type: string; resource_id: string | null; brand_id: string | null;
  actor_user_id: string | null; actor_email: string | null; actor_service: string | null;
  diff: Record<string, unknown>; correlation_id: string | null; created_at: string;
}

export async function listAudit(ctx: Ctx, q: { cursor?: string | null; resource_type?: string | null; limit?: number | null } = {}, db: Queryable = getPool()): Promise<{ items: AuditEventDto[]; next_cursor: string | null }> {
  requireAction(ctx, 'workspace.settings');
  const limit = Math.min(Math.max(q.limit ?? 50, 1), 100);
  const params: unknown[] = [ctx.access.workspaceId];
  const where = ['e.workspace_id = $1'];
  if (q.resource_type) {
    if (q.resource_type.length > 64) throw new AppError('validation_failed', 'Invalid resource type', { resource_type: 'Invalid' });
    params.push(q.resource_type);
    where.push(`e.resource_type = $${params.length}`);
  }
  if (q.cursor) {
    if (!/^\d{1,19}$/.test(q.cursor)) throw new AppError('validation_failed', 'Invalid cursor', { cursor: 'Invalid cursor' });
    params.push(q.cursor);
    where.push(`e.id < $${params.length}::bigint`);
  }
  params.push(limit + 1);
  const rows = await many<{ id: string; action: string; resource_type: string; resource_id: string | null; brand_id: string | null; actor_user_id: string | null;
    actor_email: string | null; actor_service: string | null; diff: Record<string, unknown>; correlation_id: string | null; created_at: Date }>(db,
    `SELECT e.id, e.action, e.resource_type, e.resource_id, e.brand_id, e.actor_user_id, u.email AS actor_email, e.actor_service, e.diff,
            e.correlation_id, e.created_at
       FROM audit_events e LEFT JOIN users u ON u.id = e.actor_user_id
      WHERE ${where.join(' AND ')} ORDER BY e.id DESC LIMIT $${params.length}`, params);
  const page = rows.slice(0, limit);
  return {
    items: page.map((r) => ({ ...r, id: String(r.id), created_at: r.created_at.toISOString() })),
    next_cursor: rows.length > limit ? String(page[page.length - 1]!.id) : null,
  };
}

export interface NotificationDto {
  id: string; severity: 'info' | 'warning' | 'critical'; kind: string; title: string; body: string | null;
  reference_type: string | null; reference_id: string | null; occurrences: number; created_at: string; last_seen_at: string; read_at: string | null;
}

export async function listNotifications(ctx: Ctx, q: { unread?: boolean; limit?: number | null } = {}, db: Queryable = getPool()): Promise<{ items: NotificationDto[]; unread_count: number }> {
  const limit = Math.min(Math.max(q.limit ?? 50, 1), 100);
  // V2 (collab/notifications.ts): in-app only, and the recipient must STILL be entitled to the referenced
  // resource (access may have changed since the notification was created) — re-checked on every read.
  const rows = await many<{ id: string; severity: NotificationDto['severity']; kind: string; title: string; body: string | null; reference_type: string | null;
    reference_id: string | null; occurrences: number; created_at: Date; last_seen_at: Date; read_at: Date | null; brand_id: string | null; required_permission: string | null }>(db,
    `SELECT id, severity, kind, title, body, reference_type, reference_id, occurrences, created_at, last_seen_at, read_at, brand_id, required_permission
       FROM notifications WHERE workspace_id=$1 AND user_id=$2 AND in_app AND ($3::boolean IS NOT TRUE OR read_at IS NULL)
      ORDER BY last_seen_at DESC, id DESC LIMIT $4`, [ctx.access.workspaceId, ctx.actor.userId, q.unread ?? false, limit]);
  const visible = await filterReadable(ctx, rows, db);
  const unread = await many<{ id: string; brand_id: string | null; required_permission: string | null }>(db,
    `SELECT id, brand_id, required_permission FROM notifications WHERE workspace_id=$1 AND user_id=$2 AND in_app AND read_at IS NULL LIMIT 500`, [ctx.access.workspaceId, ctx.actor.userId]);
  return {
    items: visible.map(({ brand_id: _b, required_permission: _p, ...r }) => ({ ...r, created_at: r.created_at.toISOString(), last_seen_at: r.last_seen_at.toISOString(), read_at: r.read_at?.toISOString() ?? null })),
    unread_count: (await filterReadable(ctx, unread, db)).length,
  };
}

export async function markNotificationRead(ctx: Ctx, id: string, db: Queryable = getPool()): Promise<void> {
  assertUuid(id, 'Notification');
  const r = await db.query(`UPDATE notifications SET read_at=coalesce(read_at, now()) WHERE id=$1 AND workspace_id=$2 AND user_id=$3`,
    [id, ctx.access.workspaceId, ctx.actor.userId]);
  if (!r.rowCount) throw new AppError('not_found', 'Notification not found');
}

export async function markAllNotificationsRead(ctx: Ctx, db: Queryable = getPool()): Promise<number> {
  const r = await db.query(`UPDATE notifications SET read_at=now() WHERE workspace_id=$1 AND user_id=$2 AND read_at IS NULL`,
    [ctx.access.workspaceId, ctx.actor.userId]);
  return r.rowCount ?? 0;
}
