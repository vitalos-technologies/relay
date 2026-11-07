// Per-variant image crops (V1.1). A crop lives in the draft at VariantDraft.options.crop, keyed by asset id:
//   options.crop = { "<assetId>": { preset: '4:5', x, y, width, height } }
// Coordinates are integer pixels of the auto-oriented original (assets.width × assets.height).
// Because options are part of the resolved variant, a crop is part of the revision content hash: changing it
// creates a new revision and invalidates a pending approval (posts/service.ts invalidatePendingApprovalIfChanged).
// Derivatives are deterministic (sharp; auto-orient → extract → exact resize → sRGB JPEG, metadata stripped)
// and cached in asset_derivatives under variant 'crop:<hash(rect)>' + CROP_TRANSFORM_VERSION.
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { z } from 'zod';
import type { MediaFacts, ValidationIssue } from '@social-lite/core';
import { many, maybeOne, type Queryable } from '@social-lite/db';
import { getObjectBytes, putObject } from '../storage.js';
import { MAX_INPUT_PIXELS, MAX_UPLOAD_BYTES, MIN_SIDE } from '../media/process.js';
import { mediaFacts } from '../posts/shared.js';

export const CROP_TRANSFORM_VERSION = 1;
/** Longest side of a crop derivative (same cap as the jpeg_publish derivative). */
export const CROP_MAX_SIDE = 4096;

export const CROP_PRESETS = ['1:1', '4:5', '1.91:1', '16:9', '9:16', 'free'] as const;
export type CropPreset = (typeof CROP_PRESETS)[number];
export const PRESET_RATIO: Record<CropPreset, number | null> = { '1:1': 1, '4:5': 0.8, '1.91:1': 1.91, '16:9': 16 / 9, '9:16': 9 / 16, free: null };

export const cropSpecSchema = z.object({
  preset: z.enum(CROP_PRESETS),
  x: z.number().int().min(0),
  y: z.number().int().min(0),
  width: z.number().int().min(MIN_SIDE),
  height: z.number().int().min(MIN_SIDE),
}).strict();
export type CropSpec = z.infer<typeof cropSpecSchema>;

const cropMapSchema = z.record(z.string().uuid(), cropSpecSchema);

/** Crops declared on a variant's options; malformed entries are reported, never silently applied. */
export function cropsFromOptions(options: Record<string, unknown> | null | undefined): { crops: Record<string, CropSpec>; malformed: boolean } {
  const raw = options?.crop;
  if (raw === undefined || raw === null) return { crops: {}, malformed: false };
  const r = cropMapSchema.safeParse(raw);
  return r.success ? { crops: r.data, malformed: false } : { crops: {}, malformed: true };
}

/** null when valid for an image of the given (oriented) size, else a user-facing reason. */
export function cropProblem(spec: CropSpec, imageWidth: number, imageHeight: number): string | null {
  if (spec.x + spec.width > imageWidth || spec.y + spec.height > imageHeight) return 'the crop extends beyond the image. Reset the crop.';
  const ratio = PRESET_RATIO[spec.preset];
  if (ratio !== null) {
    const okW = Math.abs(spec.width - Math.round(spec.height * ratio)) <= 1;
    const okH = Math.abs(spec.height - Math.round(spec.width / ratio)) <= 1;
    if (!okW && !okH) return `the crop is not ${spec.preset}. Re-apply the preset.`;
  }
  return null;
}

/** Exact output size of the crop derivative (downscaled so the longest side ≤ CROP_MAX_SIDE). */
export function cropOutputSize(spec: Pick<CropSpec, 'width' | 'height'>): { width: number; height: number } {
  const scale = Math.min(1, CROP_MAX_SIDE / Math.max(spec.width, spec.height));
  return { width: Math.max(1, Math.round(spec.width * scale)), height: Math.max(1, Math.round(spec.height * scale)) };
}

export function cropVariantName(spec: Pick<CropSpec, 'x' | 'y' | 'width' | 'height'>): string {
  return `crop:${createHash('sha256').update(`${spec.x},${spec.y},${spec.width},${spec.height}`).digest('hex').slice(0, 24)}`;
}

/** Deterministic crop rendering from the validated original. */
export async function renderCrop(original: Buffer, spec: CropSpec): Promise<{ data: Buffer; width: number; height: number; sha256: string }> {
  const out = cropOutputSize(spec);
  const { data, info } = await sharp(original, { limitInputPixels: MAX_INPUT_PIXELS, failOn: 'error', autoOrient: true })
    .extract({ left: spec.x, top: spec.y, width: spec.width, height: spec.height })
    .resize({ width: out.width, height: out.height, fit: 'fill' })
    .toColourspace('srgb')
    .flatten({ background: '#ffffff' })
    .jpeg({ quality: 90, chromaSubsampling: '4:2:0', mozjpeg: false })
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height, sha256: createHash('sha256').update(data).digest('hex') };
}

export interface CropDerivative { object_key: string; mime: string; bytes: number; width: number; height: number }

/**
 * Return the cached crop derivative for (asset, rect, CROP_TRANSFORM_VERSION), generating it on first use.
 * Runs outside any transaction (object storage I/O). Concurrent generation is harmless: same bytes, same key,
 * ON CONFLICT DO NOTHING.
 */
export async function ensureCropDerivative(db: Queryable, workspaceId: string, assetId: string, spec: CropSpec): Promise<CropDerivative> {
  const variant = cropVariantName(spec);
  const existing = await maybeOne<CropDerivative & { bytes: string }>(db,
    `SELECT object_key, mime, bytes, width, height FROM asset_derivatives WHERE workspace_id=$1 AND asset_id=$2 AND variant=$3 AND transform_version=$4`,
    [workspaceId, assetId, variant, CROP_TRANSFORM_VERSION]);
  if (existing) return { ...existing, bytes: Number(existing.bytes) };
  const a = await maybeOne<{ brand_id: string; object_key: string; status: string; width: number | null; height: number | null }>(db,
    `SELECT brand_id, object_key, status, width, height FROM assets WHERE workspace_id=$1 AND id=$2`, [workspaceId, assetId]);
  if (!a || (a.status !== 'ready' && a.status !== 'archived') || !a.width || !a.height) throw new Error('crop source image unavailable');
  const problem = cropProblem(spec, a.width, a.height);
  if (problem) throw new Error(`invalid crop: ${problem}`);
  const original = await getObjectBytes(a.object_key, MAX_UPLOAD_BYTES);
  const r = await renderCrop(original, spec);
  const key = `derivatives/${workspaceId}/${a.brand_id}/${assetId}/crop-v${CROP_TRANSFORM_VERSION}/${variant.slice(5)}.jpg`;
  await putObject(key, r.data, 'image/jpeg', { 'asset-id': assetId, 'transform-version': String(CROP_TRANSFORM_VERSION) });
  await db.query(
    `INSERT INTO asset_derivatives(workspace_id, asset_id, variant, object_key, mime, bytes, width, height, checksum_sha256, transform_version)
     VALUES ($1,$2,$3,$4,'image/jpeg',$5,$6,$7,$8,$9) ON CONFLICT (asset_id, variant, transform_version) DO NOTHING`,
    [workspaceId, assetId, variant, key, r.data.length, r.width, r.height, r.sha256, CROP_TRANSFORM_VERSION]);
  const row = await maybeOne<CropDerivative & { bytes: string }>(db,
    `SELECT object_key, mime, bytes, width, height FROM asset_derivatives WHERE asset_id=$1 AND variant=$2 AND transform_version=$3`,
    [assetId, variant, CROP_TRANSFORM_VERSION]);
  return { ...row!, bytes: Number(row!.bytes) };
}

/**
 * Validation facts for a variant's media WITH its crops applied: width/height become the exact crop
 * output size, mime image/jpeg, bytes from the cached derivative when it exists (else unknown).
 * Invalid crops produce issues so scheduling is blocked with an exact fix.
 */
export async function cropAwareMediaFacts(db: Queryable, workspaceId: string, assetIds: string[], options: Record<string, unknown> | null | undefined,
  issueCtx: { connectionId: string; provider: ValidationIssue['provider'] }): Promise<{ facts: MediaFacts[]; issues: ValidationIssue[] }> {
  const facts = await mediaFacts(db, workspaceId, assetIds);
  const { crops, malformed } = cropsFromOptions(options);
  const issues: ValidationIssue[] = [];
  const issue = (message: string) => issues.push({ ...issueCtx, field: 'media', code: 'invalid_crop', message });
  if (malformed) issue('The image crop is malformed. Reset the crop.');
  const cropped = assetIds.filter((id) => crops[id]);
  if (!cropped.length) return { facts, issues };
  const dims = await many<{ id: string; width: number | null; height: number | null; d_bytes: string | null; variant: string | null }>(db,
    `SELECT a.id, a.width, a.height, d.bytes AS d_bytes, d.variant FROM assets a
       LEFT JOIN asset_derivatives d ON d.asset_id=a.id AND d.transform_version=$3 AND d.variant LIKE 'crop:%'
      WHERE a.workspace_id=$1 AND a.id = ANY($2::uuid[])`, [workspaceId, cropped, CROP_TRANSFORM_VERSION]);
  return {
    issues,
    facts: facts.map((f) => {
      const spec = crops[f.assetId];
      if (!spec || f.status !== 'ready' || (f as { kind?: string }).kind === 'video') return f; // crops apply to images only
      const a = dims.find((d) => d.id === f.assetId);
      if (!a?.width || !a.height) return f;
      const problem = cropProblem(spec, a.width, a.height);
      if (problem) { issue(`Image crop: ${problem}`); return f; }
      const out = cropOutputSize(spec);
      const cached = dims.find((d) => d.id === f.assetId && d.variant === cropVariantName(spec));
      return { ...f, mime: 'image/jpeg', width: out.width, height: out.height, bytes: cached?.d_bytes ? Number(cached.d_bytes) : null };
    }),
  };
}
