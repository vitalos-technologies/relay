// Server-side ingest into the media pipeline (V3 Content Hub imports from Drive/Notion). Bytes fetched by the server
// are written to the asset's private original key and then go through EXACTLY the same validation/quarantine and
// derivative path as browser uploads (completeUpload: sniffed type, polyglot check, decode limits, re-encode; videos
// are queued for the worker). Nothing from the source (URLs, names) is trusted beyond a sanitized display filename.
import { AppError } from '@social-lite/core';
import { maybeOne, withTx } from '@social-lite/db';
import { audit } from '../audit.js';
import { config } from '../config.js';
import type { Ctx } from '../context.js';
import { reserveUsage, settleByRef } from '../product/budgets.js';
import { ensureBucket, putObject } from '../storage.js';
import { assertBrand, requireAction } from '../tenancy.js';
import { completeUpload, originalKey, type AssetDto } from './assets.js';
import { ALLOWED_MIME, MAX_UPLOAD_BYTES } from './process.js';
import { MAX_VIDEO_UPLOAD_BYTES, VIDEO_MIME } from './video.js';

export function ingestKind(mime: string | null | undefined): 'image' | 'video' | null {
  if (!mime) return null;
  if ((ALLOWED_MIME as readonly string[]).includes(mime)) return 'image';
  if ((VIDEO_MIME as readonly string[]).includes(mime)) return 'video';
  return null;
}

export function ingestLimit(kind: 'image' | 'video'): number {
  return kind === 'image' ? MAX_UPLOAD_BYTES : MAX_VIDEO_UPLOAD_BYTES;
}

function sanitize(name: string): string {
  // eslint-disable-next-line no-control-regex
  const clean = (name.split(/[\\/]/).pop() ?? '').replace(/[\u0000-\u001f\u007f"<>‪-‮⁦-⁩]/g, '').trim().slice(0, 200);
  return clean || 'import';
}

/**
 * Store server-fetched bytes as a new asset of `brandId` and validate them through the media pipeline.
 * Returns the asset (ready | rejected | quarantined for videos awaiting the worker).
 */
export async function ingestServerBytes(ctx: Ctx, p: { brandId: string; filename: string; declaredMime: string; bytes: Uint8Array; origin: Record<string, unknown> }): Promise<AssetDto> {
  requireAction(ctx, 'assets.upload', { brandId: p.brandId });
  const brand = await assertBrand(ctx, p.brandId);
  if (brand.archived_at) throw new AppError('invalid_state', 'This brand is archived');
  const kind = ingestKind(p.declaredMime);
  if (!kind) throw new AppError('unsupported_media', 'Only JPEG and PNG images and MP4 or MOV videos can be imported.');
  if (p.bytes.byteLength === 0) throw new AppError('validation_failed', 'The file is empty.');
  if (p.bytes.byteLength > ingestLimit(kind)) throw new AppError('payload_too_large', kind === 'image' ? 'Images must be 20 MB or smaller.' : `Videos must be ${MAX_VIDEO_UPLOAD_BYTES / 1_048_576} MB or smaller.`);
  if (config().APP_ENV !== 'production') await ensureBucket();
  const filename = sanitize(p.filename);
  const row = await withTx(async (tx) => {
    const id = (await maybeOne<{ id: string }>(tx, `SELECT gen_random_uuid() AS id`))!.id;
    const key = originalKey(ctx.access.workspaceId, brand.id, id);
    await reserveUsage({ workspaceId: ctx.access.workspaceId, meter: 'storage.bytes', amount: p.bytes.byteLength, userId: ctx.actor.userId, ref: `asset:${id}`, ttlSeconds: 24 * 3600 }, tx);
    await tx.query(
      `INSERT INTO assets(id, workspace_id, brand_id, uploaded_by, object_key, original_filename, declared_mime, declared_bytes, status, media_kind)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending_upload',$9)`,
      [id, ctx.access.workspaceId, brand.id, ctx.actor.userId, key, filename, p.declaredMime, p.bytes.byteLength, kind]);
    await audit(tx, { workspaceId: ctx.access.workspaceId, brandId: brand.id, actorUserId: ctx.actor.userId, action: 'asset.server_ingest',
      resourceType: 'asset', resourceId: id, diff: { filename, declared_mime: p.declaredMime, bytes: p.bytes.byteLength, origin: p.origin }, correlationId: ctx.correlationId });
    return { id, key };
  });
  try {
    await putObject(row.key, p.bytes, p.declaredMime, { 'asset-id': row.id, origin: 'content-hub' });
  } catch (err) {
    await withTx(async (tx) => {
      await tx.query(`UPDATE assets SET status='rejected', rejection_reason='Storage write failed' WHERE id=$1 AND status='pending_upload'`, [row.id]);
      await settleByRef(ctx.access.workspaceId, `asset:${row.id}`, null, tx);
    });
    throw err;
  }
  // Same validation path as browser uploads (images synchronously; videos quarantined for the worker).
  return completeUpload(ctx, row.id);
}
