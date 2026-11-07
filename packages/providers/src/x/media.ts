// X multi-image (2–4) and video uploads (V1.1). Verified 2026-11-07 at docs.x.com:
//  - "You may attach up to 4 photos, 1 animated GIF or 1 video in a Post" (media best practices / introduction).
//  - Chunked v2 upload: POST /2/media/upload/initialize {media_type, total_bytes, media_category: tweet_video}
//    → data.id; POST /2/media/upload/{id}/append (multipart: segment_index, media; segments ≤ 5 MB);
//    POST /2/media/upload/{id}/finalize → data.processing_info; GET /2/media/upload?command=STATUS&media_id=…
//    until state succeeded|failed (wait check_after_secs). Do NOT send command=INIT/APPEND/FINALIZE.
//  - Video: ≥ 0.5 s, ≤ 20 min (default account), 32×32..1280×1024, ≤ 60 fps, aspect 1:3..3:1, H.264 + AAC-LC.
//
// Checkpoint (nothing is visible before POST /2/tweets):
//   { step: 'media_uploading' | 'media_processing' | 'media_ready',
//     data: { items: [{ assetId, mediaId, state: 'uploading'|'finalizing'|'processing'|'ready', nextSegment?, expiresAt }], mediaIds } }
// Resume continues a video upload from its next segment and never re-uploads a ready item.
import { TransportError, type AdapterContext, type Checkpoint, type PrepareOutcome, type PublishInput } from '@social-lite/core';
import { XApiError, xCall } from './api.js';

export const VIDEO_SEGMENT_BYTES = 4 * 1024 * 1024;
const EXPIRY_MARGIN_MS = 5 * 60_000;

type ItemState = 'uploading' | 'finalizing' | 'processing' | 'ready';
export interface XMediaItem { assetId: string; mediaId: string; state: ItemState; nextSegment?: number; expiresAt: string | null; video: boolean }

interface UploadData {
  id?: string;
  expires_after_secs?: number;
  processing_info?: { state: 'pending' | 'in_progress' | 'failed' | 'succeeded'; check_after_secs?: number };
}

const isVideo = (m: PublishInput['media'][number]) => m.kind === 'video' || m.mime.startsWith('video/');

export function needsMediaFlow(media: PublishInput['media']): boolean {
  return media.length > 1 || media.some(isVideo);
}

export function itemsFrom(cp: Checkpoint | null): XMediaItem[] {
  const raw = (cp?.data as { items?: unknown } | undefined)?.items;
  if (!Array.isArray(raw)) return [];
  return raw.filter((x): x is XMediaItem => !!x && typeof (x as XMediaItem).mediaId === 'string' && typeof (x as XMediaItem).assetId === 'string');
}

/** media_ids for POST /2/tweets from a ready checkpoint (V1.1 items, or the single-image `mediaId`). */
export function mediaIdsFrom(cp: Checkpoint | null, count: number): string[] | null {
  const items = itemsFrom(cp);
  if (items.length) return items.length === count && items.every((i) => i.state === 'ready') ? items.map((i) => i.mediaId) : null;
  const one = cp?.data.mediaId;
  return count === 1 && typeof one === 'string' && one ? [one] : null;
}

function checkpoint(items: XMediaItem[]): Checkpoint {
  const step = items.some((i) => i.state === 'uploading' || i.state === 'finalizing') ? 'media_uploading'
    : items.some((i) => i.state === 'processing') ? 'media_processing' : 'media_ready';
  const expiries = items.map((i) => i.expiresAt).filter((x): x is string => !!x).sort();
  return { step, data: { items, mediaIds: items.map((i) => i.mediaId) }, expiresAt: expiries[0] ?? null };
}

const expiry = (ctx: AdapterContext, secs: number | undefined, prev: string | null) =>
  (secs ? new Date(ctx.now().getTime() + secs * 1000).toISOString() : prev);

class ProcessingFailed extends Error {}

function afterProcessing(ctx: AdapterContext, item: XMediaItem, data: UploadData): { item: XMediaItem; checkAfterMs?: number } {
  const st = data.processing_info?.state;
  const expiresAt = expiry(ctx, data.expires_after_secs, item.expiresAt);
  if (st === 'failed') throw new ProcessingFailed();
  if (st === 'pending' || st === 'in_progress') {
    return { item: { ...item, state: 'processing', expiresAt }, checkAfterMs: Math.max(1, data.processing_info?.check_after_secs ?? 5) * 1000 };
  }
  return { item: { ...item, state: 'ready', expiresAt } };
}

async function uploadImage(ctx: AdapterContext, token: string, m: PublishInput['media'][number], bytes: Uint8Array): Promise<UploadData> {
  const form = new FormData();
  form.append('media', new Blob([bytes as unknown as ArrayBuffer], { type: m.mime }), m.mime === 'image/png' ? 'image.png' : 'image.jpg');
  form.append('media_category', 'tweet_image');
  const r = await xCall<{ data: UploadData }>(ctx, { method: 'POST', path: '/2/media/upload', formData: form, bearer: token, op: 'x.media.upload', timeoutMs: 60_000 });
  return r.data?.data ?? {};
}

/** Continue (or start) a chunked video upload; returns the item after finalize, or after the failed step. */
async function uploadVideo(ctx: AdapterContext, token: string, m: PublishInput['media'][number], bytes: Uint8Array, prev: XMediaItem | null, progress: (i: XMediaItem) => void): Promise<{ item: XMediaItem; checkAfterMs?: number }> {
  let item = prev;
  if (!item) {
    const r = await xCall<{ data: UploadData }>(ctx, {
      method: 'POST', path: '/2/media/upload/initialize', bearer: token, op: 'x.media.initialize',
      json: { media_type: 'video/mp4', total_bytes: bytes.byteLength, media_category: 'tweet_video' },
    });
    const id = r.data?.data?.id;
    if (!id) throw new XApiError(502, null, 'no_media_id', 'X did not return a media id', null);
    item = { assetId: m.assetId, mediaId: String(id), state: 'uploading', nextSegment: 0, expiresAt: expiry(ctx, r.data.data.expires_after_secs, null), video: true };
    progress(item);
  }
  const segments = Math.max(1, Math.ceil(bytes.byteLength / VIDEO_SEGMENT_BYTES));
  for (let seg = item.nextSegment ?? 0; item.state === 'uploading' && seg < segments; seg++) {
    const form = new FormData();
    form.append('segment_index', String(seg));
    form.append('media', new Blob([bytes.subarray(seg * VIDEO_SEGMENT_BYTES, (seg + 1) * VIDEO_SEGMENT_BYTES) as unknown as ArrayBuffer], { type: 'application/octet-stream' }), `segment-${seg}`);
    await xCall(ctx, { method: 'POST', path: `/2/media/upload/${encodeURIComponent(item.mediaId)}/append`, formData: form, bearer: token, op: 'x.media.append', timeoutMs: 120_000 });
    item = { ...item, nextSegment: seg + 1 };
    progress(item);
  }
  if (item.state === 'uploading') { item = { ...item, state: 'finalizing' }; progress(item); }
  let data: UploadData;
  try {
    const r = await xCall<{ data: UploadData }>(ctx, { method: 'POST', path: `/2/media/upload/${encodeURIComponent(item.mediaId)}/finalize`, bearer: token, op: 'x.media.finalize', timeoutMs: 60_000 });
    data = r.data?.data ?? {};
  } catch (err) {
    // A finalize whose response was lost may already have succeeded: ask STATUS before giving up.
    if (!(err instanceof XApiError) || err.status >= 500 || err.status === 429 || err.status === 401) throw err;
    data = (await status(ctx, token, item.mediaId)) ?? (() => { throw err; })();
  }
  return afterProcessing(ctx, item, data);
}

async function status(ctx: AdapterContext, token: string, mediaId: string): Promise<UploadData | null> {
  const r = await xCall<{ data: UploadData }>(ctx, { method: 'GET', path: '/2/media/upload', query: { command: 'STATUS', media_id: mediaId }, bearer: token, op: 'x.media.status' });
  return r.data?.data ?? null;
}

/**
 * Prepare 2–4 images or one video. `onError` maps provider errors exactly like the single-image path;
 * every failure carries the checkpoint so a retry resumes where it stopped.
 */
export async function prepareMedia(ctx: AdapterContext, input: PublishInput, token: string, cp: Checkpoint | null,
  onError: (err: unknown) => PrepareOutcome): Promise<PrepareOutcome> {
  const nowMs = ctx.now().getTime();
  const prev = itemsFrom(cp);
  const items: XMediaItem[] = [];
  let checkAfter: number | null = null;
  const withCp = (o: PrepareOutcome): PrepareOutcome => (o.kind === 'retryable' ? { ...o, checkpoint: checkpoint(items) } : o);

  for (let i = 0; i < input.media.length; i++) {
    const m = input.media[i]!;
    const p = prev[i];
    const usable = p && p.assetId === m.assetId && (!p.expiresAt || Date.parse(p.expiresAt) - nowMs > EXPIRY_MARGIN_MS) ? p : null;
    try {
      if (usable?.state === 'ready') { items.push(usable); continue; }
      if (usable?.state === 'processing') {
        const data = await status(ctx, token, usable.mediaId);
        const r = afterProcessing(ctx, usable, data ?? {});
        items.push(r.item);
        if (r.checkAfterMs) checkAfter = Math.min(checkAfter ?? Infinity, r.checkAfterMs);
        continue;
      }
      let bytes: Uint8Array;
      try {
        bytes = await m.load();
      } catch {
        return { kind: 'retryable', code: 'media_unavailable', message: `The ${isVideo(m) ? 'video' : 'image'} could not be read from storage; it will be retried.`, checkpoint: checkpoint(items) };
      }
      let r: { item: XMediaItem; checkAfterMs?: number };
      if (isVideo(m)) {
        let latest: XMediaItem | null = usable && (usable.state === 'uploading' || usable.state === 'finalizing') ? usable : null;
        try {
          r = await uploadVideo(ctx, token, m, bytes, latest, (it) => { latest = it; });
        } catch (err) {
          if (latest) items.push(latest);
          throw err;
        }
      } else {
        const data = await uploadImage(ctx, token, m, bytes);
        if (!data.id) return { kind: 'retryable', code: 'x_media_no_id', message: 'X did not return a media id; the upload will be retried.', checkpoint: checkpoint(items) };
        r = afterProcessing(ctx, { assetId: m.assetId, mediaId: String(data.id), state: 'processing', expiresAt: null, video: false }, data);
      }
      items.push(r.item);
      if (r.checkAfterMs) checkAfter = Math.min(checkAfter ?? Infinity, r.checkAfterMs);
    } catch (err) {
      if (err instanceof ProcessingFailed) {
        return { kind: 'permanent', code: 'x_media_processing_failed', message: isVideo(m) ? 'X could not process the video. Use an H.264/AAC MP4 (≤ 1280×1024, ≤ 60 fps).' : 'X could not process the image. Replace it with a JPEG or PNG up to 5 MB.' };
      }
      if (err instanceof TransportError || err instanceof XApiError) return withCp(onError(err));
      return { kind: 'retryable', code: 'unexpected', message: 'Unexpected error while uploading media to X; it will be retried.', checkpoint: checkpoint(items) };
    }
  }
  if (checkAfter !== null) return { kind: 'pending', checkpoint: checkpoint(items), checkAfterMs: checkAfter };
  return { kind: 'ready', checkpoint: checkpoint(items) };
}
