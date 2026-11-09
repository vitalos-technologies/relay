// Instagram carousel preparation (V1.1). Verified 2026-11-07 (IG content publishing guide + IG User Media
// reference): one child container per item with is_carousel_item=true (images: image_url; videos:
// media_type=VIDEO + video_url; captions are NOT supported on children), then a parent container with
// media_type=CAROUSEL, children=<comma-separated ids> and the caption. Up to 20 items, images and videos mixed.
// The parent is published with the normal media_publish call (instagram.ts publish()).
//
// Checkpoint (resumable, nothing is visible until media_publish):
//   { step, data: { kind:'carousel', children:[{assetId, containerId, finished, video}], containerId?, createdAt, expiresAt, polls } }
// Children already created are never re-created on resume; an expired set (24 h) is rebuilt from scratch,
// after checking that the parent was not already published.
import { altTextFor, type AdapterContext, type Checkpoint, type PrepareOutcome, type PublishInput } from '@social-lite/core';
import { igUserIdOf, isVideoMedia } from './common.js';
import { isTransportError, normalizeGraphError, prepareOutcomeFromGraphError, prepareOutcomeFromTransportError } from './errors.js';
import { graph, str } from './graph.js';
import {
  CONTAINER_TTL_MS, PROCESSING_TIMEOUT_MS, VIDEO_PROCESSING_TIMEOUT_MS, checkpointOf, containerStatus, pollContainer, pollDelayMs,
  type ContainerData,
} from './instagram.js';

const EXPIRY_SAFETY_MS = 10 * 60_000;

type Child = NonNullable<ContainerData['children']>[number];

interface CarouselState {
  containerId: string;        // parent; '' until created
  createdAt: string;
  expiresAt: string;
  polls: number;
  published?: boolean;
  children: Child[];
}

function stateFrom(cp: Checkpoint | null): CarouselState | null {
  const d = cp?.data as Partial<ContainerData> | undefined;
  if (!d || d.kind !== 'carousel' || !Array.isArray(d.children)) return null;
  const children = d.children.filter((c): c is Child => !!c && typeof c.containerId === 'string' && typeof c.assetId === 'string');
  return {
    containerId: typeof d.containerId === 'string' ? d.containerId : '',
    createdAt: typeof d.createdAt === 'string' ? d.createdAt : new Date(0).toISOString(),
    expiresAt: typeof d.expiresAt === 'string' ? d.expiresAt : new Date(0).toISOString(),
    polls: typeof d.polls === 'number' ? d.polls : 0,
    published: d.published === true,
    children,
  };
}

const asData = (s: CarouselState): ContainerData => ({ ...s, kind: 'carousel' });
const cp = (step: string, s: CarouselState): Checkpoint => checkpointOf(step, asData(s));

function fresh(ctx: AdapterContext): CarouselState {
  const now = ctx.now();
  return { containerId: '', createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + CONTAINER_TTL_MS).toISOString(), polls: 0, children: [] };
}

const position = (i: number, n: number) => `item ${i + 1} of ${n}`;

export async function prepareCarousel(ctx: AdapterContext, input: PublishInput, token: string, checkpoint: Checkpoint | null): Promise<PrepareOutcome> {
  const igUserId = igUserIdOf(input.connection);
  let s = stateFrom(checkpoint);

  if (s) {
    if (s.published) return { kind: 'ready', checkpoint: cp('container_published', s) };
    const expires = Date.parse(s.expiresAt);
    if (!Number.isFinite(expires) || ctx.now().getTime() >= expires - EXPIRY_SAFETY_MS) {
      // Never rebuild a carousel whose parent may already be published.
      if (s.containerId) {
        try {
          const st = await containerStatus(ctx, token, s.containerId);
          if (st.ok && st.data.status_code === 'PUBLISHED') return { kind: 'ready', checkpoint: cp('container_published', { ...s, published: true }) };
        } catch { /* unreachable status does not block rebuilding an expired set */ }
      }
      s = null;
    }
  }
  // Media changed since the checkpoint (e.g. a retry after an edit): start over.
  if (s && (s.children.length > input.media.length || s.children.some((c, i) => c.assetId !== input.media[i]!.assetId))) s = null;
  if (!s) s = fresh(ctx);

  // Parent already created: poll it (FINISHED ⇒ ready, PUBLISHED ⇒ ready+published, EXPIRED ⇒ rebuild).
  if (s.containerId) return pollContainer(ctx, token, asData(s), input, false);

  // 1) Create the missing children, in order. Progress is checkpointed on every failure.
  const n = input.media.length;
  for (let i = s.children.length; i < n; i++) {
    const m = input.media[i]!;
    const video = isVideoMedia(m);
    let res;
    try {
      res = await graph<{ id?: string }>(ctx, {
        method: 'POST', path: `${igUserId}/media`, token, op: 'meta.instagram.carousel_item_create', timeoutMs: 60_000,
        params: video ? { media_type: 'VIDEO', video_url: m.url, is_carousel_item: true } : { image_url: m.url, is_carousel_item: true, alt_text: altTextFor('instagram', m) ?? undefined },
      });
    } catch (err) {
      if (isTransportError(err)) return prepareOutcomeFromTransportError(err, cp('carousel_children', s));
      throw err;
    }
    if (!res.ok) {
      const o = prepareOutcomeFromGraphError(res.error, res.headers, cp('carousel_children', s));
      return o.kind === 'permanent' ? { ...o, message: `${o.message} (carousel ${position(i, n)})` } : o;
    }
    const id = str(res.data.id);
    if (!id) return { kind: 'retryable', code: 'missing_container_id', message: 'Instagram did not return an upload ID. It will be retried.', retryAfterMs: 30_000, checkpoint: cp('carousel_children', s) };
    s = { ...s, children: [...s.children, { assetId: m.assetId, containerId: id, finished: false, video }] };
  }

  // 2) Every child must be FINISHED before the parent can be created.
  let pending = false;
  const children = [...s.children];
  for (let i = 0; i < children.length; i++) {
    const c = children[i]!;
    if (c.finished) continue;
    let st;
    try {
      st = await containerStatus(ctx, token, c.containerId);
    } catch (err) {
      if (isTransportError(err)) return prepareOutcomeFromTransportError(err, cp('carousel_children', { ...s, children }));
      throw err;
    }
    if (!st.ok) {
      const ne = normalizeGraphError(st.error, st.headers);
      if (ne.cls === 'container_expired') return { kind: 'retryable', code: ne.code, message: ne.message, retryAfterMs: 5_000 }; // rebuild
      return prepareOutcomeFromGraphError(st.error, st.headers, cp('carousel_children', { ...s, children }));
    }
    const code = st.data.status_code;
    if (code === 'FINISHED') children[i] = { ...c, finished: true };
    else if (code === 'EXPIRED') return { kind: 'retryable', code: 'ig_container_expired', message: 'A prepared carousel item expired. The carousel will be prepared again.', retryAfterMs: 5_000 };
    else if (code === 'ERROR') {
      return {
        kind: 'permanent', code: 'ig_carousel_item_error',
        message: c.video
          ? `Instagram could not process the video (carousel ${position(i, n)}). Use an H.264/AAC MP4 of 3 s – 15 min, 23–60 fps, then try again.`
          : `Instagram could not process the image (carousel ${position(i, n)}). Use a JPEG between 4:5 and 1.91:1, at least 320px wide and under 8 MB.`,
      };
    } else pending = true;
  }
  s = { ...s, children, polls: s.polls + 1 };
  if (pending) {
    const anyVideo = children.some((c) => c.video);
    if (ctx.now().getTime() - Date.parse(s.createdAt) > (anyVideo ? VIDEO_PROCESSING_TIMEOUT_MS : PROCESSING_TIMEOUT_MS)) {
      return { kind: 'retryable', code: 'ig_processing_timeout', message: 'Instagram is taking too long to process the carousel items. A fresh upload will be tried.', retryAfterMs: 60_000 };
    }
    return { kind: 'pending', checkpoint: cp('carousel_children', s), checkAfterMs: pollDelayMs(s.polls - 1, anyVideo) };
  }

  // 3) Parent container with the caption.
  let res;
  try {
    res = await graph<{ id?: string }>(ctx, {
      method: 'POST', path: `${igUserId}/media`, token, op: 'meta.instagram.media_create', timeoutMs: 60_000,
      params: { media_type: 'CAROUSEL', children: s.children.map((c) => c.containerId).join(','), caption: input.variant.text || undefined },
    });
  } catch (err) {
    if (isTransportError(err)) return prepareOutcomeFromTransportError(err, cp('carousel_children', s));
    throw err;
  }
  if (!res.ok) return prepareOutcomeFromGraphError(res.error, res.headers, cp('carousel_children', s));
  const parent = str(res.data.id);
  if (!parent) return { kind: 'retryable', code: 'missing_container_id', message: 'Instagram did not return an upload ID. It will be retried.', retryAfterMs: 30_000, checkpoint: cp('carousel_children', s) };
  s = { ...s, containerId: parent, polls: 0 };
  return pollContainer(ctx, token, asData(s), input, true);
}
