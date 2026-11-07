'use client';
// Accessible image crop editor: presets, numeric inputs (original pixels), keyboard nudging and pointer drag.
// The crop is stored on the variant (options.crop[assetId]); the server renders the exact derivative and
// validates the cropped size/aspect, so this UI only proposes a rectangle.
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { Button, Dialog, Field, Input, Segmented } from '@/components/ui';

export const CROP_PRESETS = ['1:1', '4:5', '1.91:1', '16:9', '9:16', 'free'] as const;
export type CropPreset = (typeof CROP_PRESETS)[number];
export interface CropSpec { preset: CropPreset; x: number; y: number; width: number; height: number }
const RATIO: Record<CropPreset, number | null> = { '1:1': 1, '4:5': 0.8, '1.91:1': 1.91, '16:9': 16 / 9, '9:16': 9 / 16, free: null };
const MIN = 16;
const MAX_OUT = 4096;

/** Largest centred rectangle of the preset's aspect inside W×H. */
export function presetRect(preset: CropPreset, W: number, H: number): CropSpec {
  const r = RATIO[preset];
  if (r === null) return { preset, x: 0, y: 0, width: W, height: H };
  let w = W; let h = Math.round(W / r);
  if (h > H) { h = H; w = Math.round(H * r); }
  return { preset, x: Math.floor((W - w) / 2), y: Math.floor((H - h) / 2), width: w, height: h };
}

function clamp(c: CropSpec, W: number, H: number): CropSpec {
  let width = Math.max(MIN, Math.min(Math.round(c.width), W));
  let height = Math.max(MIN, Math.min(Math.round(c.height), H));
  const r = RATIO[c.preset];
  if (r !== null) {
    height = Math.round(width / r);
    if (height > H) { height = H; width = Math.round(H * r); }
  }
  const x = Math.max(0, Math.min(Math.round(c.x), W - width));
  const y = Math.max(0, Math.min(Math.round(c.y), H - height));
  return { ...c, x, y, width, height };
}

export function outputSize(c: Pick<CropSpec, 'width' | 'height'>) {
  const s = Math.min(1, MAX_OUT / Math.max(c.width, c.height));
  return { width: Math.round(c.width * s), height: Math.round(c.height * s) };
}

export function CropEditor({ open, onOpenChange, imageUrl, imageWidth: W, imageHeight: H, value, onApply, onRemove, alt }: {
  open: boolean; onOpenChange: (o: boolean) => void; imageUrl: string | null; imageWidth: number; imageHeight: number;
  value: CropSpec | null; onApply: (c: CropSpec) => void; onRemove: () => void; alt: string;
}) {
  const [c, setC] = useState<CropSpec>(() => value ?? presetRect('4:5', W, H));
  useEffect(() => { if (open) setC(value ?? presetRect('4:5', W, H)); }, [open, value, W, H]);
  const set = (next: Partial<CropSpec>) => setC((cur) => clamp({ ...cur, ...next }, W, H));
  const step = Math.max(1, Math.round(Math.max(W, H) / 200));
  const box = useRef<HTMLDivElement>(null);
  const drag = useRef<{ px: number; py: number; x: number; y: number } | null>(null);

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const d = (e.shiftKey ? 10 : 1) * step;
    const k = e.key;
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(k)) return;
    e.preventDefault();
    const dx = k === 'ArrowLeft' ? -d : k === 'ArrowRight' ? d : 0;
    const dy = k === 'ArrowUp' ? -d : k === 'ArrowDown' ? d : 0;
    if (e.altKey) {
      // Alt+Left/Right: width; Alt+Up/Down: height (fixed presets keep their aspect).
      const r = RATIO[c.preset];
      if (r !== null && dx === 0) set({ width: c.width + Math.round(dy * r) });
      else set({ width: c.width + dx, height: c.height + dy });
    }
    else set({ x: c.x + dx, y: c.y + dy });
  };
  const onDown = (e: PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { px: e.clientX, py: e.clientY, x: c.x, y: c.y };
  };
  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!drag.current || !box.current) return;
    const scale = W / box.current.clientWidth;
    set({ x: drag.current.x + (e.clientX - drag.current.px) * scale, y: drag.current.y + (e.clientY - drag.current.py) * scale });
  };
  const out = outputSize(c);
  const pct = (n: number, of: number) => `${(n / of) * 100}%`;
  const num = (k: 'x' | 'y' | 'width' | 'height', label: string) => (
    <Field label={label}>
      <Input type="number" inputMode="numeric" min={0} value={c[k]} onChange={(e) => set({ [k]: Number(e.target.value) || 0 })} className="tabular" />
    </Field>
  );

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      title="Crop"
      footer={<>
        {value ? <Button variant="quiet" onClick={() => { onRemove(); onOpenChange(false); }}>Remove crop</Button> : null}
        <span className="flex-1" />
        <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
        <Button variant="primary" onClick={() => { onApply(c); onOpenChange(false); }}>Apply</Button>
      </>}
    >
      <div className="flex flex-col gap-4">
        <Segmented<CropPreset> label="Aspect ratio" size="sm" value={c.preset}
          onChange={(p) => setC(p === 'free' ? { ...c, preset: 'free' } : presetRect(p, W, H))}
          options={CROP_PRESETS.map((p) => ({ value: p, label: p === 'free' ? 'Free' : p }))} />
        <div ref={box} className="relative mx-auto select-none overflow-hidden rounded-lg bg-sunken" style={{ aspectRatio: `${W} / ${H}`, width: `min(100%, 640px, calc(48vh * ${W / H}))` }}>
          {imageUrl ? <img src={imageUrl} alt={alt} className="absolute inset-0 size-full object-fill" draggable={false} /> : null}
          <div
            role="group"
            tabIndex={0}
            aria-label={`Crop area ${c.width}×${c.height} at ${c.x}, ${c.y}. Arrow keys move, Shift moves faster, Alt with arrows resizes.`}
            onKeyDown={onKey}
            onPointerDown={onDown}
            onPointerMove={onMove}
            onPointerUp={() => { drag.current = null; }}
            className="absolute cursor-move touch-none outline-none ring-2 ring-white focus-visible:ring-4 focus-visible:ring-[var(--info)]"
            style={{ left: pct(c.x, W), top: pct(c.y, H), width: pct(c.width, W), height: pct(c.height, H), boxShadow: '0 0 0 9999px rgba(0,0,0,0.55)' }}
          />
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {num('x', 'X')}{num('y', 'Y')}{num('width', 'Width')}{num('height', 'Height')}
        </div>
        <p className="text-xs text-muted tabular" aria-live="polite">Output {out.width}×{out.height} px · source {W}×{H}</p>
      </div>
    </Dialog>
  );
}
