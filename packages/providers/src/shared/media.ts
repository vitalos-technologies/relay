// Media helpers shared by the V3 adapters.
import type { MediaFacts, PublishInput, PublishMedia } from '@social-lite/core';

export const isVideoMedia = (m: Pick<PublishMedia, 'kind' | 'mime'>): boolean => m.kind === 'video' || m.mime.startsWith('video/');

/** PublishMedia → MediaFacts for core validateVariant (already-ready derivatives). */
export function factsOf(media: PublishInput['media']): MediaFacts[] {
  return media.map((m) => ({
    assetId: m.assetId, status: 'ready', mime: m.mime, bytes: m.bytes, width: m.width, height: m.height,
    kind: m.kind, durationMs: m.durationMs, videoCodec: m.videoCodec, audioCodec: m.audioCodec, frameRate: m.frameRate,
  }));
}

/** Provider option bag: variant.options[provider] (object) or {}. */
export function providerOptions<T extends object>(options: Record<string, unknown>, key: string): Partial<T> {
  const v = options[key];
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Partial<T>) : {};
}

export async function loadBytes(m: PublishMedia): Promise<Uint8Array | null> {
  try {
    return await m.load();
  } catch {
    return null;
  }
}
