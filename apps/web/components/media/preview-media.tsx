'use client';
import { Play } from 'lucide-react';
import type { Provider } from '@social-lite/core';
import type { Asset } from '@/lib/client/types';
import { cn } from '@/components/ui';
import { fmtDuration, isVideoAsset, type MediaAsset } from './media-kind';

function Tile({ a, className }: { a: Asset; className?: string }) {
  const src = a.preview_url || a.thumb_url;
  const video = isVideoAsset(a);
  return (
    <div className={cn('relative overflow-hidden bg-black', className)}>
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt={a.alt_text || ''} className="size-full object-cover" />
      ) : <div className="flex size-full items-center justify-center bg-sunken text-xs text-muted">{a.original_filename}</div>}
      {video ? (
        <span className="absolute inset-0 flex items-center justify-center" aria-label={`Video ${fmtDuration((a as MediaAsset).duration_ms) ?? ''}`}>
          <span className="flex size-10 items-center justify-center rounded-full bg-[var(--overlay)] text-white"><Play aria-hidden className="size-5 fill-current" /></span>
          {fmtDuration((a as MediaAsset).duration_ms) ? <span className="absolute bottom-1.5 right-1.5 rounded bg-[var(--overlay)] px-1 text-[10px] text-white">{fmtDuration((a as MediaAsset).duration_ms)}</span> : null}
        </span>
      ) : null}
    </div>
  );
}

/**
 * Approximate media layout per network: Instagram swipes a carousel (1/N), Reels are 9:16; the others
 * show a grid (Facebook / Telegram / X up to 4 tiles, "+N" beyond). Never pixel-accurate.
 */
export function PreviewMedia({ items, provider }: { items: Asset[]; provider: Provider }) {
  if (!items.length) return null;
  if (items.length === 1) {
    const reel = provider === 'instagram' && isVideoAsset(items[0]);
    return <Tile a={items[0]!} className={reel ? 'mx-auto aspect-[9/16] max-h-[360px]' : 'aspect-video max-h-[360px] w-full'} />;
  }
  if (provider === 'instagram') {
    return (
      <div className="relative">
        <div className="flex snap-x snap-mandatory overflow-x-auto" aria-label={`Carousel, ${items.length} items`}>
          {items.map((a) => <Tile key={a.id} a={a} className="aspect-square w-full shrink-0 snap-center" />)}
        </div>
        <span className="absolute right-2 top-2 rounded-full bg-[var(--overlay)] px-2 py-0.5 text-[11px] text-white">1/{items.length}</span>
      </div>
    );
  }
  const shown = items.slice(0, 4);
  const extra = items.length - shown.length;
  return (
    <div className="grid grid-cols-2 gap-0.5" aria-label={`${items.length} media items`}>
      {shown.map((a, i) => (
        <div key={a.id} className={cn('relative', shown.length === 3 && i === 0 && 'col-span-2')}>
          <Tile a={a} className={shown.length === 3 && i === 0 ? 'aspect-video w-full' : 'aspect-square w-full'} />
          {extra > 0 && i === shown.length - 1 ? <span className="absolute inset-0 flex items-center justify-center bg-[var(--overlay)] text-lg font-semibold text-white">+{extra}</span> : null}
        </div>
      ))}
    </div>
  );
}
