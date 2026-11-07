// V3.1 §10 trash, soft delete, restore, undo and the retention purge.
// Semantics (docs/V3_1_DATA_API.md "Trash"):
//  - Trash is a soft delete (deleted_at + purge_after = now + TRASH_RETENTION_DAYS). Trashed rows are invisible to every
//    normal read path (posts/service.ts loadPost/listPosts, media/assets.ts) and restorable until purge.
//  - Posts: refused while a schedule is live (active/pending approval) or any delivery is still in flight; refused for
//    posts with published history (archive those instead). Deleting in Relay NEVER deletes anything on a network;
//    restoring NEVER republishes (it only clears the trash flag; schedules stay as they were: cancelled/none).
//  - Assets: refused while a live schedule or an unfinished delivery uses the asset; drafts that use it are listed as
//    a consequence. Physical deletion happens only in the purge job after re-checking every reference (live schedules,
//    unfinished deliveries, any non-trashed draft, Content Hub snapshots); a referenced asset is kept (purge deferred).
//  - Undo: every trash/restore result carries an UndoToken describing the inverse server operation and the state it
//    expects (deleted_at / version), so an undo after someone else changed the item fails with a conflict.
//  - Every trash, restore and purge is audited.
import { AppError, notFound } from '@social-lite/core';
import { TRASH_RETENTION_DAYS, type RestoreResult, type TrashConsequences, type TrashItemView, type TrashKind, type TrashResult } from '@social-lite/core/contracts/v31-data';
import { getPool, many, maybeOne, one, withTx, type Queryable } from '@social-lite/db';
import type { Ctx } from '../context.js';
import { audit } from '../audit.js';
import { log } from '../log.js';
import { deleteObject } from '../storage.js';
import { assertUuid, authorizeCtx, brandAllowed, brandFilter, requireAction } from '../tenancy.js';

const KIND_PERMISSION = { post: 'content.archive', asset: 'assets.manage' } as const;
const READ_PERMISSION = { post: 'content.read', asset: 'assets.read' } as const;
const ACTIVE_DELIVERY = `d.state NOT IN ('published','failed','cancelled','expired','handoff')`;
const REACHED_NETWORK = `(d.state IN ('published','unknown','handoff') OR d.published_at IS NOT NULL OR cardinality(d.provider_ids) > 0)`;

interface PostFacts { live_schedules: number; active_deliveries: number; published_deliveries: number }
interface AssetFacts { live_schedules: number; active_deliveries: number; drafts: number; snapshots: number }

export async function postFacts(db: Queryable, workspaceId: string, postId: string): Promise<PostFacts> {
  return one<PostFacts>(db,
    `SELECT (SELECT count(*) FROM schedules s WHERE s.workspace_id=$1 AND s.post_id=$2 AND s.status IN ('active','pending_approval'))::int AS live_schedules,
            (SELECT count(*) FROM deliveries d WHERE d.workspace_id=$1 AND d.post_id=$2 AND ${ACTIVE_DELIVERY})::int AS active_deliveries,
            (SELECT count(*) FROM deliveries d WHERE d.workspace_id=$1 AND d.post_id=$2 AND ${REACHED_NETWORK})::int AS published_deliveries`,
    [workspaceId, postId]);
}

/** Every reference that must block physical deletion of an asset (and trashing, for live work). */
export async function assetFacts(db: Queryable, workspaceId: string, assetId: string): Promise<AssetFacts> {
  return one<AssetFacts>(db,
    `SELECT
       (SELECT count(DISTINCT s.id) FROM schedules s JOIN variants v ON v.revision_id=s.revision_id AND v.workspace_id=s.workspace_id
         WHERE s.workspace_id=$1 AND s.status IN ('active','pending_approval') AND $2::uuid = ANY(v.asset_ids))::int AS live_schedules,
       (SELECT count(*) FROM deliveries d JOIN variants v ON v.id=d.variant_id AND v.workspace_id=d.workspace_id
         WHERE d.workspace_id=$1 AND $2::uuid = ANY(v.asset_ids) AND ${ACTIVE_DELIVERY})::int AS active_deliveries,
       (SELECT count(*) FROM posts p WHERE p.workspace_id=$1 AND p.deleted_at IS NULL
          AND (coalesce(p.draft->'baseAssetIds', '[]'::jsonb) ? $2::text
               OR jsonb_path_exists(p.draft, '$.variants[*].assetIds[*] ? (@ == $id)', jsonb_build_object('id', $2::text))))::int AS drafts,
       (SELECT count(*) FROM source_snapshots ss WHERE ss.workspace_id=$1 AND ss.asset_id=$2)::int AS snapshots`,
    [workspaceId, assetId]);
}

interface TrashRow { id: string; brand_id: string; title: string | null; version?: number; archived_at: Date | null; deleted_at: Date | null; deleted_by: string | null; purge_after: Date | null; status?: string }

async function loadRow(ctx: Ctx, db: Queryable, kind: TrashKind, id: string, lock: boolean): Promise<TrashRow> {
  assertUuid(id, kind === 'post' ? 'Post' : 'Asset');
  const sql = kind === 'post'
    ? `SELECT id, brand_id, title, version, archived_at, deleted_at, deleted_by, purge_after FROM posts WHERE id=$1 AND workspace_id=$2 ${lock ? 'FOR UPDATE' : ''}`
    : `SELECT id, brand_id, original_filename AS title, archived_at, deleted_at, deleted_by, purge_after, status::text AS status FROM assets WHERE id=$1 AND workspace_id=$2 ${lock ? 'FOR UPDATE' : ''}`;
  const row = await maybeOne<TrashRow>(db, sql, [id, ctx.access.workspaceId]);
  if (!row || !brandAllowed(ctx, row.brand_id)) throw notFound(kind === 'post' ? 'Post' : 'Asset');
  return row;
}

function consequencesFor(kind: TrashKind, row: TrashRow, f: PostFacts | AssetFacts): { blocked: string | null; consequences: string[] } {
  const days = TRASH_RETENTION_DAYS[kind];
  const c: string[] = [`Moves to Trash. You can restore it for ${days} days; after that it is deleted permanently.`];
  let blocked: string | null = null;
  if (row.deleted_at) blocked = 'Already in Trash.';
  if (kind === 'post') {
    const p = f as PostFacts;
    if (p.live_schedules > 0) blocked ??= 'This post is scheduled or waiting for approval. Cancel the schedule first.';
    if (p.active_deliveries > 0) blocked ??= 'Publishing is in progress for this post.';
    if (p.published_deliveries > 0) blocked ??= 'This post was published. Archive it instead; Relay never deletes posts from social networks.';
    c.push('Nothing on social networks is deleted or changed.', 'Restoring it later does not schedule or publish it.');
  } else {
    const a = f as AssetFacts;
    if (a.live_schedules > 0 || a.active_deliveries > 0) blocked ??= 'This file is used by a scheduled post. Cancel or finish that post first.';
    if (a.drafts > 0) c.push(`Used by ${a.drafts} draft${a.drafts === 1 ? '' : 's'}: they keep working, and the file is not deleted permanently while a draft uses it.`);
    c.push('Posts already published with this file are not affected.');
  }
  return { blocked, consequences: c };
}

/** GET /api/trash/consequences — explain before a destructive action. */
export async function trashConsequences(ctx: Ctx, kind: TrashKind, id: string): Promise<TrashConsequences> {
  requireAction(ctx, READ_PERMISSION[kind]);
  const db = getPool();
  const row = await loadRow(ctx, db, kind, id, false);
  const f = kind === 'post' ? await postFacts(db, ctx.access.workspaceId, id) : await assetFacts(db, ctx.access.workspaceId, id);
  const { blocked, consequences } = consequencesFor(kind, row, f);
  const may = authorizeCtx(ctx, KIND_PERMISSION[kind], { brandId: row.brand_id }).allowed;
  return {
    kind, id, title: row.title, can_trash: may && !blocked, blocked_reason: may ? blocked : 'You do not have permission to delete this.', consequences,
    references: kind === 'post'
      ? { live_schedules: (f as PostFacts).live_schedules, active_deliveries: f.active_deliveries, drafts: 0, published_deliveries: (f as PostFacts).published_deliveries }
      : { live_schedules: f.live_schedules, active_deliveries: f.active_deliveries, drafts: (f as AssetFacts).drafts, published_deliveries: 0 },
    retention_days: TRASH_RETENTION_DAYS[kind], external_posts_affected: false,
  };
}

/** Move to trash inside the caller's transaction (used by the API and by bulk jobs). */
export async function trashTx(tx: Queryable, ctx: Ctx, kind: TrashKind, id: string, opts: { expectedVersion?: number | null } = {}): Promise<TrashResult> {
  const row = await loadRow(ctx, tx, kind, id, true);
  if (row.deleted_at) throw new AppError('invalid_state', 'Already in Trash', undefined, { reason: 'already_trashed' });
  if (kind === 'post' && opts.expectedVersion != null && row.version !== opts.expectedVersion) {
    throw new AppError('version_conflict', 'This post changed since you loaded it. Reload and try again.', undefined, { current: { version: row.version } });
  }
  const f = kind === 'post' ? await postFacts(tx, ctx.access.workspaceId, id) : await assetFacts(tx, ctx.access.workspaceId, id);
  const { blocked } = consequencesFor(kind, row, f);
  if (blocked) throw new AppError('conflict', blocked, undefined, { reason: 'trash_blocked', references: f });
  const r = await one<{ deleted_at: Date; purge_after: Date }>(tx,
    `UPDATE ${kind === 'post' ? 'posts' : 'assets'} SET deleted_at=date_trunc('milliseconds', now()), deleted_by=$3,
            purge_after=date_trunc('milliseconds', now()) + make_interval(days => $4) WHERE id=$1 AND workspace_id=$2 RETURNING deleted_at, purge_after`,
    [id, ctx.access.workspaceId, ctx.actor.userId, TRASH_RETENTION_DAYS[kind]]);
  if (kind === 'post') {
    await tx.query(`UPDATE mcp_publication_intents SET status='invalidated', invalid_reason='The post was deleted.' WHERE post_id=$1 AND status IN ('prepared','confirmed')`, [id]);
  }
  await audit(tx, { workspaceId: ctx.access.workspaceId, brandId: row.brand_id, actorUserId: ctx.actor.userId, action: `${kind}.trashed`, resourceType: kind, resourceId: id,
    diff: { purge_after: r.purge_after.toISOString(), references: f }, correlationId: ctx.correlationId });
  return { kind, id, deleted_at: r.deleted_at.toISOString(), purge_after: r.purge_after.toISOString(),
    undo: { operation: 'trash.restore', kind, id, expected_deleted_at: r.deleted_at.toISOString() } };
}

export async function restoreTx(tx: Queryable, ctx: Ctx, kind: TrashKind, id: string, opts: { expectedDeletedAt?: string | null } = {}): Promise<RestoreResult> {
  const row = await loadRow(ctx, tx, kind, id, true);
  if (!row.deleted_at) throw new AppError('invalid_state', 'This item is not in Trash', undefined, { reason: 'not_trashed' });
  if (opts.expectedDeletedAt && new Date(opts.expectedDeletedAt).getTime() !== row.deleted_at.getTime()) {
    throw new AppError('conflict', 'This item changed since then (it was restored and deleted again). Reload Trash.', undefined, { reason: 'trash_state_changed' });
  }
  await tx.query(`UPDATE ${kind === 'post' ? 'posts' : 'assets'} SET deleted_at=NULL, deleted_by=NULL, purge_after=NULL${kind === 'asset' ? ', purge_blocked_reason=NULL' : ''} WHERE id=$1 AND workspace_id=$2`,
    [id, ctx.access.workspaceId]);
  await audit(tx, { workspaceId: ctx.access.workspaceId, brandId: row.brand_id, actorUserId: ctx.actor.userId, action: `${kind}.restored`, resourceType: kind, resourceId: id,
    diff: { deleted_at: row.deleted_at.toISOString(), republished: false }, correlationId: ctx.correlationId });
  return { kind, id, restored: true, republished: false,
    undo: { operation: 'trash.delete', kind, id, expected_deleted_at: null, expected_version: kind === 'post' ? (row.version ?? null) : null } };
}

/** POST /api/trash/items — move one item to Trash. */
export async function trashItem(ctx: Ctx, kind: TrashKind, id: string, opts: { expectedVersion?: number | null } = {}): Promise<TrashResult> {
  requireAction(ctx, KIND_PERMISSION[kind]);
  return withTx((tx) => trashTx(tx, ctx, kind, id, opts));
}

/** POST /api/trash/restore — restore one item (permission re-checked on its brand). */
export async function restoreItem(ctx: Ctx, kind: TrashKind, id: string, opts: { expectedDeletedAt?: string | null } = {}): Promise<RestoreResult> {
  requireAction(ctx, KIND_PERMISSION[kind]);
  return withTx((tx) => restoreTx(tx, ctx, kind, id, opts));
}

/** GET /api/trash — trashed posts and assets on brands the caller can read (newest first, cursor-paginated). */
export async function listTrash(ctx: Ctx, q: { kind?: TrashKind | null; brand_id?: string | null; cursor?: string | null; limit?: number | null }): Promise<{ items: TrashItemView[]; next_cursor: string | null; retention_days: Record<TrashKind, number> }> {
  const kinds: TrashKind[] = q.kind ? [q.kind] : ['post', 'asset'];
  const limit = Math.min(Math.max(q.limit ?? 50, 1), 100);
  const db = getPool();
  let cur: { t: string; id: string } | null = null;
  if (q.cursor) {
    try { cur = JSON.parse(Buffer.from(q.cursor, 'base64url').toString()) as { t: string; id: string }; } catch { throw new AppError('validation_failed', 'Invalid cursor'); }
  }
  if (q.brand_id) assertUuid(q.brand_id, 'Brand');
  const parts: string[] = [];
  const params: unknown[] = [ctx.access.workspaceId];
  const f = brandFilter(ctx, 'brand_id', 2);
  params.push(...f.params);
  if (q.brand_id) params.push(q.brand_id);
  const brandSql = q.brand_id ? ` AND brand_id = $${params.length}` : '';
  let curSql = '';
  if (cur) { params.push(cur.t, cur.id); curSql = ` AND (deleted_at, id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`; }
  for (const k of kinds) {
    parts.push(k === 'post'
      ? `SELECT 'post' AS kind, id, brand_id, title, deleted_at, deleted_by, purge_after, NULL::text AS purge_blocked_reason FROM posts WHERE workspace_id=$1 AND deleted_at IS NOT NULL AND ${f.sql}${brandSql}${curSql}`
      : `SELECT 'asset' AS kind, id, brand_id, original_filename AS title, deleted_at, deleted_by, purge_after, purge_blocked_reason FROM assets WHERE workspace_id=$1 AND deleted_at IS NOT NULL AND ${f.sql}${brandSql}${curSql}`);
  }
  params.push(limit * 3 + 1);
  const rows = await many<{ kind: TrashKind; id: string; brand_id: string; title: string | null; deleted_at: Date; deleted_by: string | null; purge_after: Date; purge_blocked_reason: string | null; email: string | null }>(db,
    `SELECT t.*, u.email FROM (${parts.join(' UNION ALL ')}) t LEFT JOIN users u ON u.id=t.deleted_by ORDER BY t.deleted_at DESC, t.id DESC LIMIT $${params.length}`, params);
  // Per-item authorization: read permission of that kind on that brand (guests/brand-scoped grants never see others).
  const visible = rows.filter((r) => authorizeCtx(ctx, READ_PERMISSION[r.kind], { brandId: r.brand_id }).allowed);
  const page = visible.slice(0, limit);
  const last = page[page.length - 1];
  return {
    items: page.map((r) => ({ kind: r.kind, id: r.id, brand_id: r.brand_id, title: r.title, deleted_at: r.deleted_at.toISOString(), deleted_by: r.email,
      purge_after: r.purge_after.toISOString(), purge_blocked_reason: r.purge_blocked_reason, can_restore: authorizeCtx(ctx, KIND_PERMISSION[r.kind], { brandId: r.brand_id }).allowed })),
    next_cursor: (visible.length > limit || rows.length > limit * 3) && last ? Buffer.from(JSON.stringify({ t: last.deleted_at.toISOString(), id: last.id })).toString('base64url') : null,
    retention_days: TRASH_RETENTION_DAYS,
  };
}

// ------------------------------------------------------------------ retention purge (worker)

const PURGE_ACTOR = 'worker:trash-purge';

/**
 * Physically delete trashed items whose retention has passed. Each item is re-checked in its own transaction:
 * posts with live/published work and assets with any remaining reference are kept (purge deferred, reason recorded).
 * Storage objects of a purged asset are deleted after the row commits (best effort; failures are logged).
 */
export async function purgeTrash(opts: { limit?: number; now?: Date } = {}): Promise<{ posts: number; assets: number; deferred: number }> {
  const limit = Math.min(opts.limit ?? 100, 500);
  const now = opts.now ?? new Date();
  const pool = getPool();
  let posts = 0; let assets = 0; let deferred = 0;
  const duePosts = await many<{ id: string }>(pool, `SELECT id FROM posts WHERE deleted_at IS NOT NULL AND purge_after <= $1 ORDER BY purge_after LIMIT $2`, [now, limit]);
  for (const { id } of duePosts) {
    await withTx(async (tx) => {
      const p = await maybeOne<{ id: string; workspace_id: string; brand_id: string; title: string | null; deleted_at: Date }>(tx,
        `SELECT id, workspace_id, brand_id, title, deleted_at FROM posts WHERE id=$1 AND deleted_at IS NOT NULL AND purge_after <= $2 FOR UPDATE SKIP LOCKED`, [id, now]);
      if (!p) return;
      const f = await postFacts(tx, p.workspace_id, p.id);
      if (f.live_schedules || f.active_deliveries || f.published_deliveries) {
        await tx.query(`UPDATE posts SET purge_after = $2::timestamptz + interval '1 day' WHERE id=$1`, [p.id, now]);
        await audit(tx, { workspaceId: p.workspace_id, brandId: p.brand_id, actorService: PURGE_ACTOR, action: 'post.purge_deferred', resourceType: 'post', resourceId: p.id, diff: { references: f } });
        deferred++;
        return;
      }
      await tx.query(`DELETE FROM posts WHERE id=$1`, [p.id]);
      await audit(tx, { workspaceId: p.workspace_id, brandId: p.brand_id, actorService: PURGE_ACTOR, action: 'post.purged', resourceType: 'post', resourceId: p.id,
        diff: { deleted_at: p.deleted_at.toISOString() } });
      posts++;
    });
  }
  const dueAssets = await many<{ id: string }>(pool, `SELECT id FROM assets WHERE deleted_at IS NOT NULL AND purge_after <= $1 ORDER BY purge_after LIMIT $2`, [now, limit]);
  for (const { id } of dueAssets) {
    const keys = await withTx(async (tx) => {
      const a = await maybeOne<{ id: string; workspace_id: string; brand_id: string; object_key: string; deleted_at: Date }>(tx,
        `SELECT id, workspace_id, brand_id, object_key, deleted_at FROM assets WHERE id=$1 AND deleted_at IS NOT NULL AND purge_after <= $2 FOR UPDATE SKIP LOCKED`, [id, now]);
      if (!a) return null;
      const f = await assetFacts(tx, a.workspace_id, a.id);
      const reason = f.live_schedules || f.active_deliveries ? 'used_by_scheduled_post' : f.drafts ? 'used_by_draft' : f.snapshots ? 'used_by_source_snapshot' : null;
      if (reason) {
        await tx.query(`UPDATE assets SET purge_after = $2::timestamptz + interval '1 day', purge_blocked_reason=$3 WHERE id=$1`, [a.id, now, reason]);
        await audit(tx, { workspaceId: a.workspace_id, brandId: a.brand_id, actorService: PURGE_ACTOR, action: 'asset.purge_deferred', resourceType: 'asset', resourceId: a.id, diff: { reason, references: f } });
        deferred++;
        return null;
      }
      const derivs = await many<{ object_key: string }>(tx, `SELECT object_key FROM asset_derivatives WHERE asset_id=$1`, [a.id]);
      await tx.query(`DELETE FROM assets WHERE id=$1`, [a.id]);
      await audit(tx, { workspaceId: a.workspace_id, brandId: a.brand_id, actorService: PURGE_ACTOR, action: 'asset.purged', resourceType: 'asset', resourceId: a.id,
        diff: { deleted_at: a.deleted_at.toISOString(), objects: derivs.length + 1 } });
      assets++;
      return [a.object_key, ...derivs.map((d) => d.object_key)];
    });
    for (const k of keys ?? []) {
      await deleteObject(k).catch((err) => log.warn('trash_purge_object_delete_failed', { assetId: id, err: err as Error }));
    }
  }
  // Housekeeping for the other V3.1 data tables (bounded deletes).
  await pool.query(`DELETE FROM draft_save_clients WHERE updated_at < $1::timestamptz - interval '30 days'`, [now]);
  await pool.query(`DELETE FROM bulk_jobs WHERE id IN (SELECT id FROM bulk_jobs WHERE status IN ('completed','completed_with_errors','failed','cancelled')
                      AND finished_at < $1::timestamptz - interval '90 days' LIMIT 1000)`, [now]);
  return { posts, assets, deferred };
}
