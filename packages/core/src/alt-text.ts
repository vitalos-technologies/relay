// Library alt text → networks (fix H3, 2026-11-09). The library field (assets.alt_text) is attached to each image when
// it is published, where the network's API has a field for it. Sources checked 2026-11-09:
//  - Facebook  POST /{page-id}/photos `alt_text_custom` (no documented limit)
//  - Instagram POST /{ig-user-id}/media `alt_text` — single image + carousel images only (not Reels/stories), ≤ 1,000
//  - Threads   POST /{threads-user-id}/threads `alt_text` — image or video, ≤ 1,000
//  - X         POST /2/media/metadata {id, metadata:{alt_text:{text}}} — ≤ 1,000 (a separate, billable call per image)
//  - LinkedIn  Posts API image `altText` — ≤ 4,086
//  - Bluesky   app.bsky.embed.images#image `alt` — required string, no limit
//  - Pinterest POST /v5/pins `alt_text` — one per Pin, ≤ 500
//  - Telegram (Bot API), TikTok (Content Posting API) and YouTube (videos only) have no alt-text field.
// Persisted values are unchanged. Text longer than a network accepts is a validation issue (never cut silently).
import type { Provider } from './types.js';

export interface AltTextSupport {
  /** Sent for images. */
  images: boolean;
  /** Sent for videos. */
  videos: boolean;
  /** Network limit in characters (Unicode code points); null = no documented limit. */
  maxLength: number | null;
}

export const ALT_TEXT_SUPPORT: Record<Provider, AltTextSupport> = {
  facebook: { images: true, videos: false, maxLength: null },
  instagram: { images: true, videos: false, maxLength: 1000 },
  threads: { images: true, videos: true, maxLength: 1000 },
  x: { images: true, videos: false, maxLength: 1000 },
  linkedin: { images: true, videos: false, maxLength: 4086 },
  bluesky: { images: true, videos: false, maxLength: null },
  pinterest: { images: true, videos: false, maxLength: 500 },
  telegram: { images: false, videos: false, maxLength: null },
  tiktok: { images: false, videos: false, maxLength: null },
  youtube: { images: false, videos: false, maxLength: null },
};

/** Networks that receive library alt text, in display order. */
export const ALT_TEXT_PROVIDERS: Provider[] = (Object.keys(ALT_TEXT_SUPPORT) as Provider[]).filter((p) => ALT_TEXT_SUPPORT[p].images);

/** Whitespace collapsed and trimmed; empty ⇒ null. Never shortened (no silent truncation: see altTextIssues). */
export function cleanAltText(text: string | null | undefined): string | null {
  const t = (text ?? '').replace(/\s+/g, ' ').trim();
  return t || null;
}

const isVideoItem = (m: { kind?: 'image' | 'video' | null; mime?: string | null }) => m.kind === 'video' || (!m.kind && !!m.mime?.startsWith('video/'));

/** A non-empty per-destination override (e.g. Pinterest "Alt text"), or null. */
export const altOverride = (v: unknown): string | null => (typeof v === 'string' ? cleanAltText(v) : null);

/**
 * The alt text to send for one media item, or null when the network has no field for it (or there is none).
 * `override` (a per-destination option, e.g. Pinterest "Alt text") wins over the library text when non-empty.
 */
export function altTextFor(provider: Provider, media: { altText?: string | null; kind?: 'image' | 'video'; mime?: string | null }, override?: unknown): string | null {
  const s = ALT_TEXT_SUPPORT[provider];
  if (isVideoItem(media) ? !s.videos : !s.images) return null;
  return altOverride(override) ?? cleanAltText(media.altText);
}

/**
 * Library alt text longer than the network accepts is a validation issue (composer readiness and the send-time check),
 * never a silent cut. Pinterest sends one alt text per Pin (the first image's), unless the Pinterest option is set.
 */
export function altTextTooLong(provider: Provider, media: Array<{ altText?: string | null; kind?: 'image' | 'video' | null; mime?: string | null }>,
  options: Record<string, unknown> = {}): Array<{ index: number; length: number; max: number }> {
  const s = ALT_TEXT_SUPPORT[provider];
  if (s.maxLength === null) return [];
  const items = provider === 'pinterest'
    ? (altOverride((options.pinterest as { altText?: unknown } | undefined)?.altText) ? [] : media.slice(0, 1))
    : media;
  const out: Array<{ index: number; length: number; max: number }> = [];
  items.forEach((m, index) => {
    if (isVideoItem(m) ? !s.videos : !s.images) return;
    const t = cleanAltText(m.altText);
    const length = t ? [...t].length : 0;
    if (length > s.maxLength!) out.push({ index, length, max: s.maxLength! });
  });
  return out;
}
