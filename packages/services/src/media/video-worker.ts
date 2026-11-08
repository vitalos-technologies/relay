// Worker-side processing of uploaded videos (outbox 'asset.uploaded' → handleAssetUploaded).
// The web request only quarantines the asset and writes the outbox row (same transaction); this runs
// in the worker, outside any DB transaction, under a claim so two workers never process one asset.
//   quarantined → (probe, poster, remux|transcode) → ready | rejected
// Infrastructure failures (storage down) throw so pg-boss retries; after MAX_ATTEMPTS the asset is rejected.
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, open, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createHash } from 'node:crypto';
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { fileTypeFromBuffer } from 'file-type';
import sharp, { type Sharp } from 'sharp';
import { getPool, maybeOne, withTx, type Pool } from '@social-lite/db';
import { audit } from '../audit.js';
import { settleByRef } from '../product/budgets.js';
import { log } from '../log.js';
import { bucket, deleteObject, headObject, putObject, s3 } from '../storage.js';
import { derivativeKey } from './assets.js';
import { TRANSFORM_VERSION } from './process.js';
import {
  extractPoster, makePublishVideo, MAX_VIDEO_UPLOAD_BYTES, probeVideo, ToolError, VIDEO_MIME, type VideoFacts,
} from './video.js';

export const MAX_PROCESSING_ATTEMPTS = 3;
/** A claim older than this is considered abandoned (worker died mid-transcode). */
export const PROCESSING_LEASE_MINUTES = 40;

interface VideoAssetRow {
  id: string; workspace_id: string; brand_id: string; uploaded_by: string | null; object_key: string;
  declared_mime: string | null; processing_attempts: number;
}

export type VideoProcessResult =
  | { status: 'ready'; transcoded: boolean; facts: { width: number; height: number; durationMs: number; videoCodec: string; audioCodec: string | null } }
  | { status: 'rejected'; code: string; reason: string }
  | { status: 'skipped'; reason: string };

class Rejection extends Error {
  constructor(readonly code: string, readonly reason: string) { super(reason); }
}

async function sha256File(path: string): Promise<string> {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(path)) h.update(chunk as Buffer);
  return h.digest('hex');
}

async function downloadToFile(key: string, path: string, maxBytes: number): Promise<number> {
  const ac = new AbortController();
  const out = await s3().send(new GetObjectCommand({ Bucket: bucket(), Key: key }), { abortSignal: ac.signal });
  if (out.ContentLength !== undefined && out.ContentLength > maxBytes) { ac.abort(); throw new Rejection('too_large', `The video is larger than ${maxBytes / 1_048_576} MB.`); }
  const body = out.Body;
  if (!body) throw new Rejection('empty', 'The file is empty.');
  const src = body instanceof Readable ? body : Readable.fromWeb((body as unknown as { transformToWebStream(): import('node:stream/web').ReadableStream }).transformToWebStream());
  let total = 0;
  const limiter = async function* (source: AsyncIterable<Buffer>) {
    for await (const chunk of source) {
      total += chunk.length;
      if (total > maxBytes) { ac.abort(); throw new Rejection('too_large', `The video is larger than ${maxBytes / 1_048_576} MB.`); }
      yield chunk;
    }
  };
  await pipeline(src, limiter, createWriteStream(path, { mode: 0o600 }));
  return total;
}

async function putFile(key: string, path: string, contentType: string, metadata: Record<string, string>): Promise<number> {
  const size = (await stat(path)).size;
  await s3().send(new PutObjectCommand({ Bucket: bucket(), Key: key, Body: createReadStream(path), ContentType: contentType, ContentLength: size, Metadata: metadata }));
  return size;
}

async function sniff(path: string): Promise<string | null> {
  const fh = await open(path, 'r');
  try {
    const buf = Buffer.alloc(4100);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    return (await fileTypeFromBuffer(buf.subarray(0, bytesRead)).catch(() => undefined))?.mime ?? null;
  } finally {
    await fh.close();
  }
}

/** Claim a quarantined video for processing (atomic; abandoned claims expire). */
async function claim(pool: Pool, workspaceId: string, assetId: string): Promise<VideoAssetRow | null> {
  return maybeOne<VideoAssetRow>(pool,
    `UPDATE assets SET processing_started_at=now(), processing_attempts=processing_attempts+1
      WHERE id=$1 AND workspace_id=$2 AND status='quarantined' AND media_kind='video'
        AND (processing_started_at IS NULL OR processing_started_at < now() - ($3 || ' minutes')::interval)
      RETURNING id, workspace_id, brand_id, uploaded_by, object_key, declared_mime, processing_attempts`,
    [assetId, workspaceId, String(PROCESSING_LEASE_MINUTES)]);
}

async function reject(pool: Pool, a: VideoAssetRow, code: string, reason: string, bytes: number | null): Promise<void> {
  await withTx(async (tx) => {
    await tx.query(
      `UPDATE assets SET status='rejected', rejection_reason=$3, bytes=coalesce($4, bytes), validated_at=now(), processing_started_at=NULL
        WHERE id=$1 AND workspace_id=$2 AND status='quarantined'`, [a.id, a.workspace_id, reason, bytes]);
    await settleByRef(a.workspace_id, `asset:${a.id}`, null, tx); // release the storage reservation
    await audit(tx, { workspaceId: a.workspace_id, brandId: a.brand_id, actorService: 'worker', action: 'asset.rejected',
      resourceType: 'asset', resourceId: a.id, diff: { code, kind: 'video' } });
  }, pool);
  await deleteObject(a.object_key).catch((err) => log.warn('asset_reject_delete_failed', { assetId: a.id, err }));
}

/** Validate an uploaded video and create poster/preview/thumb + video_publish derivatives. */
export async function processVideoAsset(workspaceId: string, assetId: string, pool: Pool = getPool()): Promise<VideoProcessResult> {
  const a = await claim(pool, workspaceId, assetId);
  if (!a) return { status: 'skipped', reason: 'not quarantined, not a video, or already being processed' };
  if (a.processing_attempts > MAX_PROCESSING_ATTEMPTS) {
    const reason = 'The video could not be processed after several attempts. Export it again and re-upload.';
    await reject(pool, a, 'processing_failed', reason, null);
    return { status: 'rejected', code: 'processing_failed', reason };
  }
  const dir = await mkdtemp(join(tmpdir(), 'socialite-video-'));
  const src = join(dir, 'source');
  const out = join(dir, 'publish.mp4');
  const poster = join(dir, 'poster.jpg');
  let bytes: number | null = null;
  try {
    const head = await headObject(a.object_key);
    if (!head) throw new Rejection('missing', 'The uploaded file is missing. Upload it again.');
    if ((head.ContentLength ?? 0) > MAX_VIDEO_UPLOAD_BYTES) throw new Rejection('too_large', `The video is larger than ${MAX_VIDEO_UPLOAD_BYTES / 1_048_576} MB.`);
    bytes = await downloadToFile(a.object_key, src, MAX_VIDEO_UPLOAD_BYTES);
    if (bytes === 0) throw new Rejection('empty', 'The file is empty.');

    const sniffed = await sniff(src);
    if (!sniffed || !(VIDEO_MIME as readonly string[]).includes(sniffed)) {
      throw new Rejection('unsupported_type', `Only MP4 and MOV videos are supported (this file is ${sniffed ?? 'not a recognised video'}).`);
    }
    const probe = await probeVideo(src);
    if (!probe.ok) throw new Rejection(probe.code, probe.reason);
    const facts = probe.facts;

    try {
      await extractPoster(src, poster, facts);
    } catch {
      throw new Rejection('malformed', 'The video could not be decoded. It may be corrupted.');
    }
    let transcoded: boolean;
    try {
      ({ transcoded } = await makePublishVideo(src, out, facts));
    } catch (err) {
      if (err instanceof ToolError && err.kind === 'timeout') throw new Rejection('processing_timeout', 'The video took too long to convert. Shorten it or export it as H.264 MP4, then re-upload.');
      throw new Rejection('malformed', 'The video could not be converted. It may be corrupted.');
    }
    const outProbe = await probeVideo(out);
    if (!outProbe.ok) throw new Rejection('malformed', 'The video could not be converted. It may be corrupted.');
    const pf: VideoFacts = outProbe.facts;
    const outSize = (await stat(out)).size;
    if (outSize > MAX_VIDEO_UPLOAD_BYTES) throw new Rejection('too_large', 'The converted video is too large. Shorten it and re-upload.');

    // Poster/preview/thumb from the extracted frame (sharp re-encode strips any metadata).
    const frame = await readFile(poster);
    const images = await Promise.all([
      { variant: 'poster', size: 1280, mime: 'image/jpeg', ext: 'jpg', enc: (s: Sharp) => s.jpeg({ quality: 85 }) },
      { variant: 'preview', size: 1600, mime: 'image/webp', ext: 'webp', enc: (s: Sharp) => s.webp({ quality: 82 }) },
      { variant: 'thumb', size: 400, mime: 'image/webp', ext: 'webp', enc: (s: Sharp) => s.webp({ quality: 78 }) },
    ].map(async (spec) => {
      const { data, info } = await spec.enc(sharp(frame, { limitInputPixels: 40_000_000, failOn: 'error' })
        .resize({ width: spec.size, height: spec.size, fit: 'inside', withoutEnlargement: true }).toColourspace('srgb'))
        .toBuffer({ resolveWithObject: true });
      return { ...spec, data, width: info.width, height: info.height };
    }));

    const meta = { 'asset-id': a.id, 'transform-version': String(TRANSFORM_VERSION) };
    const stored: Array<{ variant: string; key: string; mime: string; bytes: number; width: number; height: number; sha256: string; video?: VideoFacts }> = [];
    for (const img of images) {
      const key = derivativeKey(a.workspace_id, a.brand_id, a.id, img.variant, img.ext);
      await putObject(key, img.data, img.mime, meta);
      stored.push({ variant: img.variant, key, mime: img.mime, bytes: img.data.length, width: img.width, height: img.height, sha256: createHash('sha256').update(img.data).digest('hex') });
    }
    const vkey = derivativeKey(a.workspace_id, a.brand_id, a.id, 'video_publish', 'mp4');
    await putFile(vkey, out, 'video/mp4', meta);
    stored.push({ variant: 'video_publish', key: vkey, mime: 'video/mp4', bytes: outSize, width: pf.width, height: pf.height, sha256: await sha256File(out), video: pf });

    const done = await withTx(async (tx) => {
      for (const d of stored) {
        await tx.query(
          `INSERT INTO asset_derivatives(workspace_id, asset_id, variant, object_key, mime, bytes, width, height, checksum_sha256, transform_version,
                                         duration_ms, video_codec, audio_codec, frame_rate)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
           ON CONFLICT (asset_id, variant, transform_version) DO UPDATE SET object_key=EXCLUDED.object_key, mime=EXCLUDED.mime, bytes=EXCLUDED.bytes,
             width=EXCLUDED.width, height=EXCLUDED.height, checksum_sha256=EXCLUDED.checksum_sha256, duration_ms=EXCLUDED.duration_ms,
             video_codec=EXCLUDED.video_codec, audio_codec=EXCLUDED.audio_codec, frame_rate=EXCLUDED.frame_rate`,
          [a.workspace_id, a.id, d.variant, d.key, d.mime, d.bytes, d.width, d.height, d.sha256, TRANSFORM_VERSION,
            d.video?.durationMs ?? null, d.video?.videoCodec ?? null, d.video?.audioCodec ?? null, d.video?.frameRate ?? null]);
      }
      const r = await tx.query(
        `UPDATE assets SET status='ready', rejection_reason=NULL, mime=$3, bytes=$4, width=$5, height=$6, checksum_sha256=$7, validated_at=now(),
                duration_ms=$8, video_codec=$9, audio_codec=$10, frame_rate=$11, processing_started_at=NULL
          WHERE id=$1 AND workspace_id=$2 AND status='quarantined'`,
        [a.id, a.workspace_id, sniffed, bytes, facts.width, facts.height, await sha256File(src), facts.durationMs, facts.videoCodec, facts.audioCodec, facts.frameRate]);
      if (!r.rowCount) return false;
      await settleByRef(a.workspace_id, `asset:${a.id}`, bytes, tx); // storage budget: actual bytes
      await audit(tx, { workspaceId: a.workspace_id, brandId: a.brand_id, actorService: 'worker', action: 'asset.ready', resourceType: 'asset', resourceId: a.id,
        diff: { kind: 'video', mime: sniffed, bytes, width: facts.width, height: facts.height, duration_ms: facts.durationMs, transcoded } });
      return true;
    }, pool);
    if (!done) return { status: 'skipped', reason: 'asset changed during processing' };
    return { status: 'ready', transcoded, facts: { width: pf.width, height: pf.height, durationMs: pf.durationMs, videoCodec: pf.videoCodec, audioCodec: pf.audioCodec } };
  } catch (err) {
    if (err instanceof Rejection) {
      await reject(pool, a, err.code, err.reason, bytes);
      return { status: 'rejected', code: err.code, reason: err.reason };
    }
    // Infrastructure problem: release the claim so a retry (pg-boss) can process it again.
    await pool.query(`UPDATE assets SET processing_started_at=NULL WHERE id=$1 AND status='quarantined'`, [a.id]).catch(() => undefined);
    log.error('video_processing_failed', { assetId: a.id, err: err as Error });
    throw err;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Outbox handler for 'asset.uploaded' (registered in the worker). Images are processed synchronously and ignored here. */
export async function handleAssetUploaded(evt: { workspace_id: string | null; aggregate_id: string; payload?: Record<string, unknown> }, pool: Pool = getPool()): Promise<VideoProcessResult | null> {
  if (!evt.workspace_id) return null;
  const r = await processVideoAsset(evt.workspace_id, evt.aggregate_id, pool);
  log.info('asset_processed', { assetId: evt.aggregate_id, status: r.status });
  return r;
}
