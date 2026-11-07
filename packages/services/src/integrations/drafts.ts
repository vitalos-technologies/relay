// Draft creation by a SERVICE-ACCOUNT principal (TipSignal, API keys). The only permission needed is
// `content.create_draft` on the target brand (integration preset), checked through the real policy path. The
// integration cannot edit, schedule, publish, read content or upload arbitrary files: it supplies text and
// (TipSignal only) a server-rendered image that runs through the same image validation + derivative pipeline.
// Rows carry no human author (created_by / uploaded_by NULL); attribution is audit actor_service.
import { AppError, notFound } from '@social-lite/core';
import { getPool, one, withTx } from '@social-lite/db';
import type { Ctx } from '../context.js';
import { audit } from '../audit.js';
import { log } from '../log.js';
import { requireAction } from '../tenancy.js';
import { brandConnections } from '../posts/shared.js';
import { derivativeKey, originalKey } from '../media/assets.js';
import { processImage, TRANSFORM_VERSION } from '../media/process.js';
import { deleteObject, ensureBucket, putObject } from '../storage.js';
import { config } from '../config.js';
import { serviceActor } from '../service-accounts.js';

export interface IntegrationDraftInput {
  title: string;
  text: string;
  image?: { bytes: Buffer; filename: string; mime: 'image/png' | 'image/jpeg' };
  source?: Record<string, unknown>;
  tags?: string[];
}

async function storeImage(ctx: Ctx, brandId: string, actorService: string, img: NonNullable<IntegrationDraftInput['image']>): Promise<string | null> {
  const result = await processImage(img.bytes, img.mime);
  if (!result.ok) {
    log.warn('integration_image_rejected', { code: result.code });
    return null;
  }
  if (config().APP_ENV !== 'production') await ensureBucket();
  const ws = ctx.access.workspaceId;
  const id = (await one<{ id: string }>(getPool(), `SELECT gen_random_uuid() AS id`)).id;
  const key = originalKey(ws, brandId, id);
  const written: string[] = [];
  try {
    await putObject(key, img.bytes, result.mime);
    written.push(key);
    const stored: Array<{ variant: string; key: string; mime: string; bytes: number; width: number; height: number; sha256: string }> = [];
    for (const d of result.derivatives) {
      const k = derivativeKey(ws, brandId, id, d.variant, d.ext);
      await putObject(k, d.data, d.mime, { 'asset-id': id, 'transform-version': String(TRANSFORM_VERSION) });
      written.push(k);
      stored.push({ variant: d.variant, key: k, mime: d.mime, bytes: d.bytes, width: d.width, height: d.height, sha256: d.sha256 });
    }
    await withTx(async (tx) => {
      await tx.query(
        `INSERT INTO assets(id, workspace_id, brand_id, uploaded_by, object_key, original_filename, declared_mime, declared_bytes, status, media_kind,
                            mime, bytes, width, height, checksum_sha256, validated_at, tags)
         VALUES ($1,$2,$3,NULL,$4,$5,$6,$7,'ready','image',$6,$7,$8,$9,$10,now(),$11)`,
        [id, ws, brandId, key, img.filename.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120), result.mime, result.bytes, result.width, result.height, result.sha256, ['integration']]);
      for (const d of stored) {
        await tx.query(`INSERT INTO asset_derivatives(workspace_id, asset_id, variant, object_key, mime, bytes, width, height, checksum_sha256, transform_version)
                        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [ws, id, d.variant, d.key, d.mime, d.bytes, d.width, d.height, d.sha256, TRANSFORM_VERSION]);
      }
      await audit(tx, { workspaceId: ws, brandId, actorService, action: 'asset.ready', resourceType: 'asset', resourceId: id,
        diff: { mime: result.mime, bytes: result.bytes, width: result.width, height: result.height, via: 'integration' }, correlationId: ctx.correlationId });
    });
    return id;
  } catch (err) {
    for (const k of written) await deleteObject(k).catch(() => undefined);
    throw err;
  }
}

/** Create a draft (never scheduled/published) on `brandId` as the service account `serviceAccountId`. */
export async function createIntegrationDraft(ctx: Ctx, serviceAccountId: string, brandId: string, input: IntegrationDraftInput): Promise<{ id: string }> {
  requireAction(ctx, 'content.create_draft', { brandId });
  const ws = ctx.access.workspaceId;
  const brand = await one<{ n: number }>(getPool(), `SELECT count(*)::int n FROM brands WHERE id=$1 AND workspace_id=$2 AND archived_at IS NULL`, [brandId, ws]);
  if (!brand.n) throw notFound('Brand');
  const text = input.text.slice(0, 10_000);
  if (!text.trim()) throw new AppError('validation_failed', 'Text is required', { text: 'Required' });
  const actorService = serviceActor(serviceAccountId);
  const assetId = input.image ? await storeImage(ctx, brandId, actorService, input.image) : null;
  const conns = (await brandConnections(getPool(), ws, brandId)).filter((c) => ['ready', 'expiring'].includes(c.status));
  const draft = { baseText: text, baseLink: null, baseAssetIds: assetId ? [assetId] : [],
    variants: conns.map((c) => ({ connectionId: c.id, inheritText: true, inheritMedia: true })) };
  return withTx(async (tx) => {
    const post = await one<{ id: string }>(tx,
      `INSERT INTO posts(workspace_id, brand_id, created_by, updated_by, title, draft, source, tags) VALUES ($1,$2,NULL,NULL,$3,$4,$5,$6) RETURNING id`,
      [ws, brandId, input.title.slice(0, 200), JSON.stringify(draft), JSON.stringify({ ...(input.source ?? {}), service_account_id: serviceAccountId }), input.tags ?? []]);
    await audit(tx, { workspaceId: ws, brandId, actorService, action: 'post.created', resourceType: 'post', resourceId: post.id,
      diff: { via: 'service_account', key: ctx.actor.sessionId.startsWith('api-key:') ? ctx.actor.sessionId.slice(8) : null }, correlationId: ctx.correlationId });
    return post;
  });
}
