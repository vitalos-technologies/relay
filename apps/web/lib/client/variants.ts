import {
  composeTextWithLink, measure, resolveVariants, validateVariant, type ChannelCapabilities, type ChannelConstraints,
  type DraftContent, type MediaFacts, type ResolvedVariant, type ValidationIssue,
} from '@social-lite/core';
import type { Asset, Connection } from './types';

export function constraintsOf(c: Connection): ChannelConstraints | null {
  const caps = c.capabilities as Partial<ChannelCapabilities>;
  return caps && caps.constraints ? caps.constraints : null;
}

/**
 * Facebook text-only posts send the link as a separate (link card) field; everywhere else, and for
 * Facebook posts with an image, the link is appended to the text. Mirrors the server's validation.
 */
export function linkIsSeparate(c: Pick<Connection, 'provider'>, mediaCount: number): boolean {
  return c.provider === 'facebook' && mediaCount === 0;
}

export function outgoingText(v: ResolvedVariant, c: Pick<Connection, 'provider'>): string {
  return linkIsSeparate(c, v.assetIds.length) ? v.text : composeTextWithLink(v.text, v.link);
}

export function mediaFacts(ids: string[], assets: Map<string, Asset>): MediaFacts[] {
  return ids.map((id) => {
    const a = assets.get(id);
    if (!a) return { assetId: id, status: 'missing', mime: null, bytes: null, width: null, height: null };
    return { assetId: id, status: a.status, mime: a.mime, bytes: a.bytes, width: a.width, height: a.height };
  });
}

export interface LocalCheck {
  connectionId: string;
  measured: number | null;
  limit: number | null;
  unit: ChannelConstraints['textCounting'] | null;
  issues: ValidationIssue[];
  hasConstraints: boolean;
}

/** Local, immediate per-destination check using the same pure validator as the server (CO-04/CO-05). */
export function localChecks(draft: DraftContent, connections: Connection[], assets: Map<string, Asset>): Map<string, LocalCheck> {
  const out = new Map<string, LocalCheck>();
  const resolved = resolveVariants(draft, connections);
  for (const v of resolved) {
    const c = connections.find((x) => x.id === v.connectionId);
    if (!c) continue;
    const k = constraintsOf(c);
    if (!k) {
      out.set(c.id, { connectionId: c.id, measured: null, limit: null, unit: null, issues: [], hasConstraints: false });
      continue;
    }
    const media = mediaFacts(v.assetIds, assets);
    const r = validateVariant({
      provider: c.provider, connectionId: c.id, constraints: k, text: v.text, link: v.link, buttons: v.buttons, media,
      linkIsSeparateField: linkIsSeparate(c, media.length),
    });
    const text = outgoingText(v, c);
    out.set(c.id, {
      connectionId: c.id,
      measured: measure(text, k.textCounting),
      limit: media.length ? k.maxCaptionLength : k.maxTextLength,
      unit: k.textCounting,
      issues: r.issues,
      hasConstraints: true,
    });
  }
  return out;
}

export const UNIT_LABEL: Record<ChannelConstraints['textCounting'], string> = {
  utf16: 'UTF-16 units',
  codepoints: 'characters',
  x_weighted: 'X-weighted (links = 23)',
  graphemes: 'characters',
};
