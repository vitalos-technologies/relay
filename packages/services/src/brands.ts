// Brands: list/create/get/update/pause. Brand-restricted members only see granted brands.
import { z } from 'zod';
import { AppError, isValidTimeZone, notFound } from '@social-lite/core';
import { getPool, many, maybeOne, withTx, type Queryable } from '@social-lite/db';
import { audit } from './audit.js';
import type { Ctx } from './context.js';
import { onScopePaused, onScopeResumed } from './engine/hooks.js';
import { assertBrand, brandFilter, requireAction, type BrandRow } from './tenancy.js';

export interface BrandVoice {
  tone?: string; terminology?: string[]; prohibited?: string[]; default_cta?: string; hashtags?: string[]; footer?: string;
}

export interface BrandDto {
  id: string; name: string; timezone: string; approval_required: boolean; editors_can_publish: boolean; default_deadline_minutes: number;
  publishing_paused: boolean; paused_reason: string | null; paused_at: string | null; voice: BrandVoice; is_demo: boolean;
  connection_count: number; created_at: string;
}

export const brandVoiceSchema = z.object({
  tone: z.string().trim().max(500).optional(),
  terminology: z.array(z.string().trim().min(1).max(100)).max(50).optional(),
  prohibited: z.array(z.string().trim().min(1).max(100)).max(100).optional(),
  default_cta: z.string().trim().max(300).optional(),
  hashtags: z.array(z.string().trim().min(1).max(100)).max(30).optional(),
  footer: z.string().trim().max(500).optional(),
}).strict();

export function brandDto(b: BrandRow & { connection_count?: number | string }): BrandDto {
  return {
    id: b.id, name: b.name, timezone: b.timezone, approval_required: b.approval_required, editors_can_publish: b.editors_can_publish,
    default_deadline_minutes: b.default_deadline_minutes, publishing_paused: b.publishing_paused, paused_reason: b.paused_reason,
    paused_at: b.paused_at?.toISOString() ?? null, voice: (b.voice ?? {}) as BrandVoice, is_demo: b.is_demo,
    connection_count: Number(b.connection_count ?? 0), created_at: b.created_at.toISOString(),
  };
}

const CONN_COUNT = `(SELECT count(*) FROM connections c WHERE c.workspace_id = b.workspace_id AND c.brand_id = b.id AND c.disconnected_at IS NULL)::int`;

export async function listBrands(ctx: Ctx, db: Queryable = getPool()): Promise<BrandDto[]> {
  const f = brandFilter(ctx, 'b.id', 2);
  const rows = await many<BrandRow & { connection_count: number }>(db,
    `SELECT b.*, ${CONN_COUNT} AS connection_count FROM brands b
      WHERE b.workspace_id = $1 AND b.archived_at IS NULL AND ${f.sql} ORDER BY b.name, b.id`, [ctx.access.workspaceId, ...f.params]);
  return rows.map(brandDto);
}

export async function getBrand(ctx: Ctx, brandId: string, db: Queryable = getPool()): Promise<BrandDto> {
  const b = await assertBrand(ctx, brandId, db);
  if (b.archived_at) throw notFound('Brand');
  const row = (await maybeOne<BrandRow & { connection_count: number }>(db,
    `SELECT b.*, ${CONN_COUNT} AS connection_count FROM brands b WHERE b.id=$1 AND b.workspace_id=$2`, [brandId, ctx.access.workspaceId]))!;
  return brandDto(row);
}

function checkName(name: string): string {
  const n = name.trim();
  if (n.length < 1 || n.length > 120) throw new AppError('validation_failed', 'Name must be 1-120 characters', { name: 'Must be 1-120 characters' });
  return n;
}
function checkTz(tz: string): string {
  if (!isValidTimeZone(tz) || tz.length > 64) throw new AppError('validation_failed', 'Unknown time zone', { timezone: 'Use an IANA time zone such as Europe/London' });
  return tz;
}

export async function createBrand(ctx: Ctx, input: { name: string; timezone?: string }): Promise<BrandDto> {
  requireAction(ctx, 'brands.manage');
  const name = checkName(input.name);
  const tzIn = input.timezone !== undefined ? checkTz(input.timezone) : null;
  const id = await withTx(async (tx) => {
    const exists = await maybeOne<{ id: string }>(tx,
      `SELECT id FROM brands WHERE workspace_id=$1 AND lower(name)=lower($2) AND archived_at IS NULL`, [ctx.access.workspaceId, name]);
    if (exists) throw new AppError('conflict', 'A brand with this name already exists', { name: 'Already in use' });
    const b = (await maybeOne<{ id: string }>(tx,
      `INSERT INTO brands(workspace_id, name, timezone, is_demo)
       SELECT w.id, $2, coalesce($3, w.timezone), w.is_demo FROM workspaces w WHERE w.id=$1 RETURNING id`,
      [ctx.access.workspaceId, name, tzIn]))!;
    await audit(tx, { workspaceId: ctx.access.workspaceId, brandId: b.id, actorUserId: ctx.actor.userId, action: 'brand.created',
      resourceType: 'brand', resourceId: b.id, diff: { name, timezone: tzIn }, correlationId: ctx.correlationId });
    return b.id;
  });
  return getBrand(ctx, id);
}

export interface BrandPatch {
  name?: string; timezone?: string; approval_required?: boolean; editors_can_publish?: boolean;
  default_deadline_minutes?: number; voice?: BrandVoice;
}

export async function updateBrand(ctx: Ctx, brandId: string, patch: BrandPatch): Promise<BrandDto> {
  requireAction(ctx, 'brands.manage');
  const name = patch.name !== undefined ? checkName(patch.name) : null;
  const tz = patch.timezone !== undefined ? checkTz(patch.timezone) : null;
  if (patch.default_deadline_minutes !== undefined && (!Number.isInteger(patch.default_deadline_minutes) || patch.default_deadline_minutes < 1 || patch.default_deadline_minutes > 10080)) {
    throw new AppError('validation_failed', 'Deadline must be 1-10080 minutes', { default_deadline_minutes: 'Must be between 1 and 10080 minutes' });
  }
  const voice = patch.voice !== undefined ? brandVoiceSchema.parse(patch.voice) : null;
  await withTx(async (tx) => {
    const before = await assertBrand(ctx, brandId, tx);
    if (before.archived_at) throw notFound('Brand');
    if (name && name.toLowerCase() !== before.name.toLowerCase()) {
      const exists = await maybeOne<{ id: string }>(tx,
        `SELECT id FROM brands WHERE workspace_id=$1 AND lower(name)=lower($2) AND archived_at IS NULL AND id<>$3`, [ctx.access.workspaceId, name, brandId]);
      if (exists) throw new AppError('conflict', 'A brand with this name already exists', { name: 'Already in use' });
    }
    await tx.query(
      `UPDATE brands SET name=coalesce($3,name), timezone=coalesce($4,timezone), approval_required=coalesce($5,approval_required),
              editors_can_publish=coalesce($6,editors_can_publish), default_deadline_minutes=coalesce($7,default_deadline_minutes),
              voice=coalesce($8::jsonb, voice)
        WHERE id=$1 AND workspace_id=$2`,
      [brandId, ctx.access.workspaceId, name, tz, patch.approval_required ?? null, patch.editors_can_publish ?? null,
        patch.default_deadline_minutes ?? null, voice ? JSON.stringify(voice) : null]);
    const changed: Record<string, unknown> = {};
    if (name !== null && name !== before.name) changed.name = { from: before.name, to: name };
    if (tz !== null && tz !== before.timezone) changed.timezone = { from: before.timezone, to: tz };
    if (patch.approval_required !== undefined && patch.approval_required !== before.approval_required) changed.approval_required = { from: before.approval_required, to: patch.approval_required };
    if (patch.editors_can_publish !== undefined && patch.editors_can_publish !== before.editors_can_publish) changed.editors_can_publish = { from: before.editors_can_publish, to: patch.editors_can_publish };
    if (patch.default_deadline_minutes !== undefined && patch.default_deadline_minutes !== before.default_deadline_minutes) changed.default_deadline_minutes = { from: before.default_deadline_minutes, to: patch.default_deadline_minutes };
    if (voice) changed.voice = true;
    await audit(tx, { workspaceId: ctx.access.workspaceId, brandId, actorUserId: ctx.actor.userId, action: 'brand.updated',
      resourceType: 'brand', resourceId: brandId, diff: changed, correlationId: ctx.correlationId });
  });
  return getBrand(ctx, brandId);
}

/** Emergency pause/resume for one brand (SC-05). Engine hooks run in the same transaction. */
export async function setBrandPaused(ctx: Ctx, brandId: string, input: { paused: boolean; reason?: string | null }): Promise<BrandDto & { affected: Record<string, number> }> {
  requireAction(ctx, 'pause.emergency');
  const reason = input.reason?.trim().slice(0, 500) || null;
  const affected = await withTx(async (tx) => {
    await assertBrand(ctx, brandId, tx);
    const before = (await maybeOne<BrandRow>(tx, `SELECT * FROM brands WHERE id=$1 AND workspace_id=$2 FOR UPDATE`, [brandId, ctx.access.workspaceId]))!;
    if (before.archived_at) throw notFound('Brand');
    if (input.paused) {
      await tx.query(
        `UPDATE brands SET publishing_paused=true, paused_reason=$3, paused_by=$4, paused_at=CASE WHEN publishing_paused THEN paused_at ELSE now() END
          WHERE id=$1 AND workspace_id=$2`, [brandId, ctx.access.workspaceId, reason, ctx.actor.userId]);
    } else {
      await tx.query(
        `UPDATE brands SET publishing_paused=false, paused_reason=NULL, paused_by=NULL, paused_at=NULL WHERE id=$1 AND workspace_id=$2`,
        [brandId, ctx.access.workspaceId]);
    }
    let a: Record<string, number> = {};
    if (input.paused) a = { paused: await onScopePaused(tx, { workspaceId: ctx.access.workspaceId, brandId }) };
    else if (before.publishing_paused) a = await onScopeResumed(tx, { workspaceId: ctx.access.workspaceId, brandId });
    await audit(tx, { workspaceId: ctx.access.workspaceId, brandId, actorUserId: ctx.actor.userId, action: input.paused ? 'brand.paused' : 'brand.resumed',
      resourceType: 'brand', resourceId: brandId, diff: { reason, was_paused: before.publishing_paused, ...a }, correlationId: ctx.correlationId });
    return a;
  });
  return { ...(await getBrand(ctx, brandId)), affected };
}
