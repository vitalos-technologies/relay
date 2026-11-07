// Scheduling, publish-now, submit-for-review, approval, cancellation and rescheduling.
// One transaction writes schedule + deliveries + outbox (durable publishing algorithm steps 1-3).
import {
  AppError, isCancellable, notFound, resolveVariants, resolveWallTimeWithOffset, isValidTimeZone,
  scheduleRequestSchema, type ScheduleRequest, type ResolvedVariant,
} from '@social-lite/core';
import { getPool, many, maybeOne, one, withTx, type Queryable } from '@social-lite/db';
import type { Ctx } from '../context.js';
import { audit } from '../audit.js';
import { writeOutbox } from '../outbox.js';
import { assertBrand, assertUuid, authorizeCtx, brandAllowed, requireAction, type BrandRow } from '../tenancy.js';
import { recordPublicationAuthority } from '../engine/authority.js';
import { beginIdempotent, completeIdempotent } from '../idempotency.js';
import { assetsByIds } from '../media/assets.js';
import { brandConnections, contentHash, scheduleFingerprint, type ConnectionRow } from './shared.js';
import { loadPost, validateDraft, deliveriesForSchedule, type PostRow } from './service.js';
import { approvalJson, deliveryJson, scheduleJson, type ApprovalRow, type ScheduleRow } from './serialize.js';
import { approvalRequiredFor, createReviewRequest, recordApproval, recordRejection, type ReviewRequestRow } from './approval-policy.js';

const PAST_TOLERANCE_MS = 60_000;

interface ResolvedTime { dueAt: Date; publishBefore: Date; timezone: string; localTime: string; offset: string | null; immediate: boolean }

export function resolveScheduleTime(req: Pick<ScheduleRequest, 'input_local_time' | 'timezone' | 'offset' | 'deadline_minutes'>, brand: BrandRow, mode: 'timed' | 'immediate' | 'on_approval', now = new Date()): ResolvedTime {
  const tz = req.timezone ?? brand.timezone;
  if (!isValidTimeZone(tz)) throw new AppError('validation_failed', `Unknown time zone "${tz}"`, { timezone: 'Choose a valid time zone' });
  const deadlineMs = (req.deadline_minutes ?? brand.default_deadline_minutes) * 60_000;
  if (mode !== 'timed') {
    const local = new Intl.DateTimeFormat('sv-SE', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(now).replace(' ', 'T');
    return { dueAt: now, publishBefore: new Date(now.getTime() + deadlineMs), timezone: tz, localTime: local, offset: null, immediate: true };
  }
  if (!req.input_local_time) throw new AppError('validation_failed', 'Choose a date and time', { input_local_time: 'Required' });
  const r = resolveWallTimeWithOffset(req.input_local_time, tz, req.offset);
  if (r.kind === 'invalid' || r.kind === 'gap') throw new AppError('validation_failed', r.message, { input_local_time: r.message });
  if (r.kind === 'ambiguous') {
    throw new AppError('conflict', r.message, { input_local_time: r.message }, {
      reason: 'ambiguous_time', options: r.options.map((o) => ({ offset: o.offset, instant: o.instant.toISOString() })),
    });
  }
  if (r.instant.getTime() < now.getTime() - PAST_TOLERANCE_MS) {
    throw new AppError('validation_failed', 'That time is in the past. Choose a future time or publish now.', { input_local_time: 'In the past' });
  }
  return { dueAt: r.instant, publishBefore: new Date(r.instant.getTime() + deadlineMs), timezone: tz, localTime: req.input_local_time.slice(0, 16), offset: r.offset, immediate: false };
}

async function lockedBrand(tx: Queryable, ctx: Ctx, brandId: string): Promise<BrandRow> {
  const b = await assertBrand(ctx, brandId, tx);
  if (b.archived_at) throw new AppError('invalid_state', 'This brand is archived');
  return b;
}

/** Snapshot the working draft into an immutable revision + variants (reused if unchanged). */
export async function snapshotRevision(tx: Queryable, ctx: Ctx, post: PostRow, connectionIds: string[], conns: ConnectionRow[]): Promise<{ revisionId: string; revisionNumber: number; variants: Array<ResolvedVariant & { id: string }> }> {
  const draft = { ...post.draft, variants: connectionIds.map((id) => post.draft.variants.find((v) => v.connectionId === id) ?? { connectionId: id, inheritText: true, inheritMedia: true }) };
  const resolved = resolveVariants(draft, conns);
  const hash = contentHash(draft.baseText, draft.baseLink ?? null, draft.baseAssetIds, resolved);
  const latest = await maybeOne<{ id: string; revision_number: number; content_hash: string }>(tx,
    `SELECT id, revision_number, content_hash FROM post_revisions WHERE post_id=$1 ORDER BY revision_number DESC LIMIT 1`, [post.id]);
  if (latest && latest.content_hash === hash) {
    const vs = await many<{ id: string; connection_id: string }>(tx, `SELECT id, connection_id FROM variants WHERE revision_id=$1`, [latest.id]);
    if (vs.length === resolved.length) {
      return { revisionId: latest.id, revisionNumber: latest.revision_number, variants: resolved.map((r) => ({ ...r, id: vs.find((v) => v.connection_id === r.connectionId)!.id })) };
    }
  }
  const num = (latest?.revision_number ?? 0) + 1;
  const rev = await one<{ id: string }>(tx,
    `INSERT INTO post_revisions(workspace_id, post_id, revision_number, base_text, base_link, base_asset_ids, content_hash, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [ctx.access.workspaceId, post.id, num, draft.baseText, draft.baseLink ?? null, draft.baseAssetIds, hash, ctx.actor.userId]);
  const variants: Array<ResolvedVariant & { id: string }> = [];
  for (const v of resolved) {
    const row = await one<{ id: string }>(tx,
      `INSERT INTO variants(workspace_id, revision_id, connection_id, inherit_text, rendered_text, link, format, asset_ids, buttons, options)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [ctx.access.workspaceId, rev.id, v.connectionId, v.inheritText, v.text, v.link, v.format, v.assetIds, JSON.stringify(v.buttons), JSON.stringify(v.options)]);
    variants.push({ ...v, id: row.id });
  }
  await tx.query(`UPDATE posts SET current_revision_id=$2 WHERE id=$1`, [post.id, rev.id]);
  return { revisionId: rev.id, revisionNumber: num, variants };
}

/** Supersede the live schedule: not-started deliveries are cancelled; pending approvals invalidated (SC-08). */
async function supersedeLive(tx: Queryable, postId: string): Promise<{ inFlight: number }> {
  const live = await maybeOne<{ id: string }>(tx, `SELECT id FROM schedules WHERE post_id=$1 AND status IN ('active','pending_approval') FOR UPDATE`, [postId]);
  if (!live) return { inFlight: 0 };
  await tx.query(`UPDATE schedules SET status='superseded' WHERE id=$1`, [live.id]);
  await tx.query(`UPDATE approvals SET decision='invalidated', decided_at=now(), reason='Superseded by a newer schedule or revision' WHERE schedule_id=$1 AND decision IN ('pending','approved')`, [live.id]);
  await tx.query(
    `UPDATE deliveries SET state='cancelled', last_error_code='superseded', last_error_message='Replaced by a newer schedule', updated_at=now()
      WHERE schedule_id=$1 AND (state IN ('scheduled','retry_wait','blocked','paused') OR (state='preparing' AND phase<>'sending'))`, [live.id]);
  const f = await one<{ n: number }>(tx, `SELECT count(*)::int n FROM deliveries WHERE schedule_id=$1 AND state IN ('preparing','publishing','processing')`, [live.id]);
  return { inFlight: f.n };
}

async function insertDeliveries(tx: Queryable, ctx: Ctx, schedule: { id: string; post_id: string; brand_id: string; generation: number; revision_id: string; due_at: Date; publish_before: Date }, variants: Array<{ id: string; connectionId: string }>, conns: ConnectionRow[]) {
  for (const v of variants) {
    const c = conns.find((x) => x.id === v.connectionId)!;
    const d = await one<{ id: string }>(tx,
      `INSERT INTO deliveries(workspace_id, brand_id, post_id, schedule_id, generation, revision_id, variant_id, connection_id, provider, is_mock,
                              due_at, publish_before, next_attempt_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$11) ON CONFLICT (schedule_id, variant_id) DO NOTHING RETURNING id`,
      [ctx.access.workspaceId, schedule.brand_id, schedule.post_id, schedule.id, schedule.generation, schedule.revision_id, v.id, c.id, c.provider, c.is_mock,
        schedule.due_at, schedule.publish_before]);
    await writeOutbox(tx, { workspaceId: ctx.access.workspaceId, aggregateType: 'delivery', aggregateId: d.id, eventType: 'delivery.due', availableAt: schedule.due_at });
  }
}

type Mode = 'timed' | 'immediate' | 'submit';

async function createScheduleTx(ctx: Ctx, postId: string, rawReq: unknown, idemKey: string | null, mode: Mode) {
  const req = scheduleRequestSchema.parse(rawReq);
  const action = mode === 'submit' ? 'post.submit' : mode === 'immediate' ? 'post.publish' : 'post.schedule';
  return withTx(async (tx) => {
    const idem = await beginIdempotent(tx, { workspaceId: ctx.access.workspaceId, userId: ctx.actor.userId, action, key: idemKey, body: { postId, req } });
    if (idem) return { status: idem.status, body: idem.body };
    const post = await loadPost(ctx, postId, tx, true);
    if (post.archived_at) throw new AppError('invalid_state', 'This post is archived');
    const brand = await lockedBrand(tx, ctx, post.brand_id);
    if (post.version !== req.expected_version) {
      throw new AppError('version_conflict', 'This post changed since you opened it. Review the latest version, then try again.', undefined, { current: { version: post.version } });
    }
    // V2: the brand's approval POLICY (approval-policy.ts) decides whether review is required.
    const reviewRequired = await approvalRequiredFor(tx, ctx.access.workspaceId, post.brand_id);
    if (mode === 'submit') {
      requireAction(ctx, 'drafts.edit', { brandId: post.brand_id });
      if (!reviewRequired) throw new AppError('invalid_state', 'This brand does not require approval. Schedule it directly.');
    } else {
      if (reviewRequired) throw new AppError('invalid_state', 'This brand requires approval: submit for review instead.', undefined, { reason: 'approval_required' });
      // V2: scheduling/publishing come from publisher/brand_manager (or admin/owner) grants on this brand.
      // brands.editors_can_publish no longer grants anything (listed for review by migration 009).
      requireAction(ctx, 'content.schedule', { brandId: post.brand_id, message: 'You cannot schedule posts for this brand' });
      if (mode === 'immediate' && ctx.access.authz) requireAction(ctx, 'content.publish', { brandId: post.brand_id, message: 'You cannot publish posts for this brand' });
    }
    const ids = [...new Set(req.connection_ids)];
    const conns = await brandConnections(tx, ctx.access.workspaceId, post.brand_id, true);
    const validation = await validateDraft(tx, ctx, post, ids);
    if (!validation.ok) {
      throw new AppError('validation_failed', 'Fix the highlighted destinations or deselect them, then try again.', undefined, { issues: validation.issues, per_destination: validation.per_destination });
    }
    const time = resolveScheduleTime(req, brand, mode === 'immediate' || (mode === 'submit' && !req.input_local_time) ? (mode === 'submit' ? 'on_approval' : 'immediate') : 'timed');
    const snap = await snapshotRevision(tx, ctx, post, ids, conns);
    await supersedeLive(tx, post.id);
    const gen = await one<{ schedule_generation: number }>(tx, `UPDATE posts SET schedule_generation=schedule_generation+1 WHERE id=$1 RETURNING schedule_generation`, [post.id]);
    const fingerprint = scheduleFingerprint({ revisionId: snap.revisionId, connectionIds: ids, dueAt: time.dueAt, publishBefore: time.publishBefore, immediate: time.immediate });
    const status = mode === 'submit' ? 'pending_approval' : 'active';
    const schedule = await one<ScheduleRow & { brand_id: string }>(tx,
      `INSERT INTO schedules(workspace_id, brand_id, post_id, revision_id, generation, due_at, input_timezone, input_local_time, input_offset,
                             publish_before, is_immediate, status, fingerprint, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
      [ctx.access.workspaceId, post.brand_id, post.id, snap.revisionId, gen.schedule_generation, time.dueAt, time.timezone, time.localTime, time.offset,
        time.publishBefore, time.immediate, status, fingerprint, ctx.actor.userId]);
    schedule.revision_number = snap.revisionNumber;
    let approval: ApprovalRow | null = null;
    if (mode === 'submit') {
      const request = await createReviewRequest(tx, ctx, { postId: post.id, brandId: post.brand_id, revisionId: snap.revisionId, scheduleId: schedule.id, scheduleGeneration: schedule.generation, fingerprint });
      approval = await one<ApprovalRow>(tx, `SELECT * FROM approvals WHERE id=$1`, [request.id]);
      await writeOutbox(tx, { workspaceId: ctx.access.workspaceId, aggregateType: 'approval', aggregateId: approval.id, eventType: 'approval.requested', payload: { postId: post.id, brandId: post.brand_id } });
    } else {
      await insertDeliveries(tx, ctx, schedule, snap.variants, conns);
      // V2: record publication authority (revalidated by the worker at dispatch).
      await recordPublicationAuthority(tx, ctx, { scheduleId: schedule.id, postId: post.id, brandId: post.brand_id, revisionId: snap.revisionId, connectionIds: ids,
        basis: 'scheduler', permission: mode === 'immediate' ? 'content.publish' : 'content.schedule' });
      await writeOutbox(tx, { workspaceId: ctx.access.workspaceId, aggregateType: 'schedule', aggregateId: schedule.id, eventType: 'schedule.created' });
    }
    await audit(tx, { workspaceId: ctx.access.workspaceId, brandId: post.brand_id, actorUserId: ctx.actor.userId, action: `schedule.${mode === 'submit' ? 'submitted' : mode === 'immediate' ? 'publish_now' : 'created'}`,
      resourceType: 'schedule', resourceId: schedule.id, correlationId: ctx.correlationId,
      diff: { revision: snap.revisionNumber, generation: schedule.generation, due_at: time.dueAt.toISOString(), timezone: time.timezone, local: time.localTime, destinations: ids } });
    const deliveries = mode === 'submit' ? [] : (await deliveriesForSchedule(tx, schedule.id)).map((d) => deliveryJson(d));
    const body = { schedule: scheduleJson(schedule), deliveries, ...(approval ? { approval: approvalJson(approval) } : {}) };
    await completeIdempotent(tx, { workspaceId: ctx.access.workspaceId, action, key: idemKey!, status: 202, body });
    return { status: 202, body };
  });
}

export const schedulePost = (ctx: Ctx, postId: string, req: unknown, key: string | null) => createScheduleTx(ctx, postId, req, key, 'timed');
export const submitForReview = (ctx: Ctx, postId: string, req: unknown, key: string | null) => createScheduleTx(ctx, postId, req, key, 'submit');
export const publishNow = (ctx: Ctx, postId: string, req: { expected_version: number; connection_ids: string[] }, key: string | null) =>
  createScheduleTx(ctx, postId, { expected_version: req.expected_version, connection_ids: req.connection_ids }, key, 'immediate');

// ------------------------------------------------------------------ approvals
async function loadApproval(tx: Queryable, ctx: Ctx, id: string, lock = false): Promise<ApprovalRow> {
  assertUuid(id, 'Approval');
  const a = await maybeOne<ApprovalRow>(tx,
    `SELECT a.*, ru.email AS requested_by_email, rv.email AS reviewer_email FROM approvals a
       LEFT JOIN users ru ON ru.id=a.requested_by LEFT JOIN users rv ON rv.id=a.reviewer_id
      WHERE a.id=$1 AND a.workspace_id=$2 ${lock ? 'FOR UPDATE OF a' : ''}`, [id, ctx.access.workspaceId]);
  if (!a || !brandAllowed(ctx, a.brand_id)) throw notFound('Approval');
  return a;
}

export async function approve(ctx: Ctx, approvalId: string, expectedFingerprint: string) {
  requireAction(ctx, 'approvals.decide');
  return decideApproval(ctx, (tx) => loadApproval(tx, ctx, approvalId, true), expectedFingerprint);
}

/** Load an approval by id within the caller's workspace (after the caller's own access check). */
async function reloadApproval(tx: Queryable, ctx: Ctx, id: string): Promise<ApprovalRow> {
  return one<ApprovalRow>(tx,
    `SELECT a.*, ru.email AS requested_by_email, rv.email AS reviewer_email FROM approvals a
       LEFT JOIN users ru ON ru.id=a.requested_by LEFT JOIN users rv ON rv.id=a.reviewer_id WHERE a.id=$1 AND a.workspace_id=$2`, [id, ctx.access.workspaceId]);
}

/**
 * Approve (shared by the approvals inbox and the guest review portal, which loads the request through its share).
 * V2: records this reviewer's decision for the current stage; the schedule activates only when every stage has
 * its quorum of distinct, currently eligible people. Stale requests are invalidated and the error thrown after commit.
 */
export async function decideApproval(ctx: Ctx, load: (tx: Queryable) => Promise<ApprovalRow>, expectedFingerprint: string) {
  const out = await withTx(async (tx) => {
    const a = await load(tx);
    if (a.decision !== 'pending') throw new AppError('invalid_state', a.decision === 'invalidated' ? 'This request was invalidated because the post changed. Review the new submission.' : `This request was already ${a.decision}.`);
    if (a.fingerprint !== expectedFingerprint) throw new AppError('conflict', 'The submission changed while you were reviewing. Reload to review the current version.');
    const s = await one<ScheduleRow & { brand_id: string }>(tx, `SELECT * FROM schedules WHERE id=$1 FOR UPDATE`, [a.schedule_id]);
    if (s.status !== 'pending_approval' || s.fingerprint !== a.fingerprint) throw new AppError('invalid_state', 'This schedule is no longer awaiting approval.');
    const now = new Date();
    let dueAt = s.due_at;
    let publishBefore = s.publish_before;
    if (s.is_immediate) {
      const grace = s.publish_before.getTime() - s.due_at.getTime();
      dueAt = now; publishBefore = new Date(now.getTime() + grace);
    } else if (publishBefore.getTime() <= now.getTime()) {
      throw new AppError('invalid_state', 'The scheduled time and its publish-before deadline have passed. Reject and ask for a new time.');
    }
    const decision = await recordApproval(tx, ctx, a as unknown as ReviewRequestRow);
    if (decision.kind === 'error') return { error: decision.error };
    if (decision.kind === 'recorded') {
      return { result: { approval: approvalJson(await reloadApproval(tx, ctx, a.id)), schedule: scheduleJson(s), deliveries: [] as ReturnType<typeof deliveryJson>[], stage: decision.stage } };
    }
    const approverIds = [...new Set(decision.stages.flatMap((st) => st.approver_ids))];
    await tx.query(`UPDATE approvals SET decision='approved', reviewer_id=$2, decided_at=now(), current_stage=stage_count WHERE id=$1`, [a.id, ctx.actor.userId]);
    const updated = await one<ScheduleRow & { brand_id: string }>(tx,
      `UPDATE schedules SET status='active', due_at=$2, publish_before=$3 WHERE id=$1 RETURNING *`, [s.id, dueAt, publishBefore]);
    const variants = await many<{ id: string; connection_id: string }>(tx, `SELECT id, connection_id FROM variants WHERE revision_id=$1`, [s.revision_id]);
    const conns = await brandConnections(tx, ctx.access.workspaceId, a.brand_id, true);
    await insertDeliveries(tx, ctx, updated, variants.map((v) => ({ id: v.id, connectionId: v.connection_id })), conns);
    // V2: activation by approval — the approvers (not the draft author) are revalidated at dispatch.
    await recordPublicationAuthority(tx, ctx, { scheduleId: s.id, postId: a.post_id, brandId: a.brand_id, revisionId: s.revision_id,
      connectionIds: variants.map((v) => v.connection_id), basis: 'approval', principalUserId: (a as ApprovalRow & { requested_by?: string | null }).requested_by ?? null,
      permission: 'content.submit', approvalIds: [a.id], approverUserIds: approverIds.length ? approverIds : [ctx.actor.userId] });
    await writeOutbox(tx, { workspaceId: ctx.access.workspaceId, aggregateType: 'approval', aggregateId: a.id, eventType: 'approval.decided', payload: { decision: 'approved', postId: a.post_id } });
    await audit(tx, { workspaceId: ctx.access.workspaceId, brandId: a.brand_id, actorUserId: ctx.actor.userId, action: 'approval.approved', resourceType: 'approval', resourceId: a.id,
      diff: { revision_id: a.revision_id, fingerprint: a.fingerprint, self_approved: (a as ApprovalRow & { requested_by?: string }).requested_by === ctx.actor.userId }, correlationId: ctx.correlationId });
    const fresh = await reloadApproval(tx, ctx, a.id);
    return { result: { approval: approvalJson(fresh), schedule: scheduleJson(updated), deliveries: (await deliveriesForSchedule(tx, s.id)).map((d) => deliveryJson(d)), stage: null as number | null } };
  });
  if ('error' in out) throw out.error;
  return out.result;
}

export async function reject(ctx: Ctx, approvalId: string, reason: string) {
  requireAction(ctx, 'approvals.decide');
  return decideRejection(ctx, (tx) => loadApproval(tx, ctx, approvalId, true), reason);
}

/** Reject (shared by the inbox and the guest review portal). Only an eligible reviewer of the current stage may reject. */
export async function decideRejection(ctx: Ctx, load: (tx: Queryable) => Promise<ApprovalRow>, reason: string) {
  const r = (reason ?? '').trim();
  if (!r) throw new AppError('validation_failed', 'A reason is required when rejecting', { reason: 'Required' });
  const out = await withTx(async (tx) => {
    const a = await load(tx);
    if (a.decision !== 'pending') throw new AppError('invalid_state', `This request was already ${a.decision}.`);
    const err = await recordRejection(tx, ctx, a as unknown as ReviewRequestRow, r);
    if (err) return { error: err };
    await tx.query(`UPDATE approvals SET decision='rejected', reviewer_id=$2, decided_at=now(), reason=$3 WHERE id=$1`, [a.id, ctx.actor.userId, r.slice(0, 2000)]);
    await tx.query(`UPDATE schedules SET status='rejected' WHERE id=$1 AND status='pending_approval'`, [a.schedule_id]);
    await writeOutbox(tx, { workspaceId: ctx.access.workspaceId, aggregateType: 'approval', aggregateId: a.id, eventType: 'approval.decided', payload: { decision: 'rejected', postId: a.post_id } });
    await audit(tx, { workspaceId: ctx.access.workspaceId, brandId: a.brand_id, actorUserId: ctx.actor.userId, action: 'approval.rejected', resourceType: 'approval', resourceId: a.id, diff: { reason: r.slice(0, 200) }, correlationId: ctx.correlationId });
    return { result: { approval: approvalJson(await reloadApproval(tx, ctx, a.id)) } };
  });
  if ('error' in out) throw out.error;
  return out.result;
}

export async function listApprovals(ctx: Ctx, status: 'pending' | 'decided' = 'pending') {
  const db = getPool();
  const rows = await many<ApprovalRow & { title: string | null; base_text: string; due_at: Date; is_immediate: boolean; input_timezone: string; brand_name: string; revision_number: number }>(db,
    `SELECT a.*, ru.email AS requested_by_email, rv.email AS reviewer_email, p.title, r.base_text, r.revision_number, s.due_at, s.is_immediate, s.input_timezone, b.name AS brand_name
       FROM approvals a JOIN posts p ON p.id=a.post_id JOIN post_revisions r ON r.id=a.revision_id JOIN schedules s ON s.id=a.schedule_id
       JOIN brands b ON b.id=a.brand_id LEFT JOIN users ru ON ru.id=a.requested_by LEFT JOIN users rv ON rv.id=a.reviewer_id
      WHERE a.workspace_id=$1 AND ${status === 'pending' ? `a.decision='pending'` : `a.decision<>'pending'`}
        AND ($2::uuid[] IS NULL OR a.brand_id = ANY($2::uuid[]))
      ORDER BY a.requested_at DESC LIMIT 100`, [ctx.access.workspaceId, ctx.access.brandIds]);
  return {
    items: rows.map((r) => ({ ...approvalJson(r), title: r.title, excerpt: r.base_text.slice(0, 140), brand_name: r.brand_name, revision_number: r.revision_number,
      due_at: r.is_immediate ? null : r.due_at.toISOString(), publish_on_approval: r.is_immediate, input_timezone: r.input_timezone })),
  };
}

export async function approvalDetail(ctx: Ctx, approvalId: string) {
  const db = getPool();
  const a = await loadApproval(db, ctx, approvalId);
  const s = await one<ScheduleRow>(db, `SELECT s.*, r.revision_number FROM schedules s JOIN post_revisions r ON r.id=s.revision_id WHERE s.id=$1`, [a.schedule_id]);
  const rev = await one<{ revision_number: number; base_text: string; base_link: string | null; base_asset_ids: string[] }>(db, `SELECT * FROM post_revisions WHERE id=$1`, [a.revision_id]);
  const brand = await assertBrand(ctx, a.brand_id, db);
  const conns = await brandConnections(db, ctx.access.workspaceId, a.brand_id, true);
  const variants = await many<{ connection_id: string; inherit_text: boolean; rendered_text: string; link: string | null; format: string; asset_ids: string[]; buttons: unknown; options: unknown }>(db,
    `SELECT * FROM variants WHERE revision_id=$1`, [a.revision_id]);
  const assetIds = [...new Set(variants.flatMap((v) => v.asset_ids))];
  const assets = await assetsByIds(ctx, assetIds, db);
  // Diff against the previous approved/published revision of this post (AP-03).
  const prev = await maybeOne<{ revision_number: number; base_text: string; conns: string[] }>(db,
    `SELECT r.revision_number, r.base_text, (SELECT array_agg(v.connection_id::text) FROM variants v WHERE v.revision_id=r.id) conns
       FROM post_revisions r WHERE r.post_id=$1 AND r.revision_number < $2
        AND EXISTS (SELECT 1 FROM schedules s WHERE s.revision_id=r.id AND s.status IN ('active','completed','superseded'))
      ORDER BY r.revision_number DESC LIMIT 1`, [a.post_id, rev.revision_number]);
  const { connectionJson } = await import('./serialize.js');
  return {
    ...approvalJson(a), post_id: a.post_id,
    brand: { id: brand.id, name: brand.name, timezone: brand.timezone },
    schedule: scheduleJson(s),
    variants: variants.map((v) => {
      const c = conns.find((x) => x.id === v.connection_id)!;
      return { connectionId: v.connection_id, provider: c.provider, inheritText: v.inherit_text, text: v.rendered_text, link: v.link, format: v.format,
        assetIds: v.asset_ids, buttons: v.buttons, options: v.options, connection: connectionJson(c), assets: assets.filter((x) => v.asset_ids.includes(x.id)) };
    }),
    diff: {
      previous_revision_number: prev?.revision_number ?? null,
      base_text: prev ? { before: prev.base_text, after: rev.base_text } : null,
      changed_destinations: prev ? variants.map((v) => v.connection_id).filter((id) => !(prev.conns ?? []).includes(id)) : [],
    },
    can_decide: authorizeCtx(ctx, 'content.approve', { brandId: a.brand_id }).allowed && a.decision === 'pending',
  };
}

// ------------------------------------------------------------------ cancel / reschedule
function canManageSchedule(ctx: Ctx, brand: BrandRow): boolean {
  return authorizeCtx(ctx, 'content.schedule', { brandId: brand.id }).allowed;
}

export async function cancelSchedule(ctx: Ctx, scheduleId: string) {
  assertUuid(scheduleId, 'Schedule');
  return withTx(async (tx) => {
    const s = await maybeOne<ScheduleRow & { brand_id: string; workspace_id: string }>(tx, `SELECT * FROM schedules WHERE id=$1 AND workspace_id=$2 FOR UPDATE`, [scheduleId, ctx.access.workspaceId]);
    if (!s || !brandAllowed(ctx, s.brand_id)) throw notFound('Schedule');
    const brand = await assertBrand(ctx, s.brand_id, tx);
    const isRequester = s.status === 'pending_approval' && authorizeCtx(ctx, 'drafts.edit', { brandId: s.brand_id }).allowed;
    if (!canManageSchedule(ctx, brand) && !isRequester) throw new AppError('forbidden', 'You cannot cancel this schedule');
    if (!['active', 'pending_approval'].includes(s.status)) throw new AppError('invalid_state', `This schedule is already ${s.status}.`);
    await tx.query(`UPDATE schedules SET status='cancelled', cancelled_at=now(), cancelled_by=$2 WHERE id=$1`, [s.id, ctx.actor.userId]);
    await tx.query(`UPDATE approvals SET decision='invalidated', decided_at=now(), reason='Schedule cancelled' WHERE schedule_id=$1 AND decision='pending'`, [s.id]);
    const ds = await many<{ id: string; state: Parameters<typeof isCancellable>[0]; phase: string }>(tx, `SELECT id, state, phase FROM deliveries WHERE schedule_id=$1 FOR UPDATE`, [s.id]);
    const cancelled: string[] = [];
    const inFlight: string[] = [];
    for (const d of ds) {
      if (isCancellable(d.state, d.phase)) cancelled.push(d.id);
      else if (['preparing', 'publishing', 'processing'].includes(d.state)) inFlight.push(d.id);
    }
    if (cancelled.length) {
      await tx.query(`UPDATE deliveries SET state='cancelled', last_error_code='cancelled', last_error_message='Cancelled before publication', updated_at=now() WHERE id = ANY($1::uuid[])`, [cancelled]);
    }
    await writeOutbox(tx, { workspaceId: ctx.access.workspaceId, aggregateType: 'schedule', aggregateId: s.id, eventType: 'schedule.cancelled', payload: { cancelled: cancelled.length, inFlight: inFlight.length } });
    await audit(tx, { workspaceId: ctx.access.workspaceId, brandId: s.brand_id, actorUserId: ctx.actor.userId, action: 'schedule.cancelled', resourceType: 'schedule', resourceId: s.id, diff: { cancelled: cancelled.length, in_flight: inFlight.length }, correlationId: ctx.correlationId });
    const updated = await one<ScheduleRow>(tx, `SELECT s.*, r.revision_number FROM schedules s JOIN post_revisions r ON r.id=s.revision_id WHERE s.id=$1`, [s.id]);
    return {
      schedule: scheduleJson(updated),
      deliveries: (await deliveriesForSchedule(tx, s.id)).map((d) => deliveryJson(d)),
      message: inFlight.length
        ? `Cancellation requested; publication may already be in progress for ${inFlight.length} destination${inFlight.length === 1 ? '' : 's'}.`
        : 'Schedule cancelled. Nothing was published.',
    };
  });
}

export async function reschedule(ctx: Ctx, scheduleId: string, input: { input_local_time: string; timezone?: string; offset?: string; expected_generation: number; deadline_minutes?: number }, idemKey: string | null) {
  assertUuid(scheduleId, 'Schedule');
  return withTx(async (tx) => {
    const idem = await beginIdempotent(tx, { workspaceId: ctx.access.workspaceId, userId: ctx.actor.userId, action: 'schedule.reschedule', key: idemKey, body: { scheduleId, input } });
    if (idem) return { status: idem.status, body: idem.body };
    const s = await maybeOne<ScheduleRow & { brand_id: string }>(tx, `SELECT * FROM schedules WHERE id=$1 AND workspace_id=$2 FOR UPDATE`, [scheduleId, ctx.access.workspaceId]);
    if (!s || !brandAllowed(ctx, s.brand_id)) throw notFound('Schedule');
    const brand = await lockedBrand(tx, ctx, s.brand_id);
    const post = await loadPost(ctx, s.post_id, tx, true);
    if (post.schedule_generation !== input.expected_generation || s.generation !== input.expected_generation) {
      throw new AppError('conflict', 'This schedule changed since you loaded it. Reload and try again.');
    }
    if (!['active', 'pending_approval'].includes(s.status)) throw new AppError('invalid_state', `This schedule is ${s.status} and cannot be moved.`);
    const needsApproval = await approvalRequiredFor(tx, ctx.access.workspaceId, s.brand_id);
    if (!needsApproval && !canManageSchedule(ctx, brand)) throw new AppError('forbidden', 'You cannot reschedule posts for this brand');
    if (needsApproval && !authorizeCtx(ctx, 'drafts.edit', { brandId: s.brand_id }).allowed && !authorizeCtx(ctx, 'approvals.decide', { brandId: s.brand_id }).allowed) throw new AppError('forbidden', 'You cannot reschedule posts for this brand');
    const started = await one<{ n: number }>(tx, `SELECT count(*)::int n FROM deliveries WHERE schedule_id=$1 AND state NOT IN ('scheduled','retry_wait','blocked','paused','cancelled')`, [s.id]);
    if (started.n > 0) throw new AppError('invalid_state', 'Publishing has already started for at least one destination. Cancel remaining destinations instead.');
    const time = resolveScheduleTime({ input_local_time: input.input_local_time, timezone: input.timezone ?? s.input_timezone, offset: input.offset,
      deadline_minutes: input.deadline_minutes ?? Math.round((s.publish_before.getTime() - s.due_at.getTime()) / 60_000) }, brand, 'timed');
    const variants = await many<{ id: string; connection_id: string }>(tx, `SELECT id, connection_id FROM variants WHERE revision_id=$1`, [s.revision_id]);
    await supersedeLive(tx, post.id);
    const gen = await one<{ schedule_generation: number }>(tx, `UPDATE posts SET schedule_generation=schedule_generation+1 WHERE id=$1 RETURNING schedule_generation`, [post.id]);
    const ids = variants.map((v) => v.connection_id);
    const fingerprint = scheduleFingerprint({ revisionId: s.revision_id, connectionIds: ids, dueAt: time.dueAt, publishBefore: time.publishBefore, immediate: false });
    const schedule = await one<ScheduleRow & { brand_id: string }>(tx,
      `INSERT INTO schedules(workspace_id, brand_id, post_id, revision_id, generation, due_at, input_timezone, input_local_time, input_offset, publish_before, is_immediate, status, fingerprint, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,false,$11,$12,$13) RETURNING *`,
      [ctx.access.workspaceId, s.brand_id, post.id, s.revision_id, gen.schedule_generation, time.dueAt, time.timezone, time.localTime, time.offset, time.publishBefore,
        needsApproval ? 'pending_approval' : 'active', fingerprint, ctx.actor.userId]);
    let approval: ApprovalRow | null = null;
    if (needsApproval) {
      const request = await createReviewRequest(tx, ctx, { postId: post.id, brandId: s.brand_id, revisionId: s.revision_id, scheduleId: schedule.id, scheduleGeneration: schedule.generation, fingerprint });
      approval = await one<ApprovalRow>(tx, `SELECT * FROM approvals WHERE id=$1`, [request.id]);
      await writeOutbox(tx, { workspaceId: ctx.access.workspaceId, aggregateType: 'approval', aggregateId: approval.id, eventType: 'approval.requested', payload: { postId: post.id, brandId: s.brand_id } });
    } else {
      const conns = await brandConnections(tx, ctx.access.workspaceId, s.brand_id, true);
      await insertDeliveries(tx, ctx, schedule, variants.map((v) => ({ id: v.id, connectionId: v.connection_id })), conns);
      await recordPublicationAuthority(tx, ctx, { scheduleId: schedule.id, postId: post.id, brandId: s.brand_id, revisionId: s.revision_id, connectionIds: ids,
        basis: 'scheduler', permission: 'content.schedule' });
    }
    await audit(tx, { workspaceId: ctx.access.workspaceId, brandId: s.brand_id, actorUserId: ctx.actor.userId, action: 'schedule.rescheduled', resourceType: 'schedule', resourceId: schedule.id,
      diff: { from: s.due_at.toISOString(), to: time.dueAt.toISOString(), generation: schedule.generation, approval_required: needsApproval }, correlationId: ctx.correlationId });
    const body = { schedule: scheduleJson(schedule), deliveries: (await deliveriesForSchedule(tx, schedule.id)).map((d) => deliveryJson(d)), ...(approval ? { approval: approvalJson(approval) } : {}) };
    await completeIdempotent(tx, { workspaceId: ctx.access.workspaceId, action: 'schedule.reschedule', key: idemKey!, status: 202, body });
    return { status: 202, body };
  });
}
