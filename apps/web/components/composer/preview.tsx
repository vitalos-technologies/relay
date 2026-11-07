'use client';
import { Heart, MessageCircle, Repeat2, Send, Eye, Globe } from 'lucide-react';
import { PROVIDER_LABEL, type ResolvedVariant } from '@social-lite/core';
import { linkIsSeparate, outgoingText } from '@/lib/client/variants';
import type { Asset, Connection } from '@/lib/client/types';
import { PlatformIcon, SimulatedBadge } from '@/components/ui';
import { PreviewMedia } from '@/components/media/preview-media';
import { isVideoAsset } from '@/components/media/media-kind';

/**
 * Approximate per-platform preview. Text is rendered as plain text (React escapes it) with
 * line breaks preserved; no HTML is ever injected (CO-05).
 */
export function VariantPreview({ variant, connection, assets }: { variant: ResolvedVariant; connection: Connection; assets: Map<string, Asset> }) {
  const imgs = variant.assetIds.map((id) => assets.get(id)).filter(Boolean) as Asset[];
  const text = outgoingText(variant, connection);
  const name = connection.display_name;
  const handle = connection.username ? `@${connection.username.replace(/^@/, '')}` : null;
  const img = imgs[0];
  // V1.1: albums / videos use the approximate multi-media layout (components/media).
  const image = imgs.length > 1 || isVideoAsset(img) ? <PreviewMedia items={imgs} provider={connection.provider} /> : img ? (
    img.preview_url || img.thumb_url ? (
      // eslint-disable-next-line @next/next/no-img-element
      <img src={(img.preview_url || img.thumb_url)!} alt={img.alt_text || ''} className="block max-h-[360px] w-full bg-black object-contain" />
    ) : <div className="flex aspect-square w-full items-center justify-center bg-sunken text-xs text-muted">{img.original_filename}</div>
  ) : null;

  const body = text ? <p className="whitespace-pre-wrap break-words text-[13px] leading-relaxed">{text}</p> : <p className="text-[13px] italic text-subtle">No text</p>;

  let card: React.ReactNode;
  switch (connection.provider) {
    case 'instagram':
      card = (
        <>
          <Header name={handle ?? name} provider="instagram" />
          {image ?? <div className="flex aspect-square items-center justify-center bg-sunken px-6 text-center text-xs text-warn">Instagram requires an image</div>}
          <div className="flex gap-3 px-3 pt-2.5 text-muted" aria-hidden><Heart className="size-5" /><MessageCircle className="size-5" /><Send className="size-5" /></div>
          <div className="px-3 pb-3 pt-1.5">
            {text ? <p className="whitespace-pre-wrap break-words text-[13px] leading-relaxed"><span className="mr-1.5 font-semibold">{handle ?? name}</span>{text}</p> : null}
          </div>
        </>
      );
      break;
    case 'facebook':
      card = (
        <>
          <Header name={name} provider="facebook" sub={<span className="inline-flex items-center gap-1">Just now · <Globe aria-hidden className="size-3" /></span>} />
          <div className="px-3 pb-2.5">{body}</div>
          {image}
          {variant.link && linkIsSeparate(connection, variant.assetIds.length) ? (
            <div className="border-t border-border bg-sunken px-3 py-2.5">
              <p className="truncate text-[11px] uppercase text-muted">{safeHost(variant.link)}</p>
              <p className="truncate text-[13px] font-medium">{variant.link}</p>
            </div>
          ) : null}
        </>
      );
      break;
    case 'telegram':
      card = (
        <div className="p-3">
          <div className="overflow-hidden rounded-xl rounded-bl-sm bg-raised">
            {image}
            <div className="px-3 py-2">
              <p className="mb-1 text-[12px] font-semibold text-info">{name}</p>
              {body}
              <p className="mt-1 flex items-center justify-end gap-1 text-[11px] text-subtle"><Eye aria-hidden className="size-3" /> 1 · now</p>
            </div>
          </div>
          {variant.buttons.length ? (
            <div className="mt-1 grid gap-1">
              {variant.buttons.map((b, i) => (
                <span key={i} className="truncate rounded-lg bg-raised px-3 py-1.5 text-center text-[12px] font-medium text-info">{b.text || 'Untitled button'}</span>
              ))}
            </div>
          ) : null}
        </div>
      );
      break;
    case 'x':
      card = (
        <div className="flex gap-3 p-3">
          <span aria-hidden className="flex size-9 shrink-0 items-center justify-center rounded-full bg-raised text-xs font-semibold">{name.slice(0, 1)}</span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-[13px]"><span className="font-semibold">{name}</span> <span className="text-muted">{handle} · now</span></p>
            <div className="mt-0.5">{body}</div>
            {image ? <div className="mt-2 overflow-hidden rounded-xl border border-border">{image}</div> : null}
            <div className="mt-2 flex gap-8 text-muted" aria-hidden><MessageCircle className="size-4" /><Repeat2 className="size-4" /><Heart className="size-4" /></div>
          </div>
        </div>
      );
      break;
  }

  return (
    <figure className="overflow-hidden rounded-xl border border-border bg-surface">
      <figcaption className="flex items-center gap-2 border-b border-border bg-sunken px-3 py-2 text-[11px] text-muted">
        <PlatformIcon provider={connection.provider} size="xs" decorative />
        <span className="font-medium text-fg">{PROVIDER_LABEL[connection.provider]}</span>
        <span>· Approximate preview</span>
        {connection.is_mock ? <SimulatedBadge className="ml-auto" /> : null}
      </figcaption>
      {card}
    </figure>
  );
}

function Header({ name, provider, sub }: { name: string; provider: Connection['provider']; sub?: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2.5 px-3 py-2.5">
      <PlatformIcon provider={provider} size="sm" decorative className="rounded-full" />
      <div className="min-w-0">
        <p className="truncate text-[13px] font-semibold">{name}</p>
        {sub ? <p className="text-[11px] text-muted">{sub}</p> : null}
      </div>
    </div>
  );
}

function safeHost(u: string): string {
  try {
    return new URL(u).host;
  } catch {
    return u;
  }
}
