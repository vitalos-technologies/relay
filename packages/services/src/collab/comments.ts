// Comments (stream C): two explicit types. 'internal' notes are visible only to staff holding comments.internal
// on the brand; 'shared' comments are also visible to guests the post's review was shared with. Guests can never
// list, receive notifications about, or export internal notes. Mentions are checked at SEND time.
import { AppError, notFound } from '@social-lite/core';
import { getPool, many, maybeOne, one, withTx, type Queryable } from '@social-lite/db';
import type { Ctx } from '../context.js';
import { audit } from '../audit.js';
import { writeOutbox } from '../outbox.js';
import { loadUserAuthz } from '../authz.js';
import { assertUuid, authorizeCtx, isUuid, requireAction } from '../tenancy.js';
import { loadPost } from '../posts/service.js';
import { staffAllowed } from './access.js';
import { deliverNotification } from './notifications.js';

export type Visibility = 'internal' | 'shared';
const MAX_BODY = 5000;
const MAX_MENTIONS = 20;

export interface CommentRow {
  id: string; post_id: string; brand_id: string; approval_id: string | null; visibility: Visibility; author_id: string | null;
  author_email: string | null; author_name: string | null; body: string; created_at: Date; deleted_at: Date | null; mentions: string[] | null;
}

export function commentJson(c: CommentRow, opts: { viewerId: string; guestView?: boolean }) {
  return {
    id: c.id, post_id: c.post_id, approval_id: c.approval_id, visibility: c.visibility,
    author: c.author_id ? { id: c.author_id, name: c.author_name, email: opts.guestView ? null : c.author_email } : null,
    body: c.body, created_at: c.created_at.toISOString(), mine: c.author_id === opts.viewerId,
    mentions: opts.guestView ? [] : (c.mentions ?? []),
  };
}

export async function commentsFor(db: Queryable, workspaceId: string, postId: string, visibilities: Visibility[]): Promise<CommentRow[]> {
  return many<CommentRow>(db,
    `SELECT c.id, c.post_id, c.brand_id, c.approval_id, c.visibility, c.author_id, u.email AS author_email, u.name AS author_name, c.body, c.created_at, c.deleted_at,
            (SELECT array_agg(m.user_id::text) FROM comment_mentions m WHERE m.comment_id=c.id) AS mentions
       FROM comments c LEFT JOIN users u ON u.id=c.author_id
      WHERE c.workspace_id=$1 AND c.post_id=$2 AND c.deleted_at IS NULL AND c.visibility = ANY($3::text[])
      ORDER BY c.created_at, c.id LIMIT 500`, [workspaceId, postId, visibilities]);
}

/** Staff view of a post's comments: internal notes only with comments.internal on the brand. */
export async function listComments(ctx: Ctx, postId: string) {
  requireAction(ctx, 'content.read');
  const db = getPool();
  const post = await loadPost(ctx, postId, db);
  const canInternal = authorizeCtx(ctx, 'comments.internal', { brandId: post.brand_id }).allowed;
  const canShared = authorizeCtx(ctx, 'comments.shared', { brandId: post.brand_id }).allowed;
  const rows = await commentsFor(db, ctx.access.workspaceId, post.id, canInternal ? ['internal', 'shared'] : ['shared']);
  return { items: rows.map((r) => commentJson(r, { viewerId: ctx.actor.userId })), can: { internal: canInternal, shared: canShared } };
}

/** Insert a comment + mentions + outbox event (mention notifications are produced asynchronously, at send time). */
export async function insertComment(tx: Queryable, ctx: Ctx, p: { postId: string; brandId: string; approvalId: string | null; visibility: Visibility; body: string; mentionUserIds: string[] }) {
  const body = (p.body ?? '').trim();
  if (!body || body.length > MAX_BODY) throw new AppError('validation_failed', `Comments are 1-${MAX_BODY} characters`, { body: 'Required' });
  const mentions = [...new Set(p.mentionUserIds.filter(isUuid))].filter((u) => u !== ctx.actor.userId).slice(0, MAX_MENTIONS);
  if (p.approvalId) {
    const ok = await maybeOne(tx, `SELECT 1 FROM approvals WHERE id=$1 AND post_id=$2 AND workspace_id=$3`, [p.approvalId, p.postId, ctx.access.workspaceId]);
    if (!ok) throw notFound('Review');
  }
  const c = await one<{ id: string }>(tx,
    `INSERT INTO comments(workspace_id, brand_id, post_id, approval_id, visibility, author_id, body) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [ctx.access.workspaceId, p.brandId, p.postId, p.approvalId, p.visibility, ctx.actor.userId, body]);
  if (mentions.length) {
    // Only workspace members can be mentioned; whether they may SEE it is decided when the notification is sent.
    const members = await many<{ user_id: string }>(tx, `SELECT user_id FROM memberships WHERE workspace_id=$1 AND user_id = ANY($2::uuid[])`, [ctx.access.workspaceId, mentions]);
    for (const m of members) {
      await tx.query(`INSERT INTO comment_mentions(workspace_id, comment_id, user_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [ctx.access.workspaceId, c.id, m.user_id]);
    }
  }
  await writeOutbox(tx, { workspaceId: ctx.access.workspaceId, aggregateType: 'comment', aggregateId: c.id, eventType: 'comment.created', payload: { postId: p.postId, brandId: p.brandId } });
  await audit(tx, { workspaceId: ctx.access.workspaceId, brandId: p.brandId, actorUserId: ctx.actor.userId, action: 'comment.created', resourceType: 'comment', resourceId: c.id,
    diff: { visibility: p.visibility, post_id: p.postId, mentions: mentions.length }, correlationId: ctx.correlationId });
  return c;
}

export async function createComment(ctx: Ctx, postId: string, input: { body: string; visibility: Visibility; mention_user_ids?: string[]; approval_id?: string | null }) {
  if (input.visibility !== 'internal' && input.visibility !== 'shared') throw new AppError('validation_failed', 'Choose internal or shared', { visibility: 'Required' });
  requireAction(ctx, input.visibility === 'internal' ? 'comments.internal' : 'comments.shared');
  return withTx(async (tx) => {
    const post = await loadPost(ctx, postId, tx);
    requireAction(ctx, input.visibility === 'internal' ? 'comments.internal' : 'comments.shared', { brandId: post.brand_id });
    const c = await insertComment(tx, ctx, { postId: post.id, brandId: post.brand_id, approvalId: input.approval_id ?? null, visibility: input.visibility, body: input.body, mentionUserIds: input.mention_user_ids ?? [] });
    const [row] = await commentsFor(tx, ctx.access.workspaceId, post.id, [input.visibility]).then((rs) => rs.filter((r) => r.id === c.id));
    return commentJson(row!, { viewerId: ctx.actor.userId });
  });
}

export async function deleteComment(ctx: Ctx, commentId: string) {
  assertUuid(commentId, 'Comment');
  return withTx(async (tx) => {
    const c = await maybeOne<{ id: string; post_id: string; brand_id: string; author_id: string | null; visibility: Visibility }>(tx,
      `SELECT id, post_id, brand_id, author_id, visibility FROM comments WHERE id=$1 AND workspace_id=$2 AND deleted_at IS NULL FOR UPDATE`, [commentId, ctx.access.workspaceId]);
    if (!c) throw notFound('Comment');
    await loadPost(ctx, c.post_id, tx); // staff visibility of the post
    if (c.visibility === 'internal' && !authorizeCtx(ctx, 'comments.internal', { brandId: c.brand_id }).allowed) throw notFound('Comment');
    if (c.author_id !== ctx.actor.userId && !authorizeCtx(ctx, 'brands.manage', { brandId: c.brand_id }).allowed) throw new AppError('forbidden', 'Only the author can delete this comment');
    await tx.query(`UPDATE comments SET deleted_at=now() WHERE id=$1`, [c.id]);
    await audit(tx, { workspaceId: ctx.access.workspaceId, brandId: c.brand_id, actorUserId: ctx.actor.userId, action: 'comment.deleted', resourceType: 'comment', resourceId: c.id, correlationId: ctx.correlationId });
    return { ok: true };
  });
}

/** People who can be mentioned on this post for this visibility (entitled NOW; re-checked again at send). */
export async function mentionCandidates(ctx: Ctx, postId: string, visibility: Visibility) {
  requireAction(ctx, 'content.read');
  const db = getPool();
  const post = await loadPost(ctx, postId, db);
  const members = await many<{ user_id: string; email: string; name: string | null }>(db,
    `SELECT m.user_id, u.email, u.name FROM memberships m JOIN users u ON u.id=m.user_id
      WHERE m.workspace_id=$1 AND m.status='active' AND m.removed_at IS NULL ORDER BY u.name NULLS LAST, u.email LIMIT 300`, [ctx.access.workspaceId]);
  const shared = visibility === 'shared'
    ? new Set((await many<{ user_id: string }>(db, `SELECT user_id FROM review_shares WHERE post_id=$1 AND revoked_at IS NULL`, [post.id])).map((r) => r.user_id)) : new Set<string>();
  const out: Array<{ id: string; email: string; name: string | null; guest: boolean }> = [];
  for (const m of members) {
    if (m.user_id === ctx.actor.userId) continue;
    const s = await loadUserAuthz(m.user_id, ctx.access.workspaceId, null, db);
    if (staffAllowed(s, visibility === 'internal' ? 'comments.internal' : 'content.read', post.brand_id)) out.push({ id: m.user_id, email: m.email, name: m.name, guest: false });
    else if (visibility === 'shared' && shared.has(m.user_id)) out.push({ id: m.user_id, email: m.email, name: m.name, guest: true });
  }
  return { items: out };
}

/** Outbox handler: notify mentioned people who are entitled at send time; record why others were skipped. */
export async function onCommentCreated(db: Queryable, commentId: string): Promise<void> {
  const c = await maybeOne<{ id: string; workspace_id: string; brand_id: string; post_id: string; approval_id: string | null; visibility: Visibility; author_id: string | null; deleted_at: Date | null }>(db,
    `SELECT id, workspace_id, brand_id, post_id, approval_id, visibility, author_id, deleted_at FROM comments WHERE id=$1`, [commentId]);
  if (!c || c.deleted_at) return;
  const mentions = await many<{ user_id: string }>(db, `SELECT user_id FROM comment_mentions WHERE comment_id=$1 AND notified_at IS NULL AND skipped_reason IS NULL`, [c.id]);
  const latestReview = await maybeOne<{ id: string }>(db, `SELECT id FROM approvals WHERE post_id=$1 ORDER BY requested_at DESC LIMIT 1`, [c.post_id]);
  for (const m of mentions) {
    const s = await loadUserAuthz(m.user_id, c.workspace_id, null, db);
    const staff = staffAllowed(s, 'content.read', c.brand_id);
    const r = await deliverNotification(db, {
      workspaceId: c.workspace_id, userId: m.user_id, event: 'mention', kind: 'mention',
      title: c.visibility === 'internal' ? 'You were mentioned in an internal note' : 'You were mentioned in a comment',
      referenceType: staff ? 'post' : 'review', referenceId: staff ? c.post_id : (c.approval_id ?? latestReview?.id ?? c.post_id),
      dedupeKey: `mention:${c.id}`,
      requirement: c.visibility === 'internal' ? { brandId: c.brand_id, permission: 'comments.internal' } : { brandId: c.brand_id, permission: 'review.shared', postId: c.post_id },
    });
    await db.query(`UPDATE comment_mentions SET notified_at = CASE WHEN $3::text IN ('created','duplicate','muted') THEN now() END, skipped_reason = CASE WHEN $3::text = 'not_entitled' THEN 'not_entitled' END
                     WHERE comment_id=$1 AND user_id=$2`, [c.id, m.user_id, r]);
  }
  // A guest's shared comment is actionable for the person who requested the review.
  if (c.visibility === 'shared' && c.author_id) {
    const author = await loadUserAuthz(c.author_id, c.workspace_id, null, db);
    if (!staffAllowed(author, 'content.read', c.brand_id)) {
      const req = await maybeOne<{ id: string; requested_by: string | null; assignee_user_id: string | null }>(db,
        `SELECT id, requested_by, assignee_user_id FROM approvals WHERE post_id=$1 ORDER BY requested_at DESC LIMIT 1`, [c.post_id]);
      for (const uid of new Set([req?.requested_by, req?.assignee_user_id].filter((x): x is string => !!x))) {
        await deliverNotification(db, { workspaceId: c.workspace_id, userId: uid, event: 'comment', kind: 'comment.client', title: 'A client commented on a review',
          referenceType: 'approval', referenceId: req!.id, dedupeKey: `comment:${c.id}`, requirement: { brandId: c.brand_id, permission: 'content.read' } });
      }
    }
  }
}
