// Tenant and brand authorization. Every service query on tenant data must include
// workspace_id = ctx.access.workspaceId and, for brand data, assertBrand().
// Cross-tenant lookups return not_found (no existence leakage).
import { can, forbidden, notFound, type Action, type Role } from '@social-lite/core';
import { getPool, many, maybeOne, type Queryable } from '@social-lite/db';
import type { Ctx, WorkspaceAccess } from './context.js';

export async function loadAccess(userId: string, workspaceId: string, db: Queryable = getPool()): Promise<WorkspaceAccess | null> {
  const m = await maybeOne<{ role: Role; brand_restricted: boolean; is_demo: boolean; state: string }>(db,
    `SELECT m.role, m.brand_restricted, w.is_demo, w.state
       FROM memberships m JOIN workspaces w ON w.id = m.workspace_id
      WHERE m.workspace_id = $1 AND m.user_id = $2 AND m.removed_at IS NULL`, [workspaceId, userId]);
  if (!m || m.state !== 'active') return null;
  let brandIds: string[] | null = null;
  if (m.brand_restricted && m.role !== 'owner' && m.role !== 'admin') {
    brandIds = (await many<{ brand_id: string }>(db,
      `SELECT brand_id FROM membership_brand_grants WHERE workspace_id=$1 AND user_id=$2`, [workspaceId, userId])).map((r) => r.brand_id);
  }
  return { workspaceId, role: m.role, brandIds, isDemo: m.is_demo };
}

export function requireAction(ctx: Ctx, action: Action, message?: string): void {
  if (!can(ctx.access.role, action)) throw forbidden(message);
}

export function brandAllowed(ctx: Ctx, brandId: string): boolean {
  return ctx.access.brandIds === null || ctx.access.brandIds.includes(brandId);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(id: unknown): id is string {
  return typeof id === 'string' && UUID_RE.test(id);
}

export function assertUuid(id: string, what = 'Resource'): void {
  if (!isUuid(id)) throw notFound(what);
}

export interface BrandRow {
  id: string; workspace_id: string; name: string; timezone: string; approval_required: boolean;
  editors_can_publish: boolean; default_deadline_minutes: number; publishing_paused: boolean;
  paused_reason: string | null; paused_at: Date | null; voice: Record<string, unknown>; is_demo: boolean; archived_at: Date | null;
  created_at: Date;
}

/** Load a brand in the caller's workspace that the caller may access; else not_found. */
export async function assertBrand(ctx: Ctx, brandId: string, db: Queryable = getPool()): Promise<BrandRow> {
  assertUuid(brandId, 'Brand');
  const b = await maybeOne<BrandRow>(db, `SELECT * FROM brands WHERE id = $1 AND workspace_id = $2`, [brandId, ctx.access.workspaceId]);
  if (!b || !brandAllowed(ctx, b.id)) throw notFound('Brand');
  return b;
}

/**
 * SQL predicate restricting a brand column to the caller's grants.
 * Usage: const f = brandFilter(ctx, 'p.brand_id', params.length + 1); params.push(...f.params)
 */
export function brandFilter(ctx: Ctx, column: string, paramIndex: number): { sql: string; params: unknown[] } {
  if (ctx.access.brandIds === null) return { sql: 'TRUE', params: [] };
  return { sql: `${column} = ANY($${paramIndex}::uuid[])`, params: [ctx.access.brandIds] };
}
