// Effective access (spec §3): for a member — brands/connections, permitted actions, the source grant of
// each (direct or via team), expiry, restrictions that deny, and the policy version used. Computed by the
// SAME evaluate() the enforcement path uses, from the database, never from a cache.
// Viewers see only brands they can see themselves (no exposure of unrelated brands).
import { PERMISSIONS, WORKSPACE_ONLY, notFound, type Permission, type RolePreset } from '@social-lite/core';
import { getPool, many, maybeOne, type Queryable } from '@social-lite/db';
import type { Ctx } from './context.js';
import { authorize, hasAnywhere, loadUserAuthz, type AuthzState } from './authz.js';
import { assertUuid, authorizeCtx, requireAction } from './tenancy.js';

/** Holds `perm` on some scope (UI flags / pre-checks; enforcement still re-checks per resource). */
export function canAnywhere(ctx: Ctx, perm: Permission): boolean {
  const a = ctx.access.authz;
  return a ? hasAnywhere(a, perm) : authorizeCtx(ctx, perm).allowed;
}

export interface AccessSource { grant_id: string; role: RolePreset; via: 'direct' | 'team'; team_id: string | null; team_name: string | null; expires_at: string | null }
export interface PermissionAccess { permission: Permission; allowed: boolean; reason: string; sources: AccessSource[] }
export interface EffectiveAccess {
  user: { id: string; email: string; name: string | null; status: string };
  policy_version: number;
  workspace: PermissionAccess[];
  brands: Array<{ brand_id: string; name: string; permissions: PermissionAccess[];
    connections: Array<{ connection_id: string; name: string; provider: string; permissions: PermissionAccess[] }> }>;
  restrictions: Array<{ id: string; brand_id: string | null; brand_name: string | null; actions: string[]; expires_at: string | null; reason: string | null }>;
  generated_at: string;
}

const BRAND_PERMS = PERMISSIONS.filter((p) => !WORKSPACE_ONLY.has(p));
const WS_PERMS = PERMISSIONS.filter((p) => WORKSPACE_ONLY.has(p));
const CONNECTION_PERMS: Permission[] = ['content.schedule', 'content.publish', 'publishing.pause', 'publishing.resume', 'publishing.retry', 'connections.manage'];

export function permissionMatrix(state: AuthzState, perms: readonly Permission[], resource: { brandId?: string | null; connectionId?: string | null }, teams: Map<string, string>): PermissionAccess[] {
  const byId = new Map(state.subject.grants.map((g) => [g.grantId, g]));
  return perms.map((p) => {
    const d = authorize(state, p, resource);
    return {
      permission: p, allowed: d.allowed, reason: d.reason,
      sources: d.sources.map((s) => ({ grant_id: s.grantId, role: s.role, via: s.via, team_id: s.teamId ?? null, team_name: s.teamId ? teams.get(s.teamId) ?? null : null,
        expires_at: byId.get(s.grantId)?.expiresAt ?? null })),
    };
  });
}

/** Members admins/team managers (members.read) or the user themself may view effective access. */
export async function effectiveAccess(ctx: Ctx, userId: string, db: Queryable = getPool()): Promise<EffectiveAccess> {
  assertUuid(userId, 'Member');
  if (userId !== ctx.actor.userId) requireAction(ctx, 'members.read');
  const u = await maybeOne<{ id: string; email: string; name: string | null; status: string }>(db,
    `SELECT u.id, u.email, u.name, m.status FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.workspace_id=$1 AND m.user_id=$2`, [ctx.access.workspaceId, userId]);
  if (!u) throw notFound('Member');
  // Background view: assurance is not part of "what is this person allowed" (it is enforced per session).
  const state = await loadUserAuthz(userId, ctx.access.workspaceId, null, db);
  const teams = new Map((await many<{ id: string; name: string }>(db, `SELECT id, name FROM teams WHERE workspace_id=$1`, [ctx.access.workspaceId])).map((t) => [t.id, t.name]));
  const viewerBrands = ctx.access.brandIds;
  const brands = await many<{ id: string; name: string }>(db,
    `SELECT id, name FROM brands WHERE workspace_id=$1 AND archived_at IS NULL AND ($2::uuid[] IS NULL OR id = ANY($2::uuid[])) ORDER BY name, id`, [ctx.access.workspaceId, viewerBrands]);
  const conns = await many<{ id: string; brand_id: string; display_name: string; provider: string }>(db,
    `SELECT id, brand_id, display_name, provider FROM connections WHERE workspace_id=$1 AND disconnected_at IS NULL ORDER BY display_name`, [ctx.access.workspaceId]);
  const restrictions = await many<{ id: string; brand_id: string | null; brand_name: string | null; actions: string[]; expires_at: Date | null; reason: string | null }>(db,
    `SELECT r.id, r.brand_id, b.name AS brand_name, r.actions, r.expires_at, r.reason FROM access_restrictions r LEFT JOIN brands b ON b.id=r.brand_id
      WHERE r.workspace_id=$1 AND r.user_id=$2 AND r.revoked_at IS NULL AND (r.expires_at IS NULL OR r.expires_at > now())`, [ctx.access.workspaceId, userId]);
  const connGrantBrands = new Set(state.subject.grants.filter((g) => g.scopeType === 'connection').map((g) => g.connectionId));
  return {
    user: { id: u.id, email: u.email, name: u.name, status: u.status },
    policy_version: state.policyVersion,
    workspace: permissionMatrix(state, WS_PERMS, {}, teams).filter((p) => p.allowed || p.reason === 'restricted'),
    brands: brands.map((b) => ({
      brand_id: b.id, name: b.name,
      permissions: permissionMatrix(state, BRAND_PERMS, { brandId: b.id }, teams).filter((p) => p.allowed || p.reason === 'restricted'),
      // Connection rows only where a connection-scoped grant adds something beyond the brand.
      connections: conns.filter((c) => c.brand_id === b.id && connGrantBrands.has(c.id)).map((c) => ({
        connection_id: c.id, name: c.display_name, provider: c.provider,
        permissions: permissionMatrix(state, CONNECTION_PERMS, { brandId: b.id, connectionId: c.id }, teams).filter((p) => p.allowed),
      })),
    })).filter((b) => b.permissions.length || b.connections.length),
    restrictions: restrictions.filter((r) => !r.brand_id || viewerBrands === null || viewerBrands.includes(r.brand_id))
      .map((r) => ({ ...r, expires_at: r.expires_at?.toISOString() ?? null })),
    generated_at: new Date().toISOString(),
  };
}
