// Facebook Page multi-photo posts and Page videos (V1.1).
// Verified 2026-11-07:
//  - /{page-id}/photos reference: `published=false` uploads a photo without publishing; unpublished photos are
//    kept ~24 h; publish "a multi-photo post using the returned ids" via /{page-id}/feed with
//    attached_media[n]={"media_fbid":"<photo id>"}. Return {id, post_id}.
//  - /{page-id}/videos reference: `file_url` ("Accessible URL of a video file"), `description`, `title`,
//    `published` (default true). Error 389 "Unable to fetch video file from URL", 382 "file too small".
//  - Video Status reference: status.video_status ∈ ready | processing | error, processing_progress 0..100.
// Assumed: the video post's `description` is what /published_posts reports as `message` (reconcile search).
import type { AdapterContext, AttemptReference, Checkpoint, PrepareOutcome, PublishInput, PublishOutcome, ReconcileOutcome } from '@social-lite/core';
import { facebookPhotoCaption, pageIdOf } from './common.js';
import {
  isTransportError, normalizeGraphError, prepareOutcomeFromGraphError, prepareOutcomeFromTransportError,
  publishOutcomeFromGraphError, publishOutcomeFromTransportError,
} from './errors.js';
import { graph, str } from './graph.js';

/** Unpublished photos are deleted after ~24 h; re-upload well before that. */
export const UNPUBLISHED_PHOTO_TTL_MS = 20 * 60 * 60_000;
export const VIDEO_POLL_MS = 30_000;

interface AlbumData { kind: 'album'; photos: Array<{ assetId: string; photoId: string }>; createdAt: string; expiresAt: string }

function albumFrom(cp: Checkpoint | null): AlbumData | null {
  const d = cp?.data as Partial<AlbumData> | undefined;
  if (!d || d.kind !== 'album' || !Array.isArray(d.photos)) return null;
  return {
    kind: 'album',
    photos: d.photos.filter((p) => p && typeof p.photoId === 'string' && typeof p.assetId === 'string'),
    createdAt: typeof d.createdAt === 'string' ? d.createdAt : new Date(0).toISOString(),
    expiresAt: typeof d.expiresAt === 'string' ? d.expiresAt : new Date(0).toISOString(),
  };
}

const albumCp = (a: AlbumData): Checkpoint => ({ step: 'album_photos', data: { ...a }, expiresAt: a.expiresAt });

/** Upload every photo unpublished (invisible); already-uploaded photos are reused from the checkpoint. */
export async function prepareAlbum(ctx: AdapterContext, input: PublishInput, token: string, checkpoint: Checkpoint | null): Promise<PrepareOutcome> {
  const now = ctx.now();
  let a = albumFrom(checkpoint);
  if (a && (now.getTime() >= Date.parse(a.expiresAt) || a.photos.length > input.media.length || a.photos.some((p, i) => p.assetId !== input.media[i]!.assetId))) a = null;
  if (!a) a = { kind: 'album', photos: [], createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + UNPUBLISHED_PHOTO_TTL_MS).toISOString() };
  const pageId = pageIdOf(input.connection);
  for (let i = a.photos.length; i < input.media.length; i++) {
    const m = input.media[i]!;
    let res;
    try {
      res = await graph<{ id?: string }>(ctx, {
        method: 'POST', path: `${pageId}/photos`, token, op: 'meta.facebook.photo_stage', timeoutMs: 60_000,
        params: { url: m.url, published: false },
      });
    } catch (err) {
      if (isTransportError(err)) return prepareOutcomeFromTransportError(err, albumCp(a)); // unpublished photos are invisible
      throw err;
    }
    if (!res.ok) return prepareOutcomeFromGraphError(res.error, res.headers, albumCp(a));
    const id = str(res.data.id);
    if (!id) return { kind: 'retryable', code: 'missing_photo_id', message: 'Facebook did not return a photo ID. It will be retried.', retryAfterMs: 30_000, checkpoint: albumCp(a) };
    a = { ...a, photos: [...a.photos, { assetId: m.assetId, photoId: id }] };
  }
  return { kind: 'ready', checkpoint: albumCp(a) };
}

export async function publishAlbum(ctx: AdapterContext, input: PublishInput, token: string, checkpoint: Checkpoint | null, postUrl: (id: string) => string): Promise<PublishOutcome> {
  const a = albumFrom(checkpoint);
  if (!a || a.photos.length !== input.media.length) {
    return { kind: 'rejected_safe_to_retry', code: 'not_prepared', message: 'The Facebook photos were not uploaded yet. They will be uploaded and retried.', retryAfterMs: 5_000 };
  }
  const params: Record<string, string | boolean | undefined> = { message: facebookPhotoCaption(input.variant.text, input.variant.link) || undefined };
  a.photos.forEach((p, i) => { params[`attached_media[${i}]`] = JSON.stringify({ media_fbid: p.photoId }); });
  let res;
  try {
    res = await graph<{ id?: string }>(ctx, { method: 'POST', path: `${pageIdOf(input.connection)}/feed`, token, op: 'meta.facebook.feed', publishes: true, params });
  } catch (err) {
    if (isTransportError(err)) return publishOutcomeFromTransportError(err);
    throw err;
  }
  if (!res.ok) {
    const o = publishOutcomeFromGraphError(res.error, res.headers);
    // Staged photos gone (expired / deleted): nothing was published; prepare uploads them again.
    if (o.kind === 'permanent_failure' && normalizeGraphError(res.error).code === 'object_inaccessible') {
      return { kind: 'rejected_safe_to_retry', code: 'staged_photos_missing', message: 'Facebook no longer has the uploaded photos. They will be uploaded again.', retryAfterMs: 5_000 };
    }
    return o;
  }
  const postId = str(res.data.id);
  if (!postId) return { kind: 'unknown', code: 'missing_post_id', message: 'Facebook accepted the request but returned no post ID. Checking whether it was published.' };
  return { kind: 'confirmed', providerIds: [postId], url: postUrl(postId), publishedAt: ctx.now().toISOString() };
}

/** POST /{page-id}/videos {file_url, description}. Facebook processes the video asynchronously ⇒ 'processing'. */
export async function publishVideo(ctx: AdapterContext, input: PublishInput, token: string): Promise<PublishOutcome> {
  const video = input.media[0]!;
  let res;
  try {
    res = await graph<{ id?: string }>(ctx, {
      method: 'POST', path: `${pageIdOf(input.connection)}/videos`, token, op: 'meta.facebook.videos', publishes: true, timeoutMs: 120_000,
      params: { file_url: video.url, description: facebookPhotoCaption(input.variant.text, input.variant.link) || undefined, published: true },
    });
  } catch (err) {
    if (isTransportError(err)) return publishOutcomeFromTransportError(err);
    throw err;
  }
  if (!res.ok) return publishOutcomeFromGraphError(res.error, res.headers);
  const videoId = str(res.data.id);
  if (!videoId) return { kind: 'unknown', code: 'missing_video_id', message: 'Facebook accepted the video but returned no ID. Checking whether it was published.' };
  return {
    kind: 'processing', providerIds: [videoId], checkAfterMs: VIDEO_POLL_MS,
    checkpoint: { step: 'video_processing', data: { kind: 'video', videoId, sentAt: ctx.now().toISOString() } },
  };
}

interface VideoNode { id?: string; status?: { video_status?: string; processing_progress?: number }; permalink_url?: string; created_time?: string; post_id?: string }

export function isVideoAttempt(ref: Pick<AttemptReference, 'checkpoint'>): boolean {
  const d = ref.checkpoint?.data as { kind?: string } | undefined;
  return d?.kind === 'video';
}

const absolute = (u: string | null) => (u && u.startsWith('/') ? `https://www.facebook.com${u}` : u);

/** Status of a Page video by id (read-only). null ⇒ no known id; caller falls back to the post search. */
export async function reconcileVideo(ctx: AdapterContext, ref: AttemptReference, token: string): Promise<ReconcileOutcome | null> {
  const d = ref.checkpoint?.data as { videoId?: string } | undefined;
  const ids = [...new Set([...(typeof d?.videoId === 'string' ? [d.videoId] : []), ...ref.providerIds])];
  for (const id of ids) {
    const r = await graph<VideoNode>(ctx, { method: 'GET', path: id, token, params: { fields: 'id,status,permalink_url,created_time' }, op: 'meta.facebook.video_status' });
    if (!r.ok) {
      const n = normalizeGraphError(r.error, r.headers);
      if (n.cls === 'reconnect' || n.cls === 'permission') return { kind: 'still_unknown', reason: n.message };
      continue;
    }
    const status = r.data.status?.video_status;
    if (status === 'processing') return { kind: 'processing', checkAfterMs: VIDEO_POLL_MS };
    if (status === 'error') return { kind: 'not_published', reason: 'Facebook could not process the video. Use an H.264/AAC MP4 and try again.' };
    if (status === 'ready' || !status) {
      return { kind: 'published', providerIds: [r.data.id ?? id], url: absolute(str(r.data.permalink_url)) ?? `https://www.facebook.com/${encodeURIComponent(id)}`, publishedAt: str(r.data.created_time) };
    }
  }
  return null;
}
