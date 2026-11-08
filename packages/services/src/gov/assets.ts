// V3.1 §12 — asset governance: ownership/licence notes, expiry, superseded/archived lifecycle. Changes never touch
// drafts or schedules; posts that use the asset are re-evaluated and listed for review (brand-rules.ts).
// Read: assets.read on the asset's brand. Write: assets.manage.
import { z } from 'zod';
import { AppError, notFound } from '@social-lite/core';
import type { AssetGovernanceDto } from '@social-lite/core/contracts/v31-gov';
import { getPool, many, maybeOne, withTx, type Queryable } from '@social-lite/db';
import type { Ctx } from '../context.js';
import { audit } from '../audit.js';
import { assertUuid, brandAllowed, requireAction } from '../tenancy.js';
import { flagAffectedContent } from './brand-rules.js';

export const assetGovernanceSchema = z.object({
  ownership: z.enum(['owned', 'licensed', 'stock', 'partner', 'user_generated', 'unknown']).optional(),
  owner_name: z.string().trim().max(200).nullish(),
  licence: z.string().trim().max(200).nullish(),
  licence_url: z.string().trim().max(2048).regex(/^https?:\/\//, 'Use an http(s) link').nullish(),
  notes: z.string().trim().max(2000).nullish(),
  expires_at: z.string().datetime({ offset: true }).nullish(),
  lifecycle: z.enum(['active', 'superseded', 'archived']).optional(),
  superseded_by: z.string().uuid().nullish(),
}).strict();

const EXPIRING_MS = 14 * 86_400_000;

interface Row {
  asset_id: string; brand_id: string; ownership: AssetGovernanceDto['ownership']; owner_name: string | null; licence: string | null; licence_url: string | null;
  notes: string | null; expires_at: Date | null; lifecycle: AssetGovernanceDto['lifecycle']; superseded_by: string | null; updated_at: Date | null;
}

async function loadAsset(ctx: Ctx, assetId: string, db: Queryable): Promise<{ id: string; brand_id: string }> {
  assertUuid(assetId, 'Asset');
  const a = await maybeOne<{ id: string; brand_id: string }>(db, `SELECT id, brand_id FROM assets WHERE id=$1 AND workspace_id=$2`, [assetId, ctx.access.workspaceId]);
  if (!a || !brandAllowed(ctx, a.brand_id)) throw notFound('Asset');
  return a;
}

export async function getAssetGovernance(ctx: Ctx, assetId: string, db: Queryable = getPool(), now = new Date()): Promise<AssetGovernanceDto> {
  const a = await loadAsset(ctx, assetId, db);
  requireAction(ctx, 'assets.read', { brandId: a.brand_id });
  const g = await maybeOne<Row>(db, `SELECT * FROM asset_governance WHERE asset_id=$1 AND workspace_id=$2`, [a.id, ctx.access.workspaceId]);
  const logo = await maybeOne(db, `SELECT 1 FROM brand_profiles WHERE brand_id=$1 AND $2 = ANY(logo_asset_ids)`, [a.brand_id, a.id]);
  const usage = await maybeOne<{ drafts: number; live: number }>(db,
    `SELECT (SELECT count(*)::int FROM posts p WHERE p.workspace_id=$1 AND p.archived_at IS NULL AND (p.draft->'baseAssetIds' ? $2::text
               OR EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(p.draft->'variants','[]'::jsonb)) v WHERE v->'assetIds' ? $2::text))) AS drafts,
            (SELECT count(DISTINCT s.id)::int FROM schedules s JOIN variants v ON v.revision_id=s.revision_id
              WHERE s.workspace_id=$1 AND s.status IN ('active','pending_approval') AND $2::uuid = ANY(v.asset_ids)) AS live`, [ctx.access.workspaceId, a.id]);
  const exp = g?.expires_at ?? null;
  return {
    asset_id: a.id, brand_id: a.brand_id, ownership: g?.ownership ?? 'unknown', owner_name: g?.owner_name ?? null, licence: g?.licence ?? null,
    licence_url: g?.licence_url ?? null, notes: g?.notes ?? null, expires_at: exp?.toISOString() ?? null, lifecycle: g?.lifecycle ?? 'active',
    superseded_by: g?.superseded_by ?? null,
    expiry_state: !exp ? 'none' : exp.getTime() <= now.getTime() ? 'expired' : exp.getTime() - now.getTime() <= EXPIRING_MS ? 'expiring' : 'ok',
    is_approved_logo: !!logo, usage: { drafts: usage?.drafts ?? 0, live_schedules: usage?.live ?? 0 }, updated_at: g?.updated_at?.toISOString() ?? null,
  };
}

export async function setAssetGovernance(ctx: Ctx, assetId: string, raw: unknown) {
  const input = assetGovernanceSchema.parse(raw);
  const db = getPool();
  const a = await loadAsset(ctx, assetId, db);
  requireAction(ctx, 'assets.manage', { brandId: a.brand_id, message: 'You cannot change this asset’s governance' });
  if (input.superseded_by) {
    if (input.superseded_by === a.id) throw new AppError('validation_failed', 'An asset cannot supersede itself', { superseded_by: 'Pick another asset' });
    const s = await maybeOne(db, `SELECT 1 FROM assets WHERE id=$1 AND workspace_id=$2 AND brand_id=$3`, [input.superseded_by, ctx.access.workspaceId, a.brand_id]);
    if (!s) throw new AppError('validation_failed', 'The replacement must be an asset of the same brand', { superseded_by: 'Pick an asset of this brand' });
  }
  const lifecycle = input.superseded_by ? 'superseded' : input.lifecycle;
  if (input.superseded_by === undefined && lifecycle && lifecycle !== 'superseded') input.superseded_by = null;
  await withTx(async (tx) => {
    const before = await maybeOne<Row>(tx, `SELECT * FROM asset_governance WHERE asset_id=$1 FOR UPDATE`, [a.id]);
    await tx.query(
      `INSERT INTO asset_governance(asset_id, workspace_id, brand_id, ownership, owner_name, licence, licence_url, notes, expires_at, lifecycle, superseded_by, updated_by)
       VALUES ($1,$2,$3,coalesce($4,'unknown'),$5,$6,$7,$8,$9,coalesce($10,'active'),$11,$12)
       ON CONFLICT (asset_id) DO UPDATE SET
         ownership=coalesce($4, asset_governance.ownership),
         owner_name=CASE WHEN $13 THEN $5 ELSE asset_governance.owner_name END,
         licence=CASE WHEN $14 THEN $6 ELSE asset_governance.licence END,
         licence_url=CASE WHEN $15 THEN $7 ELSE asset_governance.licence_url END,
         notes=CASE WHEN $16 THEN $8 ELSE asset_governance.notes END,
         expires_at=CASE WHEN $17 THEN $9 ELSE asset_governance.expires_at END,
         lifecycle=coalesce($10, asset_governance.lifecycle),
         superseded_by=CASE WHEN $18 THEN $11 ELSE asset_governance.superseded_by END,
         updated_by=$12, updated_at=now()`,
      [a.id, ctx.access.workspaceId, a.brand_id, input.ownership ?? null, input.owner_name ?? null, input.licence ?? null, input.licence_url ?? null, input.notes ?? null,
        input.expires_at ? new Date(input.expires_at) : null, lifecycle ?? null, input.superseded_by ?? null, ctx.actor.userId,
        input.owner_name !== undefined, input.licence !== undefined, input.licence_url !== undefined, input.notes !== undefined, input.expires_at !== undefined, input.superseded_by !== undefined]);
    await tx.query(
      `INSERT INTO brand_profiles(workspace_id, brand_id, rules_version, updated_by) VALUES ($1,$2,1,$3)
       ON CONFLICT (brand_id) DO UPDATE SET rules_version=brand_profiles.rules_version+1, updated_by=$3, updated_at=now()`, [ctx.access.workspaceId, a.brand_id, ctx.actor.userId]);
    await audit(tx, { workspaceId: ctx.access.workspaceId, brandId: a.brand_id, actorUserId: ctx.actor.userId, action: 'asset.governance_updated', resourceType: 'asset', resourceId: a.id,
      diff: { before: before ? { lifecycle: before.lifecycle, expires_at: before.expires_at?.toISOString() ?? null } : null, after: { lifecycle: lifecycle ?? before?.lifecycle ?? 'active', expires_at: input.expires_at }, fields: Object.keys(input) },
      correlationId: ctx.correlationId });
  }).catch((e) => {
    if ((e as { code?: string }).code === '23514') throw new AppError('validation_failed', 'Only a superseded asset can name a replacement', { superseded_by: 'Set lifecycle to superseded' });
    throw e;
  });
  const impact = await flagAffectedContent(ctx, a.brand_id);
  return { ...(await getAssetGovernance(ctx, a.id)), impact };
}

/** Governance for a brand's assets that need attention (expired / expiring / superseded / archived). */
export async function listAssetGovernance(ctx: Ctx, brandId: string, db: Queryable = getPool()) {
  assertUuid(brandId, 'Brand');
  if (!brandAllowed(ctx, brandId)) throw notFound('Brand');
  requireAction(ctx, 'assets.read', { brandId });
  const rows = await many<Row & { original_filename: string | null }>(db,
    `SELECT g.*, a.original_filename FROM asset_governance g JOIN assets a ON a.id=g.asset_id
      WHERE g.workspace_id=$1 AND g.brand_id=$2 AND (g.lifecycle <> 'active' OR g.expires_at < now() + interval '14 days')
      ORDER BY g.expires_at NULLS LAST, g.updated_at DESC LIMIT 200`, [ctx.access.workspaceId, brandId]);
  const now = Date.now();
  return {
    items: rows.map((g) => ({
      asset_id: g.asset_id, name: g.original_filename, lifecycle: g.lifecycle, superseded_by: g.superseded_by, expires_at: g.expires_at?.toISOString() ?? null,
      expiry_state: !g.expires_at ? 'none' : g.expires_at.getTime() <= now ? 'expired' : 'expiring', ownership: g.ownership, licence: g.licence,
    })),
  };
}
