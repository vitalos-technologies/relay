// Saved replies (workspace or brand) and personal saved views (filters only).
import { AppError, notFound } from '@social-lite/core';
import { getPool, many, maybeOne, one } from '@social-lite/db';
import { z } from 'zod';
import type { Ctx } from '../context.js';
import { audit } from '../audit.js';
import { assertUuid, authorizeCtx, brandAllowed, requireAction } from '../tenancy.js';

export interface SavedReplyDto { id: string; brand_id: string | null; title: string; body: string; updated_at: string }

export const savedReplySchema = z.object({ brand_id: z.string().uuid().nullable().optional(), title: z.string().trim().min(1).max(80), body: z.string().trim().min(1).max(2000) }).strict();

export async function listSavedReplies(ctx: Ctx, q: { brand_id?: string | null } = {}): Promise<{ items: SavedReplyDto[] }> {
  requireAction(ctx, 'inbox.read');
  const rows = await many<{ id: string; brand_id: string | null; title: string; body: string; updated_at: Date }>(getPool(),
    `SELECT id, brand_id, title, body, updated_at FROM inbox_saved_replies WHERE workspace_id=$1 AND archived_at IS NULL AND ($2::uuid IS NULL OR brand_id IS NULL OR brand_id=$2) ORDER BY title LIMIT 200`,
    [ctx.access.workspaceId, q.brand_id ?? null]);
  return { items: rows.filter((r) => !r.brand_id || (brandAllowed(ctx, r.brand_id) && authorizeCtx(ctx, 'inbox.read', { brandId: r.brand_id }).allowed)).map((r) => ({ ...r, updated_at: r.updated_at.toISOString() })) };
}

export async function saveSavedReply(ctx: Ctx, input: z.infer<typeof savedReplySchema>, id?: string): Promise<SavedReplyDto> {
  requireAction(ctx, 'inbox.manage', input.brand_id ? { brandId: input.brand_id } : undefined);
  if (id) assertUuid(id, 'Saved reply');
  const r = id
    ? await maybeOne<{ id: string; brand_id: string | null; title: string; body: string; updated_at: Date }>(getPool(),
      `UPDATE inbox_saved_replies SET brand_id=$3, title=$4, body=$5, updated_at=now() WHERE id=$1 AND workspace_id=$2 AND archived_at IS NULL RETURNING id, brand_id, title, body, updated_at`, [id, ctx.access.workspaceId, input.brand_id ?? null, input.title, input.body])
    : await one<{ id: string; brand_id: string | null; title: string; body: string; updated_at: Date }>(getPool(),
      `INSERT INTO inbox_saved_replies(workspace_id, brand_id, title, body, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id, brand_id, title, body, updated_at`, [ctx.access.workspaceId, input.brand_id ?? null, input.title, input.body, ctx.actor.userId]);
  if (!r) throw notFound('Saved reply');
  await audit(getPool(), { workspaceId: ctx.access.workspaceId, brandId: input.brand_id ?? null, actorUserId: ctx.actor.userId, action: 'inbox.saved_reply_saved', resourceType: 'inbox_saved_reply', resourceId: r.id, correlationId: ctx.correlationId });
  return { ...r, updated_at: r.updated_at.toISOString() };
}

export async function archiveSavedReply(ctx: Ctx, id: string): Promise<void> {
  assertUuid(id, 'Saved reply');
  const r = await maybeOne<{ brand_id: string | null }>(getPool(), `SELECT brand_id FROM inbox_saved_replies WHERE id=$1 AND workspace_id=$2 AND archived_at IS NULL`, [id, ctx.access.workspaceId]);
  if (!r) throw notFound('Saved reply');
  requireAction(ctx, 'inbox.manage', r.brand_id ? { brandId: r.brand_id } : undefined);
  await getPool().query(`UPDATE inbox_saved_replies SET archived_at=now() WHERE id=$1`, [id]);
}

export const savedViewSchema = z.object({ name: z.string().trim().min(1).max(60), filters: z.record(z.string(), z.string().max(200)).refine((f) => Object.keys(f).length <= 12, 'Too many filters') }).strict();

export async function listSavedViews(ctx: Ctx): Promise<{ items: Array<{ id: string; name: string; filters: Record<string, string> }> }> {
  requireAction(ctx, 'inbox.read');
  return { items: await many(getPool(), `SELECT id, name, filters FROM inbox_saved_views WHERE workspace_id=$1 AND user_id=$2 ORDER BY created_at LIMIT 50`, [ctx.access.workspaceId, ctx.actor.userId]) };
}

export async function createSavedView(ctx: Ctx, input: z.infer<typeof savedViewSchema>): Promise<{ id: string; name: string; filters: Record<string, string> }> {
  requireAction(ctx, 'inbox.read');
  const n = await one<{ n: number }>(getPool(), `SELECT count(*)::int n FROM inbox_saved_views WHERE workspace_id=$1 AND user_id=$2`, [ctx.access.workspaceId, ctx.actor.userId]);
  if (n.n >= 50) throw new AppError('invalid_state', 'You have 50 saved views. Delete one first.');
  return one(getPool(), `INSERT INTO inbox_saved_views(workspace_id, user_id, name, filters) VALUES ($1,$2,$3,$4) RETURNING id, name, filters`, [ctx.access.workspaceId, ctx.actor.userId, input.name, JSON.stringify(input.filters)]);
}

export async function deleteSavedView(ctx: Ctx, id: string): Promise<void> {
  assertUuid(id, 'View');
  await getPool().query(`DELETE FROM inbox_saved_views WHERE id=$1 AND workspace_id=$2 AND user_id=$3`, [id, ctx.access.workspaceId, ctx.actor.userId]);
}
