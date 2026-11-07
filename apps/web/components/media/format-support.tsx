'use client';
import { Check, Minus } from 'lucide-react';
import { PROVIDER_LABEL, type ChannelCapabilities, type MediaFormat } from '@social-lite/core';
import type { Asset, Connection } from '@/lib/client/types';
import { cn, PlatformIcon, Tooltip } from '@/components/ui';
import { FORMAT_LABEL, formatFor, formatsOf } from './media-kind';

const SHOWN: MediaFormat[] = ['image', 'album', 'video'];

function limit(c: Connection, f: MediaFormat): string {
  const k = (c.capabilities as Partial<ChannelCapabilities> | undefined)?.constraints;
  if (!k) return '';
  if (f === 'album') {
    const max = k.maxAlbumItems ?? k.maxImages;
    return `${k.minAlbumItems ?? 2}–${max} items${k.albumAllowsVideo ? ', photos + videos' : ', photos only'}${k.albumSupportsButtons === false && k.supportsButtons ? ', no buttons' : ''}`;
  }
  if (f === 'video' || f === 'reel') {
    const parts: string[] = [];
    if (k.maxVideoSeconds) parts.push(`${k.minVideoSeconds ? `${k.minVideoSeconds} s – ` : '≤ '}${Math.round(k.maxVideoSeconds / 60)} min`);
    if (k.maxVideoBytes) parts.push(`≤ ${Math.round(k.maxVideoBytes / 1_048_576)} MB`);
    if (k.maxVideoLongSide) parts.push(`≤ ${k.maxVideoLongSide}×${k.maxVideoShortSide ?? k.maxVideoLongSide}`);
    return parts.join(', ');
  }
  return `≤ ${Math.round(k.maxImageBytes / 1_048_576)} MB`;
}

/**
 * Per-destination format support (Image / Album / Video or Reel) and which one the current media
 * resolves to. Unsupported current formats are flagged; details live in tooltips.
 */
export function FormatSupport({ connections, ids, assets, className }: { connections: Connection[]; ids: string[]; assets: Map<string, Asset>; className?: string }) {
  if (!connections.length) return null;
  return (
    <ul aria-label="Formats per destination" className={cn('flex flex-col gap-1.5', className)}>
      {connections.map((c) => {
        const formats = formatsOf(c);
        const current = ids.length ? formatFor(c.provider, ids, assets) : null;
        return (
          <li key={c.id} className="flex flex-wrap items-center gap-1.5 text-xs">
            <PlatformIcon provider={c.provider} size="xs" decorative />
            <span className="sr-only">{PROVIDER_LABEL[c.provider]} {c.display_name}:</span>
            {SHOWN.map((f) => {
              const shownAs: MediaFormat = f === 'video' && c.provider === 'instagram' ? 'reel' : f;
              const ok = formats.includes(shownAs);
              const active = current === shownAs;
              const tip = ok ? `${FORMAT_LABEL[shownAs]} · ${limit(c, shownAs)}` : `${FORMAT_LABEL[shownAs]} not supported on ${PROVIDER_LABEL[c.provider]}`;
              return (
                <Tooltip key={f} content={tip}>
                  <span
                    tabIndex={0}
                    aria-label={`${FORMAT_LABEL[shownAs]}: ${ok ? 'supported' : 'not supported'}${active ? ', current media' : ''}`}
                    data-format={shownAs}
                    data-active={active || undefined}
                    className={cn(
                      'inline-flex h-6 items-center gap-1 rounded-full border px-2 font-medium',
                      ok ? 'border-border text-fg' : 'border-dashed border-border text-subtle',
                      active && ok && 'border-[var(--text)] bg-raised',
                      active && !ok && 'border-danger text-danger',
                    )}
                  >
                    {ok ? <Check aria-hidden className="size-3" /> : <Minus aria-hidden className="size-3" />}
                    {FORMAT_LABEL[shownAs]}
                  </span>
                </Tooltip>
              );
            })}
          </li>
        );
      })}
    </ul>
  );
}
