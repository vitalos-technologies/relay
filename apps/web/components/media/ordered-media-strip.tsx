'use client';
import { useState, type DragEvent } from 'react';
import { ChevronLeft, ChevronRight, ImagePlus, Play, X } from 'lucide-react';
import type { Asset } from '@/lib/client/types';
import { cn, Tooltip } from '@/components/ui';
import { fmtDuration, isVideoAsset, type MediaAsset } from './media-kind';

export function move<T>(list: T[], from: number, to: number): T[] {
  if (to < 0 || to >= list.length || from === to) return list;
  const next = [...list];
  const [x] = next.splice(from, 1);
  next.splice(to, 0, x!);
  return next;
}

/**
 * Attached media in publish order: thumbnails, video badge with duration, drag or arrow-button
 * reordering (keyboard accessible), remove and add. Order is the order sent to every destination.
 */
export function OrderedMediaStrip({
  ids, assets, onRemove, onAdd, onReorder, disabled, label,
}: {
  ids: string[]; assets: Map<string, Asset>; onRemove: (id: string) => void; onAdd: () => void;
  onReorder?: (ids: string[]) => void; disabled?: boolean; label: string;
}) {
  const [dragging, setDragging] = useState<number | null>(null);
  const canMove = !disabled && !!onReorder && ids.length > 1;
  const drop = (e: DragEvent, to: number) => {
    e.preventDefault();
    if (dragging !== null && onReorder) onReorder(move(ids, dragging, to));
    setDragging(null);
  };

  return (
    <div role="group" aria-label={label} className="flex flex-wrap gap-2">
      {ids.map((id, i) => {
        const a = assets.get(id) as MediaAsset | undefined;
        const video = isVideoAsset(a);
        const name = a?.original_filename ?? (video ? 'video' : 'image');
        const state = !a ? 'Missing' : a.status === 'ready' ? null : a.status === 'rejected' ? 'Rejected' : 'Processing';
        return (
          <div
            key={id}
            data-testid="media-tile"
            draggable={canMove}
            onDragStart={() => setDragging(i)}
            onDragOver={(e) => { if (canMove) e.preventDefault(); }}
            onDrop={(e) => drop(e, i)}
            onDragEnd={() => setDragging(null)}
            className={cn('group relative size-20 overflow-hidden rounded-lg border border-border bg-sunken', dragging === i && 'opacity-50', canMove && 'cursor-grab')}
          >
            {a?.thumb_url ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={a.thumb_url} alt={a.alt_text || name} className="size-full object-cover" draggable={false} />
            ) : <span className="flex size-full items-center justify-center p-1 text-center text-[10px] text-muted">{a?.original_filename ?? 'Unavailable'}</span>}
            {ids.length > 1 ? (
              <span className="absolute left-1 top-1 flex size-5 items-center justify-center rounded-full bg-[var(--overlay)] text-[10px] font-semibold text-white" aria-hidden>{i + 1}</span>
            ) : null}
            {video && !state ? (
              <span className="absolute bottom-1 left-1 inline-flex items-center gap-0.5 rounded bg-[var(--overlay)] px-1 py-0.5 text-[10px] font-medium text-white">
                <Play aria-hidden className="size-2.5 fill-current" />{fmtDuration(a?.duration_ms) ?? 'Video'}
              </span>
            ) : null}
            {state ? <span className="absolute inset-x-0 bottom-0 bg-[var(--overlay)] px-1 py-0.5 text-center text-[10px] font-medium text-white">{state}</span> : null}
            {!disabled ? (
              <button
                type="button"
                onClick={() => onRemove(id)}
                aria-label={`Remove ${name}`}
                className="absolute right-1 top-1 flex size-6 items-center justify-center rounded-full bg-[var(--overlay)] text-white hover:bg-black"
              >
                <X aria-hidden className="size-3.5" />
              </button>
            ) : null}
            {canMove ? (
              <div className="absolute inset-x-1 bottom-1 hidden justify-between group-hover:flex group-focus-within:flex">
                <Tooltip content="Move earlier">
                  <button type="button" aria-label={`Move ${name} earlier`} disabled={i === 0} onClick={() => onReorder!(move(ids, i, i - 1))}
                    className="flex size-6 items-center justify-center rounded-full bg-[var(--overlay)] text-white disabled:opacity-30">
                    <ChevronLeft aria-hidden className="size-3.5" />
                  </button>
                </Tooltip>
                <Tooltip content="Move later">
                  <button type="button" aria-label={`Move ${name} later`} disabled={i === ids.length - 1} onClick={() => onReorder!(move(ids, i, i + 1))}
                    className="flex size-6 items-center justify-center rounded-full bg-[var(--overlay)] text-white disabled:opacity-30">
                    <ChevronRight aria-hidden className="size-3.5" />
                  </button>
                </Tooltip>
              </div>
            ) : null}
          </div>
        );
      })}
      {!disabled ? (
        <button type="button" onClick={onAdd} className="flex size-20 flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-border-strong text-xs text-muted hover:border-[var(--focus)] hover:text-fg">
          <ImagePlus aria-hidden className="size-5" />
          Add
        </button>
      ) : null}
    </div>
  );
}
