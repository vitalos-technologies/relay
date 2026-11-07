// Approval inbox + review-request notifications (stream C). The inbox groups work by brand / assignee / due date
// (client-side grouping over this list) and links to exact outgoing-variant previews; `can_decide` reflects the
// caller's CURRENT eligibility for the request's current stage (policy roles/teams/quorum/SoD).
import { AppError } from '@social-lite/core';
import { getPool, many, maybeOne, type Queryable } from '@social-lite/db';
import type { Ctx } from '../context.js';
import { loadUserAuthz } from '../authz.js';
import { authorizeCtx, requireAction } from '../tenancy.js';
import { approvalDetail } from '../posts/scheduling.js';
import { approvalJson, type ApprovalRow } from '../posts/serialize.js';
import { evaluateStages, loadPolicy, reviewState, reviewerFacts, reviewerFactsMany, stageEligibility, stageProgressFrom, type PolicyDef, type ReviewRequestRow } from '../posts/approval-policy.js';
import { staffAllowed } from './access.js';
import { deliverNotification } from './notifications.js';

type InboxRow = ApprovalRow & ReviewRequestRow & {
  title: string | null; base_text: string; revision_number: number; schedule_due: Date; is_immediate: boolean; input_timezone: string; brand_name: string;
  assignee_email: string | null; assignee_name: string | null; providers: string[] | null; campaign_name: string | null;
};

export async function approvalInbox(ctx: Ctx, q: { status?: string | null; brand_id?: string | null } = {}) {
  requireAction(ctx, 'content.read');
  const db = getPool();
  const status = q.status === 'decided' ? 'decided' : 'pending';
  const params: unknown[] = [ctx.access.workspaceId, ctx.access.brandIds];
  let extra = '';
  if (q.brand_id) {
    if (!/^[0-9a-f-]{36}$/i.test(q.brand_id)) throw new AppError('validation_failed', 'Invalid brand');
    params.push(q.brand_id); extra = ` AND a.brand_id=$${params.length}`;
  }
  const rows = await many<InboxRow>(db,
    `SELECT a.*, ru.email AS requested_by_email, rv.email AS reviewer_email, p.title, r.base_text, r.revision_number, s.due_at AS schedule_due, s.is_immediate,
            s.input_timezone, b.name AS brand_name, au.email AS assignee_email, au.name AS assignee_name, c.name AS campaign_name,
            (SELECT array_agg(cn.provider::text ORDER BY cn.provider) FROM variants v JOIN connections cn ON cn.id=v.connection_id WHERE v.revision_id=a.revision_id) AS providers
       FROM approvals a JOIN posts p ON p.id=a.post_id JOIN post_revisions r ON r.id=a.revision_id JOIN schedules s ON s.id=a.schedule_id
       JOIN brands b ON b.id=a.brand_id LEFT JOIN users ru ON ru.id=a.requested_by LEFT JOIN users rv ON rv.id=a.reviewer_id
       LEFT JOIN users au ON au.id=a.assignee_user_id LEFT JOIN campaigns c ON c.id=p.campaign_id
      WHERE a.workspace_id=$1 AND ($2::uuid[] IS NULL OR a.brand_id = ANY($2::uuid[])) AND ${status === 'pending' ? `a.decision='pending'` : `a.decision<>'pending'`}${extra}
      ORDER BY ${status === 'pending' ? 'coalesce(a.due_at, s.due_at) ASC NULLS LAST' : 'a.decided_at DESC NULLS LAST'}, a.requested_at DESC LIMIT 150`, params);
  // V3.1 PERF: batched (was ~8 queries per row). Policies per brand+generation, decisions for all pending requests,
  // reviewer facts per distinct user (fresh for this request) — same eligibility rules as evaluateStages().
  const policies = new Map<string, PolicyDef>();
  const pendingRows = rows.filter((r) => r.decision === 'pending');
  for (const r of pendingRows) {
    const key = `${r.brand_id}:${r.policy_generation}`;
    if (!policies.has(key)) policies.set(key, await loadPolicy(db, r.workspace_id, r.brand_id, r.policy_generation ?? undefined));
  }
  const decisions = pendingRows.length ? await many<{ approval_id: string; stage: number; user_id: string; decision: string }>(db,
    `SELECT approval_id, stage, user_id, decision FROM approval_decisions WHERE approval_id = ANY($1::uuid[])`, [pendingRows.map((r) => r.id)]) : [];
  const decisionsBy = new Map<string, typeof decisions>();
  for (const d of decisions) { const l = decisionsBy.get(d.approval_id) ?? []; l.push(d); decisionsBy.set(d.approval_id, l); }
  const facts = await reviewerFactsMany(db, ctx.access.workspaceId, [
    ...pendingRows.map((r) => ({ userId: ctx.actor.userId, postId: r.post_id })),
    ...pendingRows.flatMap((r) => (decisionsBy.get(r.id) ?? []).filter((d) => d.decision === 'approved').map((d) => ({ userId: d.user_id, postId: r.post_id }))),
  ]);
  const items = [];
  for (const r of rows) {
    let canDecide = false;
    let stageName: string | null = null;
    let progress: { approvals: number; quorum: number } | null = null;
    if (r.decision === 'pending') {
      const policy = policies.get(`${r.brand_id}:${r.policy_generation}`)!;
      const mine = decisionsBy.get(r.id) ?? [];
      const stages = stageProgressFrom(mine.filter((d) => d.decision === 'approved'), (uid) => facts(uid, r.post_id), r, policy);
      const cur = stages.find((s) => !s.met);
      if (cur) {
        stageName = cur.name; progress = { approvals: cur.approvals, quorum: cur.quorum };
        const def = policy.stages.find((s) => s.position === cur.position)!;
        const e = stageEligibility(facts(ctx.actor.userId, r.post_id), def, r.brand_id, ctx.actor.userId, { enabled: policy.separation_of_duties, authorIds: r.author_ids });
        const decided = mine.some((d) => d.user_id === ctx.actor.userId && (d.stage === cur.position || d.decision === 'approved'));
        canDecide = e.eligible && !decided;
      }
    }
    items.push({
      ...approvalJson(r), title: r.title, excerpt: r.base_text.replace(/\s+/g, ' ').slice(0, 140), brand_name: r.brand_name, revision_number: r.revision_number,
      due_at: r.is_immediate ? null : r.schedule_due.toISOString(), publish_on_approval: r.is_immediate, input_timezone: r.input_timezone,
      review_due_at: r.due_at?.toISOString() ?? null,
      assignee: r.assignee_user_id ? { id: r.assignee_user_id, email: r.assignee_email, name: r.assignee_name } : null,
      campaign_name: r.campaign_name,
      destinations: (r.providers ?? []).map((provider) => ({ provider })),
      stage: { current: r.current_stage, count: r.stage_count, name: stageName, ...(progress ?? {}) },
      can_decide: canDecide,
    });
  }
  return { items };
}

/** Approval detail for staff: V1 detail (exact variants + diff) + V2 policy progress, decisions and eligibility. */
export async function approvalDetailV2(ctx: Ctx, approvalId: string) {
  const base = await approvalDetail(ctx, approvalId);
  const db = getPool();
  const a = await maybeOne<ReviewRequestRow & { binding: unknown }>(db, `SELECT * FROM approvals WHERE id=$1 AND workspace_id=$2`, [base.id, ctx.access.workspaceId]);
  const review = await reviewState(db, ctx, a as ReviewRequestRow & { binding: null });
  return {
    ...base, review, can_decide: review.me.eligible,
    can_assign: authorizeCtx(ctx, 'content.submit', { brandId: base.brand_id }).allowed || authorizeCtx(ctx, 'content.approve', { brandId: base.brand_id }).allowed,
    can_share: authorizeCtx(ctx, 'content.submit', { brandId: base.brand_id }).allowed,
  };
}

/** Outbox 'approval.requested': notify every person eligible for the CURRENT stage (distinct, entitled at send). */
export async function onApprovalRequested(db: Queryable, evt: { workspace_id: string; aggregate_id: string; payload: Record<string, unknown> }) {
  const a = await maybeOne<ReviewRequestRow>(db, `SELECT * FROM approvals WHERE id=$1 AND workspace_id=$2`, [evt.aggregate_id, evt.workspace_id]);
  if (!a || a.decision !== 'pending') return;
  const policy = await loadPolicy(db, a.workspace_id, a.brand_id, a.policy_generation ?? undefined);
  const stages = await evaluateStages(db, a, policy);
  const cur = stages.find((s) => !s.met);
  const def = cur ? policy.stages.find((s) => s.position === cur.position) : null;
  if (!def) return;
  const candidates = await many<{ user_id: string }>(db,
    `SELECT user_id FROM memberships WHERE workspace_id=$1 AND status='active' AND removed_at IS NULL LIMIT 1000`, [a.workspace_id]);
  for (const c of candidates) {
    const facts = await reviewerFacts(db, a.workspace_id, c.user_id, a.post_id);
    const e = stageEligibility(facts, def, a.brand_id, c.user_id, { enabled: policy.separation_of_duties, authorIds: a.author_ids });
    if (!e.eligible || cur!.approver_ids.includes(c.user_id)) continue;
    const staff = staffAllowed(facts.state, 'content.read', a.brand_id);
    await deliverNotification(db, {
      workspaceId: a.workspace_id, userId: c.user_id, event: 'review_requested', kind: 'approval.requested',
      title: def.position > 1 ? `A post is ready for "${def.name}"` : 'A post is waiting for your review',
      referenceType: staff ? 'approval' : 'review', referenceId: a.id, dedupeKey: `approval:${a.id}:stage:${def.position}`,
      requirement: staff ? { brandId: a.brand_id, permission: 'content.approve' } : { brandId: a.brand_id, permission: 'review.shared', postId: a.post_id },
    });
  }
}

/** Outbox 'approval.decided': tell the requester (entitled at send time). */
export async function onApprovalDecided(db: Queryable, evt: { workspace_id: string; aggregate_id: string }) {
  const a = await maybeOne<{ requested_by: string | null; decision: string; post_id: string; brand_id: string }>(db,
    `SELECT requested_by, decision, post_id, brand_id FROM approvals WHERE id=$1 AND workspace_id=$2`, [evt.aggregate_id, evt.workspace_id]);
  if (!a?.requested_by) return;
  const s = await loadUserAuthz(a.requested_by, evt.workspace_id, null, db);
  if (!staffAllowed(s, 'content.read', a.brand_id)) return;
  await deliverNotification(db, {
    workspaceId: evt.workspace_id, userId: a.requested_by, event: 'review_decided', kind: `approval.${a.decision}`, severity: a.decision === 'rejected' ? 'warning' : 'info',
    title: a.decision === 'rejected' ? 'Changes were requested on your post' : 'Your post was approved',
    referenceType: 'post', referenceId: a.post_id, dedupeKey: `approval:${evt.aggregate_id}:${a.decision}`,
    requirement: { brandId: a.brand_id, permission: 'content.read' },
  });
}
