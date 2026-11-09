// Facebook Page publishing adapter (Graph API, Page access token).
//  text/link  → POST /{page-id}/feed   { message, link }
//  image      → POST /{page-id}/photos { url, caption, alt_text_custom?, published=true }   (caption verified; `message` is deprecated)
//  album      → prepare: POST /{page-id}/photos { url, alt_text_custom?, published=false } per photo (checkpointed)
//  alt_text_custom = the library alt text (fix H3; core altTextFor).
//               publish: POST /{page-id}/feed { message, attached_media[n]={"media_fbid":…} }        (V1.1)
//  video      → POST /{page-id}/videos { file_url, description } ⇒ processing; reconcile polls status  (V1.1)
import {
  altTextFor,
  type AdapterContext, type AttemptReference, type ConnectionHealth, type Checkpoint, type PrepareOutcome, type ProviderCredentials,
  type PublishConnection, type PublishInput, type PublishOutcome, type PublishingAdapter, type ReconcileOutcome,
} from '@social-lite/core';
import {
  capabilitiesFor, facebookPhotoCaption, metaShape, pageIdOf, textMatches, unixSeconds, validateMeta, validationFailureMessage,
} from './common.js';
import { isVideoAttempt, prepareAlbum, publishAlbum, publishVideo, reconcileVideo } from './facebook-media.js';
import { isTransportError, normalizeGraphError, publishOutcomeFromGraphError, publishOutcomeFromTransportError } from './errors.js';
import { graph, pageToken, str } from './graph.js';
import { metaHealth } from './health.js';

export function facebookPostUrl(id: string): string {
  return `https://www.facebook.com/${encodeURIComponent(id)}`;
}

const RECONCILE_WINDOW_MS = 10 * 60_000;

interface PagePost { id?: string; message?: string; created_time?: string; permalink_url?: string }

export const facebookAdapter: PublishingAdapter = {
  provider: 'facebook',

  capabilities(connection: PublishConnection) {
    return capabilitiesFor('facebook', connection);
  },

  validate(input) {
    return validateMeta('facebook', input);
  },

  async prepare(ctx: AdapterContext, input: PublishInput, checkpoint: Checkpoint | null): Promise<PrepareOutcome> {
    const v = validateMeta('facebook', input);
    if (!v.ok) return { kind: 'permanent', code: 'invalid_content', message: validationFailureMessage(v) };
    const token = pageToken(input.credentials);
    if (!token) {
      return { kind: 'permanent', code: 'credentials_missing', message: 'This Facebook Page has no usable credentials. Reconnect it in Settings → Connections.', blocking: 'reconnect' };
    }
    const shape = metaShape('facebook', input.media);
    if (shape === 'album') return prepareAlbum(ctx, input, token, checkpoint);
    // The video is fetched by Meta from file_url at publish time; the checkpoint marks the attempt as a video.
    if (shape === 'video') return { kind: 'ready', checkpoint: { step: 'video_ready', data: { kind: 'video' } } };
    // Facebook needs no provider-side preparation: the image URL is fetched by Meta at publish time.
    return { kind: 'ready', checkpoint: checkpoint ?? { step: 'ready', data: {} } };
  },

  async publish(ctx: AdapterContext, input: PublishInput, checkpoint?: Checkpoint | null): Promise<PublishOutcome> {
    const v = validateMeta('facebook', input);
    if (!v.ok) return { kind: 'permanent_failure', code: 'invalid_content', message: validationFailureMessage(v) };
    const token = pageToken(input.credentials);
    if (!token) return { kind: 'permanent_failure', code: 'credentials_missing', message: 'This Facebook Page has no usable credentials. Reconnect it in Settings → Connections.', blocking: 'reconnect' };
    const shape = metaShape('facebook', input.media);
    if (shape === 'album') return publishAlbum(ctx, input, token, checkpoint ?? null, facebookPostUrl);
    if (shape === 'video') return publishVideo(ctx, input, token);
    const pageId = pageIdOf(input.connection);
    const image = input.media[0];

    let res;
    try {
      res = image
        ? await graph<{ id?: string; post_id?: string }>(ctx, {
          method: 'POST', path: `${pageId}/photos`, token, op: 'meta.facebook.photos', publishes: true,
          params: { url: image.url, caption: facebookPhotoCaption(input.variant.text, input.variant.link) || undefined, alt_text_custom: altTextFor('facebook', image) ?? undefined, published: true },
        })
        : await graph<{ id?: string }>(ctx, {
          method: 'POST', path: `${pageId}/feed`, token, op: 'meta.facebook.feed', publishes: true,
          params: { message: input.variant.text || undefined, link: input.variant.link || undefined },
        });
    } catch (err) {
      if (isTransportError(err)) return publishOutcomeFromTransportError(err);
      throw err;
    }
    if (!res.ok) return publishOutcomeFromGraphError(res.error, res.headers);

    const data = res.data as { id?: string; post_id?: string };
    const postId = str(data.post_id) ?? str(data.id);
    if (!postId) {
      return { kind: 'unknown', code: 'missing_post_id', message: 'Facebook accepted the request but returned no post ID. Checking whether it was published.' };
    }
    const providerIds = image && str(data.id) && data.id !== postId ? [postId, data.id!] : [postId];
    return { kind: 'confirmed', providerIds, url: facebookPostUrl(postId), publishedAt: ctx.now().toISOString() };
  },

  async reconcile(ctx: AdapterContext, ref: AttemptReference): Promise<ReconcileOutcome> {
    const token = pageToken(ref.credentials);
    if (!token) return { kind: 'still_unknown', reason: 'No usable credentials to check Facebook; reconnect the Page, then check again.' };
    try {
      // 0) V1.1 Page video: the video status decides (processing / ready / error).
      if (isVideoAttempt(ref)) {
        const r = await reconcileVideo(ctx, ref, token);
        if (r) return r;
      }
      // 1) Known IDs (late worker / partial response): look them up directly.
      for (const id of ref.providerIds) {
        const r = await graph<PagePost>(ctx, { method: 'GET', path: id, token, params: { fields: 'id,created_time,permalink_url' }, op: 'meta.facebook.post_lookup' });
        if (r.ok && str(r.data.id)) {
          return { kind: 'published', providerIds: [r.data.id!], url: str(r.data.permalink_url) ?? facebookPostUrl(r.data.id!), publishedAt: str(r.data.created_time) };
        }
      }
      // 2) Search the Page's recent published posts for our text.
      const sentAt = ref.sentAt ? new Date(ref.sentAt) : new Date(ctx.now().getTime() - 60 * 60_000);
      const since = new Date(sentAt.getTime() - RECONCILE_WINDOW_MS);
      const r = await graph<{ data?: PagePost[] }>(ctx, {
        method: 'GET', path: `${pageIdOf(ref.connection)}/published_posts`, token, op: 'meta.facebook.published_posts',
        params: { fields: 'id,message,created_time,permalink_url', since: unixSeconds(since), limit: 25 },
      });
      if (!r.ok) {
        const n = normalizeGraphError(r.error, r.headers);
        return { kind: 'still_unknown', reason: `Could not search the Page's posts (${n.code}). ${n.cls === 'reconnect' || n.cls === 'permission' ? n.message : 'Will check again.'}` };
      }
      const match = (r.data.data ?? []).find((p) => {
        if (!str(p.id)) return false;
        const t = p.created_time ? Date.parse(p.created_time) : NaN;
        if (Number.isFinite(t) && t < since.getTime()) return false;
        return textMatches(p.message, ref.variantText);
      });
      if (match) {
        return { kind: 'published', providerIds: [match.id!], url: str(match.permalink_url) ?? facebookPostUrl(match.id!), publishedAt: str(match.created_time) };
      }
      // Absence from a ranked listing is not proof of non-publication.
      return { kind: 'still_unknown', reason: 'No matching Page post found yet. Facebook does not offer an idempotency key, so the post cannot be proven absent; check the Page before retrying.' };
    } catch (err) {
      if (isTransportError(err)) return { kind: 'still_unknown', reason: 'Could not reach Facebook to check. Will check again.' };
      throw err;
    }
  },

  async health(ctx: AdapterContext, connection: PublishConnection, credentials: ProviderCredentials): Promise<ConnectionHealth> {
    return metaHealth(ctx, 'facebook', connection, credentials);
  },
};
