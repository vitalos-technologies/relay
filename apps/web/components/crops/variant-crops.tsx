'use client';
// Per-destination image crops in the composer. Stored on the variant as options.crop[assetId] (part of the
// revision content: changing a crop invalidates a pending approval). Video assets are never cropped.
import { useState } from 'react';
import { Crop } from 'lucide-react';
import type { DraftContent, VariantDraft } from '@social-lite/core';
import { Button, InfoTip } from '@/components/ui';
import { CropEditor, outputSize, type CropSpec } from './crop-editor';

interface AssetLike { id: string; width: number | null; height: number | null; preview_url: string | null; thumb_url: string | null; alt_text: string | null; status: string; mime?: string | null; media_kind?: string }

export function cropsOf(v: VariantDraft): Record<string, CropSpec> {
  const raw = (v.options as Record<string, unknown> | undefined)?.crop;
  return raw && typeof raw === 'object' ? (raw as Record<string, CropSpec>) : {};
}

export function VariantCrops({ draft, variant, assets, onChange, readOnly }: {
  draft: DraftContent; variant: VariantDraft; assets: Map<string, AssetLike>; onChange: (v: VariantDraft) => void; readOnly: boolean;
}) {
  const ids = variant.inheritMedia ? draft.baseAssetIds : (variant.assetIds ?? []);
  const images = ids.map((id) => assets.get(id)).filter((a): a is AssetLike => !!a && a.status === 'ready' && !!a.width && !!a.height && a.media_kind !== 'video' && !(a.mime ?? '').startsWith('video/'));
  const [editing, setEditing] = useState<string | null>(null);
  if (!images.length) return null;
  const crops = cropsOf(variant);
  const write = (assetId: string, c: CropSpec | null) => {
    const next = { ...crops };
    if (c) next[assetId] = c; else delete next[assetId];
    const options = { ...(variant.options ?? {}) } as Record<string, unknown>;
    if (Object.keys(next).length) options.crop = next; else delete options.crop;
    onChange({ ...variant, options });
  };
  const current = editing ? images.find((a) => a.id === editing) : undefined;
  return (
    <div className="mt-4 flex flex-col gap-2" aria-label="Image crops for this destination" role="group">
      <p className="flex items-center gap-1 text-[13px] font-medium">Crop <InfoTip>Only for this destination. The exact cropped image is what gets sent.</InfoTip></p>
      <ul className="flex flex-wrap gap-3">
        {images.map((a) => {
          const c = crops[a.id];
          const W = a.width!; const H = a.height!;
          return (
            <li key={a.id} className="flex items-center gap-2">
              <span className="relative block size-14 overflow-hidden rounded-md bg-sunken" aria-hidden>
                {a.thumb_url ? (
                  c ? (
                    <span className="absolute inset-0" style={{ backgroundImage: `url(${a.thumb_url})`, backgroundSize: `${(W / c.width) * 100}% ${(H / c.height) * 100}%`,
                      backgroundPosition: `${c.width === W ? 0 : (c.x / (W - c.width)) * 100}% ${c.height === H ? 0 : (c.y / (H - c.height)) * 100}%` }} />
                  ) : <img src={a.thumb_url} alt="" className="size-full object-cover" />
                ) : null}
              </span>
              <span className="text-xs text-muted tabular">{c ? `${c.preset === 'free' ? 'Free' : c.preset} · ${outputSize(c).width}×${outputSize(c).height}` : 'Original'}</span>
              {!readOnly ? (
                <Button size="sm" variant="ghost" icon={<Crop aria-hidden className="size-4" />} onClick={() => setEditing(a.id)}>
                  {c ? 'Edit' : 'Crop'}<span className="sr-only"> image {a.alt_text ?? ''}</span>
                </Button>
              ) : null}
            </li>
          );
        })}
      </ul>
      {current ? (
        <CropEditor
          open={!!editing}
          onOpenChange={(o) => { if (!o) setEditing(null); }}
          imageUrl={current.preview_url}
          imageWidth={current.width!}
          imageHeight={current.height!}
          value={crops[current.id] ?? null}
          alt={current.alt_text ?? 'Image to crop'}
          onApply={(c) => write(current.id, c)}
          onRemove={() => write(current.id, null)}
        />
      ) : null}
    </div>
  );
}
