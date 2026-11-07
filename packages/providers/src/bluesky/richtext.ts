// Rich-text facets for app.bsky.feed.post (A4): byteStart/byteEnd are UTF-8 BYTE offsets (end exclusive).
// Links (explicit http(s) URLs), @mentions (resolved to DIDs by the caller) and #tags.
import { graphemeLength, utf8Length } from '@social-lite/core';

export type Facet = {
  index: { byteStart: number; byteEnd: number };
  features: Array<{ $type: 'app.bsky.richtext.facet#link'; uri: string } | { $type: 'app.bsky.richtext.facet#mention'; did: string } | { $type: 'app.bsky.richtext.facet#tag'; tag: string }>;
};

export interface Detected { kind: 'link' | 'mention' | 'tag'; value: string; byteStart: number; byteEnd: number }

const byteAt = (text: string, utf16Index: number) => utf8Length(text.slice(0, utf16Index));
const TRAILING = /[.,;:!?'"]+$/;

export function detectFacets(text: string): Detected[] {
  const out: Detected[] = [];
  for (const m of text.matchAll(/(^|[\s(])(https?:\/\/[^\s]+)/gi)) {
    let url = m[2]!.replace(TRAILING, '');
    if (url.endsWith(')') && !url.includes('(')) url = url.slice(0, -1);
    const start = m.index! + m[1]!.length;
    out.push({ kind: 'link', value: url, byteStart: byteAt(text, start), byteEnd: byteAt(text, start + url.length) });
  }
  for (const m of text.matchAll(/(^|[\s(])@([a-zA-Z0-9][a-zA-Z0-9-]*(?:\.[a-zA-Z0-9][a-zA-Z0-9-]*)+)/g)) {
    const handle = m[2]!.replace(/\.+$/, '');
    const start = m.index! + m[1]!.length;
    out.push({ kind: 'mention', value: handle.toLowerCase(), byteStart: byteAt(text, start), byteEnd: byteAt(text, start + 1 + handle.length) });
  }
  for (const m of text.matchAll(/(^|\s)[#＃]([^\s#＃]+)/gu)) {
    const tag = m[2]!.replace(/\p{P}+$/u, '');
    if (!tag || /^\d+$/.test(tag) || graphemeLength(tag) > 64 || utf8Length(tag) > 640) continue;
    const start = m.index! + m[1]!.length;
    out.push({ kind: 'tag', value: tag, byteStart: byteAt(text, start), byteEnd: byteAt(text, start + 1 + tag.length) });
  }
  return out.sort((a, b) => a.byteStart - b.byteStart);
}

/** Build facets; mentions whose handle did not resolve are left as plain text. */
export function buildFacets(detected: Detected[], dids: Record<string, string | null>): Facet[] {
  const facets: Facet[] = [];
  for (const d of detected) {
    if (d.kind === 'link') facets.push({ index: { byteStart: d.byteStart, byteEnd: d.byteEnd }, features: [{ $type: 'app.bsky.richtext.facet#link', uri: d.value }] });
    else if (d.kind === 'tag') facets.push({ index: { byteStart: d.byteStart, byteEnd: d.byteEnd }, features: [{ $type: 'app.bsky.richtext.facet#tag', tag: d.value }] });
    else if (dids[d.value]) facets.push({ index: { byteStart: d.byteStart, byteEnd: d.byteEnd }, features: [{ $type: 'app.bsky.richtext.facet#mention', did: dids[d.value]! }] });
  }
  return facets;
}
