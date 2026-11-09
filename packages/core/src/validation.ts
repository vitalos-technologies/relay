// Destination-aware validation (CO-04). Used when composing, scheduling and at dispatch.
import { countHashtags, countMentions, measure, composeTextWithLink } from './text.js';
import type { ChannelConstraints, MediaFormat, MediaKind, Provider, ResolvedVariant, ValidationIssue, ValidationResult, DraftContent, UrlButton } from './types.js';
import { PROVIDER_LABEL } from './types.js';
import { altTextTooLong } from './alt-text.js';

export interface MediaFacts {
  assetId: string;
  status: 'ready' | 'pending_upload' | 'quarantined' | 'rejected' | 'archived' | 'missing';
  mime: string | null;
  bytes: number | null;
  width: number | null;
  height: number | null;
  // ---- V1.1 (optional, additive)
  /** 'image' | 'video'. Absent ⇒ inferred from mime (video/* ⇒ video). */
  kind?: MediaKind;
  durationMs?: number | null;
  videoCodec?: string | null;
  audioCodec?: string | null;
  frameRate?: number | null;
  /** Library alt text (fix H3): checked against the network's alt-text limit. */
  altText?: string | null;
}

/** Media kind from an explicit kind or the MIME type. */
export function mediaKindOf(m: { kind?: MediaKind | null; mime?: string | null }): MediaKind {
  if (m.kind === 'video' || m.kind === 'image') return m.kind;
  return m.mime?.startsWith('video/') ? 'video' : 'image';
}

/**
 * Publication format for a destination given the kinds of its attached media, in order.
 * 0 items ⇒ text; 1 image ⇒ image; 1 video ⇒ reel on Instagram (the only IG video feed format), else video;
 * 2+ items ⇒ album (Instagram carousel, Facebook multi-photo, Telegram media group, X multi-image).
 */
export function deriveFormat(provider: Provider, kinds: MediaKind[]): MediaFormat {
  if (kinds.length === 0) return 'text';
  if (kinds.length > 1) return 'album';
  if (kinds[0] === 'video') return provider === 'instagram' ? 'reel' : 'video';
  return 'image';
}

export interface ValidateVariantInput {
  provider: Provider;
  connectionId: string;
  constraints: ChannelConstraints;
  text: string;
  link: string | null;
  buttons: UrlButton[];
  media: MediaFacts[];
  /** true when the link is sent as a separate field (Facebook feed link); otherwise appended to text. */
  linkIsSeparateField?: boolean;
  /** variant.options (fix H3: a Pinterest "Alt text" option replaces the library alt text). */
  options?: Record<string, unknown>;
}

const URL_RE = /^https:\/\/[^\s/$.?#].[^\s]*$/i;

const fmtSeconds = (s: number) => (s >= 60 ? `${Math.floor(s / 60)} min${s % 60 ? ` ${Math.round(s % 60)} s` : ''}` : `${Number.isInteger(s) ? s : s.toFixed(1)} s`);

function validateVideo(m: MediaFacts, c: ChannelConstraints, add: (field: ValidationIssue['field'], code: string, message: string) => void): void {
  if (m.mime && c.videoMimes && !c.videoMimes.includes(m.mime)) add('media', 'video_mime', `${m.mime} videos are not accepted (allowed: ${c.videoMimes.join(', ')}).`);
  if (m.bytes && c.maxVideoBytes && m.bytes > c.maxVideoBytes) add('media', 'video_too_large', `video is ${(m.bytes / 1_048_576).toFixed(1)} MB; the limit is ${(c.maxVideoBytes / 1_048_576).toFixed(0)} MB.`);
  if (m.durationMs !== undefined && m.durationMs !== null) {
    const sec = m.durationMs / 1000;
    if (c.minVideoSeconds && sec < c.minVideoSeconds - 0.001) add('media', 'video_too_short', `video is ${fmtSeconds(sec)} long; at least ${fmtSeconds(c.minVideoSeconds)} is required.`);
    if (c.maxVideoSeconds && sec > c.maxVideoSeconds + 0.001) add('media', 'video_too_long', `video is ${fmtSeconds(sec)} long; the limit is ${fmtSeconds(c.maxVideoSeconds)}. Trim it.`);
  }
  if (m.videoCodec && c.videoCodecs && !c.videoCodecs.includes(m.videoCodec)) add('media', 'video_codec', `video codec ${m.videoCodec} is not accepted (allowed: ${c.videoCodecs.join(', ')}).`);
  if (m.audioCodec && c.audioCodecs && !c.audioCodecs.includes(m.audioCodec)) add('media', 'audio_codec', `audio codec ${m.audioCodec} is not accepted (allowed: ${c.audioCodecs.join(', ')}).`);
  if (m.frameRate && c.maxFrameRate && m.frameRate > c.maxFrameRate + 0.01) add('media', 'frame_rate', `video is ${m.frameRate.toFixed(0)} fps; at most ${c.maxFrameRate} fps.`);
  if (m.frameRate && c.minFrameRate && m.frameRate < c.minFrameRate - 0.01) add('media', 'frame_rate', `video is ${m.frameRate.toFixed(0)} fps; at least ${c.minFrameRate} fps is required.`);
  if (m.width && m.height) {
    const ar = m.width / m.height;
    if (c.minVideoAspectRatio && ar < c.minVideoAspectRatio - 0.005) add('media', 'video_aspect', `video aspect ratio ${ar.toFixed(2)} is too tall (minimum ${c.minVideoAspectRatio.toFixed(2)}). Crop it.`);
    if (c.maxVideoAspectRatio && ar > c.maxVideoAspectRatio + 0.005) add('media', 'video_aspect', `video aspect ratio ${ar.toFixed(2)} is too wide (maximum ${c.maxVideoAspectRatio.toFixed(2)}). Crop it.`);
    if (c.maxVideoWidth && m.width > c.maxVideoWidth) add('media', 'video_dimensions', `video is ${m.width}px wide; at most ${c.maxVideoWidth}px.`);
    const long = Math.max(m.width, m.height);
    const short = Math.min(m.width, m.height);
    if ((c.maxVideoLongSide && long > c.maxVideoLongSide) || (c.maxVideoShortSide && short > c.maxVideoShortSide)) {
      add('media', 'video_dimensions', `video is ${m.width}×${m.height}; at most ${c.maxVideoLongSide ?? long}×${c.maxVideoShortSide ?? short} (either orientation).`);
    }
  }
}

export function validateVariant(v: ValidateVariantInput): ValidationResult {
  const issues: ValidationIssue[] = [];
  const label = PROVIDER_LABEL[v.provider];
  const add = (field: ValidationIssue['field'], code: string, message: string) =>
    issues.push({ connectionId: v.connectionId, provider: v.provider, field, code, message: `${label}: ${message}` });
  const c = v.constraints;
  const hasMedia = v.media.length > 0;

  const kinds = v.media.map(mediaKindOf);
  const videos = kinds.filter((k) => k === 'video').length;
  const images = kinds.length - videos;
  const isAlbum = v.media.length > 1;
  const maxVideos = c.maxVideos ?? 0;

  // Name the media the destination actually accepts (YouTube/TikTok are video-only).
  const acceptsImages = c.maxImages > 0 && c.imageMimes.length > 0;
  const needed = acceptsImages && maxVideos > 0 ? 'an image or video' : maxVideos > 0 ? 'a video' : 'an image';
  if (c.requiresMedia && !hasMedia) add('media', 'media_required', `${needed} is required. Add ${needed} or remove this destination.`);
  else if (!hasMedia && !c.supportsTextOnly) add('media', 'text_only_unsupported', `text-only posts are not supported. Add ${needed}.`);
  if (videos > 0 && maxVideos <= 0) {
    add('media', 'video_unsupported', 'videos are not supported for this destination. Remove the video or deselect it.');
  } else if (videos > 0 && isAlbum && !c.albumAllowsVideo) {
    add('media', 'mixed_media_unsupported', 'a video must be posted on its own here. Remove the other media or the video.');
  } else if (!isAlbum && videos > maxVideos) {
    add('media', 'too_many_videos', `at most ${maxVideos} video per post.`);
  }
  if (images > c.maxImages) add('media', 'too_many_images', `at most ${c.maxImages} image${c.maxImages === 1 ? '' : 's'} per post in this release. Remove ${images - c.maxImages}.`);
  if (isAlbum) {
    const maxItems = c.maxAlbumItems ?? c.maxImages;
    if (v.media.length > maxItems && images <= c.maxImages) add('media', 'too_many_items', `at most ${maxItems} items per post. Remove ${v.media.length - maxItems}.`);
    if (c.minAlbumItems && v.media.length < c.minAlbumItems) add('media', 'too_few_items', `a multi-item post needs at least ${c.minAlbumItems} items.`);
    if (c.albumSupportsButtons === false && v.buttons.length && c.supportsButtons) {
      add('buttons', 'album_buttons_unsupported', 'buttons cannot be attached to a multi-image post. Remove the buttons or use one image.');
    }
  }

  const outgoing = v.linkIsSeparateField ? v.text : composeTextWithLink(v.text, v.link);
  if (!hasMedia && outgoing.trim().length === 0) add('text', 'empty', 'write some text or add an image.');
  const limit = hasMedia ? c.maxCaptionLength : c.maxTextLength;
  const len = measure(outgoing, c.textCounting);
  if (len > limit) {
    add('text', 'too_long', `${hasMedia ? 'caption' : 'text'} is ${len} of ${limit} allowed${c.textCounting === 'x_weighted' ? ' (X-weighted; links count as 23)' : ''}. Shorten by ${len - limit}.`);
  }
  if (c.maxHashtags !== undefined && countHashtags(outgoing) > c.maxHashtags) add('text', 'too_many_hashtags', `use at most ${c.maxHashtags} hashtags.`);
  if (c.maxMentions !== undefined && countMentions(outgoing) > c.maxMentions) add('text', 'too_many_mentions', `use at most ${c.maxMentions} mentions.`);

  if (v.link) {
    if (!URL_RE.test(v.link)) add('link', 'invalid_link', 'links must be full https:// URLs.');
    if (!c.supportsLink) add('link', 'link_unsupported', 'links are not clickable here; put the URL in your bio or remove it.');
  }
  if (v.buttons.length) {
    if (!c.supportsButtons) add('buttons', 'buttons_unsupported', 'buttons are not supported for this destination. Remove them.');
    if (v.buttons.length > c.maxButtons) add('buttons', 'too_many_buttons', `at most ${c.maxButtons} buttons.`);
    for (const b of v.buttons) {
      if (!b.text.trim()) add('buttons', 'button_text', 'every button needs a label.');
      if (!URL_RE.test(b.url)) add('buttons', 'button_url', `button "${b.text}" needs a full https:// URL.`);
    }
  }

  for (const m of v.media) {
    const kind = mediaKindOf(m);
    const noun = kind === 'video' ? 'video' : 'image';
    if (m.status !== 'ready') {
      add('media', 'media_not_ready', m.status === 'rejected' ? `an attached ${noun} was rejected. Replace it.` : m.status === 'missing' ? `an attached ${noun} no longer exists. Replace it.` : `an attached ${noun} is still processing. Wait for it to finish.`);
      continue;
    }
    if (kind === 'video') {
      if (maxVideos <= 0) continue; // already reported once as video_unsupported
      validateVideo(m, c, add);
      continue;
    }
    if (m.mime && !c.imageMimes.includes(m.mime)) add('media', 'mime', `${m.mime} is not accepted (allowed: ${c.imageMimes.join(', ')}).`);
    if (m.bytes && m.bytes > c.maxImageBytes) add('media', 'too_large', `image is ${(m.bytes / 1_048_576).toFixed(1)} MB; the limit is ${(c.maxImageBytes / 1_048_576).toFixed(0)} MB.`);
    if (m.width && m.height) {
      if (c.minImageWidth && m.width < c.minImageWidth) add('media', 'too_small', `image is ${m.width}px wide; at least ${c.minImageWidth}px is required.`);
      const ar = m.width / m.height;
      if (c.minAspectRatio && ar < c.minAspectRatio - 0.005) add('media', 'aspect', `image aspect ratio ${ar.toFixed(2)} is too tall (minimum ${c.minAspectRatio.toFixed(2)}, e.g. 4:5). Crop it.`);
      if (c.maxAspectRatio && ar > c.maxAspectRatio + 0.005) add('media', 'aspect', `image aspect ratio ${ar.toFixed(2)} is too wide (maximum ${c.maxAspectRatio.toFixed(2)}, e.g. 1.91:1). Crop it.`);
    }
  }
  for (const t of altTextTooLong(v.provider, v.media, v.options)) {
    add('media', 'alt_text_too_long', `alt text of ${v.media.length > 1 ? `item ${t.index + 1}` : 'the image'} is ${t.length} of ${t.max} characters. Shorten it in the library${v.provider === 'pinterest' ? ' or type a Pinterest alt text' : ''}.`);
  }
  return { ok: issues.length === 0, issues };
}

export function mergeResults(results: ValidationResult[]): ValidationResult {
  const issues = results.flatMap((r) => r.issues);
  return { ok: issues.length === 0, issues };
}

/** Resolve the working draft into concrete per-destination variants (CO-01, CO-03). */
export function resolveVariants(
  draft: DraftContent,
  connections: Array<{ id: string; provider: Provider }>,
  /** Optional media kinds by asset id; when given, single videos resolve to 'video' / 'reel' (V1.1). */
  assetKinds?: ReadonlyMap<string, MediaKind> | Record<string, MediaKind>,
): ResolvedVariant[] {
  const kindOf = (id: string): MediaKind => (assetKinds instanceof Map ? assetKinds.get(id) : (assetKinds as Record<string, MediaKind> | undefined)?.[id]) ?? 'image';
  const byId = new Map(connections.map((c) => [c.id, c]));
  return draft.variants.flatMap((v) => {
    const conn = byId.get(v.connectionId);
    if (!conn) return [];
    const text = v.inheritText ? draft.baseText : (v.text ?? '');
    const assetIds = v.inheritMedia ? draft.baseAssetIds : (v.assetIds ?? []);
    const link = v.link === undefined ? (draft.baseLink ?? null) : v.link;
    const format: MediaFormat = deriveFormat(conn.provider, assetIds.map(kindOf));
    return [{
      connectionId: v.connectionId, provider: conn.provider, inheritText: v.inheritText, text, link: link || null,
      assetIds, format, buttons: v.buttons ?? [], options: v.options ?? {},
    }];
  });
}
