// V3.1 §9: workspace data policy for browser-side draft recovery. Exposed to clients in GET /api/session
// (`draft_recovery`) and managed at /api/workspace/data-policy. The server never stores or receives the browser's
// local copies; this only tells clients whether they may keep them and for how long.
import { AppError } from '@social-lite/core';
import { DRAFT_RECOVERY_DEFAULTS, type DraftRecoveryPolicy, type LocalRecoveryMode } from '@social-lite/core/contracts/v31-data';
import { getPool, maybeOne, withTx, type Queryable } from '@social-lite/db';
import type { Ctx } from '../context.js';
import { audit } from '../audit.js';
import { authorizeCtx, requireAction } from '../tenancy.js';

const MODES: LocalRecoveryMode[] = ['persistent', 'session', 'off'];

export function recoveryNamespace(userId: string, workspaceId: string): string {
  return `relay:draft-recovery:v1:${userId}:${workspaceId}`;
}

export async function draftRecoveryPolicy(db: Queryable, workspaceId: string, userId: string): Promise<DraftRecoveryPolicy> {
  const r = await maybeOne<{ local_recovery: LocalRecoveryMode; local_recovery_hours: number; clear_on_logout: boolean }>(db,
    `SELECT local_recovery, local_recovery_hours, clear_on_logout FROM workspace_data_policies WHERE workspace_id=$1`, [workspaceId]);
  return {
    local_recovery: r?.local_recovery ?? DRAFT_RECOVERY_DEFAULTS.local_recovery,
    max_age_hours: r?.local_recovery_hours ?? DRAFT_RECOVERY_DEFAULTS.max_age_hours,
    clear_on_logout: r?.clear_on_logout ?? DRAFT_RECOVERY_DEFAULTS.clear_on_logout,
    namespace: recoveryNamespace(userId, workspaceId),
  };
}

export async function getDataPolicy(ctx: Ctx): Promise<DraftRecoveryPolicy & { can_manage: boolean }> {
  const p = await draftRecoveryPolicy(getPool(), ctx.access.workspaceId, ctx.actor.userId);
  return { ...p, can_manage: authorizeCtx(ctx, 'workspace.manage').allowed };
}

export async function updateDataPolicy(ctx: Ctx, input: { local_recovery?: LocalRecoveryMode; max_age_hours?: number; clear_on_logout?: boolean }): Promise<DraftRecoveryPolicy> {
  requireAction(ctx, 'workspace.manage');
  if (input.local_recovery !== undefined && !MODES.includes(input.local_recovery)) throw new AppError('validation_failed', 'Unknown mode', { local_recovery: 'Use persistent, session or off' });
  if (input.max_age_hours !== undefined && (!Number.isInteger(input.max_age_hours) || input.max_age_hours < 1 || input.max_age_hours > 720)) {
    throw new AppError('validation_failed', 'Use 1-720 hours', { max_age_hours: 'Use 1-720 hours' });
  }
  return withTx(async (tx) => {
    const before = await draftRecoveryPolicy(tx, ctx.access.workspaceId, ctx.actor.userId);
    const next = {
      local_recovery: input.local_recovery ?? before.local_recovery,
      max_age_hours: input.max_age_hours ?? before.max_age_hours,
      clear_on_logout: input.clear_on_logout ?? before.clear_on_logout,
    };
    await tx.query(
      `INSERT INTO workspace_data_policies(workspace_id, local_recovery, local_recovery_hours, clear_on_logout, updated_by, updated_at)
       VALUES ($1,$2,$3,$4,$5,now())
       ON CONFLICT (workspace_id) DO UPDATE SET local_recovery=$2, local_recovery_hours=$3, clear_on_logout=$4, updated_by=$5, updated_at=now()`,
      [ctx.access.workspaceId, next.local_recovery, next.max_age_hours, next.clear_on_logout, ctx.actor.userId]);
    await audit(tx, { workspaceId: ctx.access.workspaceId, actorUserId: ctx.actor.userId, action: 'workspace.data_policy_updated', resourceType: 'workspace',
      resourceId: ctx.access.workspaceId, diff: { before: { local_recovery: before.local_recovery, max_age_hours: before.max_age_hours, clear_on_logout: before.clear_on_logout }, after: next },
      correlationId: ctx.correlationId });
    return { ...next, namespace: before.namespace };
  });
}
