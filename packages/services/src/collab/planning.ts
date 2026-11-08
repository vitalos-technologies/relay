// Planning metadata (stream C): post campaign / assignee / due date / owning team, review-request assignee + due
// date, and calendar ownership for the planner (team, assignee, review state — only for brands already in scope).
// Assignees must be entitled to the brand at assign time (checked through the central policy).
import { randomUUID } from 'node:crypto';
import { AppError, notFound } from '@social-lite/core';
import { getPool, many, maybeOne, withTx, type Queryable } from '@social-lite/db';
import type { Ctx } from '../context.js';
import { audit } from '../audit.js';
import { writeOutbox } from '../outbox.js';
import { loadUserAuthz } from '../authz.js';
import { assertUuid, authorizeCtx, brandAllowed, isUuid, requireAction } from '../tenancy.js';
import { loadPost } from '../posts/service.js';
import { staffAllowed, hasActiveShare } from './access.js';
import { deliverNotification } from './notifications.js';

function parseDue(v: string | null | undefined, field = 'due_at'): Date | null | undefined {
  if (v === undefined) return undefined;
  if (v === null || v === '') return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) throw new AppError('validation_failed', 'Invalid date', { [field]: 'Use an ISO date' });
  return d;
}

async function assertAssignable(db: Queryable, workspaceId: string, userId: string, brandId: string, perm: 'content.read' | 'content.approve', postId?: string): Promise<void> {
  if (!isUuid(userId)) throw new AppError('validation_failed', 'Unknown person', { assignee_user_id: 'Unknown person' });
  const s = await loadUserAuthz(userId, workspaceId, null, db);
  const ok = s.subject.status === 'active' && (staffAllowed(s, perm, brandId) || (perm === 'content.approve' && !!postId && (await hasActiveShare(db, workspaceId, postId, userId))));
  if (!ok) throw new AppError('validation_failed', 'This person has no access to this brand', { assignee_user_id: 'Not entitled to this brand' });
}

export async function updatePostPlanning(ctx: Ctx, postId: string, input: { campaign_id?: string | null; assignee_user_id?: string | null; due_at?: string | null; team_id?: string | null }) {
  requireAction(ctx, 'content.edit');
  const due = parseDue(input.due_at);
  return withTx(async (tx) => {
    const post = await loadPost(ctx, postId, tx, true);
    const cur = await maybeOne<{ campaign_id: string | null; assignee_user_id: string | null; due_at: Date | null; team_id: string | null }>(tx,
      `SELECT campaign_id, assignee_user_id, due_at, team_id FROM posts WHERE id=$1`, [post.id]);
    if (input.campaign_id) {
      assertUuid(input.campaign_id, 'Campaign');
      const c = await maybeOne(tx, `SELECT 1 FROM campaigns WHERE id=$1 AND workspace_id=$2 AND brand_id=$3 AND archived_at IS NULL`, [input.campaign_id, ctx.access.workspaceId, post.brand_id]);
      if (!c) throw new AppError('validation_failed', 'Choose a campaign of this brand', { campaign_id: 'Not in this brand' });
    }
    if (input.assignee_user_id) await assertAssignable(tx, ctx.access.workspaceId, input.assignee_user_id, post.brand_id, 'content.read');
    if (input.team_id) {
      assertUuid(input.team_id, 'Team');
      // The owning team must actually have access to this brand (team grant on it or workspace-wide).
      const t = await maybeOne(tx,
        `SELECT 1 FROM teams t WHERE t.id=$1 AND t.workspace_id=$2 AND t.archived_at IS NULL AND EXISTS (
           SELECT 1 FROM scoped_role_grants g WHERE g.team_id=t.id AND g.revoked_at IS NULL AND (g.expires_at IS NULL OR g.expires_at > now())
              AND (g.scope_type='workspace' OR g.brand_id=$3))`, [input.team_id, ctx.access.workspaceId, post.brand_id]);
      if (!t) throw new AppError('validation_failed', 'Choose a team with access to this brand', { team_id: 'No access to this brand' });
    }
    const next = {
      campaign_id: input.campaign_id === undefined ? cur!.campaign_id : input.campaign_id,
      assignee_user_id: input.assignee_user_id === undefined ? cur!.assignee_user_id : input.assignee_user_id,
      due_at: due === undefined ? cur!.due_at : due,
      team_id: input.team_id === undefined ? cur!.team_id : input.team_id,
    };
    await tx.query(`UPDATE posts SET campaign_id=$2, assignee_user_id=$3, due_at=$4, team_id=$5 WHERE id=$1`, [post.id, next.campaign_id, next.assignee_user_id, next.due_at, next.team_id]);
    await audit(tx, { workspaceId: ctx.access.workspaceId, brandId: post.brand_id, actorUserId: ctx.actor.userId, action: 'post.planning_updated', resourceType: 'post', resourceId: post.id,
      diff: { campaign_id: next.campaign_id, assignee_user_id: next.assignee_user_id, due_at: next.due_at?.toISOString() ?? null, team_id: next.team_id }, correlationId: ctx.correlationId });
    if (next.assignee_user_id && next.assignee_user_id !== cur!.assignee_user_id && next.assignee_user_id !== ctx.actor.userId) {
      await writeOutbox(tx, { workspaceId: ctx.access.workspaceId, aggregateType: 'post', aggregateId: post.id, eventType: 'assignment.changed',
        payload: { userId: next.assignee_user_id, brandId: post.brand_id, kind: 'post', eventId: randomUUID() } });
    }
    return postPlanning(tx, ctx, post.id);
  });
}

export async function postPlanning(db: Queryable, ctx: Ctx, postId: string) {
  const r = await maybeOne<{ campaign_id: string | null; campaign_name: string | null; assignee_user_id: string | null; assignee_email: string | null; assignee_name: string | null;
    due_at: Date | null; team_id: string | null; team_name: string | null; brand_id: string }>(db,
    `SELECT p.brand_id, p.campaign_id, c.name AS campaign_name, p.assignee_user_id, u.email AS assignee_email, u.name AS assignee_name, p.due_at, p.team_id, t.name AS team_name
       FROM posts p LEFT JOIN campaigns c ON c.id=p.campaign_id LEFT JOIN users u ON u.id=p.assignee_user_id LEFT JOIN teams t ON t.id=p.team_id
      WHERE p.id=$1 AND p.workspace_id=$2`, [postId, ctx.access.workspaceId]);
  if (!r) throw notFound('Post');
  return {
    campaign: r.campaign_id ? { id: r.campaign_id, name: r.campaign_name } : null,
    assignee: r.assignee_user_id ? { id: r.assignee_user_id, email: r.assignee_email, name: r.assignee_name } : null,
    due_at: r.due_at?.toISOString() ?? null,
    team: r.team_id ? { id: r.team_id, name: r.team_name } : null,
    can_edit: authorizeCtx(ctx, 'content.edit', { brandId: r.brand_id }).allowed,
  };
}

export async function getPostPlanning(ctx: Ctx, postId: string) {
  requireAction(ctx, 'content.read');
  const db = getPool();
  const post = await loadPost(ctx, postId, db);
  return postPlanning(db, ctx, post.id);
}

/** People and teams that may be assigned on this brand (entitled now). */
export async function assignmentOptions(ctx: Ctx, brandId: string) {
  requireAction(ctx, 'content.read');
  const db = getPool();
  if (!isUuid(brandId) || !brandAllowed(ctx, brandId)) throw notFound('Brand');
  const members = await many<{ user_id: string; email: string; name: string | null }>(db,
    `SELECT m.user_id, u.email, u.name FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.workspace_id=$1 AND m.status='active' AND m.removed_at IS NULL
      ORDER BY u.name NULLS LAST, u.email LIMIT 300`, [ctx.access.workspaceId]);
  const people: Array<{ id: string; email: string; name: string | null; can_review: boolean }> = [];
  for (const m of members) {
    const s = await loadUserAuthz(m.user_id, ctx.access.workspaceId, null, db);
    if (staffAllowed(s, 'content.read', brandId)) people.push({ id: m.user_id, email: m.email, name: m.name, can_review: staffAllowed(s, 'content.approve', brandId) });
  }
  const teams = await many<{ id: string; name: string }>(db,
    `SELECT DISTINCT t.id, t.name FROM teams t JOIN scoped_role_grants g ON g.team_id=t.id AND g.revoked_at IS NULL AND (g.expires_at IS NULL OR g.expires_at > now())
      WHERE t.workspace_id=$1 AND t.archived_at IS NULL AND (g.scope_type='workspace' OR g.brand_id=$2) ORDER BY t.name`, [ctx.access.workspaceId, brandId]);
  return { people, teams };
}

/** Assign a review request to a reviewer (planning hint only — it grants nothing and never counts as approval). */
export async function assignReview(ctx: Ctx, approvalId: string, input: { assignee_user_id?: string | null; due_at?: string | null }) {
  assertUuid(approvalId, 'Approval');
  const due = parseDue(input.due_at);
  return withTx(async (tx) => {
    const a = await maybeOne<{ id: string; brand_id: string; post_id: string; decision: string; assignee_user_id: string | null; due_at: Date | null }>(tx,
      `SELECT id, brand_id, post_id, decision, assignee_user_id, due_at FROM approvals WHERE id=$1 AND workspace_id=$2 FOR UPDATE`, [approvalId, ctx.access.workspaceId]);
    if (!a || !brandAllowed(ctx, a.brand_id)) throw notFound('Approval');
    if (!authorizeCtx(ctx, 'content.submit', { brandId: a.brand_id }).allowed && !authorizeCtx(ctx, 'content.approve', { brandId: a.brand_id }).allowed) {
      throw new AppError('forbidden', 'You cannot assign reviews for this brand');
    }
    if (a.decision !== 'pending') throw new AppError('invalid_state', 'This review is closed.');
    if (input.assignee_user_id) await assertAssignable(tx, ctx.access.workspaceId, input.assignee_user_id, a.brand_id, 'content.approve', a.post_id);
    const assignee = input.assignee_user_id === undefined ? a.assignee_user_id : input.assignee_user_id;
    const dueAt = due === undefined ? a.due_at : due;
    await tx.query(`UPDATE approvals SET assignee_user_id=$2, due_at=$3 WHERE id=$1`, [a.id, assignee, dueAt]);
    await audit(tx, { workspaceId: ctx.access.workspaceId, brandId: a.brand_id, actorUserId: ctx.actor.userId, action: 'approval.assigned', resourceType: 'approval', resourceId: a.id,
      diff: { assignee_user_id: assignee, due_at: dueAt?.toISOString() ?? null }, correlationId: ctx.correlationId });
    if (assignee && assignee !== a.assignee_user_id && assignee !== ctx.actor.userId) {
      await writeOutbox(tx, { workspaceId: ctx.access.workspaceId, aggregateType: 'approval', aggregateId: a.id, eventType: 'assignment.changed',
        payload: { userId: assignee, brandId: a.brand_id, kind: 'review', postId: a.post_id, eventId: randomUUID() } });
    }
    return { assignee_user_id: assignee, due_at: dueAt?.toISOString() ?? null };
  });
}

/** Outbox handler: notify the new assignee if still entitled at send time. */
export async function onAssignmentChanged(db: Queryable, evt: { workspace_id: string; aggregate_id: string; payload: Record<string, unknown> }) {
  const userId = String(evt.payload.userId ?? '');
  const brandId = String(evt.payload.brandId ?? '');
  if (!isUuid(userId) || !isUuid(brandId)) return;
  const review = evt.payload.kind === 'review';
  await deliverNotification(db, {
    workspaceId: evt.workspace_id, userId, event: 'assignment', kind: 'assignment',
    title: review ? 'A review was assigned to you' : 'A post was assigned to you',
    referenceType: review ? 'approval' : 'post', referenceId: evt.aggregate_id, dedupeKey: `assignment:${evt.aggregate_id}:${userId}:${String(evt.payload.eventId ?? '')}`,
    requirement: review ? { brandId, permission: 'review.shared', postId: String(evt.payload.postId ?? '') } : { brandId, permission: 'content.read' },
  });
}

/** Calendar ownership: decorate planner items (already brand-scoped) with campaign, team, assignee and review state. */
export async function decoratePlannerItems<T extends { schedule_id: string; post_id: string }>(ctx: Ctx, items: T[], db: Queryable = getPool()) {
  if (!items.length) return items.map((i) => ({ ...i, campaign: null, team: null, assignee: null, review: null, unread_threads: 0, open_tasks: 0, next_task_due: null as string | null }));
  const posts = await many<{ id: string; campaign_id: string | null; campaign_name: string | null; team_id: string | null; team_name: string | null; assignee_user_id: string | null; assignee_email: string | null; assignee_name: string | null; due_at: Date | null }>(db,
    `SELECT p.id, p.campaign_id, c.name AS campaign_name, p.team_id, t.name AS team_name, p.assignee_user_id, u.email AS assignee_email, u.name AS assignee_name, p.due_at
       FROM posts p LEFT JOIN campaigns c ON c.id=p.campaign_id LEFT JOIN teams t ON t.id=p.team_id LEFT JOIN users u ON u.id=p.assignee_user_id
      WHERE p.workspace_id=$1 AND p.id = ANY($2::uuid[])`, [ctx.access.workspaceId, [...new Set(items.map((i) => i.post_id))]]);
  const reviews = await many<{ schedule_id: string; id: string; decision: string; current_stage: number; stage_count: number }>(db,
    `SELECT DISTINCT ON (schedule_id) schedule_id, id, decision, current_stage, stage_count FROM approvals
      WHERE workspace_id=$1 AND schedule_id = ANY($2::uuid[]) ORDER BY schedule_id, requested_at DESC`, [ctx.access.workspaceId, items.map((i) => i.schedule_id)]);
  // Collaboration: unread open discussions and open tasks (with the nearest editorial deadline) per post.
  const postRows = await many<{ id: string; brand_id: string }>(db, `SELECT id, brand_id FROM posts WHERE workspace_id=$1 AND id = ANY($2::uuid[])`,
    [ctx.access.workspaceId, [...new Set(items.map((i) => i.post_id))]]);
  const { unreadThreadCounts } = await import('./comments.js');
  const unread = await unreadThreadCounts(ctx, postRows, db);
  const tasks = await many<{ post_id: string; n: number; next_due: Date | null }>(db,
    `SELECT post_id, count(*)::int n, min(due_at) AS next_due FROM collab_tasks WHERE workspace_id=$1 AND post_id = ANY($2::uuid[]) AND status IN ('open','in_progress','blocked') GROUP BY post_id`,
    [ctx.access.workspaceId, postRows.map((p) => p.id)]);
  return items.map((i) => {
    const p = posts.find((x) => x.id === i.post_id);
    const r = reviews.find((x) => x.schedule_id === i.schedule_id);
    const t = tasks.find((x) => x.post_id === i.post_id);
    return {
      ...i,
      unread_threads: unread.get(i.post_id) ?? 0, open_tasks: t?.n ?? 0, next_task_due: t?.next_due?.toISOString() ?? null,
      campaign: p?.campaign_id ? { id: p.campaign_id, name: p.campaign_name } : null,
      team: p?.team_id ? { id: p.team_id, name: p.team_name } : null,
      assignee: p?.assignee_user_id ? { id: p.assignee_user_id, email: p.assignee_email, name: p.assignee_name } : null,
      review: r ? { id: r.id, decision: r.decision, stage: r.current_stage, stage_count: r.stage_count } : null,
    };
  });
}
