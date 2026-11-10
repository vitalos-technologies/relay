// Tenant, brand and permission enforcement. Every service query on tenant data must include
// workspace_id = ctx.access.workspaceId. Authorization is evaluated by the V2 policy (authz.ts):
//  - requireAction(ctx, action, resource?) declares a permission for this request;
//  - assertBrand()/brandAllowed() re-check EVERY declared permission against each brand the request
//    touches, so a brand-scoped grant on Brand A can never authorize work on Brand B.
// Cross-tenant/unauthorized lookups return not_found (no existence leakage).
import {
  AppError, LEGACY_ACTION_MAP, PERMISSIONS, PRESET_PERMISSIONS, can as legacyCan, forbidden, notFound, type Action, type Assurance, type Permission, type Role,
  type RolePreset,
} from '@social-lite/core';
import { getPool, maybeOne, type Queryable } from '@social-lite/db';
import type { Ctx, WorkspaceAccess } from './context.js';
import { authorize, brandsVisible, loadUserAuthz, type AuthorizeResult } from './authz.js';

export async function loadAccess(userId: string, workspaceId: string, db: Queryable = getPool(), assurance: Assurance | null = null): Promise<WorkspaceAccess | null> {
  const m = await maybeOne<{ role: Role; is_demo: boolean; state: string; status: string }>(db,
    `SELECT m.role, w.is_demo, w.state, m.status
       FROM memberships m JOIN workspaces w ON w.id = m.workspace_id
      WHERE m.workspace_id = $1 AND m.user_id = $2 AND m.removed_at IS NULL`, [workspaceId, userId]);
  if (!m || m.state !== 'active' || m.status !== 'active') return null;
  const authz = await loadUserAuthz(userId, workspaceId, assurance ?? { mfaVerified: false, authTime: null }, db);
  if (authz.subject.status !== 'active') return null;
  const hold = await memberHoldFor(db, workspaceId, userId);
  if (hold) return { workspaceId, role: m.role, brandIds: [], isDemo: m.is_demo, authz, memberHold: hold };
  return { workspaceId, role: m.role, brandIds: brandsVisible(authz), isDemo: m.is_demo, authz };
}

/** Permissions a member held by the plan's user limit keeps (D33): billing, support, and reading the workspace shell. */
export const MEMBER_HOLD_ALLOWED: ReadonlySet<Permission> = new Set<Permission>(['workspace.read', 'billing.read', 'billing.manage', 'support.workspace']);

/** D33 members gauge: is this person over the plan's user limit? Cheap when the workspace has a single active person. */
async function memberHoldFor(db: Queryable, workspaceId: string, userId: string): Promise<string | null> {
  const n = await maybeOne<{ n: number }>(db, `SELECT count(*)::int n FROM memberships WHERE workspace_id=$1 AND status='active' AND removed_at IS NULL`, [workspaceId]);
  if (!n || n.n <= 1) return null;
  const [{ memberHold }, { entitlementsCoreCached }] = await Promise.all([import('./entitlements/actions.js'), import('./entitlements/resolve.js')]);
  const core = await entitlementsCoreCached(workspaceId, db);
  if (core.limits.members.limit === null) return null;
  return memberHold(db, workspaceId, userId, core);
}

const isPermission = (s: string): s is Permission => (PERMISSIONS as readonly string[]).includes(s);

function toPermission(action: Action | Permission): Permission {
  if (isPermission(action)) return action;
  const p = LEGACY_ACTION_MAP[action];
  if (!p) throw new Error(`unmapped action ${action}`);
  return p;
}

function throwFor(r: AuthorizeResult, message?: string): never {
  if (r.reason === 'mfa_required') throw new AppError('mfa_required', 'Verify with your second factor to do this.', undefined, { reason: r.reason, policy_version: r.policyVersion });
  if (r.reason === 'step_up_required') throw new AppError('step_up_required', 'Confirm it’s you to continue.', undefined, { reason: r.reason, policy_version: r.policyVersion });
  throw new AppError('forbidden', message ?? 'You don’t have permission to do that.', undefined, { reason: r.reason, policy_version: r.policyVersion });
}

/** Strict check for a known resource. Returns the decision (for audit/policy version). */
export function authorizeCtx(ctx: Ctx, action: Action | Permission, resource: { brandId?: string | null; connectionId?: string | null } = {}, opts: { stepUp?: boolean } = {}): AuthorizeResult {
  const perm = toPermission(action);
  const a = ctx.access.authz;
  if (!a) {
    // Legacy test contexts without V2 state: V1 role matrix (never used by real requests). Permissions with no
    // V1 action fall back to the V2 preset of the same name (V1 roles are V2 presets; same as the 009 backfill).
    const legacy = (Object.entries(LEGACY_ACTION_MAP).find(([, p]) => p === perm)?.[0] ?? null) as Action | null;
    const roleOk = legacy ? legacyCan(ctx.access.role, legacy) : (PRESET_PERMISSIONS[ctx.access.role as RolePreset] ?? []).includes(perm);
    const ok = roleOk && (!resource.brandId || brandAllowedLegacy(ctx, resource.brandId));
    return { allowed: ok, reason: ok ? 'granted' : 'no_grant', sources: [], policyVersion: 0 };
  }
  return authorize(a, perm, resource, opts);
}

/**
 * Declare and check a permission. With a resource: strict. Without: the subject must hold it on some
 * scope now, and it is re-checked against every brand this request touches (before or after).
 */
export function requireAction(ctx: Ctx, action: Action | Permission, message?: string | { brandId?: string | null; connectionId?: string | null; stepUp?: boolean; message?: string }): void {
  const opts = typeof message === 'string' ? { message } : (message ?? {});
  const perm = toPermission(action);
  if (ctx.access.memberHold && !MEMBER_HOLD_ALLOWED.has(perm)) {
    throw new AppError('entitlement_required', ctx.access.memberHold, undefined, { reason: 'over_limit_held', allowance: 'members', upgrade_to: 'standard' });
  }
  const a = ctx.access.authz;
  if (opts.brandId !== undefined || opts.connectionId !== undefined) {
    const r = authorizeCtx(ctx, perm, { brandId: opts.brandId, connectionId: opts.connectionId }, { stepUp: opts.stepUp });
    if (!r.allowed) throwFor(r, opts.message);
  } else if (a) {
    const scopes = new Set<string | null>([null, ...a.subject.grants.map((g) => g.brandId)]);
    const decisions = [...scopes].map((b) => authorize(a, perm, { brandId: b }, { stepUp: opts.stepUp }));
    const ok = decisions.find((d) => d.allowed);
    if (!ok) throwFor(decisions.find((d) => d.reason === 'mfa_required' || d.reason === 'step_up_required') ?? decisions[0]!, opts.message);
  } else if (!authorizeCtx(ctx, perm).allowed) {
    throw forbidden(opts.message);
  }
  if (a) {
    a.required.add(perm);
    for (const b of a.touchedBrands) {
      const r = authorize(a, perm, { brandId: b }, { stepUp: opts.stepUp });
      if (!r.allowed) throwFor(r, opts.message);
    }
  }
}

function brandAllowedLegacy(ctx: Ctx, brandId: string): boolean {
  return ctx.access.brandIds === null || ctx.access.brandIds.includes(brandId);
}

/** Visible AND every permission declared so far is granted on this brand. Records the brand as touched. */
export function brandAllowed(ctx: Ctx, brandId: string): boolean {
  const a = ctx.access.authz;
  if (!a) return brandAllowedLegacy(ctx, brandId);
  const visible = a.subject.status === 'active' && (ctx.access.brandIds === null || ctx.access.brandIds.includes(brandId));
  if (!visible) return false;
  for (const perm of a.required) if (!authorize(a, perm, { brandId }).allowed) return false;
  a.touchedBrands.add(brandId);
  return true;
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

/** Load a brand in the caller's workspace the caller may act on (all declared permissions); else not_found/forbidden. */
export async function assertBrand(ctx: Ctx, brandId: string, db: Queryable = getPool()): Promise<BrandRow> {
  assertUuid(brandId, 'Brand');
  const b = await maybeOne<BrandRow>(db, `SELECT * FROM brands WHERE id = $1 AND workspace_id = $2`, [brandId, ctx.access.workspaceId]);
  if (!b) throw notFound('Brand');
  const visible = ctx.access.brandIds === null || ctx.access.brandIds.includes(b.id);
  if (!visible) throw notFound('Brand');
  if (!brandAllowed(ctx, b.id)) throw forbidden('You don’t have permission to do that for this brand.');
  return b;
}

/**
 * SQL predicate restricting a brand column to the caller's visible brands.
 * Usage: const f = brandFilter(ctx, 'p.brand_id', params.length + 1); params.push(...f.params)
 */
export function brandFilter(ctx: Ctx, column: string, paramIndex: number): { sql: string; params: unknown[] } {
  if (ctx.access.brandIds === null) return { sql: 'TRUE', params: [] };
  return { sql: `${column} = ANY($${paramIndex}::uuid[])`, params: [ctx.access.brandIds] };
}
