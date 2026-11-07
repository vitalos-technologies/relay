// Draft version history (stream C). Every committed save is an immutable post_versions row; a save rejected by
// optimistic concurrency is kept as a 'conflict' copy so BOTH editors' work stays recoverable (spec §12 case 11).
// Consecutive autosaves by the same person within a short window are coalesced to keep history readable.
import { AppError, draftContentSchema, notFound, type DraftContent } from '@social-lite/core';
import { getPool, many, maybeOne, one, withTx, type Queryable } from '@social-lite/db';
import type { Ctx } from '../context.js';
import { audit } from '../audit.js';
import { assertUuid, requireAction } from '../tenancy.js';
import { loadPost, updateDraft } from './service.js';

const COALESCE_MINUTES = 10;
const MAX_LIST = 60;

export async function recordVersion(tx: Queryable, ctx: Ctx, p: {
  postId: string; version: number; baseVersion: number; kind: 'created' | 'saved' | 'restored'; title: string | null; draft: DraftContent; restoredFrom?: string | null;
}): Promise<void> {
  if (p.kind === 'saved') {
    // Coalesce an autosave burst: replace the same author's immediately preceding plain save.
    await tx.query(
      `DELETE FROM post_versions WHERE post_id=$1 AND version=$2 AND kind='saved' AND saved_by=$3 AND created_at > now() - make_interval(mins => $4)`,
      [p.postId, p.version - 1, ctx.actor.userId, COALESCE_MINUTES]);
  }
  await tx.query(
    `INSERT INTO post_versions(workspace_id, post_id, version, base_version, kind, title, draft, saved_by, restored_from)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [ctx.access.workspaceId, p.postId, p.version, p.baseVersion, p.kind, p.title, JSON.stringify(p.draft), ctx.actor.userId, p.restoredFrom ?? null]);
}

/** Keep a rejected (stale) save as a recoverable conflict copy. Separate transaction: the save itself rolled back. */
export async function saveConflictCopy(ctx: Ctx, postId: string, input: { expected_version: number; draft?: unknown; title?: string | null }): Promise<{ id: string } | null> {
  const parsed = draftContentSchema.safeParse(input.draft);
  if (!parsed.success) return null;
  return withTx(async (tx) => {
    const post = await loadPost(ctx, postId, tx);
    const row = await one<{ id: string }>(tx,
      `INSERT INTO post_versions(workspace_id, post_id, version, base_version, kind, title, draft, saved_by)
       VALUES ($1,$2,NULL,$3,'conflict',$4,$5,$6) RETURNING id`,
      [ctx.access.workspaceId, post.id, input.expected_version, input.title === undefined ? post.title : input.title, JSON.stringify(parsed.data), ctx.actor.userId]);
    await audit(tx, { workspaceId: ctx.access.workspaceId, brandId: post.brand_id, actorUserId: ctx.actor.userId, action: 'post.conflict_copy_saved',
      resourceType: 'post', resourceId: post.id, diff: { base_version: input.expected_version, current_version: post.version }, correlationId: ctx.correlationId });
    return row;
  });
}

interface VersionRow { id: string; version: number | null; base_version: number; kind: string; title: string | null; draft: DraftContent; saved_by: string | null; email: string | null; restored_from: string | null; created_at: Date }

function versionJson(v: VersionRow) {
  return { id: v.id, version: v.version, base_version: v.base_version, kind: v.kind, title: v.title, draft: v.draft,
    saved_by: v.saved_by, saved_by_email: v.email, restored_from: v.restored_from, created_at: v.created_at.toISOString() };
}

/** Versions (newest first) + immutable revisions (what was submitted/scheduled). */
export async function listVersions(ctx: Ctx, postId: string) {
  requireAction(ctx, 'content.read');
  const db = getPool();
  const post = await loadPost(ctx, postId, db);
  const versions = await many<VersionRow>(db,
    `SELECT v.id, v.version, v.base_version, v.kind, v.title, v.draft, v.saved_by, u.email, v.restored_from, v.created_at
       FROM post_versions v LEFT JOIN users u ON u.id=v.saved_by WHERE v.post_id=$1 AND v.workspace_id=$2
      ORDER BY v.created_at DESC, v.version DESC NULLS FIRST LIMIT $3`, [post.id, ctx.access.workspaceId, MAX_LIST]);
  const revisions = await many<{ id: string; revision_number: number; base_text: string; created_at: Date; email: string | null; statuses: string[] | null }>(db,
    `SELECT r.id, r.revision_number, r.base_text, r.created_at, u.email,
            (SELECT array_agg(DISTINCT s.status) FROM schedules s WHERE s.revision_id=r.id) AS statuses
       FROM post_revisions r LEFT JOIN users u ON u.id=r.created_by WHERE r.post_id=$1 ORDER BY r.revision_number DESC LIMIT 30`, [post.id]);
  return {
    current_version: post.version,
    versions: versions.map(versionJson),
    revisions: revisions.map((r) => ({ id: r.id, revision_number: r.revision_number, base_text: r.base_text, created_at: r.created_at.toISOString(), created_by_email: r.email, schedule_statuses: r.statuses ?? [] })),
  };
}

export async function getVersion(ctx: Ctx, postId: string, versionId: string) {
  requireAction(ctx, 'content.read');
  assertUuid(versionId, 'Version');
  const db = getPool();
  const post = await loadPost(ctx, postId, db);
  const v = await maybeOne<VersionRow>(db,
    `SELECT v.id, v.version, v.base_version, v.kind, v.title, v.draft, v.saved_by, u.email, v.restored_from, v.created_at
       FROM post_versions v LEFT JOIN users u ON u.id=v.saved_by WHERE v.id=$1 AND v.post_id=$2 AND v.workspace_id=$3`, [versionId, post.id, ctx.access.workspaceId]);
  if (!v) throw notFound('Version');
  return versionJson(v);
}

/** Restore a version (or a conflict copy) as the new working draft — itself an optimistic-concurrency save. */
export async function restoreVersion(ctx: Ctx, postId: string, versionId: string, expectedVersion: number) {
  requireAction(ctx, 'drafts.edit');
  const v = await getVersion(ctx, postId, versionId);
  if (!Number.isInteger(expectedVersion)) throw new AppError('validation_failed', 'expected_version is required', { expected_version: 'Required' });
  return updateDraft(ctx, postId, { expected_version: expectedVersion, draft: v.draft, title: v.title }, { kind: 'restored', restoredFrom: v.id });
}
