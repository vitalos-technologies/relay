// Shared helpers for the Meta adapters: constraints, scope sets, validation input mapping.
import {
  composeTextWithLink, validateVariant, type ChannelCapabilities, type ChannelConstraints, type MediaFacts,
  type PublishConnection, type PublishInput, type ValidationResult,
} from '@social-lite/core';
import { DEFAULT_GRAPH_VERSION } from './graph.js';

export const RESEARCHED_ON = '2026-11-06';

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
  maxImages: 1,
  imageMimes: ['image/jpeg', 'image/png'],
  maxImageBytes: 10 * 1_048_576,
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
  maxImages: 1,
  imageMimes: ['image/jpeg'],
  maxImageBytes: 8 * 1_048_576,
  minImageWidth: 320,
  minAspectRatio: 0.8,
  maxAspectRatio: 1.91,
  maxHashtags: 30,
  maxMentions: 20,
};

export function capabilitiesFor(provider: 'facebook' | 'instagram', connection: PublishConnection): ChannelCapabilities {
  const version = typeof connection.metadata?.graph_version === 'string' ? connection.metadata.graph_version : DEFAULT_GRAPH_VERSION;
  return {
    provider,
    formats: provider === 'facebook' ? ['text', 'image'] : ['image'],
    canPublish: true,
    canEditPublished: false,
    canDeletePublished: false,
    canReadMetrics: false,
    canReconcile: true,
    constraints: provider === 'facebook' ? FACEBOOK_CONSTRAINTS : INSTAGRAM_CONSTRAINTS,
    constraintsVersion: `meta-${provider}-${RESEARCHED_ON}-${version}`,
    checkedAt: `${RESEARCHED_ON}T00:00:00.000Z`,
  };
}

export function toMediaFacts(media: PublishInput['media']): MediaFacts[] {
  return media.map((m) => ({ assetId: m.assetId, status: 'ready', mime: m.mime, bytes: m.bytes, width: m.width, height: m.height }));
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
