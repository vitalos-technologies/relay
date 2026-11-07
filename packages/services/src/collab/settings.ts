// Workspace collaboration settings (admin: /admin/collaboration/settings). Read by every collaboration path; changes need
// workspace.manage and are audited. Defaults apply until a workspace saves its own row.
import { AppError } from '@social-lite/core';
import { getPool, maybeOne, withTx, type Queryable } from '@social-lite/db';
import type { Ctx } from '../context.js';
import { audit } from '../audit.js';
import { authorizeCtx, requireAction } from '../tenancy.js';

export interface ChannelsDefault { in_app?: boolean; email?: boolean; digest?: boolean }
export interface CollabSettings {
  client_comments: boolean;
  task_assign: 'contributors' | 'managers';
  offboarding: 'flag' | 'unassign';
  reminder_lead_hours: number;
  max_overdue_reminders: number;
  presence_enabled: boolean;
  notification_defaults: Record<string, ChannelsDefault>;
}

export const COLLAB_DEFAULTS: CollabSettings = {
  client_comments: true, task_assign: 'contributors', offboarding: 'flag', reminder_lead_hours: 24, max_overdue_reminders: 3,
  presence_enabled: true, notification_defaults: {},
};

export async function collabSettings(db: Queryable, workspaceId: string): Promise<CollabSettings> {
  const r = await maybeOne<CollabSettings>(db,
    `SELECT client_comments, task_assign, offboarding, reminder_lead_hours, max_overdue_reminders, presence_enabled, notification_defaults
       FROM workspace_collab_settings WHERE workspace_id=$1`, [workspaceId]);
  return r ?? { ...COLLAB_DEFAULTS };
}

export async function getCollabSettings(ctx: Ctx) {
  const s = await collabSettings(getPool(), ctx.access.workspaceId);
  return { ...s, can_manage: authorizeCtx(ctx, 'workspace.manage').allowed };
}

const EVENTS = ['mention', 'comment', 'review_requested', 'review_decided', 'assignment', 'reminder'];

export async function updateCollabSettings(ctx: Ctx, input: Partial<CollabSettings>) {
  requireAction(ctx, 'workspace.manage');
  if (input.task_assign !== undefined && !['contributors', 'managers'].includes(input.task_assign)) throw new AppError('validation_failed', 'Unknown option', { task_assign: 'Invalid' });
  if (input.offboarding !== undefined && !['flag', 'unassign'].includes(input.offboarding)) throw new AppError('validation_failed', 'Unknown option', { offboarding: 'Invalid' });
  if (input.reminder_lead_hours !== undefined && (!Number.isInteger(input.reminder_lead_hours) || input.reminder_lead_hours < 1 || input.reminder_lead_hours > 168)) {
    throw new AppError('validation_failed', 'Use 1–168 hours', { reminder_lead_hours: '1–168' });
  }
  if (input.max_overdue_reminders !== undefined && (!Number.isInteger(input.max_overdue_reminders) || input.max_overdue_reminders < 0 || input.max_overdue_reminders > 10)) {
    throw new AppError('validation_failed', 'Use 0–10', { max_overdue_reminders: '0–10' });
  }
  let defaults: Record<string, ChannelsDefault> | undefined;
  if (input.notification_defaults !== undefined) {
    defaults = {};
    for (const [k, v] of Object.entries(input.notification_defaults ?? {})) {
      if (!EVENTS.includes(k)) throw new AppError('validation_failed', 'Unknown notification type', { notification_defaults: k });
      defaults[k] = { in_app: v.in_app !== false, email: !!v.email, digest: !!v.digest && !v.email };
    }
  }
  return withTx(async (tx) => {
    const before = await collabSettings(tx, ctx.access.workspaceId);
    const next: CollabSettings = {
      client_comments: input.client_comments ?? before.client_comments,
      task_assign: input.task_assign ?? before.task_assign,
      offboarding: input.offboarding ?? before.offboarding,
      reminder_lead_hours: input.reminder_lead_hours ?? before.reminder_lead_hours,
      max_overdue_reminders: input.max_overdue_reminders ?? before.max_overdue_reminders,
      presence_enabled: input.presence_enabled ?? before.presence_enabled,
      notification_defaults: defaults ?? before.notification_defaults,
    };
    await tx.query(
      `INSERT INTO workspace_collab_settings(workspace_id, client_comments, task_assign, offboarding, reminder_lead_hours, max_overdue_reminders, presence_enabled, notification_defaults, updated_by, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,now())
       ON CONFLICT (workspace_id) DO UPDATE SET client_comments=$2, task_assign=$3, offboarding=$4, reminder_lead_hours=$5, max_overdue_reminders=$6,
         presence_enabled=$7, notification_defaults=$8, updated_by=$9, updated_at=now()`,
      [ctx.access.workspaceId, next.client_comments, next.task_assign, next.offboarding, next.reminder_lead_hours, next.max_overdue_reminders, next.presence_enabled,
        JSON.stringify(next.notification_defaults), ctx.actor.userId]);
    if (!next.presence_enabled) await tx.query(`DELETE FROM post_presence WHERE workspace_id=$1`, [ctx.access.workspaceId]);
    await audit(tx, { workspaceId: ctx.access.workspaceId, actorUserId: ctx.actor.userId, action: 'collaboration.settings_updated', resourceType: 'workspace',
      resourceId: ctx.access.workspaceId, diff: { before, after: next }, correlationId: ctx.correlationId });
    return { ...next, can_manage: true };
  });
}
