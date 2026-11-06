// Session info, workspace switching/settings/pause and first-run workspace creation.
import { AppError, can, isValidTimeZone, notFound, type Action, type Role } from '@social-lite/core';
import { getPool, many, maybeOne, withTx, type Queryable } from '@social-lite/db';
import { audit } from './audit.js';
import { setActiveWorkspace, type SessionRecord } from './auth/session.js';
import { brandDto, type BrandDto } from './brands.js';
import { config, mockProvidersEnabled } from './config.js';
import type { Actor, Ctx } from './context.js';
import { onScopePaused, onScopeResumed } from './engine/hooks.js';
import { isUuid, loadAccess, requireAction } from './tenancy.js';

const ALL_ACTIONS = {
  'workspace.manage_ownership': true, 'workspace.delete': true, 'workspace.settings': true,
  'members.invite': true, 'members.remove': true, 'members.change_role': true,
  'connections.manage': true, 'brands.manage': true, 'drafts.edit': true, 'approvals.decide': true,
  'schedule.publish': true, 'pause.emergency': true, 'history.read': true, 'history.export': true,
  'assets.upload': true, 'diagnostics.read': true, 'setup.manage': true,
} satisfies Record<Action, true>;
export const ACTIONS = Object.keys(ALL_ACTIONS) as Action[];

export function permissionsFor(role: Role | null): Record<Action, boolean> {
  return Object.fromEntries(ACTIONS.map((a) => [a, role ? can(role, a) : false])) as Record<Action, boolean>;
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
  workspace: { id: string; name: string; role: Role; is_demo: boolean; timezone: string; publishing_paused: boolean } | null;
  workspaces: Array<{ id: string; name: string; role: Role; is_demo: boolean }>;
  brands: Array<{ id: string; name: string; timezone: string; publishing_paused: boolean; approval_required: boolean; is_demo: boolean }>;
  permissions: Record<Action, boolean>;
  mock_providers_enabled: boolean;
  app_env: 'development' | 'test' | 'production';
  /** First-run: true when this user may create a workspace (POST /api/workspaces). */
  can_create_workspace: boolean;
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
      WHERE m.user_id=$1 AND m.removed_at IS NULL AND w.state='active' ORDER BY w.name, w.id`, [actor.userId]);
  let active = workspaces.find((w) => w.id === session.activeWorkspaceId) ?? null;
  if (!active && workspaces.length) {
    active = workspaces[0]!;
    await setActiveWorkspace(db, session.id, active.id);
  }
  let brands: BrandDto[] = [];
  let role: Role | null = null;
  if (active) {
    const access = await loadAccess(actor.userId, active.id, db);
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
    workspace: active && role ? { id: active.id, name: active.name, role, is_demo: active.is_demo, timezone: active.timezone, publishing_paused: active.publishing_paused } : null,
    workspaces: workspaces.map((w) => ({ id: w.id, name: w.name, role: w.role, is_demo: w.is_demo })),
    brands: brands.map((b) => ({ id: b.id, name: b.name, timezone: b.timezone, publishing_paused: b.publishing_paused, approval_required: b.approval_required, is_demo: b.is_demo })),
    permissions: permissionsFor(role),
    mock_providers_enabled: mockProvidersEnabled(),
    app_env: config().APP_ENV,
    can_create_workspace: workspaces.length === 0 ? await canCreateWorkspace(actor.userId, db) : false,
  };
}

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
export async function createWorkspace(session: SessionRecord, actor: Actor, input: { name: string; timezone: string; brand_name?: string }, correlationId?: string): Promise<{ workspace: WorkspaceDto; brand: BrandDto }> {
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
    const b = (await maybeOne<Parameters<typeof brandDto>[0]>(tx,
      `INSERT INTO brands(workspace_id, name, timezone) VALUES ($1,$2,$3) RETURNING *, 0 AS connection_count`, [w.id, brandName, tz]))!;
    await setActiveWorkspace(tx, session.id, w.id);
    await audit(tx, { workspaceId: w.id, actorUserId: actor.userId, action: 'workspace.created', resourceType: 'workspace', resourceId: w.id,
      diff: { name, timezone: tz, brand_id: b.id }, correlationId });
    return { workspace: workspaceDto(w), brand: brandDto(b) };
  });
}
