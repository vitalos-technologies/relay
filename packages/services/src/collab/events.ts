// Collaboration change feed (realtime + reconnect). Rows are written in the SAME transaction as the change they describe
// ("persist before confirming") and carry no content: kind + reference id only. Readers filter by audience against the
// caller's CURRENT access, then refetch the affected resource through the normal authorized APIs, so a replayed,
// duplicated or out-of-order event can never create or expose anything.
//   audience internal = comments.internal on the brand (staff); shared = anyone who may read the post (staff or a guest
//   the review was shared with); staff = staff content.read on the brand; user = one recipient (their notifications).
import { getPool, many, maybeOne, type Queryable } from '@social-lite/db';
import type { Ctx } from '../context.js';
import { authorizeCtx, isUuid } from '../tenancy.js';
import { hasActiveShare, staffAllowed } from './access.js';

export type Audience = 'internal' | 'shared' | 'staff' | 'user';
export type CollabEventKind =
  | 'thread.created' | 'thread.updated' | 'comment.created' | 'comment.edited' | 'comment.deleted' | 'thread.resolved' | 'thread.reopened' | 'thread.visibility'
  | 'task.created' | 'task.updated' | 'post.saved' | 'review.updated' | 'notification' | 'presence';

export async function emitCollabEvent(db: Queryable, e: {
  workspaceId: string; brandId?: string | null; postId?: string | null; audience: Audience; userId?: string | null; kind: CollabEventKind; refId?: string | null; actorId?: string | null;
}): Promise<void> {
  await db.query(
    `INSERT INTO collab_events(workspace_id, brand_id, post_id, audience, user_id, kind, ref_id, actor_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [e.workspaceId, e.brandId ?? null, e.postId ?? null, e.audience, e.audience === 'user' ? e.userId : null, e.kind, e.refId ?? null, e.actorId ?? null]);
}

/** Highest event id now (clients start their cursor here after a full load, so nothing between load and subscribe is lost). */
export async function currentCursor(db: Queryable = getPool()): Promise<number> {
  const r = await maybeOne<{ id: string | null }>(db, `SELECT max(id)::text AS id FROM collab_events`);
  return Number(r?.id ?? 0);
}

export interface CollabEventDto { id: number; kind: string; post_id: string | null; ref_id: string | null; actor_id: string | null; mine: boolean; at: string }

interface PostScope { postId: string; brandId: string; audiences: Audience[] }

/** Which audiences of this post the caller may receive right now (null = none / not visible). */
export async function postAudiences(ctx: Ctx, postId: string, db: Queryable = getPool()): Promise<PostScope | null> {
  if (!isUuid(postId)) return null;
  const p = await maybeOne<{ brand_id: string }>(db, `SELECT brand_id FROM posts WHERE id=$1 AND workspace_id=$2 AND deleted_at IS NULL`, [postId, ctx.access.workspaceId]);
  if (!p) return null;
  const st = ctx.access.authz;
  const staff = st ? staffAllowed(st, 'content.read', p.brand_id) : (ctx.access.brandIds === null || ctx.access.brandIds.includes(p.brand_id));
  if (staff) {
    const aud: Audience[] = ['shared', 'staff'];
    if (authorizeCtx(ctx, 'comments.internal', { brandId: p.brand_id }).allowed) aud.push('internal');
    return { postId, brandId: p.brand_id, audiences: aud };
  }
  if (st && authorizeCtx(ctx, 'content.read', { brandId: p.brand_id }).allowed && (await hasActiveShare(db, ctx.access.workspaceId, postId, ctx.actor.userId))) {
    return { postId, brandId: p.brand_id, audiences: ['shared'] };
  }
  return null;
}

/**
 * Events after `after` for one post (if visible) plus the caller's own user-level events. Bounded; `more` = call again.
 * `reset` = the cursor predates retention: reload everything instead of replaying.
 */
export async function readCollabEvents(ctx: Ctx, q: { postId?: string | null; after: number; limit?: number }, db: Queryable = getPool(), scope?: PostScope | null) {
  const limit = Math.min(Math.max(q.limit ?? 100, 1), 200);
  const after = Number.isSafeInteger(q.after) && q.after > 0 ? q.after : 0;
  const s = scope !== undefined ? scope : q.postId ? await postAudiences(ctx, q.postId, db) : null;
  if (q.postId && !s) return { events: [] as CollabEventDto[], cursor: after, more: false, reset: false, visible: false };
  if (after > 0) {
    const min = await maybeOne<{ id: string | null }>(db, `SELECT min(id)::text AS id FROM collab_events`);
    if (min?.id && after < Number(min.id) - 1) return { events: [], cursor: await currentCursor(db), more: false, reset: true, visible: true };
  }
  const rows = await many<{ id: string; kind: string; post_id: string | null; ref_id: string | null; actor_id: string | null; created_at: Date }>(db,
    `SELECT id::text, kind, post_id, ref_id, actor_id, created_at FROM (
       SELECT * FROM collab_events WHERE post_id = $3 AND id > $2 AND workspace_id = $1 AND audience = ANY($4::text[])
       UNION ALL
       SELECT * FROM collab_events WHERE user_id = $5 AND id > $2 AND workspace_id = $1
     ) e ORDER BY id LIMIT $6`,
    [ctx.access.workspaceId, after, s?.postId ?? null, s?.audiences ?? [], ctx.actor.userId, limit + 1]);
  const page = rows.slice(0, limit);
  return {
    events: page.map((r) => ({ id: Number(r.id), kind: r.kind, post_id: r.post_id, ref_id: r.ref_id, actor_id: r.actor_id, mine: r.actor_id === ctx.actor.userId, at: r.created_at.toISOString() })),
    cursor: page.length ? Number(page[page.length - 1]!.id) : after,
    more: rows.length > limit,
    reset: false,
    visible: true,
  };
}

/** Retention: the feed is for reconnects, not history. */
export async function pruneCollabEvents(db: Queryable = getPool(), days = 7): Promise<number> {
  const r = await db.query(`DELETE FROM collab_events WHERE created_at < now() - make_interval(days => $1)`, [days]);
  return r.rowCount ?? 0;
}
