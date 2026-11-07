// Shared helpers for the Meta adapters: constraints, scope sets, validation input mapping.
import {
  composeTextWithLink, validateVariant, type ChannelCapabilities, type ChannelConstraints, type MediaFacts,
  type PublishConnection, type PublishInput, type ValidationResult,
} from '@social-lite/core';
import { DEFAULT_GRAPH_VERSION } from './graph.js';

export const RESEARCHED_ON = '2026-11-06';
/** V1.1 richer-media research date (carousel / Reels / multi-photo / Page video). */
export const MEDIA_RESEARCHED_ON = '2026-11-07';

/** Video envelope shared by the media pipeline (MP4/MOV upload ≤ 300 MB, ≤ 15 min; publish derivative is MP4). */
const PIPELINE_VIDEO = {
  videoMimes: ['video/mp4', 'video/quicktime'],
  maxVideoBytes: 300 * 1_048_576,
  maxVideoSeconds: 15 * 60,
};

/** Scopes requested at login and checked by health(). See docs/providers/meta.md. */
export const FACEBOOK_SCOPES = ['pages_show_list', 'pages_read_engagement', 'pages_manage_posts'] as const;
export const INSTAGRAM_SCOPES = ['pages_show_list', 'pages_read_engagement', 'instagram_basic', 'instagram_content_publish'] as const;

/** Page tasks that allow creating content (verified: Pages API posts / photos references). */
export const POSTING_TASKS = ['CREATE_CONTENT', 'MANAGE'];

/**
 * Facebook Page constraints. Verified: /photos accepts JPEG/BMP/PNG/GIF/TIFF up to 10 MB
 * (we accept JPEG/PNG only — our media pipeline produces JPEG publish derivatives).
 * Text length: Meta does not document a Page post limit on the pages we could read; 63,206 is widely
 * reported. We use a conservative 10,000 code points (assumption, documented).
 */
export const FACEBOOK_CONSTRAINTS: ChannelConstraints = {
  maxTextLength: 10_000,
  maxCaptionLength: 10_000,
  textCounting: 'codepoints',
  requiresMedia: false,
  supportsTextOnly: true,
  supportsLink: true,
  supportsButtons: false,
  maxButtons: 0,
  // V1.1: multi-photo posts (unpublished /photos + /feed attached_media). 10 is a product limit (Meta documents none).
  maxImages: 10,
  maxAlbumItems: 10,
  minAlbumItems: 2,
  albumAllowsVideo: false,
  imageMimes: ['image/jpeg', 'image/png'],
  maxImageBytes: 10 * 1_048_576,
  // V1.1: single Page video (/{page-id}/videos file_url). Limits = pipeline envelope (Meta's are larger; not re-verified).
  maxVideos: 1,
  ...PIPELINE_VIDEO,
  videoCodecs: ['h264'],
  audioCodecs: ['aac'],
};

/**
 * Instagram image post constraints (verified: IG User Media reference, 2026-11-06):
 * JPEG only, ≤ 8 MB, aspect 4:5..1.91:1, width 320..1440 (scaled), caption ≤ 2,200 chars,
 * ≤ 30 hashtags, ≤ 20 @mentions. Meta says "characters"; we count code points (assumption).
 */
export const INSTAGRAM_CONSTRAINTS: ChannelConstraints = {
  maxTextLength: 2_200,
  maxCaptionLength: 2_200,
  textCounting: 'codepoints',
  requiresMedia: true,
  supportsTextOnly: false,
  supportsLink: false,
  supportsButtons: false,
  maxButtons: 0,
  // V1.1 carousel (verified 2026-11-07, IG User Media reference): up to 20 images/videos, mixed allowed.
  maxImages: 20,
  maxAlbumItems: 20,
  minAlbumItems: 2,
  albumAllowsVideo: true,
  imageMimes: ['image/jpeg'],
  maxImageBytes: 8 * 1_048_576,
  minImageWidth: 320,
  minAspectRatio: 0.8,
  maxAspectRatio: 1.91,
  maxHashtags: 30,
  maxMentions: 20,
  // V1.1 Reels (verified 2026-11-07, "Reel Video Specifications"): MOV/MP4, H.264/HEVC, AAC, 23–60 fps,
  // ≤ 1920 columns, aspect 0.01:1..10:1 (9:16 recommended), 3 s – 15 min, ≤ 300 MB.
  maxVideos: 1,
  ...PIPELINE_VIDEO,
  minVideoSeconds: 3,
  videoCodecs: ['h264', 'hevc'],
  audioCodecs: ['aac'],
  minVideoAspectRatio: 0.01,
  maxVideoAspectRatio: 10,
  maxVideoWidth: 1920,
  minFrameRate: 23,
  maxFrameRate: 60,
};

export function capabilitiesFor(provider: 'facebook' | 'instagram', connection: PublishConnection): ChannelCapabilities {
  const version = typeof connection.metadata?.graph_version === 'string' ? connection.metadata.graph_version : DEFAULT_GRAPH_VERSION;
  return {
    provider,
    // V1.1: album = IG carousel / FB multi-photo; IG videos publish as Reels, FB as Page videos.
    formats: provider === 'facebook' ? ['text', 'image', 'album', 'video'] : ['image', 'album', 'reel'],
    canPublish: true,
    canEditPublished: false,
    canDeletePublished: false,
    canReadMetrics: false,
    canReconcile: true,
    constraints: provider === 'facebook' ? FACEBOOK_CONSTRAINTS : INSTAGRAM_CONSTRAINTS,
    constraintsVersion: `meta-${provider}-${MEDIA_RESEARCHED_ON}-${version}`,
    checkedAt: `${RESEARCHED_ON}T00:00:00.000Z`,
  };
}

export function toMediaFacts(media: PublishInput['media']): MediaFacts[] {
  return media.map((m) => ({
    assetId: m.assetId, status: 'ready', mime: m.mime, bytes: m.bytes, width: m.width, height: m.height,
    kind: m.kind, durationMs: m.durationMs, videoCodec: m.videoCodec, audioCodec: m.audioCodec, frameRate: m.frameRate,
  }));
}

export function validateMeta(provider: 'facebook' | 'instagram', input: Pick<PublishInput, 'variant' | 'media' | 'connection'>): ValidationResult {
  const constraints = provider === 'facebook' ? FACEBOOK_CONSTRAINTS : INSTAGRAM_CONSTRAINTS;
  return validateVariant({
    provider,
    connectionId: input.connection.id,
    constraints,
    text: input.variant.text,
    link: input.variant.link,
    buttons: input.variant.buttons,
    media: toMediaFacts(input.media),
    // Facebook text posts send the link as the separate `link` field; photo captions have no link field.
    linkIsSeparateField: provider === 'facebook' && input.media.length === 0,
  });
}

export function validationFailureMessage(r: ValidationResult): string {
  return r.issues.map((i) => i.message).join(' ');
}

/** Text actually sent for a Facebook photo caption (link appended because /photos has no link field). */
export function facebookPhotoCaption(text: string, link: string | null): string {
  return composeTextWithLink(text, link);
}

export function pageIdOf(connection: PublishConnection): string {
  const v = connection.metadata?.page_id;
  return typeof v === 'string' && v ? v : connection.providerAccountId;
}

export function igUserIdOf(connection: PublishConnection): string {
  const v = connection.metadata?.ig_user_id;
  return typeof v === 'string' && v ? v : connection.providerAccountId;
}

/** Whitespace-normalised comparison used by reconciliation. */
export function normText(s: string | null | undefined): string {
  return (s ?? '').replace(/\s+/g, ' ').trim();
}

/** true when a provider-side message plausibly is our post (exact, or our text + appended link). */
export function textMatches(providerText: string | null | undefined, ours: string): boolean {
  const a = normText(providerText);
  const b = normText(ours);
  if (!b) return false;
  return a === b || a.startsWith(b);
}

export function unixSeconds(d: Date): number {
  return Math.floor(d.getTime() / 1000);
}

export function missingScopes(required: readonly string[], granted: string[]): string[] {
  const g = new Set(granted);
  return required.filter((s) => !g.has(s));
}

/** Publication shape for the attached media (V1.1). */
export type MetaShape = 'text' | 'image' | 'carousel' | 'album' | 'reel' | 'video';

export function metaShape(provider: 'facebook' | 'instagram', media: PublishInput['media']): MetaShape {
  if (media.length === 0) return 'text';
  if (media.length > 1) return provider === 'instagram' ? 'carousel' : 'album';
  const isVideo = media[0]!.kind === 'video' || media[0]!.mime.startsWith('video/');
  if (isVideo) return provider === 'instagram' ? 'reel' : 'video';
  return 'image';
}

export const isVideoMedia = (m: PublishInput['media'][number]): boolean => m.kind === 'video' || m.mime.startsWith('video/');
