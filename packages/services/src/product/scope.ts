// Shared scoping helpers for stream-D read models: the exact set of brands on which the caller holds a
// permission (V2 policy: grants, restrictions and assurance evaluated per brand, never the V1 role).
import { notFound, type Permission } from '@social-lite/core';
import { getPool, many, maybeOne, type Queryable } from '@social-lite/db';
import type { Ctx } from '../context.js';
import { assertUuid, authorizeCtx, requireAction } from '../tenancy.js';

/** Brands (id + name) in the caller's workspace on which `perm` is granted right now. */
export async function brandsWith(ctx: Ctx, perm: Permission, db: Queryable = getPool()): Promise<Array<{ id: string; name: string }>> {
  const rows = await many<{ id: string; name: string }>(db, `SELECT id, name FROM brands WHERE workspace_id=$1 ORDER BY name`, [ctx.access.workspaceId]);
  return rows.filter((b) => authorizeCtx(ctx, perm, { brandId: b.id }).allowed);
}

/**
 * A brand in the caller's workspace on which `perm` is granted. 404 when the brand is outside the
 * workspace or the caller can see nothing on it (no existence leak); 403/mfa_required otherwise.
 */
export async function brandForPermission(ctx: Ctx, brandId: string, perm: Permission, db: Queryable = getPool()): Promise<{ id: string; name: string; timezone: string }> {
  assertUuid(brandId, 'Brand');
  const b = await maybeOne<{ id: string; name: string; timezone: string }>(db, `SELECT id, name, timezone FROM brands WHERE id=$1 AND workspace_id=$2`, [brandId, ctx.access.workspaceId]);
  if (!b) throw notFound('Brand');
  const r = authorizeCtx(ctx, perm, { brandId });
  if (!r.allowed) {
    const visible = ctx.access.brandIds === null || ctx.access.brandIds.includes(brandId);
    if (!visible && r.reason !== 'mfa_required' && r.reason !== 'step_up_required') throw notFound('Brand');
    requireAction(ctx, perm, { brandId }); // throws the policy's error (forbidden / mfa_required / step_up_required)
  }
  return b;
}
