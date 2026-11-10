// Activity / security centre (V2 §7, §11): filterable audit trail — permission changes, connection
// changes, publishing actions, security events — with cursor pagination and a permitted CSV export.
//  - Read: audit.read (workspace scope). Events on brands where audit.read is restricted for the viewer
//    are hidden. Only the caller's workspace, ever.
//  - Export: audit.read AND exports.create, rate-limited, budgeted (exports.count), audited, CSV
//    formula-injection-safe (csvCell).
import { z } from 'zod';
import { AppError } from '@social-lite/core';
import { getPool, many, type Queryable } from '@social-lite/db';
import type { Ctx } from '../context.js';
import { audit } from '../audit.js';
import { authorizeCtx, requireAction } from '../tenancy.js';
import { csvCell } from '../readmodels.js';
import { enforceRateLimit } from '../ratelimit.js';
import { releaseUsage, reserveUsage, settleUsage } from './budgets.js';

/** Category → first segment of the audit action ('connection.disconnected' → 'connection'). */
export const ACTIVITY_CATEGORIES = {
  permissions: ['member', 'members', 'membership', 'invitation', 'invitations', 'team', 'teams', 'grant', 'grants', 'restriction', 'restrictions',
    'ownership', 'delegation', 'access', 'guest', 'role', 'approval_policy'],
  connections: ['connection', 'connections', 'integration', 'credential', 'credentials'],
  publishing: ['schedule', 'approval', 'delivery', 'post', 'publication', 'publishing', 'review', 'campaign', 'slot', 'import', 'source_event'],
  security: ['auth', 'session', 'sessions', 'mfa', 'security', 'api_key', 'service_account', 'step_up', 'login', 'logout', 'recovery', 'passkey',
    'export', 'budget', 'workspace', 'brand', 'support_access', 'platform', 'mcp'],
  // Collaboration completion: discussions, visibility changes, tasks, reassignments, collaboration settings.
  collaboration: ['comment', 'thread', 'task', 'collaboration'],
  // V3.5 (stream F): inbox, cases, listening, AI and automation.
  care: ['inbox', 'case', 'listening', 'ai', 'automation'],
} as const;
export type ActivityCategory = keyof typeof ACTIVITY_CATEGORIES | 'content' | 'all';
const KNOWN = Object.values(ACTIVITY_CATEGORIES).flat() as string[];

export function categoryOf(action: string): ActivityCategory {
  const seg = action.split('.')[0] ?? '';
  for (const [k, v] of Object.entries(ACTIVITY_CATEGORIES)) if ((v as readonly string[]).includes(seg)) return k as ActivityCategory;
  return 'content';
}

export const activityQuerySchema = z.object({
  category: z.enum(['all', 'permissions', 'connections', 'publishing', 'security', 'collaboration', 'care', 'content']).default('all'),
  brand_id: z.string().uuid().nullish(),
  actor_user_id: z.string().uuid().nullish(),
  action: z.string().regex(/^[a-z_]+(\.[a-z_]+)*$/).max(64).nullish(),
  q: z.string().max(100).nullish(),
  from: z.string().datetime({ offset: true }).nullish(),
  to: z.string().datetime({ offset: true }).nullish(),
  cursor: z.string().regex(/^\d{1,19}$/).nullish(),
  limit: z.coerce.number().int().min(1).max(100).nullish(),
});
export type ActivityQuery = z.infer<typeof activityQuerySchema>;

interface Row {
  id: string; action: string; resource_type: string; resource_id: string | null; brand_id: string | null; brand_name: string | null;
  actor_user_id: string | null; actor_email: string | null; actor_service: string | null; diff: Record<string, unknown>; correlation_id: string | null; created_at: Date;
}

async function deniedBrands(ctx: Ctx, db: Queryable): Promise<string[]> {
  const brands = await many<{ id: string }>(db, `SELECT id FROM brands WHERE workspace_id=$1`, [ctx.access.workspaceId]);
  return brands.filter((b) => !authorizeCtx(ctx, 'audit.read', { brandId: b.id }).allowed).map((b) => b.id);
}

async function query(ctx: Ctx, q: ActivityQuery, limit: number, db: Queryable): Promise<Row[]> {
  const params: unknown[] = [ctx.access.workspaceId];
  const where = ['e.workspace_id = $1'];
  const denied = await deniedBrands(ctx, db);
  if (denied.length) { params.push(denied); where.push(`(e.brand_id IS NULL OR NOT (e.brand_id = ANY($${params.length}::uuid[])))`); }
  if (q.category && q.category !== 'all') {
    if (q.category === 'content') { params.push(KNOWN); where.push(`NOT (split_part(e.action, '.', 1) = ANY($${params.length}::text[]))`); }
    else { params.push([...ACTIVITY_CATEGORIES[q.category]]); where.push(`split_part(e.action, '.', 1) = ANY($${params.length}::text[])`); }
  }
  if (q.brand_id) {
    if (denied.includes(q.brand_id)) throw new AppError('not_found', 'Brand not found');
    params.push(q.brand_id); where.push(`e.brand_id = $${params.length}`);
  }
  if (q.actor_user_id) { params.push(q.actor_user_id); where.push(`e.actor_user_id = $${params.length}`); }
  if (q.action) { params.push(q.action); params.push(`${q.action}.%`); where.push(`(e.action = $${params.length - 1} OR e.action LIKE $${params.length})`); }
  if (q.q) { params.push(`%${q.q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`); where.push(`(e.action ILIKE $${params.length} OR e.resource_type ILIKE $${params.length} OR u.email ILIKE $${params.length})`); }
  if (q.from) { params.push(new Date(q.from)); where.push(`e.created_at >= $${params.length}`); }
  if (q.to) { params.push(new Date(q.to)); where.push(`e.created_at < $${params.length}`); }
  if (q.cursor) { params.push(q.cursor); where.push(`e.id < $${params.length}::bigint`); }
  params.push(limit);
  return many<Row>(db,
    `SELECT e.id, e.action, e.resource_type, e.resource_id, e.brand_id, b.name AS brand_name, e.actor_user_id, u.email AS actor_email, e.actor_service,
            e.diff, e.correlation_id, e.created_at
       FROM audit_events e LEFT JOIN users u ON u.id = e.actor_user_id LEFT JOIN brands b ON b.id = e.brand_id AND b.workspace_id = e.workspace_id
      WHERE ${where.join(' AND ')} ORDER BY e.id DESC LIMIT $${params.length}`, params);
}

const toDto = (r: Row) => ({
  id: String(r.id), category: categoryOf(r.action), action: r.action, resource_type: r.resource_type, resource_id: r.resource_id,
  brand_id: r.brand_id, brand_name: r.brand_name, actor: r.actor_email ?? (r.actor_service ? `system:${r.actor_service}` : 'system'),
  actor_user_id: r.actor_user_id, diff: r.diff, correlation_id: r.correlation_id, created_at: r.created_at.toISOString(),
});

export async function listActivity(ctx: Ctx, raw: unknown, db: Queryable = getPool()) {
  requireAction(ctx, 'audit.read');
  const q = activityQuerySchema.parse(raw ?? {});
  const limit = q.limit ?? 50;
  const rows = await query(ctx, q, limit + 1, db);
  const page = rows.slice(0, limit);
  return {
    items: page.map(toDto),
    next_cursor: rows.length > limit ? String(page[page.length - 1]!.id) : null,
    can_export: authorizeCtx(ctx, 'exports.create', { brandId: q.brand_id ?? null }).allowed,
  };
}

export const ACTIVITY_EXPORT_MAX_ROWS = 10_000;
export const EXPORT_RATE = { capacity: 5, refillPerSecond: 5 / 3600 };

/** CSV export of the filtered activity (max 10,000 rows). */
export async function activityCsv(ctx: Ctx, raw: unknown, db: Queryable = getPool()): Promise<{ csv: string; rows: number }> {
  requireAction(ctx, 'audit.read');
  const q = activityQuerySchema.parse(raw ?? {});
  requireAction(ctx, 'exports.create', q.brand_id ? { brandId: q.brand_id } : { brandId: null });
  await enforceRateLimit('activityExport', ctx.actor.userId, EXPORT_RATE);
  const reservation = await reserveUsage({ workspaceId: ctx.access.workspaceId, meter: 'exports.count', amount: 1, userId: ctx.actor.userId, ref: `export:activity:${ctx.correlationId.slice(0, 60)}`, ttlSeconds: 600, planExempt: true }); // D33: data export always works
  try {
    const header = ['created_at_utc', 'category', 'action', 'actor', 'brand', 'resource_type', 'resource_id', 'details', 'correlation_id', 'event_id'];
    const lines = [header.join(',')];
    let cursor: string | undefined;
    let n = 0;
    while (n < ACTIVITY_EXPORT_MAX_ROWS) {
      const rows = await query(ctx, { ...q, cursor: cursor ?? q.cursor ?? null }, 500, db);
      for (const r of rows) {
        const d = toDto(r);
        lines.push([d.created_at, d.category, d.action, d.actor, d.brand_name, d.resource_type, d.resource_id, JSON.stringify(d.diff ?? {}), d.correlation_id, d.id].map(csvCell).join(','));
        if (++n >= ACTIVITY_EXPORT_MAX_ROWS) break;
      }
      if (rows.length < 500) break;
      cursor = String(rows[rows.length - 1]!.id);
    }
    await audit(db, { workspaceId: ctx.access.workspaceId, brandId: q.brand_id ?? null, actorUserId: ctx.actor.userId, action: 'export.activity', resourceType: 'audit_events',
      diff: { rows: n, filters: { category: q.category, brand_id: q.brand_id ?? null, actor_user_id: q.actor_user_id ?? null, action: q.action ?? null, from: q.from ?? null, to: q.to ?? null } },
      correlationId: ctx.correlationId });
    await settleUsage(reservation.id, 1);
    return { csv: lines.join('\r\n') + '\r\n', rows: n };
  } catch (err) {
    await releaseUsage(reservation.id).catch(() => undefined);
    throw err;
  }
}
