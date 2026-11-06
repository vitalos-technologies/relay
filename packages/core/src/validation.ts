// Destination-aware validation (CO-04). Used when composing, scheduling and at dispatch.
import { countHashtags, countMentions, measure, composeTextWithLink } from './text.js';
import type { ChannelConstraints, MediaFormat, Provider, ResolvedVariant, ValidationIssue, ValidationResult, DraftContent, UrlButton } from './types.js';
import { PROVIDER_LABEL } from './types.js';

export interface MediaFacts {
  assetId: string;
  status: 'ready' | 'pending_upload' | 'quarantined' | 'rejected' | 'archived' | 'missing';
  mime: string | null;
  bytes: number | null;
  width: number | null;
  height: number | null;
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
}

const URL_RE = /^https:\/\/[^\s/$.?#].[^\s]*$/i;

export function validateVariant(v: ValidateVariantInput): ValidationResult {
  const issues: ValidationIssue[] = [];
  const label = PROVIDER_LABEL[v.provider];
  const add = (field: ValidationIssue['field'], code: string, message: string) =>
    issues.push({ connectionId: v.connectionId, provider: v.provider, field, code, message: `${label}: ${message}` });
  const c = v.constraints;
  const hasMedia = v.media.length > 0;

  if (c.requiresMedia && !hasMedia) add('media', 'media_required', 'an image is required. Add an image or remove this destination.');
  if (!hasMedia && !c.supportsTextOnly) add('media', 'text_only_unsupported', 'text-only posts are not supported. Add an image.');
  if (v.media.length > c.maxImages) add('media', 'too_many_images', `at most ${c.maxImages} image${c.maxImages === 1 ? '' : 's'} per post in this release. Remove ${v.media.length - c.maxImages}.`);

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
    if (m.status !== 'ready') {
      add('media', 'media_not_ready', m.status === 'rejected' ? 'an attached image was rejected. Replace it.' : m.status === 'missing' ? 'an attached image no longer exists. Replace it.' : 'an attached image is still processing. Wait for it to finish.');
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
  return { ok: issues.length === 0, issues };
}

export function mergeResults(results: ValidationResult[]): ValidationResult {
  const issues = results.flatMap((r) => r.issues);
  return { ok: issues.length === 0, issues };
}

/** Resolve the working draft into concrete per-destination variants (CO-01, CO-03). */
export function resolveVariants(draft: DraftContent, connections: Array<{ id: string; provider: Provider }>): ResolvedVariant[] {
  const byId = new Map(connections.map((c) => [c.id, c]));
  return draft.variants.flatMap((v) => {
    const conn = byId.get(v.connectionId);
    if (!conn) return [];
    const text = v.inheritText ? draft.baseText : (v.text ?? '');
    const assetIds = v.inheritMedia ? draft.baseAssetIds : (v.assetIds ?? []);
    const link = v.link === undefined ? (draft.baseLink ?? null) : v.link;
    const format: MediaFormat = assetIds.length > 1 ? 'album' : assetIds.length === 1 ? 'image' : 'text';
    return [{
      connectionId: v.connectionId, provider: conn.provider, inheritText: v.inheritText, text, link: link || null,
      assetIds, format, buttons: v.buttons ?? [], options: v.options ?? {},
    }];
  });
}
