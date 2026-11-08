// Session info, workspace switching/settings/pause and first-run workspace creation.
import { AppError, LEGACY_ACTION_MAP, PERMISSIONS, can, isValidTimeZone, notFound, type Action, type Permission, type Role } from '@social-lite/core';
import { getPool, many, maybeOne, withTx, type Queryable } from '@social-lite/db';
import { audit } from './audit.js';
import { setActiveWorkspace, type SessionRecord } from './auth/session.js';
import { brandDto, type BrandDto } from './brands.js';
import { config, mockProvidersEnabled } from './config.js';
import type { Actor, Ctx } from './context.js';
import { onScopePaused, onScopeResumed } from './engine/hooks.js';
import { isUuid, loadAccess, requireAction } from './tenancy.js';
import { authorize, hasAnywhere } from './authz.js';
import type { WorkspaceAccess } from './context.js';
import type { DraftRecoveryPolicy } from '@social-lite/core/contracts/v31-data';
import { draftRecoveryPolicy } from './data/policy.js';
import { loadOperatorRole } from './admin/platform.js';

async function supportBanner(db: Queryable, workspaceId: string, userId: string): Promise<SessionInfo['support_access']> {
  const r = await maybeOne<{ active: number; pending: number; until: Date | null; mine: boolean }>(db,
    `SELECT count(*) FILTER (WHERE status='active' AND expires_at > now())::int active,
            count(*) FILTER (WHERE status='requested' AND request_expires_at > now())::int pending,
            max(expires_at) FILTER (WHERE status='active' AND expires_at > now()) until,
            bool_or(status='active' AND expires_at > now() AND operator_user_id=$2) mine
       FROM support_access_grants WHERE workspace_id=$1 AND status IN ('requested','active')`, [workspaceId, userId]);
  return r && (r.active || r.pending) ? { active: r.active, pending: r.pending, until: r.until?.toISOString() ?? null, mine: !!r.mine } : null;
}

const ALL_ACTIONS = {
  'workspace.manage_ownership': true, 'workspace.delete': true, 'workspace.settings': true,
  'members.invite': true, 'members.remove': true, 'members.change_role': true,
  'connections.manage': true, 'brands.manage': true, 'drafts.edit': true, 'approvals.decide': true,
  'schedule.publish': true, 'pause.emergency': true, 'history.read': true, 'history.export': true,
  'assets.upload': true, 'diagnostics.read': true, 'setup.manage': true,
} satisfies Record<Action, true>;
export const ACTIONS = Object.keys(ALL_ACTIONS) as Action[];

/** V1 role matrix (legacy helper; real sessions use permissionsForAccess). */
export function permissionsFor(role: Role | null): Record<Action, boolean> {
  return Object.fromEntries(ACTIONS.map((a) => [a, role ? can(role, a) : false])) as Record<Action, boolean>;
}

/**
 * Legacy UI flags computed from the V2 policy: each V1 action maps to its V2 permission and is true when
 * the member holds it on SOME scope (MFA/step-up are enforced per request, so they do not hide buttons).
 */
export function permissionsForAccess(access: WorkspaceAccess | null): Record<Action, boolean> {
  const a = access?.authz;
  return Object.fromEntries(ACTIONS.map((x) => [x, !!a && hasAnywhere(a, LEGACY_ACTION_MAP[x]!)])) as Record<Action, boolean>;
}

const ROLE_ORDER = ['owner', 'admin', 'brand_manager', 'publisher', 'approver', 'editor', 'team_manager', 'analyst', 'viewer', 'exporter', 'guest'];
/** Highest V2 preset the member currently holds (display only). */
export function primaryRole(access: WorkspaceAccess | null): string | undefined {
  const now = Date.now();
  const roles = new Set<string>((access?.authz?.subject.grants ?? []).filter((g) => !g.expiresAt || new Date(g.expiresAt).getTime() > now).map((g) => g.role));
  return ROLE_ORDER.find((r) => roles.has(r));
}

/** V2 flags: permission held anywhere, and the permissions held per visible brand. */
export function v2PermissionsForAccess(access: WorkspaceAccess | null, brandIds: string[] = access?.brandIds ?? []): { permissions: Record<Permission, boolean>; brands: Record<string, Permission[]> } {
  const a = access?.authz;
  const permissions = Object.fromEntries(PERMISSIONS.map((p) => [p, !!a && hasAnywhere(a, p)])) as Record<Permission, boolean>;
  const brands: Record<string, Permission[]> = {};
  if (a) {
    const noAssurance = { ...a, subject: { ...a.subject, assurance: null } };
    for (const b of brandIds) brands[b] = PERMISSIONS.filter((p) => authorize(noAssurance, p, { brandId: b }).allowed);
  }
  return { permissions, brands };
}

export interface WorkspaceDto {
  id: string; name: string; timezone: string; is_demo: boolean; publishing_paused: boolean;
  paused_reason: string | null; paused_at: string | null; limits: Record<string, unknown>; created_at: string;
}

interface WorkspaceRow {
  id: string; name: string; timezone: string; is_demo: boolean; publishing_paused: boolean; paused_reason: string | null;
  paused_at: Date | null; limits: Record<string, unknown>; created_at: Date; state: string;
}

export const workspaceDto = (w: WorkspaceRow): WorkspaceDto => ({
  id: w.id, name: w.name, timezone: w.timezone, is_demo: w.is_demo, publishing_paused: w.publishing_paused,
  paused_reason: w.paused_reason, paused_at: w.paused_at?.toISOString() ?? null, limits: w.limits, created_at: w.created_at.toISOString(),
});

export interface SessionInfo {
  user: { id: string; email: string; name: string | null };
  csrf_token: string;
  workspace: { id: string; name: string; role: Role; is_demo: boolean; timezone: string; publishing_paused: boolean;
    /** V2: highest preset held (direct or via team), for display. */ primary_role?: string } | null;
  workspaces: Array<{ id: string; name: string; role: Role; is_demo: boolean }>;
  brands: Array<{ id: string; name: string; timezone: string; publishing_paused: boolean; approval_required: boolean; is_demo: boolean }>;
  /** Legacy (V1 action) flags, computed from V2 grants. */
  permissions: Record<Action, boolean>;
  /** V2 permission flags (held on some scope) + per-brand permissions; policy version they were computed at. */
  v2: { permissions: Record<Permission, boolean>; brands: Record<string, Permission[]>; policy_version: number; mfa_verified: boolean;
    pending_ownership_transfer: { id: string; from_email: string } | null };
  mock_providers_enabled: boolean;
  app_env: 'development' | 'test' | 'production';
  /** First-run: true when this user may create a workspace (POST /api/workspaces). */
  can_create_workspace: boolean;
  /** V3.1: workspace policy for browser-side draft recovery (null without an active workspace). */
  draft_recovery?: DraftRecoveryPolicy | null;
  /** V3.1 Admin: platform operator role of this user (re-read every request; UI convenience only). */
  platform_role?: 'operator' | 'support' | 'billing' | null;
  /** V3.1 Admin: support access open on the active workspace (banner). */
  support_access?: { active: number; pending: number; until: string | null; mine: boolean } | null;
}

export async function canCreateWorkspace(userId: string, db: Queryable = getPool()): Promise<boolean> {
  const r = await maybeOne<{ memberships: number; workspaces: number }>(db,
    `SELECT (SELECT count(*) FROM memberships m JOIN workspaces w ON w.id=m.workspace_id
              WHERE m.user_id=$1 AND m.removed_at IS NULL AND w.state='active')::int AS memberships,
            (SELECT count(*) FROM workspaces)::int AS workspaces`, [userId]);
  if (!r || r.memberships > 0) return false;
  return config().APP_ENV !== 'production' || r.workspaces === 0 || process.env.ALLOW_SELF_SERVE_WORKSPACES === 'true';
}

export async function sessionInfo(session: SessionRecord, actor: Actor, db: Queryable = getPool()): Promise<SessionInfo> {
  const workspaces = await many<{ id: string; name: string; role: Role; is_demo: boolean; timezone: string; publishing_paused: boolean }>(db,
    `SELECT w.id, w.name, m.role, w.is_demo, w.timezone, w.publishing_paused
       FROM memberships m JOIN workspaces w ON w.id = m.workspace_id
      WHERE m.user_id=$1 AND m.removed_at IS NULL AND m.status='active' AND w.state='active' ORDER BY w.name, w.id`, [actor.userId]);
  let active = workspaces.find((w) => w.id === session.activeWorkspaceId) ?? null;
  if (!active && workspaces.length) {
    active = workspaces[0]!;
    await setActiveWorkspace(db, session.id, active.id);
  }
  let brands: BrandDto[] = [];
  let role: Role | null = null;
  let access: WorkspaceAccess | null = null;
  if (active) {
    access = await loadAccess(actor.userId, active.id, db, { mfaVerified: !!session.mfaVerified, authTime: session.authTime?.toISOString() ?? null });
    role = access?.role ?? null;
    if (access) {
      brands = (await many<Parameters<typeof brandDto>[0]>(db,
        `SELECT b.*, 0 AS connection_count FROM brands b WHERE b.workspace_id=$1 AND b.archived_at IS NULL
           AND ($2::uuid[] IS NULL OR b.id = ANY($2::uuid[])) ORDER BY b.name, b.id`, [active.id, access.brandIds])).map(brandDto);
    }
  }
  return {
    user: { id: actor.userId, email: actor.email, name: actor.name },
    csrf_token: session.csrfToken,
    workspace: active && role ? { id: active.id, name: active.name, role, is_demo: active.is_demo, timezone: active.timezone, publishing_paused: active.publishing_paused,
      primary_role: primaryRole(access) } : null,
    workspaces: workspaces.map((w) => ({ id: w.id, name: w.name, role: w.role, is_demo: w.is_demo })),
    brands: brands.map((b) => ({ id: b.id, name: b.name, timezone: b.timezone, publishing_paused: b.publishing_paused, approval_required: b.approval_required, is_demo: b.is_demo })),
    permissions: permissionsForAccess(access),
    v2: { ...v2PermissionsForAccess(access, brands.map((b) => b.id)), policy_version: access?.authz?.policyVersion ?? 0, mfa_verified: !!session.mfaVerified,
      pending_ownership_transfer: access ? await maybeOne<{ id: string; from_email: string }>(db,
        `SELECT t.id, u.email AS from_email FROM ownership_transfers t JOIN users u ON u.id=t.from_user_id
          WHERE t.workspace_id=$1 AND t.to_user_id=$2 AND t.status='pending' AND t.expires_at > now() LIMIT 1`, [active!.id, actor.userId]) : null },
    mock_providers_enabled: mockProvidersEnabled(),
    app_env: config().APP_ENV,
    can_create_workspace: workspaces.length === 0 ? await canCreateWorkspace(actor.userId, db) : false,
    draft_recovery: active && access ? await draftRecoveryPolicy(db, active.id, actor.userId) : null,
    platform_role: await loadOperatorRole(actor.userId, db),
    support_access: active && access ? await supportBanner(db, active.id, actor.userId) : null,
  };
}

/**
 * Switch the session's active workspace. Authority is the membership re-checked here (a client-supplied
 * workspace id is never proof). The client must drop every cached response on switch (lib/client).
 */
export async function switchWorkspace(session: SessionRecord, actor: Actor, workspaceId: string, db: Queryable = getPool()): Promise<SessionInfo> {
  const access = isUuid(workspaceId) ? await loadAccess(actor.userId, workspaceId, db) : null;
  if (!access) throw notFound('Workspace');
  await setActiveWorkspace(db, session.id, workspaceId);
  return sessionInfo({ ...session, activeWorkspaceId: workspaceId }, actor, db);
}

async function loadWorkspace(db: Queryable, id: string, lock = false): Promise<WorkspaceRow> {
  const w = await maybeOne<WorkspaceRow>(db, `SELECT * FROM workspaces WHERE id=$1 ${lock ? 'FOR UPDATE' : ''}`, [id]);
  if (!w) throw notFound('Workspace');
  return w;
}

export async function getWorkspace(ctx: Ctx): Promise<WorkspaceDto> {
  return workspaceDto(await loadWorkspace(getPool(), ctx.access.workspaceId));
}

function validName(name: string, field = 'name'): string {
  const n = name.trim();
  if (n.length < 1 || n.length > 120) throw new AppError('validation_failed', 'Name must be 1-120 characters', { [field]: 'Must be 1-120 characters' });
  return n;
}

function validTz(tz: string, field = 'timezone'): string {
  if (!isValidTimeZone(tz) || tz.length > 64) throw new AppError('validation_failed', 'Unknown time zone', { [field]: 'Use an IANA time zone such as Europe/London' });
  return tz;
}

export async function updateWorkspace(ctx: Ctx, patch: { name?: string; timezone?: string }): Promise<WorkspaceDto> {
  requireAction(ctx, 'workspace.settings');
  const name = patch.name !== undefined ? validName(patch.name) : undefined;
  const tz = patch.timezone !== undefined ? validTz(patch.timezone) : undefined;
  return withTx(async (tx) => {
    const before = await loadWorkspace(tx, ctx.access.workspaceId, true);
    const w = (await maybeOne<WorkspaceRow>(tx,
      `UPDATE workspaces SET name=coalesce($2, name), timezone=coalesce($3, timezone) WHERE id=$1 RETURNING *`,
      [ctx.access.workspaceId, name ?? null, tz ?? null]))!;
    await audit(tx, { workspaceId: w.id, actorUserId: ctx.actor.userId, action: 'workspace.updated', resourceType: 'workspace', resourceId: w.id,
      diff: { name: name !== undefined ? { from: before.name, to: w.name } : undefined, timezone: tz !== undefined ? { from: before.timezone, to: w.timezone } : undefined },
      correlationId: ctx.correlationId });
    return workspaceDto(w);
  });
}

/** Emergency pause/resume of the whole workspace (SC-05). Engine hooks run in the same transaction. */
export async function setWorkspacePaused(ctx: Ctx, input: { paused: boolean; reason?: string | null }): Promise<WorkspaceDto & { affected: Record<string, number> }> {
  requireAction(ctx, 'pause.emergency');
  const reason = input.reason?.trim().slice(0, 500) || null;
  return withTx(async (tx) => {
    const before = await loadWorkspace(tx, ctx.access.workspaceId, true);
    const w = (await maybeOne<WorkspaceRow>(tx,
      input.paused
        ? `UPDATE workspaces SET publishing_paused=true, paused_reason=$2, paused_by=$3, paused_at=CASE WHEN publishing_paused THEN paused_at ELSE now() END WHERE id=$1 RETURNING *`
        : `UPDATE workspaces SET publishing_paused=false, paused_reason=NULL, paused_by=NULL, paused_at=NULL WHERE id=$1 RETURNING *`,
      input.paused ? [ctx.access.workspaceId, reason, ctx.actor.userId] : [ctx.access.workspaceId]))!;
    let affected: Record<string, number> = {};
    if (input.paused) affected = { paused: await onScopePaused(tx, { workspaceId: w.id }) };
    else if (before.publishing_paused) affected = await onScopeResumed(tx, { workspaceId: w.id });
    await audit(tx, { workspaceId: w.id, actorUserId: ctx.actor.userId, action: input.paused ? 'workspace.paused' : 'workspace.resumed',
      resourceType: 'workspace', resourceId: w.id, diff: { reason, was_paused: before.publishing_paused, ...affected }, correlationId: ctx.correlationId });
    return { ...workspaceDto(w), affected };
  });
}

/**
 * First-run workspace creation: creates workspace + owner membership + first brand and makes it the
 * session's active workspace. Allowed only for users without memberships, and in production only
 * while no workspace exists (bootstrap) or when ALLOW_SELF_SERVE_WORKSPACES=true.
 */
export async function createWorkspace(session: SessionRecord, actor: Actor, input: { name: string; timezone: string; brand_name?: string }, correlationId?: string,
  opts: { plan?: string | null; source?: 'signup' | 'onboarding' } = {}): Promise<{ workspace: WorkspaceDto; brand: BrandDto }> {
  const name = validName(input.name);
  const tz = validTz(input.timezone);
  const brandName = validName(input.brand_name ?? name, 'brand_name');
  return withTx(async (tx) => {
    // Serialise bootstrap so two first users cannot both pass the "zero workspaces" check.
    await tx.query(`SELECT pg_advisory_xact_lock(727101)`);
    if (!(await canCreateWorkspace(actor.userId, tx))) {
      throw new AppError('forbidden', 'You cannot create a workspace. Ask a workspace owner to invite you.');
    }
    const w = (await maybeOne<WorkspaceRow>(tx,
      `INSERT INTO workspaces(name, timezone, is_demo) VALUES ($1,$2,false) RETURNING *`, [name, tz]))!;
    await tx.query(`INSERT INTO memberships(workspace_id, user_id, role) VALUES ($1,$2,'owner')`, [w.id, actor.userId]);
    // V2: authority is the scoped owner grant (memberships.role is only a legacy summary).
    await tx.query(`INSERT INTO scoped_role_grants(workspace_id, principal_type, user_id, role, scope_type, granted_by, source) VALUES ($1,'user',$2,'owner','workspace',$2,'workspace_created')`, [w.id, actor.userId]);
    await tx.query(`INSERT INTO membership_status_history(workspace_id, user_id, from_status, to_status, actor_user_id, reason) VALUES ($1,$2,NULL,'active',$2,'workspace_created')`, [w.id, actor.userId]);
    const b = (await maybeOne<Parameters<typeof brandDto>[0]>(tx,
      `INSERT INTO brands(workspace_id, name, timezone) VALUES ($1,$2,$3) RETURNING *, 0 AS connection_count`, [w.id, brandName, tz]))!;
    await setActiveWorkspace(tx, session.id, w.id);
    await audit(tx, { workspaceId: w.id, actorUserId: actor.userId, action: 'workspace.created', resourceType: 'workspace', resourceId: w.id,
      diff: { name, timezone: tz, brand_id: b.id }, correlationId });
    // V4 billing: the workspace's one 14-day no-card trial starts now, on the plan chosen at signup (default Standard).
    const { startTrialTx } = await import('./billing/trials.js');
    await startTrialTx(tx, { workspaceId: w.id, planId: opts.plan ?? 'standard', userId: actor.userId, source: opts.source ?? 'onboarding' });
    return { workspace: workspaceDto(w), brand: brandDto(b) };
  });
}

/**
 * A tab that still shows workspace A must not receive workspace B data after a switch in another tab:
 * the client sends the workspace it rendered (X-Workspace-Id); a mismatch is refused so the tab reloads.
 * The header is never authority — it can only cause a refusal.
 */
export function assertExpectedWorkspace(activeWorkspaceId: string | null, header: string | null | undefined): void {
  if (header && activeWorkspaceId && header !== activeWorkspaceId) {
    throw new AppError('conflict', 'You switched workspace in another tab. Reload to continue.', undefined, { reason: 'workspace_changed', active_workspace_id: activeWorkspaceId });
  }
}
