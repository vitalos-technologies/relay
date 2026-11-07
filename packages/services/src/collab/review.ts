// Guest / client review portal (stream C). Authenticated, resource-scoped: a guest (expiring guest grant on the
// brand) sees ONLY review requests of posts explicitly shared with them — the exact outgoing variants and media
// previews of the submitted revision, shared comments and stage progress. Never the working draft, library,
// account details, internal notes, other posts or internal reviewer identities.
import { AppError, notFound } from '@social-lite/core';
import { getPool, many, maybeOne, withTx, type Queryable } from '@social-lite/db';
import type { Ctx } from '../context.js';
import { audit } from '../audit.js';
import { writeOutbox } from '../outbox.js';
import { authorize, loadUserAuthz } from '../authz.js';
import { assertUuid, authorizeCtx, requireAction } from '../tenancy.js';
import { assetsByIds } from '../media/assets.js';
import { loadPost } from '../posts/service.js';
import { decideApproval, decideRejection } from '../posts/scheduling.js';
import type { ApprovalRow } from '../posts/serialize.js';
import { loadPolicy, reviewState, type ReviewRequestRow } from '../posts/approval-policy.js';
import { callerEntitled, isGuestOnly, staffAllowed } from './access.js';
import { commentJson, commentsFor, insertComment } from './comments.js';
import { deliverNotification } from './notifications.js';

// ------------------------------------------------------------------ staff side: sharing
async function activeGuestOnBrand(db: Queryable, workspaceId: string, userId: string, brandId: string): Promise<boolean> {
  const s = await loadUserAuthz(userId, workspaceId, null, db);
  if (s.subject.status !== 'active') return false;
  const d = authorize(s, 'content.read', { brandId });
  return d.allowed && d.sources.some((x) => x.role === 'guest');
}

export async function listReviewShares(ctx: Ctx, postId: string) {
  requireAction(ctx, 'content.read');
  const db = getPool();
  const post = await loadPost(ctx, postId, db);
  const shares = await many<{ user_id: string; email: string; name: string | null; created_at: Date; shared_by_email: string | null }>(db,
    `SELECT rs.user_id, u.email, u.name, rs.created_at, sb.email AS shared_by_email FROM review_shares rs JOIN users u ON u.id=rs.user_id
       LEFT JOIN users sb ON sb.id=rs.shared_by WHERE rs.post_id=$1 AND rs.revoked_at IS NULL ORDER BY rs.created_at`, [post.id]);
  // Candidates: workspace members holding a live (expiring) guest grant on this brand.
  const guests = await many<{ user_id: string; email: string; name: string | null; expires_at: Date }>(db,
    `SELECT DISTINCT ON (g.user_id) g.user_id, u.email, u.name, g.expires_at FROM scoped_role_grants g JOIN users u ON u.id=g.user_id
       JOIN memberships m ON m.workspace_id=g.workspace_id AND m.user_id=g.user_id AND m.status='active' AND m.removed_at IS NULL
      WHERE g.workspace_id=$1 AND g.role='guest' AND g.brand_id=$2 AND g.revoked_at IS NULL AND g.expires_at > now()
      ORDER BY g.user_id, g.expires_at DESC`, [ctx.access.workspaceId, post.brand_id]);
  return {
    items: shares.map((s) => ({ user_id: s.user_id, email: s.email, name: s.name, shared_at: s.created_at.toISOString(), shared_by_email: s.shared_by_email,
      access_expires_at: guests.find((g) => g.user_id === s.user_id)?.expires_at.toISOString() ?? null })),
    candidates: guests.filter((g) => !shares.some((s) => s.user_id === g.user_id)).map((g) => ({ user_id: g.user_id, email: g.email, name: g.name, access_expires_at: g.expires_at.toISOString() })),
    can_share: authorizeCtx(ctx, 'content.submit', { brandId: post.brand_id }).allowed,
  };
}

/** Share a post's review requests with a guest of this brand (explicit, audited, revocable). */
export async function shareReview(ctx: Ctx, postId: string, guestUserId: string) {
  assertUuid(guestUserId, 'Guest');
  return withTx(async (tx) => {
    const post = await loadPost(ctx, postId, tx);
    requireAction(ctx, 'content.submit', { brandId: post.brand_id, message: 'You cannot share reviews for this brand' });
    if (!(await activeGuestOnBrand(tx, ctx.access.workspaceId, guestUserId, post.brand_id))) {
      throw new AppError('validation_failed', 'Invite this person as a guest of the brand first', { user_id: 'Not a guest of this brand' });
    }
    const r = await maybeOne<{ id: string }>(tx,
      `INSERT INTO review_shares(workspace_id, post_id, user_id, shared_by) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING id`,
      [ctx.access.workspaceId, post.id, guestUserId, ctx.actor.userId]);
    if (r) {
      await audit(tx, { workspaceId: ctx.access.workspaceId, brandId: post.brand_id, actorUserId: ctx.actor.userId, action: 'review.shared', resourceType: 'post', resourceId: post.id,
        diff: { guest_user_id: guestUserId }, correlationId: ctx.correlationId });
      await writeOutbox(tx, { workspaceId: ctx.access.workspaceId, aggregateType: 'post', aggregateId: post.id, eventType: 'review.shared', payload: { userId: guestUserId, brandId: post.brand_id } });
    }
    return { ok: true, created: !!r };
  });
}

export async function revokeReviewShare(ctx: Ctx, postId: string, guestUserId: string) {
  assertUuid(guestUserId, 'Guest');
  return withTx(async (tx) => {
    const post = await loadPost(ctx, postId, tx);
    requireAction(ctx, 'content.submit', { brandId: post.brand_id, message: 'You cannot change review sharing for this brand' });
    const r = await tx.query(`UPDATE review_shares SET revoked_at=now(), revoked_by=$3 WHERE post_id=$1 AND user_id=$2 AND revoked_at IS NULL`, [post.id, guestUserId, ctx.actor.userId]);
    if (r.rowCount) {
      await audit(tx, { workspaceId: ctx.access.workspaceId, brandId: post.brand_id, actorUserId: ctx.actor.userId, action: 'review.share_revoked', resourceType: 'post', resourceId: post.id,
        diff: { guest_user_id: guestUserId }, correlationId: ctx.correlationId });
    }
    return { ok: true };
  });
}

/** Outbox handler: tell the guest a review is waiting (if still entitled at send time). */
export async function onReviewShared(db: Queryable, evt: { workspace_id: string; aggregate_id: string; payload: Record<string, unknown> }) {
  const userId = String(evt.payload.userId ?? '');
  const brandId = String(evt.payload.brandId ?? '');
  const a = await maybeOne<{ id: string }>(db, `SELECT id FROM approvals WHERE post_id=$1 AND decision='pending' ORDER BY requested_at DESC LIMIT 1`, [evt.aggregate_id]);
  if (!a || !userId || !brandId) return;
  await deliverNotification(db, { workspaceId: evt.workspace_id, userId, event: 'review_requested', kind: 'approval.requested', title: 'A post is ready for your review',
    referenceType: 'review', referenceId: a.id, dedupeKey: `review:${a.id}:share`, requirement: { brandId, permission: 'review.shared', postId: evt.aggregate_id } });
}

// ------------------------------------------------------------------ guest side
export async function reviewMe(ctx: Ctx) {
  return { guest_only: isGuestOnly(ctx.access.authz), user: { email: ctx.actor.email, name: ctx.actor.name } };
}

/** Load a review request through the caller's share (or staff access). Anything else is invisible (404). */
async function loadSharedApproval(db: Queryable, ctx: Ctx, approvalId: string, lock = false): Promise<ApprovalRow & ReviewRequestRow> {
  assertUuid(approvalId, 'Review');
  const a = await maybeOne<ApprovalRow & ReviewRequestRow>(db,
    `SELECT a.*, ru.email AS requested_by_email, rv.email AS reviewer_email FROM approvals a
       LEFT JOIN users ru ON ru.id=a.requested_by LEFT JOIN users rv ON rv.id=a.reviewer_id
      WHERE a.id=$1 AND a.workspace_id=$2 ${lock ? 'FOR UPDATE OF a' : ''}`, [approvalId, ctx.access.workspaceId]);
  if (!a || !(await callerEntitled(ctx, db, { brandId: a.brand_id, permission: 'review.shared', postId: a.post_id }))) throw notFound('Review');
  return a;
}

export async function listMyReviews(ctx: Ctx) {
  const db = getPool();
  const rows = await many<{ id: string; post_id: string; brand_id: string; brand_name: string; decision: string; base_text: string; requested_at: Date;
    due_at: Date | null; schedule_due: Date; is_immediate: boolean; input_timezone: string; current_stage: number; stage_count: number; providers: string[] | null }>(db,
    `SELECT DISTINCT ON (a.post_id) a.id, a.post_id, a.brand_id, b.name AS brand_name, a.decision, r.base_text, a.requested_at, a.due_at,
            s.due_at AS schedule_due, s.is_immediate, s.input_timezone, a.current_stage, a.stage_count,
            (SELECT array_agg(c.provider::text ORDER BY c.provider) FROM variants v JOIN connections c ON c.id=v.connection_id WHERE v.revision_id=a.revision_id) AS providers
       FROM review_shares rs JOIN approvals a ON a.post_id=rs.post_id AND a.workspace_id=rs.workspace_id
       JOIN post_revisions r ON r.id=a.revision_id JOIN schedules s ON s.id=a.schedule_id JOIN brands b ON b.id=a.brand_id
      WHERE rs.workspace_id=$1 AND rs.user_id=$2 AND rs.revoked_at IS NULL AND a.decision <> 'invalidated'
      ORDER BY a.post_id, a.requested_at DESC LIMIT 200`, [ctx.access.workspaceId, ctx.actor.userId]);
  const visible = [];
  for (const r of rows) {
    // the guest grant on the brand must still be live (expiry/revocation take effect immediately)
    if (!(await callerEntitled(ctx, db, { brandId: r.brand_id, permission: 'review.shared', postId: r.post_id }))) continue;
    visible.push({ id: r.id, brand: { id: r.brand_id, name: r.brand_name }, decision: r.decision, excerpt: r.base_text.replace(/\s+/g, ' ').slice(0, 140),
      requested_at: r.requested_at.toISOString(), review_due_at: r.due_at?.toISOString() ?? null,
      publish_at: r.is_immediate ? null : r.schedule_due.toISOString(), input_timezone: r.input_timezone,
      current_stage: r.current_stage, stage_count: r.stage_count, providers: r.providers ?? [] });
  }
  visible.sort((a, b) => (a.decision === 'pending' ? 0 : 1) - (b.decision === 'pending' ? 0 : 1) || b.requested_at.localeCompare(a.requested_at));
  return { items: visible };
}

export async function getReview(ctx: Ctx, approvalId: string) {
  const db = getPool();
  const a = await loadSharedApproval(db, ctx, approvalId);
  const brand = await maybeOne<{ id: string; name: string; timezone: string }>(db, `SELECT id, name, timezone FROM brands WHERE id=$1`, [a.brand_id]);
  const s = await maybeOne<{ due_at: Date; publish_before: Date; is_immediate: boolean; input_timezone: string; status: string }>(db,
    `SELECT due_at, publish_before, is_immediate, input_timezone, status FROM schedules WHERE id=$1`, [a.schedule_id]);
  const variants = await many<{ connection_id: string; rendered_text: string; link: string | null; format: string; asset_ids: string[]; buttons: unknown; options: unknown; inherit_text: boolean;
    provider: string; display_name: string; username: string | null }>(db,
    `SELECT v.connection_id, v.rendered_text, v.link, v.format, v.asset_ids, v.buttons, v.options, v.inherit_text, c.provider, c.display_name, c.username
       FROM variants v JOIN connections c ON c.id=v.connection_id WHERE v.revision_id=$1 ORDER BY c.provider, c.display_name`, [a.revision_id]);
  // Media previews for exactly these assets (short-lived signed URLs). The brand is narrowed for this call only.
  const ids = [...new Set(variants.flatMap((v) => v.asset_ids))];
  const assets = (await assetsByIds({ ...ctx, access: { ...ctx.access, brandIds: [a.brand_id] } }, ids, db))
    .map((x) => ({ id: x.id, mime: x.mime, width: x.width, height: x.height, alt_text: x.alt_text, preview_url: x.preview_url, thumb_url: x.thumb_url,
      media_kind: x.media_kind ?? 'image', duration_ms: x.duration_ms ?? null, status: x.status, original_filename: null }));
  const staff = !!ctx.access.authz && staffAllowed(ctx.access.authz, 'content.read', a.brand_id);
  const comments = await commentsFor(db, ctx.access.workspaceId, a.post_id, ['shared']);
  const state = await reviewState(db, ctx, a, { guestView: !staff });
  const policy = await loadPolicy(db, a.workspace_id, a.brand_id);
  return {
    id: a.id, decision: a.decision, fingerprint: a.fingerprint, reason: a.decision === 'rejected' ? a.reason : null, requested_at: new Date(a.requested_at).toISOString(),
    brand: brand ? { id: brand.id, name: brand.name } : null,
    schedule: s ? { publish_at: s.is_immediate ? null : s.due_at.toISOString(), is_immediate: s.is_immediate, input_timezone: s.input_timezone } : null,
    variants: variants.map((v) => ({ connectionId: v.connection_id, provider: v.provider, text: v.rendered_text, link: v.link, format: v.format, assetIds: v.asset_ids,
      buttons: v.buttons ?? [], options: v.options ?? {}, inheritText: v.inherit_text,
      connection: { id: v.connection_id, provider: v.provider, display_name: v.display_name, username: v.username } })),
    assets,
    comments: comments.map((c) => commentJson(c, { viewerId: ctx.actor.userId, guestView: !staff })),
    review: { stages: state.stages, current_stage: state.current_stage, stage_count: state.stage_count, me: state.me, decisions: state.decisions, due_at: state.due_at },
    can: { approve: state.me.eligible, comment: authorizeCtx(ctx, 'comments.shared', { brandId: a.brand_id }).allowed && a.decision === 'pending' },
    policy_generation: policy.generation,
  };
}

export async function reviewApprove(ctx: Ctx, approvalId: string, expectedFingerprint: string) {
  requireAction(ctx, 'content.approve');
  const r = await decideApproval(ctx, (tx) => loadSharedApproval(tx, ctx, approvalId, true), expectedFingerprint);
  return { decision: r.approval.decision, stage: r.stage ?? null };
}

export async function reviewReject(ctx: Ctx, approvalId: string, reason: string) {
  requireAction(ctx, 'content.approve');
  const r = await decideRejection(ctx, (tx) => loadSharedApproval(tx, ctx, approvalId, true), reason);
  return { decision: r.approval.decision };
}

export async function addReviewComment(ctx: Ctx, approvalId: string, body: string) {
  requireAction(ctx, 'comments.shared');
  return withTx(async (tx) => {
    const a = await loadSharedApproval(tx, ctx, approvalId);
    requireAction(ctx, 'comments.shared', { brandId: a.brand_id });
    if (a.decision !== 'pending') throw new AppError('invalid_state', 'This review is closed.');
    const c = await insertComment(tx, ctx, { postId: a.post_id, brandId: a.brand_id, approvalId: a.id, visibility: 'shared', body, mentionUserIds: [] });
    const staff = !!ctx.access.authz && staffAllowed(ctx.access.authz, 'content.read', a.brand_id);
    const [row] = (await commentsFor(tx, ctx.access.workspaceId, a.post_id, ['shared'])).filter((x) => x.id === c.id);
    return commentJson(row!, { viewerId: ctx.actor.userId, guestView: !staff });
  });
}
