// Media library service (ME-01..ME-05). Assets belong to a brand; every query is scoped to
// ctx.access.workspaceId and the caller's brand grants. Cross-tenant ⇒ not_found.
import { AppError, forbidden, notFound, type MediaFacts, type PublishMedia } from '@social-lite/core';
import { getPool, many, maybeOne, withTx, type Queryable } from '@social-lite/db';
import { audit } from '../audit.js';
import { config } from '../config.js';
import type { Ctx } from '../context.js';
import { log } from '../log.js';
import { assertBrand, assertUuid, brandAllowed, brandFilter, isUuid, requireAction } from '../tenancy.js';
import {
  deleteObject, ensureBucket, getObjectBytes, headObject, ObjectTooLargeError, presignUpload, putObject, signedGetUrl,
} from '../storage.js';
import { ALLOWED_MIME, MAX_UPLOAD_BYTES, processImage, TRANSFORM_VERSION } from './process.js';

export const PREVIEW_URL_TTL_SECONDS = 300;
export const UPLOAD_URL_TTL_SECONDS = 600;

export type AssetStatus = 'pending_upload' | 'quarantined' | 'ready' | 'rejected' | 'archived';

export interface AssetDto {
  id: string; brand_id: string; status: AssetStatus; rejection_reason: string | null;
  original_filename: string | null; mime: string | null; bytes: number | null; width: number | null; height: number | null;
  alt_text: string | null; tags: string[]; created_at: string;
  preview_url: string | null; thumb_url: string | null; usage_count: number;
}

interface AssetRow {
  id: string; workspace_id: string; brand_id: string; uploaded_by: string | null; object_key: string;
  original_filename: string | null; declared_mime: string | null; declared_bytes: string | null;
  mime: string | null; checksum_sha256: string | null; bytes: string | null; width: number | null; height: number | null;
  status: AssetStatus; rejection_reason: string | null; alt_text: string | null; tags: string[];
  created_at: Date; created_at_cursor?: string; usage_count?: number;
}

const USAGE_SQL = `(SELECT count(*) FROM posts p
   WHERE p.workspace_id = a.workspace_id AND p.brand_id = a.brand_id AND p.archived_at IS NULL
     AND (coalesce(p.draft->'baseAssetIds', '[]'::jsonb) ? a.id::text
          OR jsonb_path_exists(p.draft, '$.variants[*].assetIds[*] ? (@ == $id)', jsonb_build_object('id', a.id::text))))::int`;

export const originalKey = (workspaceId: string, brandId: string, assetId: string) => `originals/${workspaceId}/${brandId}/${assetId}`;
export const derivativeKey = (workspaceId: string, brandId: string, assetId: string, variant: string, ext: string, version = TRANSFORM_VERSION) =>
  `derivatives/${workspaceId}/${brandId}/${assetId}/v${version}/${variant}.${ext}`;

function sanitizeFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? 'upload';
  // eslint-disable-next-line no-control-regex
  const clean = base.replace(/[\u0000-\u001f\u007f"<>]/g, '').trim().slice(0, 200);
  return clean || 'upload';
}

async function toDtos(rows: AssetRow[]): Promise<AssetDto[]> {
  if (!rows.length) return [];
  const readyIds = rows.filter((r) => r.status === 'ready' || r.status === 'archived').map((r) => r.id);
  const derivs = readyIds.length
    ? await many<{ asset_id: string; variant: string; object_key: string; mime: string }>(getPool(),
      `SELECT asset_id, variant, object_key, mime FROM asset_derivatives
        WHERE asset_id = ANY($1::uuid[]) AND variant IN ('thumb','preview') AND transform_version = $2`, [readyIds, TRANSFORM_VERSION])
    : [];
  const byAsset = new Map<string, Map<string, { key: string; mime: string }>>();
  for (const d of derivs) {
    if (!byAsset.has(d.asset_id)) byAsset.set(d.asset_id, new Map());
    byAsset.get(d.asset_id)!.set(d.variant, { key: d.object_key, mime: d.mime });
  }
  return Promise.all(rows.map(async (r) => {
    const d = byAsset.get(r.id);
    const preview = d?.get('preview');
    const thumb = d?.get('thumb');
    return {
      id: r.id, brand_id: r.brand_id, status: r.status, rejection_reason: r.rejection_reason,
      original_filename: r.original_filename, mime: r.mime ?? r.declared_mime,
      bytes: r.bytes !== null ? Number(r.bytes) : r.declared_bytes !== null ? Number(r.declared_bytes) : null,
      width: r.width, height: r.height, alt_text: r.alt_text, tags: r.tags, created_at: r.created_at.toISOString(),
      preview_url: preview ? await signedGetUrl(preview.key, PREVIEW_URL_TTL_SECONDS, { contentType: preview.mime }) : null,
      thumb_url: thumb ? await signedGetUrl(thumb.key, PREVIEW_URL_TTL_SECONDS, { contentType: thumb.mime }) : null,
      usage_count: r.usage_count ?? 0,
    };
  }));
}

/** Load an asset the caller may see (workspace + brand grant), else not_found. */
async function loadAsset(ctx: Ctx, assetId: string, db: Queryable = getPool(), lock = false): Promise<AssetRow> {
  assertUuid(assetId, 'Asset');
  const row = await maybeOne<AssetRow>(db,
    `SELECT a.*, ${USAGE_SQL} AS usage_count FROM assets a WHERE a.id = $1 AND a.workspace_id = $2 ${lock ? 'FOR UPDATE OF a' : ''}`,
    [assetId, ctx.access.workspaceId]);
  if (!row || !brandAllowed(ctx, row.brand_id)) throw notFound('Asset');
  return row;
}

// ------------------------------------------------------------------ upload

export interface UploadIntentInput { brand_id: string; filename: string; content_type: string; bytes: number }
export interface UploadIntent { asset_id: string; upload: { method: 'POST'; url: string; fields: Record<string, string> }; expires_at: string; max_bytes: number }

export async function createUploadIntent(ctx: Ctx, input: UploadIntentInput): Promise<UploadIntent> {
  requireAction(ctx, 'assets.upload');
  const brand = await assertBrand(ctx, input.brand_id);
  if (brand.archived_at) throw notFound('Brand');
  if (!(ALLOWED_MIME as readonly string[]).includes(input.content_type)) {
    throw new AppError('unsupported_media', 'Only JPEG and PNG images are supported.', { content_type: 'Only image/jpeg and image/png are supported' });
  }
  if (!Number.isInteger(input.bytes) || input.bytes <= 0) throw new AppError('validation_failed', 'File size is invalid', { bytes: 'Must be a positive integer' });
  if (input.bytes > MAX_UPLOAD_BYTES) throw new AppError('payload_too_large', 'Images must be 20 MB or smaller.');
  if (config().APP_ENV !== 'production') await ensureBucket();

  const filename = sanitizeFilename(input.filename);
  const row = await withTx(async (tx) => {
    const id = (await maybeOne<{ id: string }>(tx, `SELECT gen_random_uuid() AS id`))!.id;
    const key = originalKey(ctx.access.workspaceId, brand.id, id);
    await tx.query(
      `INSERT INTO assets(id, workspace_id, brand_id, uploaded_by, object_key, original_filename, declared_mime, declared_bytes, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending_upload')`,
      [id, ctx.access.workspaceId, brand.id, ctx.actor.userId, key, filename, input.content_type, input.bytes]);
    await audit(tx, { workspaceId: ctx.access.workspaceId, brandId: brand.id, actorUserId: ctx.actor.userId, action: 'asset.upload_intent',
      resourceType: 'asset', resourceId: id, diff: { filename, declared_mime: input.content_type, declared_bytes: input.bytes }, correlationId: ctx.correlationId });
    return { id, key };
  });
  const post = await presignUpload({ key: row.key, contentType: input.content_type, maxBytes: MAX_UPLOAD_BYTES, expiresSeconds: UPLOAD_URL_TTL_SECONDS });
  return {
    asset_id: row.id,
    upload: { method: 'POST', url: post.url, fields: post.fields },
    expires_at: new Date(Date.now() + UPLOAD_URL_TTL_SECONDS * 1000).toISOString(),
    max_bytes: MAX_UPLOAD_BYTES,
  };
}

async function markRejected(ctx: Ctx, row: AssetRow, reason: string, code: string, facts: { mime?: string | null; bytes?: number | null } = {}): Promise<void> {
  await withTx(async (tx) => {
    await tx.query(
      `UPDATE assets SET status='rejected', rejection_reason=$3, mime=coalesce($4, mime), bytes=coalesce($5, bytes), validated_at=now()
        WHERE id=$1 AND workspace_id=$2 AND status='quarantined'`,
      [row.id, ctx.access.workspaceId, reason, facts.mime ?? null, facts.bytes ?? null]);
    await audit(tx, { workspaceId: ctx.access.workspaceId, brandId: row.brand_id, actorUserId: ctx.actor.userId, action: 'asset.rejected',
      resourceType: 'asset', resourceId: row.id, diff: { code }, correlationId: ctx.correlationId });
  });
  // Rejected content is not retained in storage.
  await deleteObject(row.object_key).catch((err) => log.warn('asset_reject_delete_failed', { assetId: row.id, err }));
}

/**
 * Validate an uploaded original synchronously (images ≤ 20 MB): quarantined → ready | rejected.
 * Idempotent: completing an already-validated asset returns it unchanged.
 */
export async function completeUpload(ctx: Ctx, assetId: string): Promise<AssetDto> {
  requireAction(ctx, 'assets.upload');
  const existing = await loadAsset(ctx, assetId);
  if (existing.uploaded_by !== ctx.actor.userId && ctx.access.role !== 'owner' && ctx.access.role !== 'admin') {
    throw forbidden('Only the person who uploaded this file can complete it');
  }
  if (existing.status === 'ready' || existing.status === 'rejected' || existing.status === 'archived') return getAsset(ctx, assetId);

  const claimed = await maybeOne<AssetRow>(getPool(),
    `UPDATE assets SET status='quarantined' WHERE id=$1 AND workspace_id=$2 AND status IN ('pending_upload','quarantined') RETURNING *`,
    [assetId, ctx.access.workspaceId]);
  if (!claimed) return getAsset(ctx, assetId);

  // External calls happen outside any transaction.
  const head = await headObject(claimed.object_key);
  if (!head) {
    await getPool().query(`UPDATE assets SET status='pending_upload' WHERE id=$1 AND status='quarantined'`, [assetId]);
    throw new AppError('invalid_state', 'The upload has not finished yet. Upload the file, then try again.');
  }
  if ((head.ContentLength ?? 0) > MAX_UPLOAD_BYTES) {
    await markRejected(ctx, claimed, 'The file is larger than 20 MB.', 'too_large', { bytes: head.ContentLength ?? null });
    return getAsset(ctx, assetId);
  }
  let original: Buffer;
  try {
    original = await getObjectBytes(claimed.object_key, MAX_UPLOAD_BYTES);
  } catch (err) {
    if (err instanceof ObjectTooLargeError) {
      await markRejected(ctx, claimed, 'The file is larger than 20 MB.', 'too_large');
      return getAsset(ctx, assetId);
    }
    throw err;
  }

  const result = await processImage(original, claimed.declared_mime);
  if (!result.ok) {
    await markRejected(ctx, claimed, result.reason, result.code, { bytes: original.length });
    return getAsset(ctx, assetId);
  }

  const stored: Array<{ variant: string; key: string; mime: string; bytes: number; width: number; height: number; sha256: string }> = [];
  for (const d of result.derivatives) {
    const key = derivativeKey(ctx.access.workspaceId, claimed.brand_id, claimed.id, d.variant, d.ext);
    await putObject(key, d.data, d.mime, { 'asset-id': claimed.id, 'transform-version': String(TRANSFORM_VERSION) });
    stored.push({ variant: d.variant, key, mime: d.mime, bytes: d.bytes, width: d.width, height: d.height, sha256: d.sha256 });
  }

  await withTx(async (tx) => {
    for (const d of stored) {
      await tx.query(
        `INSERT INTO asset_derivatives(workspace_id, asset_id, variant, object_key, mime, bytes, width, height, checksum_sha256, transform_version)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (asset_id, variant, transform_version) DO UPDATE SET object_key=EXCLUDED.object_key, mime=EXCLUDED.mime,
           bytes=EXCLUDED.bytes, width=EXCLUDED.width, height=EXCLUDED.height, checksum_sha256=EXCLUDED.checksum_sha256`,
        [ctx.access.workspaceId, claimed.id, d.variant, d.key, d.mime, d.bytes, d.width, d.height, d.sha256, TRANSFORM_VERSION]);
    }
    await tx.query(
      `UPDATE assets SET status='ready', rejection_reason=NULL, mime=$3, bytes=$4, width=$5, height=$6, checksum_sha256=$7, validated_at=now()
        WHERE id=$1 AND workspace_id=$2 AND status='quarantined'`,
      [claimed.id, ctx.access.workspaceId, result.mime, result.bytes, result.width, result.height, result.sha256]);
    await audit(tx, { workspaceId: ctx.access.workspaceId, brandId: claimed.brand_id, actorUserId: ctx.actor.userId, action: 'asset.ready',
      resourceType: 'asset', resourceId: claimed.id, diff: { mime: result.mime, bytes: result.bytes, width: result.width, height: result.height }, correlationId: ctx.correlationId });
  });
  return getAsset(ctx, assetId);
}

// ------------------------------------------------------------------ read / update

export async function getAsset(ctx: Ctx, assetId: string): Promise<AssetDto> {
  const row = await loadAsset(ctx, assetId);
  return (await toDtos([row]))[0]!;
}

/** Assets by id for composer/approval views (silently omits ids the caller cannot see). */
export async function assetsByIds(ctx: Ctx, ids: string[], db: Queryable = getPool()): Promise<AssetDto[]> {
  const valid = [...new Set(ids.filter(isUuid))];
  if (!valid.length) return [];
  const f = brandFilter(ctx, 'a.brand_id', 3);
  const rows = await many<AssetRow>(db,
    `SELECT a.*, ${USAGE_SQL} AS usage_count FROM assets a WHERE a.workspace_id = $1 AND a.id = ANY($2::uuid[]) AND ${f.sql}`,
    [ctx.access.workspaceId, valid, ...f.params]);
  const order = new Map(valid.map((id, i) => [id, i]));
  rows.sort((a, b) => order.get(a.id)! - order.get(b.id)!);
  return toDtos(rows);
}

export interface AssetListQuery { status?: string | null; tag?: string | null; q?: string | null; cursor?: string | null; limit?: number | null }

function decodeCursor(c: string | null | undefined): { t: string; id: string } | null {
  if (!c) return null;
  try {
    const v = JSON.parse(Buffer.from(c, 'base64url').toString('utf8')) as { t?: unknown; id?: unknown };
    if (typeof v.t === 'string' && isUuid(v.id) && !Number.isNaN(Date.parse(v.t))) return { t: v.t, id: v.id };
  } catch { /* fallthrough */ }
  throw new AppError('validation_failed', 'Invalid cursor', { cursor: 'Invalid cursor' });
}

export async function listAssets(ctx: Ctx, brandId: string, q: AssetListQuery = {}): Promise<{ items: AssetDto[]; next_cursor: string | null }> {
  await assertBrand(ctx, brandId);
  const limit = Math.min(Math.max(q.limit ?? 50, 1), 100);
  const params: unknown[] = [ctx.access.workspaceId, brandId];
  const where = ['a.workspace_id = $1', 'a.brand_id = $2'];
  const statuses: AssetStatus[] = ['pending_upload', 'quarantined', 'ready', 'rejected', 'archived'];
  if (q.status) {
    if (!statuses.includes(q.status as AssetStatus)) throw new AppError('validation_failed', 'Unknown status filter', { status: 'Unknown status' });
    params.push(q.status);
    where.push(`a.status = $${params.length}::asset_status`);
  } else {
    where.push(`a.status <> 'archived'`);
  }
  if (q.tag) { params.push(q.tag); where.push(`$${params.length} = ANY(a.tags)`); }
  if (q.q) {
    params.push(`%${q.q.replace(/[\\%_]/g, (m) => `\\${m}`).slice(0, 100)}%`);
    where.push(`(a.original_filename ILIKE $${params.length} OR a.alt_text ILIKE $${params.length})`);
  }
  const cur = decodeCursor(q.cursor);
  if (cur) {
    params.push(cur.t, cur.id);
    where.push(`(a.created_at, a.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
  }
  params.push(limit + 1);
  const rows = await many<AssetRow>(getPool(),
    `SELECT a.*, a.created_at::text AS created_at_cursor, ${USAGE_SQL} AS usage_count FROM assets a
      WHERE ${where.join(' AND ')} ORDER BY a.created_at DESC, a.id DESC LIMIT $${params.length}`, params);
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  const next = rows.length > limit && last ? Buffer.from(JSON.stringify({ t: last.created_at_cursor, id: last.id })).toString('base64url') : null;
  return { items: await toDtos(page), next_cursor: next };
}

export async function updateAsset(ctx: Ctx, assetId: string, patch: { alt_text?: string | null; tags?: string[] }): Promise<AssetDto> {
  requireAction(ctx, 'assets.upload');
  const tags = patch.tags?.map((t) => t.trim()).filter(Boolean);
  if (tags && (tags.length > 30 || tags.some((t) => t.length > 50))) throw new AppError('validation_failed', 'Too many or too long tags', { tags: 'Up to 30 tags of 50 characters' });
  if (patch.alt_text && patch.alt_text.length > 1500) throw new AppError('validation_failed', 'Alt text is too long', { alt_text: 'Up to 1500 characters' });
  await withTx(async (tx) => {
    const row = await loadAsset(ctx, assetId, tx, true);
    await tx.query(
      `UPDATE assets SET alt_text = CASE WHEN $3::boolean THEN $4 ELSE alt_text END, tags = coalesce($5::text[], tags) WHERE id=$1 AND workspace_id=$2`,
      [row.id, ctx.access.workspaceId, patch.alt_text !== undefined, patch.alt_text?.trim() || null, tags ? [...new Set(tags)] : null]);
    await audit(tx, { workspaceId: ctx.access.workspaceId, brandId: row.brand_id, actorUserId: ctx.actor.userId, action: 'asset.updated',
      resourceType: 'asset', resourceId: row.id, diff: { alt_text: patch.alt_text !== undefined, tags: tags ?? undefined }, correlationId: ctx.correlationId });
  });
  return getAsset(ctx, assetId);
}

/** Non-terminal deliveries / live schedules that reference the asset (ME-05). */
async function activeReferences(db: Queryable, workspaceId: string, assetId: string): Promise<{ deliveries: number; schedules: number }> {
  const r = await maybeOne<{ deliveries: number; schedules: number }>(db,
    `SELECT
       (SELECT count(*) FROM deliveries d JOIN variants v ON v.id = d.variant_id AND v.workspace_id = d.workspace_id
         WHERE d.workspace_id = $1 AND $2::uuid = ANY(v.asset_ids)
           AND d.state NOT IN ('published','failed','cancelled','expired'))::int AS deliveries,
       (SELECT count(*) FROM schedules s JOIN variants v ON v.revision_id = s.revision_id AND v.workspace_id = s.workspace_id
         WHERE s.workspace_id = $1 AND s.status IN ('active','pending_approval') AND $2::uuid = ANY(v.asset_ids))::int AS schedules`,
    [workspaceId, assetId]);
  return r ?? { deliveries: 0, schedules: 0 };
}

export async function archiveAsset(ctx: Ctx, assetId: string): Promise<AssetDto> {
  requireAction(ctx, 'assets.upload');
  await withTx(async (tx) => {
    const row = await loadAsset(ctx, assetId, tx, true);
    if (row.status === 'archived') return;
    const refs = await activeReferences(tx, ctx.access.workspaceId, row.id);
    if (refs.deliveries > 0 || refs.schedules > 0) {
      throw new AppError('conflict', 'This image is used by a scheduled post. Cancel or finish that post before archiving it.', undefined,
        { active_deliveries: refs.deliveries, active_schedules: refs.schedules });
    }
    await tx.query(
      `UPDATE assets SET status='archived', archived_at=now(), retention_at=now() + interval '30 days' WHERE id=$1 AND workspace_id=$2`,
      [row.id, ctx.access.workspaceId]);
    await audit(tx, { workspaceId: ctx.access.workspaceId, brandId: row.brand_id, actorUserId: ctx.actor.userId, action: 'asset.archived',
      resourceType: 'asset', resourceId: row.id, diff: { previous_status: row.status }, correlationId: ctx.correlationId });
  });
  return getAsset(ctx, assetId);
}

// ------------------------------------------------------------------ engine-facing (no Ctx; workspace-scoped)

/**
 * Publish-ready media for the given assets, in order. URL = signed GET of the jpeg_publish derivative
 * (TTL covers provider fetch/processing/retries); load() streams the same bytes from storage.
 * Throws invalid_state when any asset is missing, not validated, or lacks its publish derivative.
 * Archived assets remain publishable (archive is refused while referenced by active deliveries;
 * physical deletion only happens after retention).
 */
export async function loadPublishMedia(db: Queryable, workspaceId: string, assetIds: string[], ttlSeconds = 3600): Promise<PublishMedia[]> {
  if (!assetIds.length) return [];
  if (!assetIds.every(isUuid)) throw new AppError('invalid_state', 'An attached image is no longer available.');
  const rows = await many<{ id: string; status: AssetStatus; object_key: string | null; mime: string | null; bytes: string | null; width: number | null; height: number | null }>(db,
    `SELECT a.id, a.status, d.object_key, d.mime, d.bytes, d.width, d.height
       FROM assets a
       LEFT JOIN asset_derivatives d ON d.asset_id = a.id AND d.workspace_id = a.workspace_id
            AND d.variant = 'jpeg_publish' AND d.transform_version = $3
      WHERE a.workspace_id = $1 AND a.id = ANY($2::uuid[])`, [workspaceId, assetIds, TRANSFORM_VERSION]);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const out: PublishMedia[] = [];
  for (const id of assetIds) {
    const r = byId.get(id);
    if (!r || (r.status !== 'ready' && r.status !== 'archived') || !r.object_key || !r.mime || r.bytes === null || r.width === null || r.height === null) {
      throw new AppError('invalid_state', 'An attached image is not available for publishing. Replace it and try again.', undefined, { asset_id: id });
    }
    const key = r.object_key;
    const bytes = Number(r.bytes);
    out.push({
      assetId: id, mime: r.mime, width: r.width, height: r.height, bytes,
      url: await signedGetUrl(key, ttlSeconds, { contentType: r.mime }),
      load: async () => new Uint8Array(await getObjectBytes(key, Math.max(bytes, 1) + 1024)),
    });
  }
  return out;
}

/** Validation facts (from the jpeg_publish derivative) for core validateVariant(); unknown ids ⇒ status 'missing'. */
export async function assetFacts(db: Queryable, workspaceId: string, assetIds: string[]): Promise<MediaFacts[]> {
  const valid = assetIds.filter(isUuid);
  const rows = valid.length
    ? await many<{ id: string; status: AssetStatus; mime: string | null; bytes: string | null; width: number | null; height: number | null }>(db,
      `SELECT a.id, a.status, d.mime, d.bytes, d.width, d.height
         FROM assets a
         LEFT JOIN asset_derivatives d ON d.asset_id = a.id AND d.workspace_id = a.workspace_id
              AND d.variant = 'jpeg_publish' AND d.transform_version = $3
        WHERE a.workspace_id = $1 AND a.id = ANY($2::uuid[])`, [workspaceId, valid, TRANSFORM_VERSION])
    : [];
  const byId = new Map(rows.map((r) => [r.id, r]));
  return assetIds.map((id) => {
    const r = byId.get(id);
    if (!r) return { assetId: id, status: 'missing', mime: null, bytes: null, width: null, height: null };
    return { assetId: id, status: r.status, mime: r.mime, bytes: r.bytes !== null ? Number(r.bytes) : null, width: r.width, height: r.height };
  });
}
