/// <reference path="./twitter-text.d.ts" />
// Platform-aware text measurement (CO-05). JavaScript string length is NOT a universal limit.
import twitterText from 'twitter-text';

/** UTF-16 code units — Telegram measures message/caption limits after entity parsing in UTF-16. */
export function utf16Length(s: string): number {
  return s.length;
}

/** Unicode code points (emoji with ZWJ count as several). Used for Meta caption limits. */
export function codePointLength(s: string): number {
  let n = 0;
  for (const _ of s) n++;
  return n;
}

/** X weighted length: URLs count 23, CJK/emoji weighted per twitter-text v3 config. */
export function xWeightedLength(s: string): number {
  const r = (twitterText as unknown as { parseTweet(t: string): { weightedLength: number } }).parseTweet(s);
  return r.weightedLength;
}

let segmenter: Intl.Segmenter | null = null;
/** User-perceived characters (extended grapheme clusters), e.g. Bluesky's 300-grapheme limit (V3). */
export function graphemeLength(s: string): number {
  segmenter ??= new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  let n = 0;
  for (const _ of segmenter.segment(s)) n++;
  return n;
}

/** UTF-8 byte length (V3: Bluesky facets / 3000-byte limit, YouTube description bytes). */
export function utf8Length(s: string): number {
  return new TextEncoder().encode(s).byteLength;
}

export function measure(s: string, unit: 'utf16' | 'codepoints' | 'x_weighted' | 'graphemes'): number {
  if (unit === 'x_weighted') return xWeightedLength(s);
  if (unit === 'graphemes') return graphemeLength(s);
  if (unit === 'codepoints') return codePointLength(s);
  return utf16Length(s);
}

export function countHashtags(s: string): number {
  return (s.match(/(^|\s)#[\p{L}\p{N}_]+/gu) ?? []).length;
}

export function countMentions(s: string): number {
  return (s.match(/(^|\s)@[\p{L}\p{N}_.]+/gu) ?? []).length;
}

/** Compose the text actually sent: body plus link (when the provider has no separate link field). */
export function composeTextWithLink(text: string, link: string | null | undefined): string {
  if (!link) return text;
  if (text.includes(link)) return text;
  return text.trim().length ? `${text.trimEnd()}\n\n${link}` : link;
}
