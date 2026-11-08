// Approved brand knowledge for the assistant (brief §16: "approved brand assets and selected document sources from the
// existing Content Hub"; "do not place all customer documents into an unscoped shared knowledge store").
// A brand manager (brands.manage on the brand) approves a linked Content Hub item or a saved reply for ONE brand, with
// optional topics and a review date. Text stays where it is and is read live per run with the requester's access.
import { z } from 'zod';
import { AppError, notFound } from '@social-lite/core';
import type { KnowledgeSourceDto } from '@social-lite/core/contracts/v35-ai';
import { getPool, many, maybeOne, one } from '@social-lite/db';
import type { Ctx } from '../context.js';
import { audit } from '../audit.js';
import { assertBrand, assertUuid, authorizeCtx, brandAllowed, requireAction } from '../tenancy.js';

export const knowledgeSchema = z.object({
  brand_id: z.string().uuid(),
  kind: z.enum(['source_item', 'saved_reply']),
  ref_id: z.string().uuid(),
  topics: z.array(z.string().trim().min(1).max(40)).max(10).optional(),
  review_by: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
}).strict();

export const knowledgePatchSchema = z.object({
  topics: z.array(z.string().trim().min(1).max(40)).max(10).optional(),
  review_by: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
}).strict();

interface Row { id: string; workspace_id: string; brand_id: string; kind: 'source_item' | 'saved_reply'; ref_id: string; title: string; topics: string[]; review_by: Date | null; approved_by: string | null; approved_at: Date; approver_name: string | null; available: boolean }

const SELECT = `SELECT k.*, coalesce(u.name, u.email) AS approver_name,
  CASE WHEN k.kind='source_item' THEN EXISTS (SELECT 1 FROM source_items si WHERE si.id=k.ref_id AND si.state='linked' AND si.last_snapshot_id IS NOT NULL)
       ELSE EXISTS (SELECT 1 FROM inbox_saved_replies sr WHERE sr.id=k.ref_id AND sr.archived_at IS NULL) END AS available
  FROM ai_knowledge_sources k LEFT JOIN users u ON u.id=k.approved_by`;

function dto(r: Row): KnowledgeSourceDto {
  const review = r.review_by ? r.review_by.toISOString().slice(0, 10) : null;
  return { id: r.id, brand_id: r.brand_id, kind: r.kind, ref_id: r.ref_id, title: r.title, topics: r.topics, review_by: review,
    approved_by: r.approved_by ? { id: r.approved_by, name: r.approver_name } : null, approved_at: r.approved_at.toISOString(), available: r.available,
    stale: !!review && review < new Date().toISOString().slice(0, 10) };
}

export async function listKnowledge(ctx: Ctx, q: { brand_id?: string | null } = {}): Promise<{ items: KnowledgeSourceDto[]; can_manage: boolean }> {
  const rows = await many<Row>(getPool(), `${SELECT} WHERE k.workspace_id=$1 AND k.revoked_at IS NULL ${q.brand_id ? 'AND k.brand_id=$2' : ''} ORDER BY k.approved_at DESC LIMIT 200`,
    q.brand_id ? [ctx.access.workspaceId, q.brand_id] : [ctx.access.workspaceId]);
  const visible = rows.filter((r) => brandAllowed(ctx, r.brand_id) && authorizeCtx(ctx, 'content.read', { brandId: r.brand_id }).allowed);
  return { items: visible.map(dto), can_manage: q.brand_id ? authorizeCtx(ctx, 'brands.manage', { brandId: q.brand_id }).allowed : false };
}

/** Candidates a manager can approve on a brand: linked Content Hub items and saved replies. */
export async function knowledgeCandidates(ctx: Ctx, brandId: string): Promise<{ items: Array<{ kind: 'source_item' | 'saved_reply'; ref_id: string; title: string; approved: boolean }> }> {
  await assertBrand(ctx, brandId);
  requireAction(ctx, 'brands.manage', { brandId });
  const items = await many<{ kind: 'source_item' | 'saved_reply'; ref_id: string; title: string; approved: boolean }>(getPool(),
    `SELECT 'source_item' AS kind, si.id AS ref_id, coalesce(si.title, 'Untitled document') AS title,
            EXISTS (SELECT 1 FROM ai_knowledge_sources k WHERE k.brand_id=$2 AND k.ref_id=si.id AND k.revoked_at IS NULL) AS approved
       FROM source_items si WHERE si.workspace_id=$1 AND si.brand_id=$2 AND si.state='linked' AND si.last_snapshot_id IS NOT NULL AND si.item_kind IN ('google_doc','notion_page','drive_file')
     UNION ALL
     SELECT 'saved_reply', sr.id, sr.title, EXISTS (SELECT 1 FROM ai_knowledge_sources k WHERE k.brand_id=$2 AND k.ref_id=sr.id AND k.revoked_at IS NULL)
       FROM inbox_saved_replies sr WHERE sr.workspace_id=$1 AND (sr.brand_id IS NULL OR sr.brand_id=$2) AND sr.archived_at IS NULL
     ORDER BY 3 LIMIT 200`, [ctx.access.workspaceId, brandId]);
  return { items };
}

export async function approveKnowledge(ctx: Ctx, input: z.infer<typeof knowledgeSchema>): Promise<KnowledgeSourceDto> {
  await assertBrand(ctx, input.brand_id);
  requireAction(ctx, 'brands.manage', { brandId: input.brand_id });
  const ref = input.kind === 'source_item'
    ? await maybeOne<{ title: string | null }>(getPool(), `SELECT title FROM source_items WHERE id=$1 AND workspace_id=$2 AND brand_id=$3 AND state='linked'`, [input.ref_id, ctx.access.workspaceId, input.brand_id])
    : await maybeOne<{ title: string | null }>(getPool(), `SELECT title FROM inbox_saved_replies WHERE id=$1 AND workspace_id=$2 AND (brand_id IS NULL OR brand_id=$3) AND archived_at IS NULL`, [input.ref_id, ctx.access.workspaceId, input.brand_id]);
  if (!ref) throw notFound(input.kind === 'source_item' ? 'Document' : 'Saved reply');
  const r = await maybeOne<{ id: string }>(getPool(),
    `INSERT INTO ai_knowledge_sources(workspace_id, brand_id, kind, ref_id, title, topics, review_by, approved_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (brand_id, kind, ref_id) WHERE revoked_at IS NULL DO NOTHING RETURNING id`,
    [ctx.access.workspaceId, input.brand_id, input.kind, input.ref_id, (ref.title ?? 'Untitled').slice(0, 200), input.topics ?? [], input.review_by ?? null, ctx.actor.userId]);
  if (!r) throw new AppError('conflict', 'Already approved for this brand.');
  await audit(getPool(), { workspaceId: ctx.access.workspaceId, brandId: input.brand_id, actorUserId: ctx.actor.userId, action: 'ai.knowledge_approved', resourceType: 'ai_knowledge_source', resourceId: r.id,
    diff: { kind: input.kind, ref_id: input.ref_id, review_by: input.review_by ?? null }, correlationId: ctx.correlationId });
  return dto(await one<Row>(getPool(), `${SELECT} WHERE k.id=$1`, [r.id]));
}

async function loadOwn(ctx: Ctx, id: string): Promise<Row> {
  assertUuid(id, 'Knowledge source');
  const r = await maybeOne<Row>(getPool(), `${SELECT} WHERE k.id=$1 AND k.workspace_id=$2 AND k.revoked_at IS NULL`, [id, ctx.access.workspaceId]);
  if (!r || !brandAllowed(ctx, r.brand_id)) throw notFound('Knowledge source');
  requireAction(ctx, 'brands.manage', { brandId: r.brand_id });
  return r;
}

export async function updateKnowledge(ctx: Ctx, id: string, input: z.infer<typeof knowledgePatchSchema>): Promise<KnowledgeSourceDto> {
  const r = await loadOwn(ctx, id);
  await getPool().query(`UPDATE ai_knowledge_sources SET topics=coalesce($2, topics), review_by=CASE WHEN $3 THEN $4::date ELSE review_by END WHERE id=$1`,
    [id, input.topics ?? null, input.review_by !== undefined, input.review_by ?? null]);
  await audit(getPool(), { workspaceId: ctx.access.workspaceId, brandId: r.brand_id, actorUserId: ctx.actor.userId, action: 'ai.knowledge_updated', resourceType: 'ai_knowledge_source', resourceId: id, diff: input, correlationId: ctx.correlationId });
  return dto(await one<Row>(getPool(), `${SELECT} WHERE k.id=$1`, [id]));
}

/** Revoke: the source is no longer retrieved by any later run (and policies referencing it lose it). */
export async function revokeKnowledge(ctx: Ctx, id: string): Promise<void> {
  const r = await loadOwn(ctx, id);
  await getPool().query(`UPDATE ai_knowledge_sources SET revoked_at=now(), revoked_by=$2 WHERE id=$1`, [id, ctx.actor.userId]);
  await audit(getPool(), { workspaceId: ctx.access.workspaceId, brandId: r.brand_id, actorUserId: ctx.actor.userId, action: 'ai.knowledge_revoked', resourceType: 'ai_knowledge_source', resourceId: id, correlationId: ctx.correlationId });
}
