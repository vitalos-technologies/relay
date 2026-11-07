// Campaigns (stream C): brand-scoped groupings; a post belongs to 0..1 campaign of its own brand
// (enforced by a composite foreign key). Lightweight on purpose: name, optional dates, archive.
import { AppError, notFound } from '@social-lite/core';
import { getPool, many, maybeOne, one, withTx } from '@social-lite/db';
import type { Ctx } from '../context.js';
import { audit } from '../audit.js';
import { assertBrand, assertUuid, authorizeCtx, requireAction } from '../tenancy.js';

interface CampaignRow { id: string; brand_id: string; name: string; description: string | null; starts_on: string | null; ends_on: string | null; archived_at: Date | null; created_at: Date; post_count?: number }

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function campaignJson(c: CampaignRow) {
  return { id: c.id, brand_id: c.brand_id, name: c.name, description: c.description, starts_on: c.starts_on, ends_on: c.ends_on,
    archived: !!c.archived_at, created_at: c.created_at.toISOString(), post_count: Number(c.post_count ?? 0) };
}

function checkInput(input: { name?: string; description?: string | null; starts_on?: string | null; ends_on?: string | null }) {
  if (input.name !== undefined && (!input.name.trim() || input.name.trim().length > 120)) throw new AppError('validation_failed', 'Name must be 1-120 characters', { name: 'Required' });
  if (input.description && input.description.length > 2000) throw new AppError('validation_failed', 'Description is too long', { description: 'Max 2000 characters' });
  for (const k of ['starts_on', 'ends_on'] as const) {
    const v = input[k];
    if (v && (!DATE_RE.test(v) || Number.isNaN(Date.parse(v)))) throw new AppError('validation_failed', 'Use YYYY-MM-DD', { [k]: 'Use YYYY-MM-DD' });
  }
  if (input.starts_on && input.ends_on && input.ends_on < input.starts_on) throw new AppError('validation_failed', 'End is before start', { ends_on: 'End is before start' });
}

const SELECT = `SELECT c.id, c.brand_id, c.name, c.description, to_char(c.starts_on, 'YYYY-MM-DD') starts_on, to_char(c.ends_on, 'YYYY-MM-DD') ends_on, c.archived_at, c.created_at,
  (SELECT count(*)::int FROM posts p WHERE p.campaign_id=c.id AND p.archived_at IS NULL) AS post_count FROM campaigns c`;

export async function listCampaigns(ctx: Ctx, brandId: string, opts: { archived?: boolean } = {}) {
  requireAction(ctx, 'content.read');
  const db = getPool();
  await assertBrand(ctx, brandId, db);
  const rows = await many<CampaignRow>(db, `${SELECT} WHERE c.workspace_id=$1 AND c.brand_id=$2 AND (c.archived_at IS NULL) = $3 ORDER BY c.starts_on NULLS LAST, c.name LIMIT 200`,
    [ctx.access.workspaceId, brandId, !opts.archived]);
  return { items: rows.map(campaignJson), can_manage: authorizeCtx(ctx, 'content.edit', { brandId }).allowed };
}

export async function createCampaign(ctx: Ctx, brandId: string, input: { name: string; description?: string | null; starts_on?: string | null; ends_on?: string | null }) {
  requireAction(ctx, 'content.edit');
  checkInput(input);
  return withTx(async (tx) => {
    const brand = await assertBrand(ctx, brandId, tx);
    const dup = await maybeOne(tx, `SELECT 1 FROM campaigns WHERE workspace_id=$1 AND brand_id=$2 AND lower(name)=lower($3) AND archived_at IS NULL`, [ctx.access.workspaceId, brand.id, input.name.trim()]);
    if (dup) throw new AppError('conflict', 'A campaign with this name exists', { name: 'Already in use' });
    const r = await one<{ id: string }>(tx,
      `INSERT INTO campaigns(workspace_id, brand_id, name, description, starts_on, ends_on, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [ctx.access.workspaceId, brand.id, input.name.trim(), input.description?.trim() || null, input.starts_on || null, input.ends_on || null, ctx.actor.userId]);
    await audit(tx, { workspaceId: ctx.access.workspaceId, brandId: brand.id, actorUserId: ctx.actor.userId, action: 'campaign.created', resourceType: 'campaign', resourceId: r.id,
      diff: { name: input.name.trim() }, correlationId: ctx.correlationId });
    return campaignJson((await one<CampaignRow>(tx, `${SELECT} WHERE c.id=$1`, [r.id])));
  });
}

export async function updateCampaign(ctx: Ctx, campaignId: string, input: { name?: string; description?: string | null; starts_on?: string | null; ends_on?: string | null; archived?: boolean }) {
  assertUuid(campaignId, 'Campaign');
  requireAction(ctx, 'content.edit');
  checkInput(input);
  return withTx(async (tx) => {
    const c = await maybeOne<CampaignRow>(tx, `${SELECT} WHERE c.id=$1 AND c.workspace_id=$2 FOR UPDATE OF c`, [campaignId, ctx.access.workspaceId]);
    if (!c) throw notFound('Campaign');
    await assertBrand(ctx, c.brand_id, tx);
    const merged = { starts_on: input.starts_on === undefined ? c.starts_on : input.starts_on, ends_on: input.ends_on === undefined ? c.ends_on : input.ends_on };
    checkInput(merged);
    await tx.query(
      `UPDATE campaigns SET name=coalesce($2,name), description=CASE WHEN $3::boolean THEN $4 ELSE description END, starts_on=$5, ends_on=$6,
              archived_at=CASE WHEN $7::boolean IS NULL THEN archived_at WHEN $7 THEN coalesce(archived_at, now()) ELSE NULL END WHERE id=$1`,
      [c.id, input.name?.trim() ?? null, input.description !== undefined, input.description?.trim() || null, merged.starts_on || null, merged.ends_on || null, input.archived ?? null]);
    await audit(tx, { workspaceId: ctx.access.workspaceId, brandId: c.brand_id, actorUserId: ctx.actor.userId, action: input.archived ? 'campaign.archived' : 'campaign.updated',
      resourceType: 'campaign', resourceId: c.id, correlationId: ctx.correlationId });
    return campaignJson((await one<CampaignRow>(tx, `${SELECT} WHERE c.id=$1`, [c.id])));
  });
}
