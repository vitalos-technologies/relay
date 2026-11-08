// V3.1 §9 draft resilience (server side).
//  - autosaveDraft: debounced autosave with optimistic concurrency (base_version) plus per-tab client revisions:
//    an out-of-order save from the same tab is ignored (never rolls content back), a retried save whose response was
//    lost returns the original result (no false conflict), and identical content never creates a new version.
//    A real conflict is a 409 version_conflict carrying the current server copy so the client can resolve; the
//    rejected content is kept as a conflict copy in History (posts/versions.ts) so nothing is lost.
//  - recoverDraft: sync content recovered from browser storage after refresh/restart. Rechecks permission (content.edit
//    on the brand, fresh policy) and revision: applied only when the server has not moved on; otherwise stored as a
//    conflict copy and NEVER overwrites the newer server version. Recovery only edits the working draft: it never
//    schedules, submits or publishes anything.
//  - recoveryStatus: what the client needs to decide (server newer? editable? own conflict copies? workspace policy).
// Revision history itself is posts/versions.ts (GET /api/posts/:id/versions).
import { createHash } from 'node:crypto';
import { AppError, draftContentSchema, notFound, type DraftContent } from '@social-lite/core';
import type { AutosaveResponse, DraftConflictDetails, DraftRecoveryStatus, RecoverResponse } from '@social-lite/core/contracts/v31-data';
import { getPool, many, maybeOne, one, withTx, type Queryable } from '@social-lite/db';
import type { Ctx } from '../context.js';
import { audit } from '../audit.js';
import { stableStringify } from '../idempotency.js';
import { assertUuid, authorizeCtx, brandAllowed, requireAction } from '../tenancy.js';
import { invalidatePendingApprovalIfChanged, loadPost, type PostRow } from '../posts/service.js';
import { recordVersion, saveConflictCopy } from '../posts/versions.js';
import { draftRecoveryPolicy } from './policy.js';
import { emitCollabEvent } from '../collab/events.js';

const CLIENT_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

export interface SaveInput { base_version: number; client_id: string; client_revision?: number; draft?: unknown; title?: string | null }

function contentHash(draft: DraftContent, title: string | null): string {
  return createHash('sha256').update(stableStringify({ d: { ...draft, baseLink: draft.baseLink ?? null }, t: title ?? null })).digest('hex');
}

function checkInput(input: SaveInput, needRevision: boolean): { draft: DraftContent | undefined } {
  if (!Number.isInteger(input.base_version) || input.base_version < 1) throw new AppError('validation_failed', 'base_version is required', { base_version: 'Required' });
  if (typeof input.client_id !== 'string' || !CLIENT_ID_RE.test(input.client_id)) throw new AppError('validation_failed', 'client_id must be 8-64 letters, digits, _ or -', { client_id: 'Invalid' });
  if (needRevision && (!Number.isSafeInteger(input.client_revision) || (input.client_revision as number) < 0)) {
    throw new AppError('validation_failed', 'client_revision must be a non-negative integer', { client_revision: 'Invalid' });
  }
  if (input.title !== undefined && input.title !== null && (typeof input.title !== 'string' || input.title.length > 200)) throw new AppError('validation_failed', 'Title is too long', { title: 'Max 200 characters' });
  const parsed = input.draft === undefined ? undefined : draftContentSchema.safeParse(input.draft);
  if (parsed && !parsed.success) throw new AppError('validation_failed', 'The draft is not valid', { draft: parsed.error.issues[0]?.message ?? 'Invalid' });
  return { draft: parsed?.success ? ({ ...parsed.data, baseLink: parsed.data.baseLink ?? null } as DraftContent) : undefined };
}

async function conflictDetails(db: Queryable, post: PostRow): Promise<DraftConflictDetails['current']> {
  const who = post.updated_by ? await maybeOne<{ email: string }>(db, `SELECT email FROM users WHERE id=$1`, [post.updated_by]) : null;
  return { version: post.version, updated_at: post.updated_at.toISOString(), updated_by: who?.email ?? null, title: post.title, draft: post.draft };
}

class Conflict extends Error { constructor(readonly current: DraftConflictDetails['current']) { super('conflict'); } }

type Outcome = { kind: 'saved'; version: number; savedAt: string; unchanged: boolean; duplicate: boolean } | { kind: 'stale'; version: number };

async function saveTx(ctx: Ctx, postId: string, input: SaveInput, draftIn: DraftContent | undefined, mode: 'autosave' | 'recover'): Promise<Outcome> {
  return withTx(async (tx) => {
    const post = await loadPost(ctx, postId, tx, true);
    if (post.archived_at) throw new AppError('invalid_state', 'This post is archived', undefined, { reason: 'archived' });
    const draft = draftIn ?? post.draft;
    const title = input.title === undefined ? post.title : (input.title ?? '');
    const hash = contentHash(draft, title);
    const serverHash = contentHash(post.draft, post.title);
    const prior = await maybeOne<{ last_client_revision: string; last_content_hash: string; last_version: number }>(tx,
      `SELECT last_client_revision, last_content_hash, last_version FROM draft_save_clients WHERE post_id=$1 AND user_id=$2 AND client_id=$3 FOR UPDATE`,
      [post.id, ctx.actor.userId, input.client_id]);
    const rev = input.client_revision ?? null;
    if (prior && rev !== null) {
      const last = Number(prior.last_client_revision);
      if (rev < last) return { kind: 'stale', version: post.version };
      if (rev === last && prior.last_content_hash === hash) {
        return { kind: 'saved', version: prior.last_version, savedAt: post.updated_at.toISOString(), unchanged: true, duplicate: true };
      }
    }
    const remember = async (version: number) => {
      if (rev === null) return;
      await tx.query(
        `INSERT INTO draft_save_clients(workspace_id, post_id, user_id, client_id, last_client_revision, last_content_hash, last_version, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,now())
         ON CONFLICT (post_id, user_id, client_id) DO UPDATE SET last_client_revision=$5, last_content_hash=$6, last_version=$7, updated_at=now()`,
        [ctx.access.workspaceId, post.id, ctx.actor.userId, input.client_id, rev, hash, version]);
    };
    // Same content as the server copy: nothing to save (even if the base is stale) — no version churn, no conflict.
    if (hash === serverHash) {
      await remember(post.version);
      return { kind: 'saved', version: post.version, savedAt: post.updated_at.toISOString(), unchanged: true, duplicate: false };
    }
    if (post.version !== input.base_version) throw new Conflict(await conflictDetails(tx, post));
    const r = await one<{ version: number; updated_at: Date }>(tx,
      `UPDATE posts SET draft=$2, title=$3, version=version+1, updated_at=now(), updated_by=$4 WHERE id=$1 RETURNING version, updated_at`,
      [post.id, JSON.stringify(draft), title, ctx.actor.userId]);
    await recordVersion(tx, ctx, { postId: post.id, version: r.version, baseVersion: post.version, kind: mode === 'recover' ? 'recovered' : 'saved', title, draft });
    if (draftIn) {
      // Same consequences as any draft change: pending approvals and prepared MCP publication intents are invalidated.
      await invalidatePendingApprovalIfChanged(tx, ctx, post, draft);
      await tx.query(`UPDATE mcp_publication_intents SET status='invalidated', invalid_reason='The post changed.' WHERE post_id=$1 AND status IN ('prepared','confirmed')`, [post.id]);
    }
    await remember(r.version);
    // Collaboration: other open editors learn a newer version exists (content-free event; they refetch).
    await emitCollabEvent(tx, { workspaceId: ctx.access.workspaceId, brandId: post.brand_id, postId: post.id, audience: 'staff', kind: 'post.saved', refId: String(r.version), actorId: ctx.actor.userId });
    if (mode === 'recover') {
      await audit(tx, { workspaceId: ctx.access.workspaceId, brandId: post.brand_id, actorUserId: ctx.actor.userId, action: 'post.recovered_content_applied',
        resourceType: 'post', resourceId: post.id, diff: { base_version: input.base_version, version: r.version }, correlationId: ctx.correlationId });
    }
    return { kind: 'saved', version: r.version, savedAt: r.updated_at.toISOString(), unchanged: false, duplicate: false };
  });
}

/** PUT /api/posts/:id/autosave */
export async function autosaveDraft(ctx: Ctx, postId: string, input: SaveInput): Promise<AutosaveResponse> {
  requireAction(ctx, 'content.edit');
  const { draft } = checkInput(input, true);
  try {
    const o = await saveTx(ctx, postId, input, draft, 'autosave');
    if (o.kind === 'stale') return { status: 'stale_ignored', post_id: postId, version: o.version };
    return { status: 'saved', post_id: postId, version: o.version, saved_at: o.savedAt, unchanged: o.unchanged, duplicate: o.duplicate };
  } catch (err) {
    if (!(err instanceof Conflict)) throw err;
    const copy = draft ? await saveConflictCopy(ctx, postId, { expected_version: input.base_version, draft, title: input.title }).catch(() => null) : null;
    const details: DraftConflictDetails = { current: err.current, conflict_copy_id: copy?.id ?? null };
    throw new AppError('version_conflict', 'Someone else saved this post since you opened it', undefined, details as unknown as Record<string, unknown>);
  }
}

/** POST /api/posts/:id/recover — sync content recovered from local (browser) storage. */
export async function recoverDraft(ctx: Ctx, postId: string, input: SaveInput & { local_saved_at?: string | null }): Promise<RecoverResponse> {
  requireAction(ctx, 'content.edit');
  const { draft } = checkInput({ ...input, client_revision: undefined }, false);
  if (!draft) throw new AppError('validation_failed', 'draft is required', { draft: 'Required' });
  try {
    const o = await saveTx(ctx, postId, { ...input, client_revision: undefined }, draft, 'recover');
    if (o.kind !== 'saved') throw new AppError('internal', 'Unexpected recovery state');
    return { status: 'applied', post_id: postId, version: o.version, saved_at: o.savedAt, unchanged: o.unchanged };
  } catch (err) {
    if (!(err instanceof Conflict)) throw err;
    // Never overwrite a newer server revision: keep the recovered content as a conflict copy for the person to compare.
    const copy = await saveConflictCopy(ctx, postId, { expected_version: input.base_version, draft, title: input.title });
    if (!copy) throw new AppError('internal', 'Could not keep the recovered copy');
    return { status: 'kept_as_copy', post_id: postId, conflict_copy_id: copy.id, current_version: err.current.version, current_updated_at: err.current.updated_at, current_updated_by: err.current.updated_by };
  }
}

/** GET /api/posts/:id/recovery-status?base_version=N — read-only; safe to call before syncing recovered content. */
export async function recoveryStatus(ctx: Ctx, postId: string, baseVersion: number | null): Promise<DraftRecoveryStatus> {
  requireAction(ctx, 'content.read');
  assertUuid(postId, 'Post');
  const db = getPool();
  const row = await maybeOne<PostRow & { deleted_at: Date | null }>(db, `SELECT * FROM posts WHERE id=$1 AND workspace_id=$2`, [postId, ctx.access.workspaceId]);
  if (!row || !brandAllowed(ctx, row.brand_id)) throw notFound('Post');
  const policy = await draftRecoveryPolicy(db, ctx.access.workspaceId, ctx.actor.userId);
  const canEdit = authorizeCtx(ctx, 'content.edit', { brandId: row.brand_id }).allowed;
  const blocked = row.deleted_at ? 'trashed' : row.archived_at ? 'archived' : !canEdit ? 'no_permission' : null;
  const who = row.updated_by ? await maybeOne<{ email: string }>(db, `SELECT email FROM users WHERE id=$1`, [row.updated_by]) : null;
  const copies = await many<{ id: string; base_version: number; created_at: Date }>(db,
    `SELECT id, base_version, created_at FROM post_versions WHERE post_id=$1 AND workspace_id=$2 AND kind='conflict' AND saved_by=$3 ORDER BY created_at DESC LIMIT 5`,
    [row.id, ctx.access.workspaceId, ctx.actor.userId]);
  return {
    post_id: row.id, current_version: row.version, updated_at: row.updated_at.toISOString(), updated_by: who?.email ?? null,
    editable: blocked === null, blocked_reason: blocked,
    server_newer: baseVersion === null ? null : row.version > baseVersion,
    conflict_copies: copies.map((c) => ({ id: c.id, base_version: c.base_version, created_at: c.created_at.toISOString() })),
    policy,
  };
}
