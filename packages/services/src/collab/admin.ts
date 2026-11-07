// Collaboration in the admin app (/admin/collaboration/**), on the SAME services and authorization as the main app.
// Workspace admins: overdue tasks + review backlog, work needing reassignment (offboarding), reassign, eligible reviewers per
// brand, notification delivery diagnostics (metadata only: type, recipient, state, error code — never content).
// Platform operators: aggregate pipeline health across workspaces (counts and ages only; no discussions, no names).
import { AppError, notFound } from '@social-lite/core';
import { getPool, many, one, withTx, type Queryable } from '@social-lite/db';
import type { Ctx } from '../context.js';
import { audit } from '../audit.js';
import { mailer } from '../email.js';
import { loadUserAuthz, type AuthzState } from '../authz.js';
import { assertUuid, authorizeCtx, brandAllowed, isUuid, requireAction } from '../tenancy.js';
import { loadPolicy, stageEligibility } from '../posts/approval-policy.js';
import { writeOutbox } from '../outbox.js';
import { staffAllowed } from './access.js';
import { emitCollabEvent } from './events.js';

async function visibleBrands(ctx: Ctx, db: Queryable): Promise<Array<{ id: string; name: string }>> {
  const all = await many<{ id: string; name: string }>(db, `SELECT id, name FROM brands WHERE workspace_id=$1 AND archived_at IS NULL ORDER BY name`, [ctx.access.workspaceId]);
  return all.filter((b) => brandAllowed(ctx, b.id) && (!ctx.access.authz || staffAllowed(ctx.access.authz, 'content.read', b.id)));
}

function stateCache(db: Queryable, workspaceId: string) {
  const m = new Map<string, Promise<AuthzState>>();
  return (userId: string) => { let p = m.get(userId); if (!p) { p = loadUserAuthz(userId, workspaceId, null, db); m.set(userId, p); } return p; };
}

/** Work that needs a new owner: flagged tasks, open reviews / post assignments held by people who lost access. */
export async function reassignmentWork(ctx: Ctx, db: Queryable = getPool()) {
  const brands = await visibleBrands(ctx, db);
  const ids = brands.map((b) => b.id);
  const tasks = await many<{ id: string; title: string; brand_id: string; assignee_id: string | null; assignee: string | null; due_at: Date | null; reason: string | null }>(db,
    `SELECT t.id, t.title, t.brand_id, t.assignee_id, coalesce(u.name, u.email) AS assignee, t.due_at, t.reassign_reason AS reason
       FROM collab_tasks t LEFT JOIN users u ON u.id=t.assignee_id
      WHERE t.workspace_id=$1 AND t.brand_id = ANY($2::uuid[]) AND t.needs_reassignment AND t.status IN ('open','in_progress','blocked')
      ORDER BY t.due_at NULLS LAST LIMIT 200`, [ctx.access.workspaceId, ids]);
  const state = stateCache(db, ctx.access.workspaceId);
  const reviews = await many<{ id: string; brand_id: string; post_id: string; assignee_user_id: string; assignee: string | null; due_at: Date | null; title: string | null }>(db,
    `SELECT a.id, a.brand_id, a.post_id, a.assignee_user_id, coalesce(u.name, u.email) AS assignee, a.due_at, p.title
       FROM approvals a JOIN users u ON u.id=a.assignee_user_id JOIN posts p ON p.id=a.post_id
      WHERE a.workspace_id=$1 AND a.brand_id = ANY($2::uuid[]) AND a.decision='pending' AND a.assignee_user_id IS NOT NULL LIMIT 500`, [ctx.access.workspaceId, ids]);
  const posts = await many<{ id: string; brand_id: string; assignee_user_id: string; assignee: string | null; title: string | null; due_at: Date | null }>(db,
    `SELECT p.id, p.brand_id, p.assignee_user_id, coalesce(u.name, u.email) AS assignee, p.title, p.due_at
       FROM posts p JOIN users u ON u.id=p.assignee_user_id
      WHERE p.workspace_id=$1 AND p.brand_id = ANY($2::uuid[]) AND p.deleted_at IS NULL AND p.archived_at IS NULL AND p.assignee_user_id IS NOT NULL LIMIT 500`, [ctx.access.workspaceId, ids]);
  const lost = async (uid: string, brandId: string) => { const s = await state(uid); return s.subject.status !== 'active' || !staffAllowed(s, 'content.read', brandId); };
  const outReviews = [];
  for (const r of reviews) if (await lost(r.assignee_user_id, r.brand_id)) outReviews.push(r);
  const outPosts = [];
  for (const p of posts) if (await lost(p.assignee_user_id, p.brand_id)) outPosts.push(p);
  const name = (id: string) => brands.find((b) => b.id === id)?.name ?? '';
  return {
    tasks: tasks.map((t) => ({ id: t.id, title: t.title, brand: name(t.brand_id), assignee_id: t.assignee_id, assignee: t.assignee, due_at: t.due_at?.toISOString() ?? null, reason: t.reason })),
    reviews: outReviews.map((r) => ({ id: r.id, post_id: r.post_id, title: r.title, brand: name(r.brand_id), assignee_id: r.assignee_user_id, assignee: r.assignee, due_at: r.due_at?.toISOString() ?? null })),
    posts: outPosts.map((p) => ({ id: p.id, title: p.title, brand: name(p.brand_id), assignee_id: p.assignee_user_id, assignee: p.assignee, due_at: p.due_at?.toISOString() ?? null })),
  };
}

/** Workspace collaboration overview (admin). */
export async function collabAdminOverview(ctx: Ctx) {
  requireAction(ctx, 'content.read');
  const db = getPool();
  const brands = await visibleBrands(ctx, db);
  const ids = brands.map((b) => b.id);
  const tasks = await one<{ open: number; overdue: number; blocked: number; unassigned: number; reassign: number; due_soon: number }>(db,
    `SELECT count(*) FILTER (WHERE status IN ('open','in_progress','blocked'))::int AS open,
            count(*) FILTER (WHERE status IN ('open','in_progress','blocked') AND due_at < now())::int AS overdue,
            count(*) FILTER (WHERE status='blocked')::int AS blocked,
            count(*) FILTER (WHERE status IN ('open','in_progress','blocked') AND assignee_id IS NULL)::int AS unassigned,
            count(*) FILTER (WHERE status IN ('open','in_progress','blocked') AND needs_reassignment)::int AS reassign,
            count(*) FILTER (WHERE status IN ('open','in_progress','blocked') AND due_at >= now() AND due_at < now() + interval '2 days')::int AS due_soon
       FROM collab_tasks WHERE workspace_id=$1 AND brand_id = ANY($2::uuid[])`, [ctx.access.workspaceId, ids]);
  const reviewsByBrand = await many<{ brand_id: string; pending: number; overdue: number; oldest: Date | null; unassigned: number }>(db,
    `SELECT brand_id, count(*)::int AS pending, count(*) FILTER (WHERE due_at < now())::int AS overdue, min(requested_at) AS oldest,
            count(*) FILTER (WHERE assignee_user_id IS NULL AND NOT EXISTS (SELECT 1 FROM approval_reviewer_requests r WHERE r.approval_id=approvals.id))::int AS unassigned
       FROM approvals WHERE workspace_id=$1 AND brand_id = ANY($2::uuid[]) AND decision='pending' GROUP BY brand_id`, [ctx.access.workspaceId, ids]);
  const overdueTasks = await many<{ id: string; title: string; brand_id: string; assignee: string | null; due_at: Date; status: string }>(db,
    `SELECT t.id, t.title, t.brand_id, coalesce(u.name, u.email) AS assignee, t.due_at, t.status FROM collab_tasks t LEFT JOIN users u ON u.id=t.assignee_id
      WHERE t.workspace_id=$1 AND t.brand_id = ANY($2::uuid[]) AND t.status IN ('open','in_progress','blocked') AND t.due_at < now()
      ORDER BY t.due_at LIMIT 20`, [ctx.access.workspaceId, ids]);
  const name = (id: string) => brands.find((b) => b.id === id)?.name ?? '';
  const canDiag = authorizeCtx(ctx, 'workspace.manage').allowed;
  const delivery = canDiag ? await deliveryStats(db, ctx.access.workspaceId) : null;
  const work = await reassignmentWork(ctx, db);
  return {
    tasks, reviews: {
      pending: reviewsByBrand.reduce((n, r) => n + r.pending, 0), overdue: reviewsByBrand.reduce((n, r) => n + r.overdue, 0),
      by_brand: reviewsByBrand.map((r) => ({ brand_id: r.brand_id, brand: name(r.brand_id), pending: r.pending, overdue: r.overdue, unassigned: r.unassigned, oldest_requested_at: r.oldest?.toISOString() ?? null })),
    },
    overdue_tasks: overdueTasks.map((t) => ({ id: t.id, title: t.title, brand: name(t.brand_id), assignee: t.assignee, due_at: t.due_at.toISOString(), status: t.status })),
    reassignment: { tasks: work.tasks.length, reviews: work.reviews.length, posts: work.posts.length },
    delivery,
    can: { manage: canDiag, reassign: authorizeCtx(ctx, 'members.manage').allowed },
  };
}

async function deliveryStats(db: Queryable, workspaceId: string) {
  const s = await one<{ created: number; emailed: number; pending: number; digest: number; failed: number; not_configured: number; skipped: number }>(db,
    `SELECT count(*)::int AS created, count(*) FILTER (WHERE email_state='sent')::int AS emailed, count(*) FILTER (WHERE email_state='pending')::int AS pending,
            count(*) FILTER (WHERE email_state='digest')::int AS digest, count(*) FILTER (WHERE email_state='failed')::int AS failed,
            count(*) FILTER (WHERE email_state='not_configured')::int AS not_configured, count(*) FILTER (WHERE email_state='skipped')::int AS skipped
       FROM notifications WHERE workspace_id=$1 AND created_at > now() - interval '7 days'`, [workspaceId]);
  return { window_days: 7, ...s, email_configured: !!mailer() };
}

/** Notification delivery diagnostics (admin): problems only, metadata only. */
export async function notificationDiagnostics(ctx: Ctx, q: { state?: string | null; cursor?: string | null } = {}) {
  requireAction(ctx, 'workspace.manage');
  const db = getPool();
  const states = q.state && ['failed', 'not_configured', 'skipped', 'pending'].includes(q.state) ? [q.state] : ['failed', 'not_configured', 'skipped'];
  const params: unknown[] = [ctx.access.workspaceId, states];
  let extra = '';
  if (q.cursor) {
    const [ts, id] = Buffer.from(q.cursor, 'base64url').toString().split('|');
    if (!ts || !isUuid(id)) throw new AppError('validation_failed', 'Invalid cursor');
    params.push(ts, id); extra = ` AND (n.created_at, n.id) < ($3::timestamptz, $4::uuid)`;
  }
  const rows = await many<{ id: string; event_type: string | null; kind: string; email: string; email_state: string; email_error: string | null; email_attempts: number; created_at: Date; email_after: Date | null }>(db,
    `SELECT n.id, n.event_type, n.kind, u.email, n.email_state, n.email_error, n.email_attempts, n.created_at, n.email_after
       FROM notifications n JOIN users u ON u.id=n.user_id
      WHERE n.workspace_id=$1 AND n.email_state = ANY($2::text[])${extra} ORDER BY n.created_at DESC, n.id DESC LIMIT 51`, params);
  const page = rows.slice(0, 50);
  const last = page[page.length - 1];
  return {
    stats: await deliveryStats(db, ctx.access.workspaceId),
    items: page.map((r) => ({ id: r.id, type: r.event_type ?? r.kind, recipient: r.email, state: r.email_state, error: r.email_error, attempts: r.email_attempts,
      created_at: r.created_at.toISOString(), next_attempt_at: r.email_state === 'pending' ? r.email_after?.toISOString() ?? null : null })),
    next_cursor: rows.length > 50 && last ? Buffer.from(`${last.created_at.toISOString()}|${last.id}`).toString('base64url') : null,
  };
}

/** Retry an email that failed or was skipped for missing configuration (admin). Recipient access re-checked at send. */
export async function retryNotificationEmail(ctx: Ctx, id: string) {
  requireAction(ctx, 'workspace.manage');
  assertUuid(id, 'Notification');
  const r = await getPool().query(`UPDATE notifications SET email_state='pending', email_after=now(), email_attempts=0, email_error=NULL
                                     WHERE id=$1 AND workspace_id=$2 AND email_state IN ('failed','not_configured') RETURNING id`, [id, ctx.access.workspaceId]);
  if (!r.rowCount) throw notFound('Notification');
  const { sendNotificationEmail } = await import('./notifications.js');
  const out = await sendNotificationEmail(getPool(), id);
  await audit(getPool(), { workspaceId: ctx.access.workspaceId, actorUserId: ctx.actor.userId, action: 'collaboration.email_retried', resourceType: 'notification', resourceId: id,
    diff: { outcome: out }, correlationId: ctx.correlationId });
  return { outcome: out };
}

/**
 * Reassign open work from one person to another (offboarding). Each item is only moved when the new person can see its
 * brand; others are reported. Completing/reassigning never approves or publishes anything. Audited per call.
 */
export async function reassignWork(ctx: Ctx, input: { from_user_id: string; to_user_id: string | null; include?: Array<'tasks' | 'reviews' | 'posts'> }) {
  requireAction(ctx, 'members.manage');
  assertUuid(input.from_user_id, 'Person');
  if (input.to_user_id) assertUuid(input.to_user_id, 'Person');
  const include = new Set(input.include?.length ? input.include : ['tasks', 'reviews', 'posts']);
  return withTx(async (tx) => {
    const brands = (await visibleBrands(ctx, tx)).map((b) => b.id);
    const to = input.to_user_id ? await loadUserAuthz(input.to_user_id, ctx.access.workspaceId, null, tx) : null;
    if (to && to.subject.status !== 'active') throw new AppError('validation_failed', 'Choose an active member', { to_user_id: 'Not an active member' });
    const ok = (brandId: string) => !to || staffAllowed(to, 'content.read', brandId);
    const res = { tasks: 0, reviews: 0, posts: 0, skipped: 0 };
    if (include.has('tasks')) {
      const ts = await many<{ id: string; brand_id: string; post_id: string | null; workspace_id: string }>(tx,
        `SELECT id, brand_id, post_id, workspace_id FROM collab_tasks WHERE workspace_id=$1 AND brand_id = ANY($3::uuid[]) AND status IN ('open','in_progress','blocked')
           AND (assignee_id=$2 OR (needs_reassignment AND assignee_id IS NULL AND $2 = ANY(SELECT (detail->>'previous_assignee')::uuid FROM collab_task_events e WHERE e.task_id=collab_tasks.id AND e.kind='needs_reassignment')))
         FOR UPDATE`, [ctx.access.workspaceId, input.from_user_id, brands]);
      for (const t of ts) {
        if (!ok(t.brand_id)) { res.skipped++; continue; }
        await tx.query(`UPDATE collab_tasks SET assignee_id=$2, needs_reassignment=false, reassign_reason=NULL, version=version+1, updated_at=now() WHERE id=$1`, [t.id, input.to_user_id]);
        await tx.query(`INSERT INTO collab_task_events(workspace_id, task_id, actor_id, kind, detail) VALUES ($1,$2,$3,'reassigned',$4)`,
          [ctx.access.workspaceId, t.id, ctx.actor.userId, JSON.stringify({ from: input.from_user_id, to: input.to_user_id, via: 'admin' })]);
        await emitCollabEvent(tx, { workspaceId: ctx.access.workspaceId, brandId: t.brand_id, postId: t.post_id, audience: 'staff', kind: 'task.updated', refId: t.id, actorId: ctx.actor.userId });
        if (input.to_user_id && input.to_user_id !== ctx.actor.userId) {
          await writeOutbox(tx, { workspaceId: ctx.access.workspaceId, aggregateType: 'task', aggregateId: t.id, eventType: 'task.changed',
            payload: { kind: 'assigned', userId: input.to_user_id, brandId: t.brand_id, eventId: `admin-${ctx.correlationId}` } });
        }
        res.tasks++;
      }
    }
    if (include.has('reviews')) {
      const rs = await many<{ id: string; brand_id: string }>(tx,
        `SELECT id, brand_id FROM approvals WHERE workspace_id=$1 AND assignee_user_id=$2 AND decision='pending' AND brand_id = ANY($3::uuid[]) FOR UPDATE`,
        [ctx.access.workspaceId, input.from_user_id, brands]);
      for (const r of rs) {
        if (to) {
          const policy = await loadPolicy(tx, ctx.access.workspaceId, r.brand_id);
          const facts = { state: to, teamIds: (await many<{ team_id: string }>(tx, `SELECT team_id FROM team_memberships WHERE workspace_id=$1 AND user_id=$2`, [ctx.access.workspaceId, input.to_user_id])).map((x) => x.team_id), shared: false };
          if (!policy.stages.some((st) => stageEligibility(facts, st, r.brand_id, input.to_user_id!, { enabled: false, authorIds: [] }).eligible)) { res.skipped++; continue; }
        }
        await tx.query(`UPDATE approvals SET assignee_user_id=$2 WHERE id=$1`, [r.id, input.to_user_id]);
        res.reviews++;
      }
    }
    if (include.has('posts')) {
      const ps = await many<{ id: string; brand_id: string }>(tx,
        `SELECT id, brand_id FROM posts WHERE workspace_id=$1 AND assignee_user_id=$2 AND deleted_at IS NULL AND brand_id = ANY($3::uuid[]) FOR UPDATE`,
        [ctx.access.workspaceId, input.from_user_id, brands]);
      for (const p of ps) {
        if (!ok(p.brand_id)) { res.skipped++; continue; }
        await tx.query(`UPDATE posts SET assignee_user_id=$2 WHERE id=$1`, [p.id, input.to_user_id]);
        res.posts++;
      }
    }
    await audit(tx, { workspaceId: ctx.access.workspaceId, actorUserId: ctx.actor.userId, action: 'collaboration.reassigned', resourceType: 'member', resourceId: input.from_user_id,
      diff: { to_user_id: input.to_user_id, ...res }, correlationId: ctx.correlationId });
    return res;
  });
}

/** Who can review on a brand, stage by stage (current policy; separation of duties is applied per request). */
export async function eligibleReviewersByBrand(ctx: Ctx, brandId: string) {
  requireAction(ctx, 'content.read');
  const db = getPool();
  if (!isUuid(brandId) || !brandAllowed(ctx, brandId)) throw notFound('Brand');
  const policy = await loadPolicy(db, ctx.access.workspaceId, brandId);
  const members = await many<{ user_id: string; name: string | null; email: string }>(db,
    `SELECT m.user_id, u.name, u.email FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.workspace_id=$1 AND m.status='active' AND m.removed_at IS NULL
      ORDER BY u.name NULLS LAST, u.email LIMIT 300`, [ctx.access.workspaceId]);
  const teams = await many<{ user_id: string; team_id: string }>(db, `SELECT user_id, team_id FROM team_memberships WHERE workspace_id=$1`, [ctx.access.workspaceId]);
  const state = stateCache(db, ctx.access.workspaceId);
  const stages = [];
  for (const st of policy.stages) {
    const people = [];
    for (const m of members) {
      const s = await state(m.user_id);
      const e = stageEligibility({ state: s, teamIds: teams.filter((t) => t.user_id === m.user_id).map((t) => t.team_id), shared: false }, st, brandId, m.user_id, { enabled: false, authorIds: [] });
      if (e.eligible) people.push({ id: m.user_id, name: m.name, email: m.email });
    }
    stages.push({ position: st.position, name: st.name, quorum: st.quorum, allow_guests: st.allow_guests, roles: st.eligible_roles, team_ids: st.eligible_team_ids, people });
  }
  return { brand_id: brandId, generation: policy.generation, separation_of_duties: policy.separation_of_duties, stages };
}

/** Platform scope: aggregate pipeline health (no workspace content, no names). */
export async function platformCollabHealth(db: Queryable = getPool()) {
  const n = await one<{ created: number; emailed: number; failed: number; not_configured: number; pending: number; oldest_pending: Date | null; workspaces_with_failures: number }>(db,
    `SELECT count(*)::int AS created, count(*) FILTER (WHERE email_state='sent')::int AS emailed, count(*) FILTER (WHERE email_state='failed')::int AS failed,
            count(*) FILTER (WHERE email_state='not_configured')::int AS not_configured, count(*) FILTER (WHERE email_state='pending')::int AS pending,
            min(email_after) FILTER (WHERE email_state='pending') AS oldest_pending,
            count(DISTINCT workspace_id) FILTER (WHERE email_state='failed')::int AS workspaces_with_failures
       FROM notifications WHERE created_at > now() - interval '24 hours'`);
  const outbox = await one<{ pending: number; oldest: Date | null; dead: number }>(db,
    `SELECT count(*) FILTER (WHERE dispatch_state='pending')::int AS pending, min(available_at) FILTER (WHERE dispatch_state='pending') AS oldest,
            count(*) FILTER (WHERE dispatch_state='dead')::int AS dead
       FROM outbox WHERE event_type IN ('comment.created','comment.edited','task.changed','approval.requested','approval.decided','approval.invalidated','review.reviewers_requested','assignment.changed','review.shared')`);
  const feed = await one<{ events: number; presence: number; overdue_tasks: number; overdue_reviews: number }>(db,
    `SELECT (SELECT count(*)::int FROM collab_events WHERE created_at > now() - interval '24 hours') AS events,
            (SELECT count(*)::int FROM post_presence) AS presence,
            (SELECT count(*)::int FROM collab_tasks WHERE status IN ('open','in_progress','blocked') AND due_at < now()) AS overdue_tasks,
            (SELECT count(*)::int FROM approvals WHERE decision='pending' AND due_at < now()) AS overdue_reviews`);
  return {
    window_hours: 24, notifications: { ...n, oldest_pending: n.oldest_pending?.toISOString() ?? null }, email_configured: !!mailer(),
    outbox: { pending: outbox.pending, dead: outbox.dead, oldest_pending_seconds: outbox.oldest ? Math.max(0, Math.round((Date.now() - outbox.oldest.getTime()) / 1000)) : 0 },
    feed,
  };
}

