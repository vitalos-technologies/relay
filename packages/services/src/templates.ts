// Reusable text templates per brand. Readable by anyone with brand access; editable by drafters.
import { AppError, notFound } from '@social-lite/core';
import { getPool, many, maybeOne, withTx, type Queryable } from '@social-lite/db';
import { audit } from './audit.js';
import type { Ctx } from './context.js';
import { assertBrand, assertUuid, brandAllowed, requireAction } from './tenancy.js';

export interface TemplateDto {
  id: string; brand_id: string; name: string; body: string; tags: string[]; created_by: string | null; created_at: string;
}

interface TemplateRow { id: string; workspace_id: string; brand_id: string; name: string; body: string; tags: string[]; created_by: string | null; created_at: Date; archived_at: Date | null }

const dto = (t: TemplateRow): TemplateDto => ({
  id: t.id, brand_id: t.brand_id, name: t.name, body: t.body, tags: t.tags, created_by: t.created_by, created_at: t.created_at.toISOString(),
});

function validate(p: { name?: string; body?: string; tags?: string[] }): { name?: string; body?: string; tags?: string[] } {
  const out: { name?: string; body?: string; tags?: string[] } = {};
  if (p.name !== undefined) {
    out.name = p.name.trim();
    if (!out.name || out.name.length > 120) throw new AppError('validation_failed', 'Name must be 1-120 characters', { name: 'Must be 1-120 characters' });
  }
  if (p.body !== undefined) {
    if (p.body.length > 10_000) throw new AppError('validation_failed', 'Template is too long', { body: 'Up to 10,000 characters' });
    out.body = p.body;
  }
  if (p.tags !== undefined) {
    const tags = [...new Set(p.tags.map((t) => t.trim()).filter(Boolean))];
    if (tags.length > 30 || tags.some((t) => t.length > 50)) throw new AppError('validation_failed', 'Too many or too long tags', { tags: 'Up to 30 tags of 50 characters' });
    out.tags = tags;
  }
  return out;
}

export async function listTemplates(ctx: Ctx, brandId: string, db: Queryable = getPool()): Promise<TemplateDto[]> {
  await assertBrand(ctx, brandId, db);
  const rows = await many<TemplateRow>(db,
    `SELECT * FROM templates WHERE workspace_id=$1 AND brand_id=$2 AND archived_at IS NULL ORDER BY lower(name), id`, [ctx.access.workspaceId, brandId]);
  return rows.map(dto);
}

async function loadTemplate(ctx: Ctx, id: string, db: Queryable, lock = false): Promise<TemplateRow> {
  assertUuid(id, 'Template');
  const t = await maybeOne<TemplateRow>(db, `SELECT * FROM templates WHERE id=$1 AND workspace_id=$2 ${lock ? 'FOR UPDATE' : ''}`, [id, ctx.access.workspaceId]);
  if (!t || t.archived_at || !brandAllowed(ctx, t.brand_id)) throw notFound('Template');
  return t;
}

export async function getTemplate(ctx: Ctx, id: string): Promise<TemplateDto> {
  return dto(await loadTemplate(ctx, id, getPool()));
}

export async function createTemplate(ctx: Ctx, brandId: string, input: { name: string; body: string; tags?: string[] }): Promise<TemplateDto> {
  requireAction(ctx, 'drafts.edit');
  const v = validate({ name: input.name, body: input.body, tags: input.tags ?? [] });
  return withTx(async (tx) => {
    const brand = await assertBrand(ctx, brandId, tx);
    if (brand.archived_at) throw notFound('Brand');
    const t = (await maybeOne<TemplateRow>(tx,
      `INSERT INTO templates(workspace_id, brand_id, name, body, tags, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [ctx.access.workspaceId, brandId, v.name, v.body, v.tags, ctx.actor.userId]))!;
    await audit(tx, { workspaceId: ctx.access.workspaceId, brandId, actorUserId: ctx.actor.userId, action: 'template.created',
      resourceType: 'template', resourceId: t.id, diff: { name: t.name }, correlationId: ctx.correlationId });
    return dto(t);
  });
}

export async function updateTemplate(ctx: Ctx, id: string, patch: { name?: string; body?: string; tags?: string[] }): Promise<TemplateDto> {
  requireAction(ctx, 'drafts.edit');
  const v = validate(patch);
  return withTx(async (tx) => {
    const before = await loadTemplate(ctx, id, tx, true);
    const t = (await maybeOne<TemplateRow>(tx,
      `UPDATE templates SET name=coalesce($3,name), body=coalesce($4,body), tags=coalesce($5::text[],tags) WHERE id=$1 AND workspace_id=$2 RETURNING *`,
      [id, ctx.access.workspaceId, v.name ?? null, v.body ?? null, v.tags ?? null]))!;
    await audit(tx, { workspaceId: ctx.access.workspaceId, brandId: before.brand_id, actorUserId: ctx.actor.userId, action: 'template.updated',
      resourceType: 'template', resourceId: id, diff: { name: v.name !== undefined, body: v.body !== undefined, tags: v.tags }, correlationId: ctx.correlationId });
    return dto(t);
  });
}

export async function archiveTemplate(ctx: Ctx, id: string): Promise<void> {
  requireAction(ctx, 'drafts.edit');
  await withTx(async (tx) => {
    const t = await loadTemplate(ctx, id, tx, true);
    await tx.query(`UPDATE templates SET archived_at=now() WHERE id=$1 AND workspace_id=$2`, [id, ctx.access.workspaceId]);
    await audit(tx, { workspaceId: ctx.access.workspaceId, brandId: t.brand_id, actorUserId: ctx.actor.userId, action: 'template.archived',
      resourceType: 'template', resourceId: id, correlationId: ctx.correlationId });
  });
}
