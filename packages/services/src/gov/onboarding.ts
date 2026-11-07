// V3.1 §7 — onboarding checklist state. Progress is DERIVED from real data (brands, connections, members, posts,
// schedules) so it is always resumable and never claims a step that did not happen; the stored row holds only the
// viewer's choices (dismissed, "defaults reviewed", "skip invites"). Role-adapted: steps the viewer cannot perform
// are shown with who to ask (contributors) or hidden as not_applicable (read-only members/guests are never told to
// administer). Connections are not all required: one ready destination completes the step.
import { z } from 'zod';
import { AppError } from '@social-lite/core';
import { ONBOARDING_STEPS, type ConnectionReadiness, type DiagnosticStatus, type OnboardingState, type OnboardingStep, type OnboardingStepKey } from '@social-lite/core/contracts/v31-gov';
import { getPool, many, maybeOne, type Queryable } from '@social-lite/db';
import type { Ctx } from '../context.js';
import { audit } from '../audit.js';
import { authorizeCtx } from '../tenancy.js';
import { integrationDiagnostics } from './diagnostics.js';

const TITLES: Record<OnboardingStepKey, string> = {
  workspace: 'Create your workspace', brand: 'Add a brand', brand_defaults: 'Review brand time zone and defaults', connect_destination: 'Connect a social destination',
  invite_teammates: 'Invite teammates', create_draft: 'Create a draft', schedule_first_post: 'Review and schedule your first post',
};
const HREF: Record<OnboardingStepKey, { label: string; href: string }> = {
  workspace: { label: 'Workspace settings', href: '/settings/workspace/general' }, brand: { label: 'Add a brand', href: '/settings/workspace/branding' },
  brand_defaults: { label: 'Open brand settings', href: '/settings/workspace/branding' }, connect_destination: { label: 'Connect an account', href: '/settings/connections/social' },
  invite_teammates: { label: 'Invite people', href: '/team/invitations' }, create_draft: { label: 'New post', href: '/compose' },
  schedule_first_post: { label: 'Open your draft', href: '/compose' },
};

async function brandIdsWith(ctx: Ctx, perm: Parameters<typeof authorizeCtx>[1], db: Queryable): Promise<string[]> {
  const rows = await many<{ id: string }>(db, `SELECT id FROM brands WHERE workspace_id=$1 AND archived_at IS NULL`, [ctx.access.workspaceId]);
  return rows.filter((b) => authorizeCtx(ctx, perm, { brandId: b.id }).allowed).map((b) => b.id);
}

export async function onboardingState(ctx: Ctx, db: Queryable = getPool()): Promise<OnboardingState> {
  const ws = ctx.access.workspaceId;
  const mayWs = (p: Parameters<typeof authorizeCtx>[1]) => authorizeCtx(ctx, p).allowed;
  const readable = await brandIdsWith(ctx, 'brands.read', db);
  const manageable = await brandIdsWith(ctx, 'brands.manage', db);
  const connManage = await brandIdsWith(ctx, 'connections.manage', db);
  const editable = await brandIdsWith(ctx, 'content.edit', db);
  const schedulable = [...new Set([...(await brandIdsWith(ctx, 'content.schedule', db)), ...(await brandIdsWith(ctx, 'content.submit', db))])];
  const roleView: OnboardingState['role_view'] = mayWs('workspace.manage') ? 'admin' : manageable.length ? 'manager' : editable.length ? 'contributor' : 'reader';

  const row = await maybeOne<{ dismissed_at: Date | null; acknowledged: Record<string, string> }>(db,
    `SELECT dismissed_at, acknowledged FROM onboarding_progress WHERE workspace_id=$1 AND user_id=$2`, [ws, ctx.actor.userId]);
  const ack = row?.acknowledged ?? {};
  const facts = await maybeOne<{ brands: number; profiled: number; ready_conns: number; members: number; invites: number; posts: number; schedules: number }>(db,
    `SELECT (SELECT count(*)::int FROM brands WHERE workspace_id=$1 AND archived_at IS NULL AND id = ANY($2::uuid[])) AS brands,
            (SELECT count(*)::int FROM brand_profiles WHERE workspace_id=$1 AND brand_id = ANY($2::uuid[])) AS profiled,
            (SELECT count(*)::int FROM connections WHERE workspace_id=$1 AND brand_id = ANY($2::uuid[]) AND disconnected_at IS NULL AND status IN ('ready','expiring')) AS ready_conns,
            (SELECT count(*)::int FROM memberships WHERE workspace_id=$1 AND removed_at IS NULL) AS members,
            (SELECT count(*)::int FROM invitations WHERE workspace_id=$1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now()) AS invites,
            (SELECT count(*)::int FROM posts WHERE workspace_id=$1 AND brand_id = ANY($2::uuid[])) AS posts,
            (SELECT count(*)::int FROM schedules WHERE workspace_id=$1 AND brand_id = ANY($2::uuid[]) AND status IN ('active','pending_approval','completed')) AS schedules`,
    [ws, readable]);
  const f = facts!;
  const done: Record<OnboardingStepKey, boolean> = {
    workspace: true, brand: f.brands > 0, brand_defaults: f.profiled > 0 || !!ack.brand_defaults, connect_destination: f.ready_conns > 0,
    invite_teammates: f.members > 1 || f.invites > 0, create_draft: f.posts > 0, schedule_first_post: f.schedules > 0,
  };
  const can: Record<OnboardingStepKey, boolean> = {
    workspace: mayWs('workspace.manage'), brand: mayWs('workspace.manage') || manageable.length > 0, brand_defaults: manageable.length > 0,
    connect_destination: connManage.length > 0, invite_teammates: mayWs('members.invite'), create_draft: editable.length > 0, schedule_first_post: schedulable.length > 0,
  };
  const ADMIN_STEPS: OnboardingStepKey[] = ['workspace', 'brand', 'brand_defaults', 'connect_destination', 'invite_teammates'];
  const steps: OnboardingStep[] = ONBOARDING_STEPS.map((key) => {
    const optional = key === 'invite_teammates';
    if (done[key]) return { key, title: TITLES[key], status: 'done', action: null, ask: null, optional };
    if (optional && ack.invite_teammates_skipped) return { key, title: TITLES[key], status: 'skipped', action: null, ask: null, optional };
    if (can[key]) return { key, title: TITLES[key], status: 'todo', action: HREF[key], ask: null, optional };
    // Viewer cannot do it: readers are never asked to administer; contributors see who to ask.
    if (roleView === 'reader' || (ADMIN_STEPS.includes(key) && roleView === 'contributor' && key !== 'connect_destination' && key !== 'brand')) {
      return { key, title: TITLES[key], status: 'not_applicable', action: null, ask: null, optional };
    }
    return { key, title: TITLES[key], status: 'todo', action: null, ask: key === 'schedule_first_post' ? 'A publisher or brand manager' : 'An owner or admin', optional };
  });
  const counted = steps.filter((s) => s.status !== 'not_applicable' && !(s.optional && s.status === 'skipped'));
  const required = counted.filter((s) => !s.optional);
  const next = steps.find((s) => s.status === 'todo' && s.action) ?? steps.find((s) => s.status === 'todo') ?? null;

  let connections: ConnectionReadiness[] = [];
  if (readable.some((b) => authorizeCtx(ctx, 'connections.read', { brandId: b }).allowed)) {
    const d = await integrationDiagnostics(ctx, {}, db);
    const pick = (c: (typeof d.items)[number], k: string): DiagnosticStatus => c.checks.find((x) => x.key === k)?.status ?? 'unknown';
    const worst = (...s: DiagnosticStatus[]) => (['failing', 'warning', 'unknown', 'ok', 'not_applicable'] as DiagnosticStatus[]).find((x) => s.includes(x)) ?? 'ok';
    connections = d.items.filter((c) => c.connection.status !== 'disconnected').slice(0, 50).map((c) => ({
      connection_id: c.connection.id, display_name: c.connection.display_name, provider: c.connection.provider,
      checks: { authorization: pick(c, 'authorization'), selected_account: pick(c, 'selected_account'), posting_permission: worst(pick(c, 'capabilities'), pick(c, 'publishing')),
        supported_formats: pick(c, 'media'), analytics_permission: pick(c, 'analytics') },
    }));
  }
  return {
    workspace_id: ws, role_view: roleView, dismissed: !!row?.dismissed_at, complete: required.every((s) => s.status === 'done'),
    progress: { done: counted.filter((s) => s.status === 'done').length, total: counted.length }, next, steps, connections,
  };
}

export const onboardingUpdateSchema = z.object({
  dismissed: z.boolean().optional(),
  acknowledge: z.enum(['brand_defaults', 'invite_teammates_skipped']).optional(),
  unacknowledge: z.enum(['brand_defaults', 'invite_teammates_skipped']).optional(),
}).strict();

/** Dismiss/resume the checklist or record an explicit choice. Only the viewer's own row is written. */
export async function updateOnboarding(ctx: Ctx, raw: unknown): Promise<OnboardingState> {
  const input = onboardingUpdateSchema.parse(raw);
  if (input.dismissed === undefined && !input.acknowledge && !input.unacknowledge) throw new AppError('validation_failed', 'Nothing to change');
  const db = getPool();
  const ackPatch = input.acknowledge ? { [input.acknowledge]: new Date().toISOString() } : {};
  await db.query(
    `INSERT INTO onboarding_progress(workspace_id, user_id, dismissed_at, acknowledged) VALUES ($1,$2,CASE WHEN $3::boolean THEN now() END,$4::jsonb)
     ON CONFLICT (workspace_id, user_id) DO UPDATE SET
       dismissed_at = CASE WHEN $3::boolean IS NULL THEN onboarding_progress.dismissed_at WHEN $3 THEN coalesce(onboarding_progress.dismissed_at, now()) ELSE NULL END,
       acknowledged = (onboarding_progress.acknowledged || $4::jsonb) - coalesce($5::text, ''), updated_at=now()`,
    [ctx.access.workspaceId, ctx.actor.userId, input.dismissed ?? null, JSON.stringify(ackPatch), input.unacknowledge ?? null]);
  if (input.dismissed !== undefined) {
    await audit(db, { workspaceId: ctx.access.workspaceId, actorUserId: ctx.actor.userId, action: input.dismissed ? 'onboarding.dismissed' : 'onboarding.resumed', resourceType: 'onboarding', resourceId: null, correlationId: ctx.correlationId });
  }
  return onboardingState(ctx, db);
}
