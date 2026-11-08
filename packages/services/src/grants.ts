// V2 scoped role grants and restrictions: validation, delegation enforcement and the legacy summary.
// Every mutation here runs inside the caller's transaction, which must also bumpPolicyVersion + audit.
//  - The server derives scope from ids (a connection id implies its brand); clients never send scope_type,
//    workspace ids, granted_by or sources (no mass assignment).
//  - Brand/connection ids are validated in the caller's workspace; composite FKs are the backstop.
//  - Delegation: core canDelegate() + the delegator must currently hold (not be restricted from) every
//    permission of the preset on that scope. Nobody grants owner (transfer only); no self-grants.
import {
  AppError, PERMISSIONS, PRESET_PERMISSIONS, ROLE_PRESETS, SENSITIVE_PERMISSIONS, canDelegate, forbidden,
  type Permission, type Role, type RolePreset,
} from '@social-lite/core';
import { many, maybeOne, type Queryable } from '@social-lite/db';
import type { Ctx } from './context.js';
import { authorize, bumpPolicyVersion } from './authz.js';
import { revalidateAuthorities } from './engine/authority.js';
import { isUuid } from './tenancy.js';

export interface GrantInput { role: string; brand_id?: string | null; connection_id?: string | null; expires_at?: string | null }

export interface NormalizedGrant {
  role: RolePreset; scopeType: 'workspace' | 'brand' | 'connection'; brandId: string | null; connectionId: string | null; expiresAt: Date | null;
}

export interface WorkspacePolicy { guest_max_days: number; guest_default_days: number; invite_ttl_hours: number; step_up_seconds: number }

export async function workspacePolicy(db: Queryable, workspaceId: string): Promise<WorkspacePolicy> {
  const r = await maybeOne<{ security_policy: Partial<WorkspacePolicy> }>(db, `SELECT security_policy FROM workspaces WHERE id=$1`, [workspaceId]);
  const p = r?.security_policy ?? {};
  const num = (v: unknown, d: number, lo: number, hi: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(Math.max(v, lo), hi) : d);
  const guestMax = num(p.guest_max_days, 90, 1, 365);
  return {
    guest_max_days: guestMax,
    guest_default_days: Math.min(num(p.guest_default_days, 30, 1, 365), guestMax),
    invite_ttl_hours: num(p.invite_ttl_hours, 72, 1, 24 * 30),
    step_up_seconds: num(p.step_up_seconds, 300, 30, 3600),
  };
}

/** Roles a human can be granted directly (owner moves only via transfer; integration is for service accounts). */
export const GRANTABLE_ROLES: readonly RolePreset[] = ROLE_PRESETS.filter((r) => r !== 'owner' && r !== 'integration');
/** Roles a team can hold (no workspace administration through teams). */
export const TEAM_ROLES: readonly RolePreset[] = ['brand_manager', 'editor', 'approver', 'publisher', 'analyst', 'viewer', 'exporter'];
const WORKSPACE_SCOPED: ReadonlySet<RolePreset> = new Set(['owner', 'admin', 'team_manager']);
/** Granting these requires fresh authentication (step-up): they carry sensitive permissions. */
export const SENSITIVE_ROLES: ReadonlySet<RolePreset> = new Set(ROLE_PRESETS.filter((r) => r !== 'owner' && PRESET_PERMISSIONS[r].some((p) => SENSITIVE_PERMISSIONS.has(p))));
/** Roles that can schedule/publish: a team holding one is a "publishing team" (membership is a privilege grant). */
export const isPublishingRole = (r: string) => (PRESET_PERMISSIONS[r as RolePreset] ?? []).includes('content.publish');

export const isRolePreset = (r: unknown): r is RolePreset => typeof r === 'string' && (ROLE_PRESETS as readonly string[]).includes(r);
export const isPermission = (p: unknown): p is Permission => typeof p === 'string' && (PERMISSIONS as readonly string[]).includes(p);

const bad = (msg: string, field = 'grants') => new AppError('validation_failed', msg, { [field]: msg });

/**
 * Validate and normalise grant inputs in the caller's workspace. Unknown/cross-workspace brand or
 * connection ids are rejected with the same message (no existence leak).
 */
export async function normalizeGrants(db: Queryable, workspaceId: string, inputs: GrantInput[], opts: { allowed?: readonly RolePreset[]; guestExpiry?: Date | null; now?: Date } = {}): Promise<NormalizedGrant[]> {
  if (!Array.isArray(inputs) || inputs.length === 0) throw bad('Choose at least one role');
  if (inputs.length > 50) throw bad('Too many grants in one request');
  const now = opts.now ?? new Date();
  const allowed = opts.allowed ?? GRANTABLE_ROLES;
  const policy = await workspacePolicy(db, workspaceId);
  const brandIds = [...new Set(inputs.map((i) => i.brand_id).filter((b): b is string => !!b))];
  const connIds = [...new Set(inputs.map((i) => i.connection_id).filter((c): c is string => !!c))];
  if ([...brandIds, ...connIds].some((id) => !isUuid(id))) throw bad('Unknown brand or destination');
  const brands = brandIds.length ? await many<{ id: string }>(db, `SELECT id FROM brands WHERE workspace_id=$1 AND id = ANY($2::uuid[]) AND archived_at IS NULL`, [workspaceId, brandIds]) : [];
  const conns = connIds.length ? await many<{ id: string; brand_id: string }>(db, `SELECT id, brand_id FROM connections WHERE workspace_id=$1 AND id = ANY($2::uuid[]) AND disconnected_at IS NULL`, [workspaceId, connIds]) : [];
  if (brands.length !== brandIds.length || conns.length !== connIds.length) throw bad('Unknown brand or destination');
  const out: NormalizedGrant[] = [];
  for (const i of inputs) {
    if (!isRolePreset(i.role) || !allowed.includes(i.role)) {
      throw bad(i.role === 'owner' ? 'Ownership moves only through an ownership transfer' : 'This role cannot be granted here');
    }
    const role = i.role;
    let brandId = i.brand_id ?? null;
    const connectionId = i.connection_id ?? null;
    if (connectionId) {
      const c = conns.find((x) => x.id === connectionId)!;
      if (brandId && brandId !== c.brand_id) throw bad('Unknown brand or destination');
      brandId = c.brand_id;
    }
    const scopeType = connectionId ? 'connection' : brandId ? 'brand' : 'workspace';
    if (WORKSPACE_SCOPED.has(role) && scopeType !== 'workspace') throw bad(`${role.replace('_', ' ')} applies to the whole workspace`);
    let expiresAt: Date | null = null;
    if (i.expires_at) {
      const d = new Date(i.expires_at);
      if (Number.isNaN(d.getTime()) || d.getTime() <= now.getTime() + 60_000) throw bad('Expiry must be in the future', 'expires_at');
      expiresAt = d;
    }
    if (role === 'guest') {
      if (scopeType === 'workspace') throw bad('Guests can only be given access to a brand or destination');
      expiresAt = expiresAt ?? opts.guestExpiry ?? new Date(now.getTime() + policy.guest_default_days * 86400_000);
      if (expiresAt.getTime() > now.getTime() + policy.guest_max_days * 86400_000 + 60_000) {
        throw bad(`Guest access can last at most ${policy.guest_max_days} days`, 'expires_at');
      }
    }
    if (!out.some((g) => g.role === role && g.brandId === brandId && g.connectionId === connectionId)) {
      out.push({ role, scopeType, brandId, connectionId, expiresAt });
    }
  }
  return out;
}

/** Roles the actor holds that cover a scope (workspace grants cover everything). */
function delegatorRoles(ctx: Ctx, brandId: string | null, connectionId: string | null): RolePreset[] {
  const a = ctx.access.authz;
  if (!a) return [ctx.access.role as RolePreset]; // legacy test contexts
  if (a.subject.status !== 'active') return [];
  const now = Date.now();
  return a.subject.grants
    .filter((g) => !g.expiresAt || new Date(g.expiresAt).getTime() > now)
    .filter((g) => g.scopeType === 'workspace' || (brandId !== null && g.brandId === brandId && (g.scopeType === 'brand' || (connectionId !== null && g.connectionId === connectionId))))
    .map((g) => g.role);
}

/** Can the actor delegate this grant? (ceiling via canDelegate + not restricted from any permission in it). */
export function mayDelegate(ctx: Ctx, g: Pick<NormalizedGrant, 'role' | 'brandId' | 'connectionId'>): boolean {
  const roles = delegatorRoles(ctx, g.brandId, g.connectionId);
  if (!canDelegate(roles, g.role)) return false;
  const a = ctx.access.authz;
  if (!a || roles.includes('owner')) return true;
  // Non-owners must not be restricted from any permission they hand out on that scope.
  return PRESET_PERMISSIONS[g.role].every((p) => {
    const r = authorize(a, p, { brandId: g.brandId, connectionId: g.connectionId });
    return r.allowed || r.reason === 'mfa_required' || r.reason === 'step_up_required' || (r.reason === 'workspace_scope_required');
  });
}

export function assertDelegable(ctx: Ctx, grants: Array<Pick<NormalizedGrant, 'role' | 'brandId' | 'connectionId'>>, targetUserId?: string | null): void {
  if (targetUserId && targetUserId === ctx.actor.userId) throw forbidden('You cannot change your own access');
  for (const g of grants) {
    if (!mayDelegate(ctx, g)) throw forbidden(g.role === 'admin' ? 'Only an owner can make someone an admin.' : 'You cannot grant a role you could not exercise yourself.');
  }
}

export const needsStepUp = (grants: Array<{ role: RolePreset }>) => grants.some((g) => SENSITIVE_ROLES.has(g.role));

/** Insert (or extend) a user/team grant. Identical active grant ⇒ keeps one row, takes the later expiry. */
export async function upsertGrant(tx: Queryable, p: {
  workspaceId: string; principal: { userId: string } | { teamId: string }; grant: NormalizedGrant; grantedBy: string | null; source: string;
}): Promise<{ id: string; created: boolean }> {
  const isUser = 'userId' in p.principal;
  const pid = isUser ? (p.principal as { userId: string }).userId : (p.principal as { teamId: string }).teamId;
  const existing = await maybeOne<{ id: string; expires_at: Date | null }>(tx,
    `SELECT id, expires_at FROM scoped_role_grants
      WHERE workspace_id=$1 AND principal_type=$2 AND ${isUser ? 'user_id' : 'team_id'}=$3 AND role=$4 AND scope_type=$5
        AND brand_id IS NOT DISTINCT FROM $6 AND connection_id IS NOT DISTINCT FROM $7 AND revoked_at IS NULL FOR UPDATE`,
    [p.workspaceId, isUser ? 'user' : 'team', pid, p.grant.role, p.grant.scopeType, p.grant.brandId, p.grant.connectionId]);
  if (existing) {
    const next = !existing.expires_at || !p.grant.expiresAt ? null : (existing.expires_at > p.grant.expiresAt ? existing.expires_at : p.grant.expiresAt);
    // A permanent grant is never shortened by a later expiring one (guests always have an expiry).
    if ((existing.expires_at?.getTime() ?? null) !== (next?.getTime() ?? null) && !(existing.expires_at === null)) {
      await tx.query(`UPDATE scoped_role_grants SET expires_at=$2 WHERE id=$1`, [existing.id, next]);
    }
    return { id: existing.id, created: false };
  }
  const r = await maybeOne<{ id: string }>(tx,
    `INSERT INTO scoped_role_grants(workspace_id, principal_type, user_id, team_id, role, scope_type, brand_id, connection_id, expires_at, granted_by, source)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
    [p.workspaceId, isUser ? 'user' : 'team', isUser ? pid : null, isUser ? null : pid, p.grant.role, p.grant.scopeType, p.grant.brandId, p.grant.connectionId,
      p.grant.expiresAt, p.grantedBy, p.source]);
  return { id: r!.id, created: true };
}

/** Effective (direct + team) roles of a member, for the legacy summary. */
interface RoleScopeRow { role: RolePreset; scope_type: string; brand_id: string | null }

export async function memberRoleRows(db: Queryable, workspaceId: string, userId: string): Promise<RoleScopeRow[]> {
  return many<RoleScopeRow>(db,
    `SELECT role, scope_type, brand_id FROM scoped_role_grants
      WHERE workspace_id=$1 AND user_id=$2 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())
     UNION ALL
     SELECT g.role, g.scope_type, g.brand_id FROM scoped_role_grants g
       JOIN team_memberships tm ON tm.team_id=g.team_id AND tm.user_id=$2
       JOIN teams t ON t.id=g.team_id AND t.archived_at IS NULL
      WHERE g.workspace_id=$1 AND g.principal_type='team' AND g.revoked_at IS NULL AND (g.expires_at IS NULL OR g.expires_at > now())`, [workspaceId, userId]);
}

export function legacySummary(rows: RoleScopeRow[]): { role: Role; restricted: boolean; brandIds: string[] } {
  const roles = new Set(rows.map((r) => r.role));
  const role: Role = roles.has('owner') ? 'owner' : roles.has('admin') ? 'admin'
    : roles.has('brand_manager') || roles.has('editor') ? 'editor' : roles.has('approver') ? 'approver' : 'viewer';
  const allBrands = rows.some((r) => r.scope_type === 'workspace' && r.role !== 'team_manager' && r.role !== 'exporter');
  return { role, restricted: !allBrands && role !== 'owner' && role !== 'admin', brandIds: [...new Set(rows.map((r) => r.brand_id).filter((b): b is string => !!b))] };
}

/**
 * memberships.role / brand_restricted / membership_brand_grants are a LEGACY SUMMARY derived from
 * scoped grants (kept for V1 readers). Authorization never reads them.
 */
export async function syncLegacyMembership(tx: Queryable, workspaceId: string, userId: string): Promise<void> {
  const s = legacySummary(await memberRoleRows(tx, workspaceId, userId));
  await tx.query(`UPDATE memberships SET role=$3, brand_restricted=$4 WHERE workspace_id=$1 AND user_id=$2`, [workspaceId, userId, s.role, s.restricted]);
  await tx.query(`DELETE FROM membership_brand_grants WHERE workspace_id=$1 AND user_id=$2`, [workspaceId, userId]);
  if (s.restricted && s.brandIds.length) {
    await tx.query(
      `INSERT INTO membership_brand_grants(workspace_id, user_id, brand_id)
       SELECT $1, $2, b.id FROM brands b WHERE b.workspace_id=$1 AND b.id = ANY($3::uuid[]) ON CONFLICT DO NOTHING`, [workspaceId, userId, s.brandIds]);
  }
}

/** Serialise owner-affecting changes per workspace (concurrent removals/demotions cannot drop the last owner). */
export async function lockWorkspace(tx: Queryable, workspaceId: string): Promise<void> {
  await tx.query(`SELECT 1 FROM workspaces WHERE id=$1 FOR NO KEY UPDATE`, [workspaceId]);
}

/** Active owners (direct, unexpired owner grant + active membership). Call after lockWorkspace(). */
export async function activeOwnerIds(tx: Queryable, workspaceId: string): Promise<string[]> {
  const r = await many<{ user_id: string }>(tx,
    `SELECT DISTINCT g.user_id FROM scoped_role_grants g
       JOIN memberships m ON m.workspace_id=g.workspace_id AND m.user_id=g.user_id AND m.status='active'
      WHERE g.workspace_id=$1 AND g.principal_type='user' AND g.role='owner' AND g.revoked_at IS NULL
        AND (g.expires_at IS NULL OR g.expires_at > now())`, [workspaceId]);
  return r.map((x) => x.user_id);
}

/** Is this caller an owner (V2 grant; legacy role for test contexts)? */
export function actorIsOwner(ctx: Ctx): boolean {
  const a = ctx.access.authz;
  if (!a) return ctx.access.role === 'owner';
  return a.subject.status === 'active' && a.subject.grants.some((g) => g.role === 'owner' && g.scopeType === 'workspace' && g.via === 'direct');
}

export interface GrantDto {
  id: string; role: RolePreset; scope_type: 'workspace' | 'brand' | 'connection'; brand_id: string | null; brand_name: string | null;
  connection_id: string | null; connection_name: string | null; expires_at: string | null; via: 'direct' | 'team'; team_id: string | null; team_name: string | null;
  source: string; granted_by_email: string | null; created_at: string; expired: boolean;
}

interface GrantDtoRow {
  id: string; role: RolePreset; scope_type: GrantDto['scope_type']; brand_id: string | null; brand_name: string | null; connection_id: string | null;
  connection_name: string | null; expires_at: Date | null; via: 'direct' | 'team'; team_id: string | null; team_name: string | null; source: string;
  granted_by_email: string | null; created_at: Date; user_id: string;
}

/**
 * Grants (direct + via teams, including expired ones for display) for a set of users, filtered to the
 * brands the VIEWER may see (no exposure of unrelated brands).
 */
export async function grantsForUsers(db: Queryable, ctx: Ctx, userIds: string[], opts: { includeExpired?: boolean } = {}): Promise<Map<string, GrantDto[]>> {
  const out = new Map<string, GrantDto[]>();
  if (!userIds.length) return out;
  const rows = await many<GrantDtoRow>(db,
    `WITH x AS (
       SELECT g.*, g.user_id AS for_user, 'direct' AS via FROM scoped_role_grants g
        WHERE g.workspace_id=$1 AND g.principal_type='user' AND g.user_id = ANY($2::uuid[]) AND g.revoked_at IS NULL
       UNION ALL
       SELECT g.*, tm.user_id AS for_user, 'team' AS via FROM scoped_role_grants g
         JOIN team_memberships tm ON tm.team_id=g.team_id AND tm.user_id = ANY($2::uuid[])
         JOIN teams t ON t.id=g.team_id AND t.archived_at IS NULL
        WHERE g.workspace_id=$1 AND g.principal_type='team' AND g.revoked_at IS NULL)
     SELECT x.id, x.role, x.scope_type, x.brand_id, b.name AS brand_name, x.connection_id, c.display_name AS connection_name, x.expires_at, x.via,
            x.team_id, t.name AS team_name, x.source, gu.email AS granted_by_email, x.created_at, x.for_user AS user_id
       FROM x LEFT JOIN brands b ON b.id=x.brand_id LEFT JOIN connections c ON c.id=x.connection_id
       LEFT JOIN teams t ON t.id=x.team_id LEFT JOIN users gu ON gu.id=x.granted_by
      WHERE ($3::boolean OR x.expires_at IS NULL OR x.expires_at > now())
      ORDER BY array_position(ARRAY['owner','admin','team_manager','brand_manager','publisher','approver','editor','analyst','viewer','exporter','guest','integration'], x.role), b.name NULLS FIRST`,
    [ctx.access.workspaceId, userIds, !!opts.includeExpired]);
  const visible = ctx.access.brandIds;
  const now = Date.now();
  for (const r of rows) {
    if (r.brand_id && visible !== null && !visible.includes(r.brand_id)) continue;
    const list = out.get(r.user_id) ?? [];
    list.push({
      id: r.id, role: r.role, scope_type: r.scope_type, brand_id: r.brand_id, brand_name: r.brand_name, connection_id: r.connection_id,
      connection_name: r.connection_name, expires_at: r.expires_at?.toISOString() ?? null, via: r.via, team_id: r.team_id, team_name: r.team_name,
      source: r.source, granted_by_email: r.granted_by_email, created_at: r.created_at.toISOString(), expired: !!r.expires_at && r.expires_at.getTime() <= now,
    });
    out.set(r.user_id, list);
  }
  return out;
}

/**
 * Common tail of every grant/membership/team/restriction change (same transaction): bump the policy
 * version, refresh the legacy membership summary of affected users and revalidate (hold) queued
 * publications whose authority they carried.
 */
export async function commitPolicyChange(tx: Queryable, workspaceId: string, userIds: string[]): Promise<{ policyVersion: number; held: number }> {
  const policyVersion = await bumpPolicyVersion(tx, workspaceId);
  const ids = [...new Set(userIds)];
  for (const u of ids) {
    const m = await maybeOne(tx, `SELECT 1 FROM memberships WHERE workspace_id=$1 AND user_id=$2 AND status <> 'removed'`, [workspaceId, u]);
    if (m) await syncLegacyMembership(tx, workspaceId, u);
  }
  const held = ids.length ? await revalidateAuthorities(tx, workspaceId, ids) : 0;
  return { policyVersion, held };
}
