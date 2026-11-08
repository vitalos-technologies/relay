import type { ChannelCapabilities, MediaFormat, Provider } from '@social-lite/core';
import { deriveFormat, mediaKindOf } from '@social-lite/core';
import type { Asset, Connection } from '@/lib/client/types';

/** Asset DTO plus the V1.1 media fields the API returns (additive). */
export type MediaAsset = Asset & { media_kind?: 'image' | 'video'; duration_ms?: number | null };

export const isVideoAsset = (a: Asset | undefined | null): boolean =>
  !!a && ((a as MediaAsset).media_kind === 'video' || mediaKindOf({ mime: a.mime }) === 'video');

export function fmtDuration(ms: number | null | undefined): string | null {
  if (!ms || ms < 0) return null;
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Format the attached media would publish as on this destination. */
export function formatFor(provider: Provider, ids: string[], assets: Map<string, Asset>): MediaFormat {
  return deriveFormat(provider, ids.map((id) => (isVideoAsset(assets.get(id)) ? 'video' : 'image')));
}

/** Formats each adapter declares (packages/providers); used only until the connection's own capabilities are loaded. */
const DECLARED_FORMATS: Record<Connection['provider'], MediaFormat[]> = {
  instagram: ['image', 'album', 'reel'], facebook: ['text', 'image', 'album', 'video'], telegram: ['text', 'image', 'album', 'video'],
  x: ['text', 'image', 'album', 'video'], tiktok: ['video', 'image', 'album'], youtube: ['video'], linkedin: ['text', 'image', 'album', 'video'],
  threads: ['text', 'image', 'album', 'video'], pinterest: ['image', 'album', 'video'], bluesky: ['text', 'image', 'album'],
};

export function formatsOf(c: Connection): MediaFormat[] {
  const caps = c.capabilities as Partial<ChannelCapabilities> | undefined;
  return Array.isArray(caps?.formats) ? caps!.formats : DECLARED_FORMATS[c.provider] ?? ['text', 'image'];
}

export const FORMAT_LABEL: Record<MediaFormat, string> = { text: 'Text', image: 'Image', album: 'Album', video: 'Video', reel: 'Reel' };
