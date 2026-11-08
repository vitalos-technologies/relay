// Reviewer requests + review notifications, on top of the approval engine (posts/approval-policy.ts, scheduling.ts).
// Nothing here can approve: a "requested reviewer" is a notification target only; who may decide is always the engine's
// stage eligibility (roles/teams/guests, quorum of distinct people, separation of duties, no self-approval when SoD is on),
// re-evaluated at decision time. Comments never count as approval.
import { AppError, notFound } from '@social-lite/core';
import { getPool, many, maybeOne, withTx, type Queryable } from '@social-lite/db';
import type { Ctx } from '../context.js';
import { audit } from '../audit.js';
import { writeOutbox } from '../outbox.js';
import { loadUserAuthz } from '../authz.js';
import { assertUuid, authorizeCtx, brandAllowed, isUuid, requireAction } from '../tenancy.js';
import { evaluateStages, loadPolicy, reviewerFacts, stageEligibility, type ReviewRequestRow } from '../posts/approval-policy.js';
import { staffAllowed } from './access.js';
import { deliverNotification } from './notifications.js';
import { emitCollabEvent } from './events.js';

async function loadRequest(db: Queryable, ctx: Ctx, approvalId: string, lock = false): Promise<ReviewRequestRow> {
  assertUuid(approvalId, 'Review');
  const a = await maybeOne<ReviewRequestRow>(db, `SELECT * FROM approvals WHERE id=$1 AND workspace_id=$2 ${lock ? 'FOR UPDATE' : ''}`, [approvalId, ctx.access.workspaceId]);
  if (!a || !brandAllowed(ctx, a.brand_id) || (ctx.access.authz && !staffAllowed(ctx.access.authz, 'content.read', a.brand_id))) throw notFound('Review');
  return a;
}

/** Eligible for ANY stage of the request's policy (not decided yet). */
async function eligibleSomewhere(db: Queryable, a: ReviewRequestRow, userId: string): Promise<{ eligible: boolean; reason: string | null; guest: boolean }> {
  const policy = await loadPolicy(db, a.workspace_id, a.brand_id, a.policy_generation ?? undefined);
  const facts = await reviewerFacts(db, a.workspace_id, userId, a.post_id);
  if (facts.state.subject.status !== 'active') return { eligible: false, reason: 'no_authority', guest: false };
  let reason: string | null = 'no_authority';
  for (const st of policy.stages) {
    const e = stageEligibility(facts, st, a.brand_id, userId, { enabled: policy.separation_of_duties, authorIds: a.author_ids });
    if (e.eligible) return { eligible: true, reason: null, guest: e.asGuest };
    reason = e.reason;
  }
  return { eligible: false, reason, guest: false };
}

/** People who could review this request (bounded name search), with whether they're already requested. */
export async function reviewerOptions(ctx: Ctx, approvalId: string, q = '') {
  requireAction(ctx, 'content.read');
  const db = getPool();
  const a = await loadRequest(db, ctx, approvalId);
  const term = q.trim().replace(/[%_\\]/g, '').slice(0, 40);
  const members = await many<{ user_id: string; email: string; name: string | null }>(db,
    `SELECT m.user_id, u.email, u.name FROM memberships m JOIN users u ON u.id=m.user_id
      WHERE m.workspace_id=$1 AND m.status='active' AND m.removed_at IS NULL
        AND ($2 = '' OR u.name ILIKE $2 || '%' OR u.email ILIKE $2 || '%' OR u.name ILIKE '% ' || $2 || '%')
      ORDER BY u.name NULLS LAST, u.email LIMIT 60`, [ctx.access.workspaceId, term]);
  const requested = new Set((await many<{ user_id: string }>(db, `SELECT user_id FROM approval_reviewer_requests WHERE approval_id=$1`, [a.id])).map((r) => r.user_id));
  const out: Array<{ id: string; name: string | null; email: string; guest: boolean; requested: boolean }> = [];
  for (const m of members) {
    if (out.length >= 12) break;
    const e = await eligibleSomewhere(db, a, m.user_id);
    if (e.eligible) out.push({ id: m.user_id, name: m.name, email: m.email, guest: e.guest, requested: requested.has(m.user_id) });
  }
  return { items: out };
}

export async function requestedReviewers(db: Queryable, approvalId: string) {
  const rows = await many<{ user_id: string; name: string | null; email: string; requested_at: Date; decided: string | null }>(db,
    `SELECT r.user_id, u.name, u.email, r.requested_at,
            (SELECT d.decision FROM approval_decisions d WHERE d.approval_id=r.approval_id AND d.user_id=r.user_id ORDER BY d.created_at DESC LIMIT 1) AS decided
       FROM approval_reviewer_requests r JOIN users u ON u.id=r.user_id WHERE r.approval_id=$1 ORDER BY r.requested_at LIMIT 50`, [approvalId]);
  return rows.map((r) => ({ id: r.user_id, name: r.name, email: r.email, requested_at: r.requested_at.toISOString(), decision: r.decided }));
}

export async function listRequestedReviewers(ctx: Ctx, approvalId: string) {
  const db = getPool();
  const a = await loadRequest(db, ctx, approvalId);
  return { items: await requestedReviewers(db, a.id), can_request: canRequest(ctx, a.brand_id) && a.decision === 'pending' };
}

function canRequest(ctx: Ctx, brandId: string) {
  return authorizeCtx(ctx, 'content.submit', { brandId }).allowed || authorizeCtx(ctx, 'content.approve', { brandId }).allowed;
}

/** Ask specific eligible people to review. Ineligible people are refused (with the reason); nothing is granted. */
export async function requestReviewers(ctx: Ctx, approvalId: string, userIds: string[]) {
  const ids = [...new Set((userIds ?? []).filter(isUuid))].slice(0, 10);
  if (!ids.length) throw new AppError('validation_failed', 'Choose at least one reviewer', { user_ids: 'Required' });
  return withTx(async (tx) => {
    const a = await loadRequest(tx, ctx, approvalId, true);
    if (!canRequest(ctx, a.brand_id)) throw new AppError('forbidden', 'You can’t request reviewers for this brand');
    if (a.decision !== 'pending') throw new AppError('invalid_state', 'This review is closed.');
    const refused: Record<string, string> = {};
    const added: string[] = [];
    for (const u of ids) {
      if (u === ctx.actor.userId) { refused[u] = 'self'; continue; }
      const e = await eligibleSomewhere(tx, a, u);
      if (!e.eligible) { refused[u] = e.reason ?? 'not_eligible'; continue; }
      const r = await tx.query(`INSERT INTO approval_reviewer_requests(workspace_id, approval_id, user_id, requested_by) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
        [ctx.access.workspaceId, a.id, u, ctx.actor.userId]);
      if (r.rowCount) added.push(u);
    }
    if (!added.length && Object.keys(refused).length) {
      throw new AppError('validation_failed', 'These people can’t review this post', Object.fromEntries(Object.entries(refused).map(([k, v]) => [k, v.replace(/_/g, ' ')])));
    }
    if (added.length) {
      await writeOutbox(tx, { workspaceId: ctx.access.workspaceId, aggregateType: 'approval', aggregateId: a.id, eventType: 'review.reviewers_requested', payload: { userIds: added } });
      await emitCollabEvent(tx, { workspaceId: ctx.access.workspaceId, brandId: a.brand_id, postId: a.post_id, audience: 'staff', kind: 'review.updated', refId: a.id, actorId: ctx.actor.userId });
      await audit(tx, { workspaceId: ctx.access.workspaceId, brandId: a.brand_id, actorUserId: ctx.actor.userId, action: 'approval.reviewers_requested', resourceType: 'approval', resourceId: a.id,
        diff: { post_id: a.post_id, user_ids: added, refused: Object.keys(refused).length }, correlationId: ctx.correlationId });
    }
    return { added, refused, items: await requestedReviewers(tx, a.id) };
  });
}

async function reviewLink(db: Queryable, a: { id: string; workspace_id: string; brand_id: string; post_id: string }, userId: string) {
  const s = await loadUserAuthz(userId, a.workspace_id, null, db);
  const staff = staffAllowed(s, 'content.read', a.brand_id);
  return staff
    ? { referenceType: 'approval', linkPath: `/approvals/${a.id}`, requirement: { brandId: a.brand_id, permission: 'content.read' as const } }
    : { referenceType: 'review', linkPath: `/review/${a.id}`, requirement: { brandId: a.brand_id, permission: 'review.shared' as const, postId: a.post_id } };
}

/** Outbox 'review.reviewers_requested'. */
export async function onReviewersRequested(db: Queryable, evt: { workspace_id: string; aggregate_id: string; payload: Record<string, unknown> }) {
  const a = await maybeOne<ReviewRequestRow & { requested_by: string | null }>(db, `SELECT * FROM approvals WHERE id=$1 AND workspace_id=$2`, [evt.aggregate_id, evt.workspace_id]);
  if (!a || a.decision !== 'pending') return;
  const ids = Array.isArray(evt.payload.userIds) ? (evt.payload.userIds as unknown[]).filter(isUuid) : [];
  for (const u of ids) {
    const e = await eligibleSomewhere(db, a, u);
    if (!e.eligible) continue;
    const l = await reviewLink(db, a, u);
    // One notification per review request: if the person was already told this post awaits review, that item is
    // refreshed (unread again, "Your review was requested") instead of adding a second one.
    const merged = await db.query(
      `UPDATE notifications SET title='Your review was requested', read_at=NULL, last_seen_at=now(), actor_id=coalesce($3, actor_id)
        WHERE user_id=$1 AND workspace_id=$4 AND dedupe_key LIKE $2 RETURNING id`, [u, `approval:${a.id}:stage:%`, a.requested_by, a.workspace_id]);
    if (merged.rowCount) continue;
    await deliverNotification(db, { workspaceId: a.workspace_id, userId: u, event: 'review_requested', kind: 'approval.requested', title: 'Your review was requested', actorId: a.requested_by,
      referenceType: l.referenceType, referenceId: a.id, linkPath: l.linkPath, dedupeKey: `approval:${a.id}:req:${u}`, requirement: l.requirement });
  }
  await emitCollabEvent(db, { workspaceId: a.workspace_id, brandId: a.brand_id, postId: a.post_id, audience: 'staff', kind: 'review.updated', refId: a.id });
}

const INVALID_TEXT: Record<string, string> = {
  content_changed: 'A review was reset: the post changed', binding_changed: 'A review was reset: media, destinations or links changed',
  policy_changed: 'A review was reset: the approval policy changed',
};

/** Outbox 'approval.invalidated': author, assignee, requested reviewers and anyone who already approved. */
export async function onApprovalInvalidated(db: Queryable, evt: { workspace_id: string; aggregate_id: string; payload: Record<string, unknown> }) {
  const a = await maybeOne<ReviewRequestRow & { requested_by: string | null; decision: string }>(db, `SELECT * FROM approvals WHERE id=$1 AND workspace_id=$2`, [evt.aggregate_id, evt.workspace_id]);
  if (!a || a.decision !== 'invalidated') return;
  const code = String(evt.payload.code ?? 'content_changed');
  const approvers = await many<{ user_id: string }>(db, `SELECT DISTINCT user_id FROM approval_decisions WHERE approval_id=$1 AND decision='approved'`, [a.id]);
  const requested = await many<{ user_id: string }>(db, `SELECT user_id FROM approval_reviewer_requests WHERE approval_id=$1`, [a.id]);
  const who = new Set([a.requested_by, a.assignee_user_id, ...approvers.map((x) => x.user_id), ...requested.map((x) => x.user_id)].filter((x): x is string => !!x));
  for (const u of who) {
    const s = await loadUserAuthz(u, a.workspace_id, null, db);
    if (!staffAllowed(s, 'content.read', a.brand_id)) continue; // guests see the next shared request instead
    await deliverNotification(db, { workspaceId: a.workspace_id, userId: u, event: 'review_decided', kind: 'approval.invalidated', severity: 'warning',
      title: INVALID_TEXT[code] ?? 'A review was reset', referenceType: 'post', referenceId: a.post_id, linkPath: `/posts/${a.post_id}?panel=review`,
      dedupeKey: `approval:${a.id}:invalidated`, requirement: { brandId: a.brand_id, permission: 'content.read' } });
  }
  await emitCollabEvent(db, { workspaceId: a.workspace_id, brandId: a.brand_id, postId: a.post_id, audience: 'staff', kind: 'review.updated', refId: a.id });
}

/** Worker: reviews past their review due date → assignee, requested reviewers and requester, once per request. */
export async function runReviewOverdue(db: Queryable = getPool(), limit = 100): Promise<number> {
  const rows = await many<ReviewRequestRow & { requested_by: string | null }>(db,
    `SELECT * FROM approvals WHERE decision='pending' AND due_at IS NOT NULL AND due_at < now() AND overdue_notified_at IS NULL ORDER BY due_at LIMIT $1`, [limit]);
  let n = 0;
  for (const a of rows) {
    await db.query(`UPDATE approvals SET overdue_notified_at=now() WHERE id=$1 AND overdue_notified_at IS NULL`, [a.id]);
    const policy = await loadPolicy(db, a.workspace_id, a.brand_id, a.policy_generation ?? undefined);
    const progress = await evaluateStages(db, a, policy);
    const cur = progress.find((p) => !p.met);
    const requested = await many<{ user_id: string }>(db, `SELECT user_id FROM approval_reviewer_requests WHERE approval_id=$1`, [a.id]);
    const reviewers = new Set([a.assignee_user_id, ...requested.map((r) => r.user_id)].filter((x): x is string => !!x && !cur?.approver_ids.includes(x)));
    for (const u of reviewers) {
      const l = await reviewLink(db, a, u);
      await deliverNotification(db, { workspaceId: a.workspace_id, userId: u, event: 'reminder', kind: 'approval.overdue', severity: 'warning', title: 'A review is overdue',
        referenceType: l.referenceType, referenceId: a.id, linkPath: l.linkPath, dedupeKey: `approval:${a.id}:overdue`, requirement: l.requirement });
      n++;
    }
    if (a.requested_by && !reviewers.has(a.requested_by)) {
      await deliverNotification(db, { workspaceId: a.workspace_id, userId: a.requested_by, event: 'reminder', kind: 'approval.overdue', severity: 'warning', title: 'A review you requested is overdue',
        referenceType: 'approval', referenceId: a.id, linkPath: `/approvals/${a.id}`, dedupeKey: `approval:${a.id}:overdue`, requirement: { brandId: a.brand_id, permission: 'content.read' } });
    }
  }
  return n;
}
