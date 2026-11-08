// Discussion threads (V2 stream C comments, completed). Every comment belongs to a thread whose visibility is explicit:
//  - 'internal' threads: staff holding comments.internal on the brand only. Never listed for guests, never in a guest's
//    notification, email, export or realtime event (enforced here, by audience filtering, and by a DB trigger that refuses
//    a comment whose visibility differs from its thread).
//  - 'shared' threads: staff + guests the post's review was shared with.
// Replies, resolve/reopen, edit history (comment_edits), tombstones, unread state, anchors (draft version + selected text
// or media, flagged outdated after later edits), revision link (review requests). Visibility only changes through
// setThreadVisibility (explicit, confirmed, audited). Commenting never approves anything.
// Mentions are identity tokens `@[uuid]`; people are notified asynchronously (outbox) once per comment, only if entitled
// at send time; an edit only notifies newly added people. Bodies are untrusted text (sanitised, rendered as text).
import { createHash } from 'node:crypto';
import {
  AppError, COMMENT_MAX, MENTION_MAX, anchorStatus, mentionIds, notFound, parseAnchor, sanitizeCommentBody, type DraftContent, type ThreadAnchor,
} from '@social-lite/core';
import { getPool, many, maybeOne, one, withTx, type Queryable } from '@social-lite/db';
import type { Ctx } from '../context.js';
import { audit } from '../audit.js';
import { writeOutbox } from '../outbox.js';
import { authorize, loadUserAuthz } from '../authz.js';
import { enforceRateLimit } from '../ratelimit.js';
import { assertUuid, authorizeCtx, brandAllowed, isUuid, requireAction } from '../tenancy.js';
import { loadPost } from '../posts/service.js';
import { callerEntitled, staffAllowed } from './access.js';
import { deliverNotification } from './notifications.js';
import { currentCursor, emitCollabEvent } from './events.js';
import { collabSettings } from './settings.js';

export type Visibility = 'internal' | 'shared';
const TOMBSTONE = '—';
const THREAD_PAGE = 20;
const REPLIES_INLINE = 30;
const COMMENT_RATE = { capacity: 30, refillPerSecond: 30 / 60 };       // per user: 30 burst, 30/min
const MENTION_RATE = { capacity: 100, refillPerSecond: 100 / 3600 };   // per user: 100 mentions/hour

export interface ThreadRow {
  id: string; workspace_id: string; brand_id: string; post_id: string; approval_id: string | null; visibility: Visibility; created_by: string | null;
  created_at: Date; anchor_version: number | null; anchor_revision_id: string | null; anchor: ThreadAnchor | null; resolved_at: Date | null;
  resolved_by: string | null; last_activity_at: Date; last_actor_id: string | null;
}

export interface CommentRow {
  id: string; thread_id: string; post_id: string; brand_id: string; approval_id: string | null; visibility: Visibility; author_id: string | null;
  author_email: string | null; author_name: string | null; body: string; created_at: Date; edited_at: Date | null; deleted_at: Date | null;
  mentions: string[] | null;
}

export interface Viewer { viewerId: string; guestView?: boolean; moderate?: boolean }

const COMMENT_SELECT = `c.id, c.thread_id, c.post_id, c.brand_id, c.approval_id, c.visibility, c.author_id, u.email AS author_email, u.name AS author_name,
  c.body, c.created_at, c.edited_at, c.deleted_at,
  (SELECT array_agg(m.user_id::text) FROM comment_mentions m WHERE m.comment_id=c.id AND m.removed_at IS NULL) AS mentions`;

export function commentJson(c: CommentRow, opts: Viewer) {
  const mine = !!c.author_id && c.author_id === opts.viewerId;
  const deleted = !!c.deleted_at;
  return {
    id: c.id, thread_id: c.thread_id, post_id: c.post_id, approval_id: c.approval_id, visibility: c.visibility,
    author: c.author_id ? { id: c.author_id, name: c.author_name, email: opts.guestView ? null : c.author_email } : null,
    body: deleted ? null : c.body, deleted, edited: !!c.edited_at && !deleted, edited_at: deleted ? null : c.edited_at?.toISOString() ?? null,
    created_at: c.created_at.toISOString(), mine,
    can_edit: mine && !deleted, can_delete: !deleted && (mine || !!opts.moderate),
    mentions: opts.guestView || deleted ? [] : (c.mentions ?? []),
  };
}
export type CommentDto = ReturnType<typeof commentJson>;

/** Legacy flat list (V2): live comments of a post for the given visibilities, oldest first. */
export async function commentsFor(db: Queryable, workspaceId: string, postId: string, visibilities: Visibility[]): Promise<CommentRow[]> {
  return many<CommentRow>(db,
    `SELECT ${COMMENT_SELECT} FROM comments c LEFT JOIN users u ON u.id=c.author_id
      WHERE c.workspace_id=$1 AND c.post_id=$2 AND c.deleted_at IS NULL AND c.visibility = ANY($3::text[])
      ORDER BY c.created_at, c.id LIMIT 500`, [workspaceId, postId, visibilities]);
}

// ------------------------------------------------------------------ access
interface Caps { internal: boolean; shared: boolean; moderate: boolean; staff: boolean }

function staffCaps(ctx: Ctx, brandId: string): Caps {
  const staff = ctx.access.authz ? staffAllowed(ctx.access.authz, 'content.read', brandId) : brandAllowed(ctx, brandId);
  return {
    staff,
    internal: staff && authorizeCtx(ctx, 'comments.internal', { brandId }).allowed,
    shared: staff && authorizeCtx(ctx, 'comments.shared', { brandId }).allowed,
    moderate: staff && authorizeCtx(ctx, 'brands.manage', { brandId }).allowed,
  };
}

export interface ThreadAccess { thread: ThreadRow; role: 'staff' | 'guest'; caps: Caps; canPost: boolean }

/**
 * Load a thread the caller may see: staff (brand visible + content.read; internal threads need comments.internal) or a
 * guest the post's review was shared with (shared threads only). Everything else is 404 — existence is not revealed.
 */
export async function loadThreadForCaller(ctx: Ctx, db: Queryable, threadId: string, lock = false): Promise<ThreadAccess> {
  assertUuid(threadId, 'Thread');
  const t = await maybeOne<ThreadRow>(db, `SELECT * FROM comment_threads WHERE id=$1 AND workspace_id=$2 ${lock ? 'FOR UPDATE' : ''}`, [threadId, ctx.access.workspaceId]);
  if (!t) throw notFound('Thread');
  const post = await maybeOne<{ deleted_at: Date | null }>(db, `SELECT deleted_at FROM posts WHERE id=$1`, [t.post_id]);
  if (!post || post.deleted_at) throw notFound('Thread');
  const caps = staffCaps(ctx, t.brand_id);
  if (caps.staff && brandAllowed(ctx, t.brand_id)) {
    if (t.visibility === 'internal' && !caps.internal) throw notFound('Thread');
    return { thread: t, role: 'staff', caps, canPost: t.visibility === 'internal' ? caps.internal : caps.shared };
  }
  if (t.visibility === 'shared' && (await callerEntitled(ctx, db, { brandId: t.brand_id, permission: 'review.shared', postId: t.post_id }))) {
    const s = await collabSettings(db, ctx.access.workspaceId);
    const can = s.client_comments && authorizeCtx(ctx, 'comments.shared', { brandId: t.brand_id }).allowed;
    return { thread: t, role: 'guest', caps: { staff: false, internal: false, shared: can, moderate: false }, canPost: can };
  }
  throw notFound('Thread');
}

// ------------------------------------------------------------------ people (names for mention tokens)
/** Display names for mentioned/author ids. Guests get names only; removed members are marked. */
async function peopleFor(db: Queryable, workspaceId: string, ids: string[], guestView: boolean) {
  const uniq = [...new Set(ids.filter(isUuid))];
  if (!uniq.length) return {};
  const rows = await many<{ id: string; name: string | null; email: string; active: boolean }>(db,
    `SELECT u.id, u.name, u.email, (m.user_id IS NOT NULL AND m.status='active' AND m.removed_at IS NULL) AS active
       FROM users u LEFT JOIN memberships m ON m.user_id=u.id AND m.workspace_id=$1 WHERE u.id = ANY($2::uuid[])`, [workspaceId, uniq]);
  const out: Record<string, { name: string; email: string | null; active: boolean }> = {};
  for (const r of rows) out[r.id] = { name: r.active ? (r.name || r.email.split('@')[0]!) : 'Former member', email: guestView || !r.active ? null : r.email, active: r.active };
  return out;
}

// ------------------------------------------------------------------ thread DTOs
interface ThreadListRow extends ThreadRow { live_count: number; read_at: Date | null; revision_number: number | null }

async function threadComments(db: Queryable, threadIds: string[], all: boolean): Promise<Map<string, CommentRow[]>> {
  const out = new Map<string, CommentRow[]>();
  if (!threadIds.length) return out;
  // Root + the latest replies (bounded), or the whole thread (bounded) when expanding one thread.
  const rows = await many<CommentRow & { rn: number }>(db,
    all
      ? `SELECT ${COMMENT_SELECT}, 0 AS rn FROM comments c LEFT JOIN users u ON u.id=c.author_id WHERE c.thread_id = ANY($1::uuid[]) ORDER BY c.created_at, c.id LIMIT 500`
      : `SELECT * FROM (
           SELECT ${COMMENT_SELECT}, row_number() OVER (PARTITION BY c.thread_id ORDER BY c.created_at, c.id) AS rn,
                  count(*) OVER (PARTITION BY c.thread_id) AS n
             FROM comments c LEFT JOIN users u ON u.id=c.author_id WHERE c.thread_id = ANY($1::uuid[])) x
          WHERE rn = 1 OR rn > n - ${REPLIES_INLINE} ORDER BY created_at, id`, [threadIds]);
  for (const r of rows) { const l = out.get(r.thread_id) ?? []; l.push(r); out.set(r.thread_id, l); }
  return out;
}

function threadJson(t: ThreadListRow, comments: CommentRow[], v: Viewer & { caps: Caps; role: 'staff' | 'guest'; post?: { version: number; draft: DraftContent } | null }) {
  const anchorSt = v.post ? anchorStatus(t.anchor, t.anchor_version, v.post.version, v.post.draft) : 'none';
  const unread = t.last_actor_id !== v.viewerId && (!t.read_at || t.read_at < t.last_activity_at);
  return {
    id: t.id, post_id: t.post_id, approval_id: t.approval_id, visibility: t.visibility, created_by: t.created_by, created_at: t.created_at.toISOString(),
    resolved: !!t.resolved_at, resolved_at: t.resolved_at?.toISOString() ?? null, last_activity_at: t.last_activity_at.toISOString(),
    anchor: v.guestView ? null : t.anchor, anchor_version: v.guestView ? null : t.anchor_version, anchor_status: v.guestView ? 'none' : anchorSt,
    revision_number: t.revision_number, comment_count: Number(t.live_count), hidden_replies: Math.max(0, Number(t.live_count) - comments.filter((c) => !c.deleted_at).length),
    unread,
    can: {
      reply: v.role === 'staff' ? (t.visibility === 'internal' ? v.caps.internal : v.caps.shared) : v.caps.shared,
      resolve: v.role === 'staff' && (t.visibility === 'internal' ? v.caps.internal : v.caps.shared),
      change_visibility: v.role === 'staff' && v.caps.internal && v.caps.shared && (t.created_by === v.viewerId || v.caps.moderate),
    },
    comments: comments.map((c) => commentJson(c, v)),
  };
}
export type ThreadDto = ReturnType<typeof threadJson>;

const THREAD_SELECT = `t.*, r.read_at,
  (SELECT count(*)::int FROM comments c WHERE c.thread_id=t.id AND c.deleted_at IS NULL) AS live_count,
  (SELECT pr.revision_number FROM post_revisions pr WHERE pr.id = coalesce(t.anchor_revision_id, (SELECT a.revision_id FROM approvals a WHERE a.id=t.approval_id))) AS revision_number`;

/** Staff: one page of a post's threads (open or resolved), newest activity first; replies bounded per thread. */
export async function listThreads(ctx: Ctx, postId: string, q: { status?: string | null; cursor?: string | null; limit?: number; approval_id?: string | null } = {}) {
  requireAction(ctx, 'content.read');
  const db = getPool();
  const post = await loadPost(ctx, postId, db);
  const caps = staffCaps(ctx, post.brand_id);
  const vis: Visibility[] = caps.internal ? ['internal', 'shared'] : ['shared'];
  const limit = Math.min(Math.max(q.limit ?? THREAD_PAGE, 1), 50);
  const status = q.status === 'resolved' ? 'resolved' : q.status === 'all' ? 'all' : 'open';
  const params: unknown[] = [post.id, ctx.access.workspaceId, vis, ctx.actor.userId];
  let where = `t.post_id=$1 AND t.workspace_id=$2 AND t.visibility = ANY($3::text[])
    AND EXISTS (SELECT 1 FROM comments c WHERE c.thread_id=t.id AND c.deleted_at IS NULL)`;
  if (status === 'open') where += ' AND t.resolved_at IS NULL';
  if (status === 'resolved') where += ' AND t.resolved_at IS NOT NULL';
  if (q.approval_id) { assertUuid(q.approval_id, 'Review'); params.push(q.approval_id); where += ` AND t.approval_id=$${params.length}`; }
  if (q.cursor) {
    const [ts, id] = Buffer.from(q.cursor, 'base64url').toString().split('|');
    if (!ts || !isUuid(id)) throw new AppError('validation_failed', 'Invalid cursor');
    params.push(ts, id); where += ` AND (t.last_activity_at, t.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`;
  }
  params.push(limit + 1);
  const cursor = await currentCursor(db);
  const rows = await many<ThreadListRow>(db,
    `SELECT ${THREAD_SELECT} FROM comment_threads t LEFT JOIN comment_thread_reads r ON r.thread_id=t.id AND r.user_id=$4
      WHERE ${where} ORDER BY t.last_activity_at DESC, t.id DESC LIMIT $${params.length}`, params);
  const page = rows.slice(0, limit);
  const comments = await threadComments(db, page.map((t) => t.id), false);
  const counts = await one<{ open: number; resolved: number; unread: number }>(db,
    `SELECT count(*) FILTER (WHERE t.resolved_at IS NULL)::int AS open, count(*) FILTER (WHERE t.resolved_at IS NOT NULL)::int AS resolved,
            count(*) FILTER (WHERE t.resolved_at IS NULL AND t.last_actor_id IS DISTINCT FROM $4 AND (r.read_at IS NULL OR r.read_at < t.last_activity_at))::int AS unread
       FROM comment_threads t LEFT JOIN comment_thread_reads r ON r.thread_id=t.id AND r.user_id=$4
      WHERE t.post_id=$1 AND t.workspace_id=$2 AND t.visibility = ANY($3::text[]) AND EXISTS (SELECT 1 FROM comments c WHERE c.thread_id=t.id AND c.deleted_at IS NULL)`,
    [post.id, ctx.access.workspaceId, vis, ctx.actor.userId]);
  const viewer = { viewerId: ctx.actor.userId, moderate: caps.moderate, caps, role: 'staff' as const, post: { version: post.version, draft: post.draft } };
  const items = page.map((t) => threadJson(t, comments.get(t.id) ?? [], viewer));
  const ids = items.flatMap((t) => t.comments.flatMap((c) => [...c.mentions, c.author?.id ?? ''].filter(Boolean)));
  const last = page[page.length - 1];
  return {
    items, counts, cursor,
    next_cursor: rows.length > limit && last ? Buffer.from(`${last.last_activity_at.toISOString()}|${last.id}`).toString('base64url') : null,
    people: await peopleFor(db, ctx.access.workspaceId, ids, false),
    can: { internal: caps.internal, shared: caps.shared, moderate: caps.moderate },
    current_version: post.version,
  };
}

/** One thread with all replies (bounded) — deep links and "show earlier replies". Staff or shared guest. */
export async function getThread(ctx: Ctx, threadId: string) {
  const db = getPool();
  const acc = await loadThreadForCaller(ctx, db, threadId);
  return threadDto(db, ctx, acc);
}

async function threadDto(db: Queryable, ctx: Ctx, acc: ThreadAccess) {
  const t = await one<ThreadListRow>(db,
    `SELECT ${THREAD_SELECT} FROM comment_threads t LEFT JOIN comment_thread_reads r ON r.thread_id=t.id AND r.user_id=$2 WHERE t.id=$1`, [acc.thread.id, ctx.actor.userId]);
  const comments = (await threadComments(db, [t.id], true)).get(t.id) ?? [];
  const guestView = acc.role === 'guest';
  const post = guestView ? null : await maybeOne<{ version: number; draft: DraftContent }>(db, `SELECT version, draft FROM posts WHERE id=$1`, [t.post_id]);
  const dto = threadJson(t, comments, { viewerId: ctx.actor.userId, guestView, moderate: acc.caps.moderate, caps: acc.caps, role: acc.role, post });
  const ids = dto.comments.flatMap((c) => [...c.mentions, c.author?.id ?? ''].filter(Boolean)).concat(comments.flatMap((c) => c.deleted_at ? [] : mentionIds(c.body)));
  return { thread: dto, people: await peopleFor(db, ctx.access.workspaceId, ids, guestView) };
}

/** Shared threads of a post as seen from the review portal (guest or staff), newest activity first, bounded. */
export async function sharedThreadsFor(db: Queryable, ctx: Ctx, p: { postId: string; guestView: boolean; canPost: boolean }) {
  const rows = await many<ThreadListRow>(db,
    `SELECT ${THREAD_SELECT} FROM comment_threads t LEFT JOIN comment_thread_reads r ON r.thread_id=t.id AND r.user_id=$3
      WHERE t.post_id=$1 AND t.workspace_id=$2 AND t.visibility='shared' AND EXISTS (SELECT 1 FROM comments c WHERE c.thread_id=t.id AND c.deleted_at IS NULL)
      ORDER BY t.last_activity_at DESC, t.id DESC LIMIT 50`, [p.postId, ctx.access.workspaceId, ctx.actor.userId]);
  const comments = await threadComments(db, rows.map((t) => t.id), false);
  const caps: Caps = { staff: !p.guestView, internal: false, shared: p.canPost, moderate: false };
  const items = rows.map((t) => threadJson(t, comments.get(t.id) ?? [], { viewerId: ctx.actor.userId, guestView: p.guestView, caps, role: p.guestView ? 'guest' : 'staff', post: null }));
  const ids = items.flatMap((t) => t.comments.flatMap((c) => [c.author?.id ?? ''].filter(Boolean)))
    .concat([...comments.values()].flat().flatMap((c) => (c.deleted_at ? [] : mentionIds(c.body))));
  return { items, people: await peopleFor(db, ctx.access.workspaceId, ids, p.guestView) };
}

// ------------------------------------------------------------------ writes
function checkBody(raw: string): string {
  const body = sanitizeCommentBody(raw);
  if (!body || body.length > COMMENT_MAX) throw new AppError('validation_failed', `Comments are 1–${COMMENT_MAX} characters`, { body: 'Required' });
  return body;
}

async function rateLimit(ctx: Ctx, mentions: number) {
  await enforceRateLimit('collab.comment', ctx.actor.userId, COMMENT_RATE);
  if (mentions > 0) {
    for (let i = 0; i < Math.min(mentions, MENTION_MAX); i++) await enforceRateLimit('collab.mention', ctx.actor.userId, MENTION_RATE);
  }
}

/** Store mention rows for workspace members only (entitlement is decided at send time; a mention grants nothing). */
async function syncMentions(tx: Queryable, ctx: Ctx, commentId: string, ids: string[]): Promise<{ added: string[]; removed: string[] }> {
  const wanted = [...new Set(ids.filter(isUuid).map((x) => x.toLowerCase()))].filter((u) => u !== ctx.actor.userId).slice(0, MENTION_MAX);
  const members = wanted.length ? (await many<{ user_id: string }>(tx, `SELECT user_id FROM memberships WHERE workspace_id=$1 AND user_id = ANY($2::uuid[])`,
    [ctx.access.workspaceId, wanted])).map((m) => m.user_id) : [];
  const cur = await many<{ user_id: string; removed_at: Date | null }>(tx, `SELECT user_id, removed_at FROM comment_mentions WHERE comment_id=$1`, [commentId]);
  const added: string[] = [];
  for (const u of members) {
    const row = cur.find((c) => c.user_id === u);
    if (!row) { await tx.query(`INSERT INTO comment_mentions(workspace_id, comment_id, user_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [ctx.access.workspaceId, commentId, u]); added.push(u); }
    else if (row.removed_at) await tx.query(`UPDATE comment_mentions SET removed_at=NULL WHERE comment_id=$1 AND user_id=$2`, [commentId, u]); // re-added: already notified once
  }
  const removed = cur.filter((c) => !c.removed_at && !members.includes(c.user_id)).map((c) => c.user_id);
  if (removed.length) await tx.query(`UPDATE comment_mentions SET removed_at=now() WHERE comment_id=$1 AND user_id = ANY($2::uuid[])`, [commentId, removed]);
  return { added, removed };
}

async function insertCommentRow(tx: Queryable, ctx: Ctx, t: Pick<ThreadRow, 'id' | 'brand_id' | 'post_id' | 'approval_id' | 'visibility'>, body: string, clientKey: string | null, extraMentions: string[]) {
  const c = await one<{ id: string }>(tx,
    `INSERT INTO comments(workspace_id, brand_id, post_id, approval_id, visibility, author_id, body, thread_id, client_key) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [ctx.access.workspaceId, t.brand_id, t.post_id, t.approval_id, t.visibility, ctx.actor.userId, body, t.id, clientKey]);
  const m = await syncMentions(tx, ctx, c.id, [...mentionIds(body), ...extraMentions]);
  await tx.query(`UPDATE comment_threads SET last_activity_at=now(), last_actor_id=$2 WHERE id=$1`, [t.id, ctx.actor.userId]);
  await tx.query(
    `INSERT INTO comment_thread_reads(workspace_id, user_id, thread_id, read_at) VALUES ($1,$2,$3,now()) ON CONFLICT (user_id, thread_id) DO UPDATE SET read_at=now()`,
    [ctx.access.workspaceId, ctx.actor.userId, t.id]);
  await writeOutbox(tx, { workspaceId: ctx.access.workspaceId, aggregateType: 'comment', aggregateId: c.id, eventType: 'comment.created', payload: { postId: t.post_id, brandId: t.brand_id, threadId: t.id } });
  await emitCollabEvent(tx, { workspaceId: ctx.access.workspaceId, brandId: t.brand_id, postId: t.post_id, audience: t.visibility, kind: 'comment.created', refId: t.id, actorId: ctx.actor.userId });
  return { id: c.id, mentions: m.added };
}

async function byClientKey(db: Queryable, ctx: Ctx, clientKey: string | null | undefined): Promise<{ id: string; thread_id: string } | null> {
  if (!clientKey) return null;
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(clientKey)) throw new AppError('validation_failed', 'Invalid client key', { client_key: 'Invalid' });
  return maybeOne(db, `SELECT id, thread_id FROM comments WHERE author_id=$1 AND client_key=$2 AND workspace_id=$3`, [ctx.actor.userId, clientKey, ctx.access.workspaceId]);
}

export interface StartThreadInput { visibility: Visibility; body: string; anchor?: unknown; approval_id?: string | null; client_key?: string | null; mention_user_ids?: string[] }

/** Low-level: start a thread on a post the caller may post to (callers check access first). */
export async function startThread(tx: Queryable, ctx: Ctx, post: { id: string; brand_id: string; version: number | null }, input: StartThreadInput) {
  const body = checkBody(input.body);
  let revisionId: string | null = null;
  if (input.approval_id) {
    assertUuid(input.approval_id, 'Review');
    const a = await maybeOne<{ revision_id: string }>(tx, `SELECT revision_id FROM approvals WHERE id=$1 AND post_id=$2 AND workspace_id=$3`, [input.approval_id, post.id, ctx.access.workspaceId]);
    if (!a) throw notFound('Review');
    revisionId = a.revision_id;
  }
  const anchor = input.anchor === undefined || input.anchor === null ? null : parseAnchor(input.anchor);
  if (input.anchor && !anchor) throw new AppError('validation_failed', 'The selection could not be attached', { anchor: 'Invalid' });
  if (anchor?.kind === 'media') {
    // Only media of this post's own brand can be referenced (never another tenant's or brand's asset id).
    const ok = await maybeOne(tx, `SELECT 1 FROM assets WHERE id=$1 AND workspace_id=$2 AND brand_id=$3`, [anchor.asset_id, ctx.access.workspaceId, post.brand_id]);
    if (!ok) throw new AppError('validation_failed', 'That media item isn’t in this brand', { anchor: 'Unknown media' });
  }
  const t = await one<ThreadRow>(tx,
    `INSERT INTO comment_threads(workspace_id, brand_id, post_id, approval_id, visibility, created_by, anchor_version, anchor_revision_id, anchor, last_actor_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$6) RETURNING *`,
    [ctx.access.workspaceId, post.brand_id, post.id, input.approval_id ?? null, input.visibility, ctx.actor.userId, post.version, revisionId, anchor ? JSON.stringify(anchor) : null]);
  const c = await insertCommentRow(tx, ctx, t, body, input.client_key ?? null, input.mention_user_ids ?? []);
  await audit(tx, { workspaceId: ctx.access.workspaceId, brandId: post.brand_id, actorUserId: ctx.actor.userId, action: 'comment.created', resourceType: 'comment', resourceId: c.id,
    diff: { visibility: input.visibility, post_id: post.id, thread_id: t.id, new_thread: true, mentions: c.mentions.length, anchored: !!anchor }, correlationId: ctx.correlationId });
  return { thread: t, commentId: c.id };
}

/** Staff: start a thread on a post. */
export async function createThread(ctx: Ctx, postId: string, input: StartThreadInput) {
  if (input.visibility !== 'internal' && input.visibility !== 'shared') throw new AppError('validation_failed', 'Choose internal or shared', { visibility: 'Required' });
  const perm = input.visibility === 'internal' ? 'comments.internal' : 'comments.shared';
  requireAction(ctx, perm);
  const prior = await byClientKey(getPool(), ctx, input.client_key);
  if (prior) return getThread(ctx, prior.thread_id);
  await rateLimit(ctx, mentionIds(input.body ?? '').length + (input.mention_user_ids?.length ?? 0));
  const id = await withTx(async (tx) => {
    const post = await loadPost(ctx, postId, tx);
    requireAction(ctx, perm, { brandId: post.brand_id });
    return (await startThread(tx, ctx, { id: post.id, brand_id: post.brand_id, version: post.version }, input)).thread.id;
  });
  return getThread(ctx, id);
}

/** Reply (staff or a shared guest). Replying to a resolved thread reopens it. */
export async function replyToThread(ctx: Ctx, threadId: string, input: { body: string; client_key?: string | null }) {
  const prior = await byClientKey(getPool(), ctx, input.client_key);
  if (prior) return getThread(ctx, prior.thread_id);
  await rateLimit(ctx, mentionIds(input.body ?? '').length);
  await withTx(async (tx) => {
    const acc = await loadThreadForCaller(ctx, tx, threadId, true);
    if (!acc.canPost) throw new AppError('forbidden', acc.role === 'guest' ? 'Comments are turned off for this review' : 'You can’t reply in this discussion');
    if (acc.role === 'guest' && acc.thread.approval_id) {
      const a = await maybeOne<{ decision: string }>(tx, `SELECT decision FROM approvals WHERE id=$1`, [acc.thread.approval_id]);
      if (a && a.decision !== 'pending') throw new AppError('invalid_state', 'This review is closed.');
    }
    const body = checkBody(input.body);
    const c = await insertCommentRow(tx, ctx, acc.thread, body, input.client_key ?? null, []);
    if (acc.thread.resolved_at) {
      await tx.query(`UPDATE comment_threads SET resolved_at=NULL, resolved_by=NULL WHERE id=$1`, [acc.thread.id]);
      await emitCollabEvent(tx, { workspaceId: ctx.access.workspaceId, brandId: acc.thread.brand_id, postId: acc.thread.post_id, audience: acc.thread.visibility, kind: 'thread.reopened', refId: acc.thread.id, actorId: ctx.actor.userId });
    }
    await audit(tx, { workspaceId: ctx.access.workspaceId, brandId: acc.thread.brand_id, actorUserId: ctx.actor.userId, action: 'comment.created', resourceType: 'comment', resourceId: c.id,
      diff: { visibility: acc.thread.visibility, post_id: acc.thread.post_id, thread_id: acc.thread.id, reply: true, mentions: c.mentions.length, as_guest: acc.role === 'guest' }, correlationId: ctx.correlationId });
  });
  return getThread(ctx, threadId);
}

async function loadCommentForCaller(ctx: Ctx, tx: Queryable, commentId: string) {
  assertUuid(commentId, 'Comment');
  const c = await maybeOne<{ id: string; thread_id: string; author_id: string | null; body: string; deleted_at: Date | null }>(tx,
    `SELECT id, thread_id, author_id, body, deleted_at FROM comments WHERE id=$1 AND workspace_id=$2 FOR UPDATE`, [commentId, ctx.access.workspaceId]);
  if (!c) throw notFound('Comment');
  const acc = await loadThreadForCaller(ctx, tx, c.thread_id).catch(() => { throw notFound('Comment'); });
  return { c, acc };
}

/** Edit your own comment. The previous body goes to the immutable edit history; only newly added mentions notify. */
export async function editComment(ctx: Ctx, commentId: string, input: { body: string }) {
  const threadId = await withTx(async (tx) => {
    const { c, acc } = await loadCommentForCaller(ctx, tx, commentId);
    if (c.deleted_at) throw new AppError('invalid_state', 'This comment was deleted');
    if (c.author_id !== ctx.actor.userId) throw new AppError('forbidden', 'Only the author can edit this comment');
    if (!acc.canPost) throw new AppError('forbidden', 'You can’t post in this discussion any more');
    const body = checkBody(input.body);
    if (body === c.body) return acc.thread.id;
    await tx.query(`INSERT INTO comment_edits(workspace_id, comment_id, body, edited_by) VALUES ($1,$2,$3,$4)`, [ctx.access.workspaceId, c.id, c.body, ctx.actor.userId]);
    await tx.query(`UPDATE comments SET body=$2, edited_at=now() WHERE id=$1`, [c.id, body]);
    const m = await syncMentions(tx, ctx, c.id, mentionIds(body));
    if (m.added.length) {
      await writeOutbox(tx, { workspaceId: ctx.access.workspaceId, aggregateType: 'comment', aggregateId: c.id, eventType: 'comment.edited', payload: { postId: acc.thread.post_id, threadId: acc.thread.id } });
    }
    await emitCollabEvent(tx, { workspaceId: ctx.access.workspaceId, brandId: acc.thread.brand_id, postId: acc.thread.post_id, audience: acc.thread.visibility, kind: 'comment.edited', refId: acc.thread.id, actorId: ctx.actor.userId });
    await audit(tx, { workspaceId: ctx.access.workspaceId, brandId: acc.thread.brand_id, actorUserId: ctx.actor.userId, action: 'comment.edited', resourceType: 'comment', resourceId: c.id,
      diff: { post_id: acc.thread.post_id, thread_id: acc.thread.id, mentions_added: m.added.length, mentions_removed: m.removed.length }, correlationId: ctx.correlationId });
    return acc.thread.id;
  });
  return getThread(ctx, threadId);
}

/** Previous versions of a comment (anyone who can see it). */
export async function commentHistory(ctx: Ctx, commentId: string) {
  const db = getPool();
  const { c } = await withTx(async (tx) => loadCommentForCaller(ctx, tx, commentId));
  if (c.deleted_at) return { items: [] };
  const rows = await many<{ body: string; created_at: Date }>(db, `SELECT body, created_at FROM comment_edits WHERE comment_id=$1 ORDER BY created_at DESC LIMIT 50`, [c.id]);
  return { items: rows.map((r) => ({ body: r.body, replaced_at: r.created_at.toISOString() })) };
}

/** Delete = tombstone: the text and its edit history are removed; who/when stay. Author, or a brand manager (staff). */
export async function deleteComment(ctx: Ctx, commentId: string) {
  return withTx(async (tx) => {
    const { c, acc } = await loadCommentForCaller(ctx, tx, commentId);
    if (c.deleted_at) return { ok: true };
    if (c.author_id !== ctx.actor.userId && !acc.caps.moderate) throw new AppError('forbidden', 'Only the author can delete this comment');
    await tx.query(`UPDATE comments SET deleted_at=now(), deleted_by=$2, body=$3 WHERE id=$1`, [c.id, ctx.actor.userId, TOMBSTONE]);
    await tx.query(`DELETE FROM comment_edits WHERE comment_id=$1`, [c.id]);
    await tx.query(`UPDATE comment_mentions SET removed_at=coalesce(removed_at, now()) WHERE comment_id=$1`, [c.id]);
    await emitCollabEvent(tx, { workspaceId: ctx.access.workspaceId, brandId: acc.thread.brand_id, postId: acc.thread.post_id, audience: acc.thread.visibility, kind: 'comment.deleted', refId: acc.thread.id, actorId: ctx.actor.userId });
    await audit(tx, { workspaceId: ctx.access.workspaceId, brandId: acc.thread.brand_id, actorUserId: ctx.actor.userId, action: 'comment.deleted', resourceType: 'comment', resourceId: c.id,
      diff: { post_id: acc.thread.post_id, thread_id: acc.thread.id, by_author: c.author_id === ctx.actor.userId, body_sha256: createHash('sha256').update(c.body).digest('hex').slice(0, 16) }, correlationId: ctx.correlationId });
    return { ok: true };
  });
}

/** Resolve / reopen (staff who may post in the thread). Resolving is not approval. */
export async function setThreadResolved(ctx: Ctx, threadId: string, resolved: boolean) {
  await withTx(async (tx) => {
    const acc = await loadThreadForCaller(ctx, tx, threadId, true);
    if (acc.role !== 'staff' || !acc.canPost) throw new AppError('forbidden', 'You can’t resolve this discussion');
    if (!!acc.thread.resolved_at === resolved) return;
    await tx.query(`UPDATE comment_threads SET resolved_at=$2, resolved_by=$3 WHERE id=$1`, [acc.thread.id, resolved ? new Date() : null, resolved ? ctx.actor.userId : null]);
    await emitCollabEvent(tx, { workspaceId: ctx.access.workspaceId, brandId: acc.thread.brand_id, postId: acc.thread.post_id, audience: acc.thread.visibility, kind: resolved ? 'thread.resolved' : 'thread.reopened', refId: acc.thread.id, actorId: ctx.actor.userId });
    await audit(tx, { workspaceId: ctx.access.workspaceId, brandId: acc.thread.brand_id, actorUserId: ctx.actor.userId, action: resolved ? 'thread.resolved' : 'thread.reopened', resourceType: 'thread', resourceId: acc.thread.id,
      diff: { post_id: acc.thread.post_id }, correlationId: ctx.correlationId });
  });
  return getThread(ctx, threadId);
}

/**
 * Change who can see a thread — an explicit, audited action. Making an internal thread shared exposes every comment in
 * it to client reviewers, so the caller must confirm the exact number of comments being exposed (stale → 409).
 * Requires both comment permissions on the brand and being the thread's starter or a brand manager.
 */
export async function setThreadVisibility(ctx: Ctx, threadId: string, input: { visibility: Visibility; confirm_count?: number }) {
  if (input.visibility !== 'internal' && input.visibility !== 'shared') throw new AppError('validation_failed', 'Choose internal or shared', { visibility: 'Required' });
  await withTx(async (tx) => {
    const acc = await loadThreadForCaller(ctx, tx, threadId, true);
    const t = acc.thread;
    if (acc.role !== 'staff' || !acc.caps.internal || !acc.caps.shared || (t.created_by !== ctx.actor.userId && !acc.caps.moderate)) {
      throw new AppError('forbidden', 'You can’t change who sees this discussion');
    }
    if (t.visibility === input.visibility) return;
    const n = await one<{ n: number }>(tx, `SELECT count(*)::int n FROM comments WHERE thread_id=$1 AND deleted_at IS NULL`, [t.id]);
    if (input.visibility === 'shared' && input.confirm_count !== n.n) {
      throw new AppError('conflict', `This discussion now has ${n.n} comment${n.n === 1 ? '' : 's'}. Review them before sharing.`, undefined, { comment_count: n.n });
    }
    await tx.query(`UPDATE comment_threads SET visibility=$2 WHERE id=$1`, [t.id, input.visibility]);
    await tx.query(`UPDATE comments SET visibility=$2 WHERE thread_id=$1`, [t.id, input.visibility]);
    // Both audiences refresh: clients gain or lose the thread; staff see the new label.
    for (const aud of ['internal', 'shared'] as const) {
      await emitCollabEvent(tx, { workspaceId: ctx.access.workspaceId, brandId: t.brand_id, postId: t.post_id, audience: aud, kind: 'thread.visibility', refId: t.id, actorId: ctx.actor.userId });
    }
    await audit(tx, { workspaceId: ctx.access.workspaceId, brandId: t.brand_id, actorUserId: ctx.actor.userId, action: 'thread.visibility_changed', resourceType: 'thread', resourceId: t.id,
      diff: { post_id: t.post_id, from: t.visibility, to: input.visibility, comments: n.n }, correlationId: ctx.correlationId });
  });
  return getThread(ctx, threadId);
}

/** Mark threads of a post read for the caller (only threads they can see). */
export async function markThreadsRead(ctx: Ctx, postId: string, threadIds?: string[]) {
  const db = getPool();
  const post = await loadPost(ctx, postId, db);
  const caps = staffCaps(ctx, post.brand_id);
  const vis: Visibility[] = caps.internal ? ['internal', 'shared'] : ['shared'];
  const ids = threadIds?.filter(isUuid).slice(0, 100) ?? null;
  const r = await db.query(
    `INSERT INTO comment_thread_reads(workspace_id, user_id, thread_id, read_at)
     SELECT t.workspace_id, $3, t.id, now() FROM comment_threads t
      WHERE t.post_id=$1 AND t.workspace_id=$2 AND t.visibility = ANY($4::text[]) AND ($5::uuid[] IS NULL OR t.id = ANY($5::uuid[]))
     ON CONFLICT (user_id, thread_id) DO UPDATE SET read_at=now()`, [post.id, ctx.access.workspaceId, ctx.actor.userId, vis, ids]);
  return { marked: r.rowCount ?? 0 };
}

/** Unread open threads per post for the caller (planner, inbox). Internal threads only where comments.internal holds. */
export async function unreadThreadCounts(ctx: Ctx, posts: Array<{ id: string; brand_id: string }>, db: Queryable = getPool()): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!posts.length) return out;
  const internalBrands = [...new Set(posts.map((p) => p.brand_id))].filter((b) => staffCaps(ctx, b).internal);
  const rows = await many<{ post_id: string; n: number }>(db,
    `SELECT t.post_id, count(*)::int n FROM comment_threads t LEFT JOIN comment_thread_reads r ON r.thread_id=t.id AND r.user_id=$2
      WHERE t.workspace_id=$1 AND t.post_id = ANY($3::uuid[]) AND t.resolved_at IS NULL AND t.last_actor_id IS DISTINCT FROM $2
        AND (r.read_at IS NULL OR r.read_at < t.last_activity_at) AND (t.visibility='shared' OR t.brand_id = ANY($4::uuid[]))
      GROUP BY t.post_id`, [ctx.access.workspaceId, ctx.actor.userId, posts.map((p) => p.id), internalBrands]);
  for (const r of rows) out.set(r.post_id, r.n);
  return out;
}

// ------------------------------------------------------------------ legacy V2 API (kept; now thread-backed)
/** Staff view of a post's comments (flat, V2 shape). */
export async function listComments(ctx: Ctx, postId: string) {
  requireAction(ctx, 'content.read');
  const db = getPool();
  const post = await loadPost(ctx, postId, db);
  const caps = staffCaps(ctx, post.brand_id);
  const rows = await commentsFor(db, ctx.access.workspaceId, post.id, caps.internal ? ['internal', 'shared'] : ['shared']);
  return { items: rows.map((r) => commentJson(r, { viewerId: ctx.actor.userId, moderate: caps.moderate })), can: { internal: caps.internal, shared: caps.shared } };
}

/** V2: a new comment = a new thread with one comment. */
export async function createComment(ctx: Ctx, postId: string, input: { body: string; visibility: Visibility; mention_user_ids?: string[]; approval_id?: string | null; client_key?: string | null; anchor?: unknown }) {
  const r = await createThread(ctx, postId, input);
  return r.thread.comments[0]!;
}

/** V2 helper kept for older callers: insert into a fresh thread inside an existing transaction. */
export async function insertComment(tx: Queryable, ctx: Ctx, p: { postId: string; brandId: string; approvalId: string | null; visibility: Visibility; body: string; mentionUserIds: string[] }) {
  const post = await maybeOne<{ version: number }>(tx, `SELECT version FROM posts WHERE id=$1`, [p.postId]);
  const r = await startThread(tx, ctx, { id: p.postId, brand_id: p.brandId, version: post?.version ?? null },
    { visibility: p.visibility, body: p.body, approval_id: p.approvalId, mention_user_ids: p.mentionUserIds });
  return { id: r.commentId, thread_id: r.thread.id };
}

/**
 * People who can be mentioned here (bounded search; never the whole member list). Each candidate is checked against the
 * thread's visibility NOW (internal → comments.internal; shared → content.read staff or a shared guest); checked again at
 * send. A mention never grants access.
 */
export async function mentionCandidates(ctx: Ctx, postId: string, visibility: Visibility, q = '') {
  requireAction(ctx, 'content.read');
  const db = getPool();
  const post = await loadPost(ctx, postId, db);
  const term = q.trim().replace(/[%_\\]/g, '').slice(0, 40);
  const members = await many<{ user_id: string; email: string; name: string | null }>(db,
    `SELECT m.user_id, u.email, u.name FROM memberships m JOIN users u ON u.id=m.user_id
      WHERE m.workspace_id=$1 AND m.status='active' AND m.removed_at IS NULL AND m.user_id <> $2
        AND ($3 = '' OR u.name ILIKE $3 || '%' OR u.email ILIKE $3 || '%' OR u.name ILIKE '% ' || $3 || '%')
      ORDER BY u.name NULLS LAST, u.email LIMIT 40`, [ctx.access.workspaceId, ctx.actor.userId, term]);
  const shared = visibility === 'shared' && members.length
    ? new Set((await many<{ user_id: string }>(db, `SELECT user_id FROM review_shares WHERE post_id=$1 AND revoked_at IS NULL AND user_id = ANY($2::uuid[])`,
      [post.id, members.map((m) => m.user_id)])).map((r) => r.user_id)) : new Set<string>();
  const out: Array<{ id: string; email: string; name: string | null; guest: boolean }> = [];
  for (const m of members) {
    if (out.length >= 8) break;
    const s = await loadUserAuthz(m.user_id, ctx.access.workspaceId, null, db);
    if (s.subject.status !== 'active') continue;
    if (staffAllowed(s, visibility === 'internal' ? 'comments.internal' : 'content.read', post.brand_id)) out.push({ id: m.user_id, email: m.email, name: m.name, guest: false });
    else if (visibility === 'shared' && shared.has(m.user_id) && authorize(s, 'content.read', { brandId: post.brand_id }).allowed) {
      out.push({ id: m.user_id, email: m.email, name: m.name, guest: true });
    }
  }
  return { items: out };
}

// ------------------------------------------------------------------ outbox handlers
function threadLink(t: { id: string; post_id: string; approval_id: string | null }, guest: boolean, approvalId: string | null): string {
  return guest ? `/review/${approvalId ?? t.approval_id}?thread=${t.id}` : `/posts/${t.post_id}?thread=${t.id}`;
}

/**
 * Outbox 'comment.created' / 'comment.edited': notify mentioned people (not yet notified, still mentioned) who are entitled
 * at send time; on creation also tell earlier participants about the reply. No comment text is ever put in a notification.
 */
export async function onCommentCreated(db: Queryable, commentId: string, mode: 'created' | 'edited' = 'created'): Promise<void> {
  const c = await maybeOne<{ id: string; workspace_id: string; brand_id: string; post_id: string; approval_id: string | null; visibility: Visibility; author_id: string | null; deleted_at: Date | null; thread_id: string }>(db,
    `SELECT id, workspace_id, brand_id, post_id, approval_id, visibility, author_id, deleted_at, thread_id FROM comments WHERE id=$1`, [commentId]);
  if (!c || c.deleted_at) return;
  const t = await maybeOne<{ id: string; post_id: string; approval_id: string | null; created_by: string | null }>(db, `SELECT id, post_id, approval_id, created_by FROM comment_threads WHERE id=$1`, [c.thread_id]);
  if (!t) return;
  const latestReview = await maybeOne<{ id: string }>(db, `SELECT id FROM approvals WHERE post_id=$1 ORDER BY requested_at DESC LIMIT 1`, [c.post_id]);
  const requirement = c.visibility === 'internal'
    ? { brandId: c.brand_id, permission: 'comments.internal' as const }
    : { brandId: c.brand_id, permission: 'review.shared' as const, postId: c.post_id };
  const mentions = await many<{ user_id: string }>(db,
    `SELECT user_id FROM comment_mentions WHERE comment_id=$1 AND notified_at IS NULL AND skipped_reason IS NULL AND removed_at IS NULL`, [c.id]);
  const notified = new Set<string>();
  for (const m of mentions) {
    const s = await loadUserAuthz(m.user_id, c.workspace_id, null, db);
    const staff = staffAllowed(s, 'content.read', c.brand_id);
    const reviewId = c.approval_id ?? latestReview?.id ?? null;
    const r = await deliverNotification(db, {
      workspaceId: c.workspace_id, userId: m.user_id, event: 'mention', kind: 'mention', actorId: c.author_id,
      title: c.visibility === 'internal' ? 'You were mentioned in an internal note' : 'You were mentioned in a comment',
      referenceType: staff ? 'post' : 'review', referenceId: staff ? c.post_id : (reviewId ?? c.post_id),
      linkPath: staff ? threadLink(t, false, null) : reviewId ? threadLink(t, true, reviewId) : null,
      dedupeKey: `mention:${c.id}`, requirement,
    });
    if (r === 'created' || r === 'duplicate' || r === 'muted') notified.add(m.user_id);
    await db.query(`UPDATE comment_mentions SET notified_at = CASE WHEN $3::text IN ('created','duplicate','muted') THEN now() END, skipped_reason = CASE WHEN $3::text = 'not_entitled' THEN 'not_entitled' END
                     WHERE comment_id=$1 AND user_id=$2`, [c.id, m.user_id, r]);
  }
  if (mode !== 'created') return;
  // Earlier participants (thread starter + previous commenters), except the author and anyone just mentioned.
  const participants = await many<{ user_id: string }>(db,
    `SELECT DISTINCT author_id AS user_id FROM comments WHERE thread_id=$1 AND id<>$2 AND author_id IS NOT NULL AND deleted_at IS NULL
     UNION SELECT created_by FROM comment_threads WHERE id=$1 AND created_by IS NOT NULL LIMIT 50`, [t.id, c.id]);
  const allMentioned = new Set((await many<{ user_id: string }>(db, `SELECT user_id FROM comment_mentions WHERE comment_id=$1`, [c.id])).map((m) => m.user_id));
  for (const p of participants) {
    if (p.user_id === c.author_id || allMentioned.has(p.user_id) || notified.has(p.user_id)) continue;
    const s = await loadUserAuthz(p.user_id, c.workspace_id, null, db);
    const staff = staffAllowed(s, 'content.read', c.brand_id);
    const reviewId = c.approval_id ?? latestReview?.id ?? null;
    await deliverNotification(db, {
      workspaceId: c.workspace_id, userId: p.user_id, event: 'comment', kind: 'comment.reply', actorId: c.author_id,
      title: c.visibility === 'internal' ? 'New reply in an internal discussion' : 'New reply in a discussion',
      referenceType: staff ? 'post' : 'review', referenceId: staff ? c.post_id : (reviewId ?? c.post_id),
      linkPath: staff ? threadLink(t, false, null) : reviewId ? threadLink(t, true, reviewId) : null,
      dedupeKey: `reply:${c.id}`, requirement,
    });
  }
  // A guest's shared comment is actionable for the person who requested the review (and its assignee).
  if (c.visibility === 'shared' && c.author_id) {
    const author = await loadUserAuthz(c.author_id, c.workspace_id, null, db);
    if (!staffAllowed(author, 'content.read', c.brand_id)) {
      const req = await maybeOne<{ id: string; requested_by: string | null; assignee_user_id: string | null }>(db,
        `SELECT id, requested_by, assignee_user_id FROM approvals WHERE post_id=$1 ORDER BY requested_at DESC LIMIT 1`, [c.post_id]);
      for (const uid of new Set([req?.requested_by, req?.assignee_user_id].filter((x): x is string => !!x))) {
        await deliverNotification(db, { workspaceId: c.workspace_id, userId: uid, event: 'comment', kind: 'comment.client', title: 'A client commented on a review', actorId: c.author_id,
          referenceType: 'approval', referenceId: req!.id, linkPath: threadLink(t, false, null), dedupeKey: `comment:${c.id}`, requirement: { brandId: c.brand_id, permission: 'content.read' } });
      }
    }
  }
}
