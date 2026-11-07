// V2 central authorization service: authorize(subject, action, resource, context).
// Loads the subject from the database on every request (no cross-request permission cache), so
// removal/suspension/expiry take effect on the very next request from any open tab.
import {
  evaluate, visibleBrands, type Assurance, type Decision, type Grant, type Permission, type Resource, type Restriction,
  type RolePreset, type SecurityPolicy, type Subject,
} from '@social-lite/core';
import { getPool, many, maybeOne, type Queryable } from '@social-lite/db';

export interface AuthzState {
  subject: Subject;
  policy: SecurityPolicy;
  policyVersion: number;
  /** Permissions this request declared (requireAction) — re-checked against every brand it touches. */
  required: Set<Permission>;
  /** Brands this request has loaded resources from. */
  touchedBrands: Set<string>;
}

export interface AuthorizeResult extends Decision { policyVersion: number }

const DEFAULT_POLICY: SecurityPolicy = { mfa_required_for: ['owner', 'admin', 'publisher', 'brand_manager'], mfa_required_all: false, step_up_seconds: 300 };

interface GrantRow { id: string; role: RolePreset; scope_type: Grant['scopeType']; brand_id: string | null; connection_id: string | null; expires_at: Date | null; team_id: string | null; via: 'direct' | 'team' }

function toGrant(r: GrantRow): Grant {
  return { grantId: r.id, role: r.role, scopeType: r.scope_type, brandId: r.brand_id, connectionId: r.connection_id,
    expiresAt: r.expires_at?.toISOString() ?? null, via: r.via, teamId: r.team_id };
}

export async function loadUserAuthz(userId: string, workspaceId: string, assurance: Assurance | null, db: Queryable = getPool()): Promise<AuthzState> {
  const ws = await maybeOne<{ policy_version: string; security_policy: SecurityPolicy; state: string }>(db,
    `SELECT policy_version, security_policy, state FROM workspaces WHERE id=$1`, [workspaceId]);
  const m = await maybeOne<{ status: Subject['status'] }>(db,
    `SELECT status FROM memberships WHERE workspace_id=$1 AND user_id=$2`, [workspaceId, userId]);
  const status: Subject['status'] = !ws || ws.state !== 'active' ? 'missing' : (m?.status ?? 'missing');
  const grants = status === 'active' ? await many<GrantRow>(db,
    `SELECT g.id, g.role, g.scope_type, g.brand_id, g.connection_id, g.expires_at, NULL::uuid AS team_id, 'direct' AS via
       FROM scoped_role_grants g WHERE g.workspace_id=$1 AND g.user_id=$2 AND g.revoked_at IS NULL AND (g.expires_at IS NULL OR g.expires_at > now())
     UNION ALL
     SELECT g.id, g.role, g.scope_type, g.brand_id, g.connection_id, g.expires_at, g.team_id, 'team' AS via
       FROM scoped_role_grants g JOIN team_memberships tm ON tm.team_id=g.team_id AND tm.user_id=$2
       JOIN teams t ON t.id=g.team_id AND t.archived_at IS NULL
      WHERE g.workspace_id=$1 AND g.principal_type='team' AND g.revoked_at IS NULL AND (g.expires_at IS NULL OR g.expires_at > now())`,
    [workspaceId, userId]) : [];
  const restrictions = status === 'active' ? await many<{ brand_id: string | null; actions: string[]; expires_at: Date | null }>(db,
    `SELECT brand_id, actions, expires_at FROM access_restrictions WHERE workspace_id=$1 AND user_id=$2 AND revoked_at IS NULL`, [workspaceId, userId]) : [];
  return {
    subject: {
      kind: 'user', status, grants: grants.map(toGrant), assurance,
      restrictions: restrictions.map((r): Restriction => ({ brandId: r.brand_id, actions: r.actions, expiresAt: r.expires_at?.toISOString() ?? null })),
    },
    policy: { ...DEFAULT_POLICY, ...(ws?.security_policy ?? {}) },
    policyVersion: Number(ws?.policy_version ?? 0),
    required: new Set(), touchedBrands: new Set(),
  };
}

export async function loadServiceAccountAuthz(serviceAccountId: string, workspaceId: string, db: Queryable = getPool()): Promise<AuthzState> {
  const sa = await maybeOne<{ disabled_at: Date | null; expires_at: Date | null }>(db,
    `SELECT disabled_at, expires_at FROM service_accounts WHERE id=$1 AND workspace_id=$2`, [serviceAccountId, workspaceId]);
  const status: Subject['status'] = !sa ? 'missing' : sa.disabled_at ? 'disabled' : sa.expires_at && sa.expires_at.getTime() <= Date.now() ? 'expired' : 'active';
  const grants = status === 'active' ? await many<GrantRow>(db,
    `SELECT id, role, scope_type, brand_id, connection_id, expires_at, NULL::uuid AS team_id, 'direct' AS via FROM scoped_role_grants
      WHERE workspace_id=$1 AND service_account_id=$2 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())`, [workspaceId, serviceAccountId]) : [];
  const ws = await maybeOne<{ policy_version: string }>(db, `SELECT policy_version FROM workspaces WHERE id=$1`, [workspaceId]);
  return { subject: { kind: 'service_account', status, grants: grants.map(toGrant), restrictions: [], assurance: null },
    policy: DEFAULT_POLICY, policyVersion: Number(ws?.policy_version ?? 0), required: new Set(), touchedBrands: new Set() };
}

/** authorize(subject, action, resource, context) — the single policy entry point. Fails closed on error. */
export function authorize(state: AuthzState, perm: Permission, resource: Resource = {}, opts: { stepUp?: boolean; now?: Date } = {}): AuthorizeResult {
  try {
    return { ...evaluate(state.subject, perm, resource, state.policy, opts.now ?? new Date(), { stepUp: opts.stepUp }), policyVersion: state.policyVersion };
  } catch {
    return { allowed: false, reason: 'no_grant', sources: [], policyVersion: state.policyVersion };
  }
}

/** True when any grant gives `perm` on some scope (pre-check before the brand is known). */
export function hasAnywhere(state: AuthzState, perm: Permission): boolean {
  if (state.subject.status !== 'active') return false;
  const brands = new Set<string | null>([null, ...state.subject.grants.map((g) => g.brandId)]);
  return [...brands].some((b) => authorize(state, perm, { brandId: b }).allowed || authorize(state, perm, { brandId: b }).reason === 'mfa_required');
}

export function brandsVisible(state: AuthzState): string[] | null {
  return visibleBrands(state.subject);
}

/** Bump the workspace policy version (call in the same transaction as any grant/membership/policy change). */
export async function bumpPolicyVersion(db: Queryable, workspaceId: string): Promise<number> {
  const r = await maybeOne<{ policy_version: string }>(db, `UPDATE workspaces SET policy_version = policy_version + 1 WHERE id=$1 RETURNING policy_version`, [workspaceId]);
  return Number(r?.policy_version ?? 0);
}
