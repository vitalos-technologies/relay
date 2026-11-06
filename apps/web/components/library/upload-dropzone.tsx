'use client';
import { useRef, useState, type DragEvent } from 'react';
import { CircleCheck, ImageUp, LoaderCircle, OctagonX } from 'lucide-react';
import { errorMessage } from '@/lib/client/api';
import { ACCEPTED_IMAGE_TYPES, precheck, uploadAsset, type UploadPhase } from '@/lib/client/upload';
import type { Asset } from '@/lib/client/types';
import { Button, cn } from '@/components/ui';

interface UploadRow { key: string; name: string; phase: UploadPhase; message?: string }

const PHASE_LABEL: Record<UploadPhase, string> = {
  queued: 'Waiting', requesting: 'Preparing upload', uploading: 'Uploading', validating: 'Checking image',
  ready: 'Ready', rejected: 'Rejected', error: 'Failed',
};

/** Drag-and-drop + button upload with per-file phases. Calls onUploaded for each completed asset. */
export function UploadDropzone({ brandId, onUploaded, compact, disabledReason }: { brandId: string; onUploaded: (a: Asset) => void; compact?: boolean; disabledReason?: string | null }) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const [rows, setRows] = useState<UploadRow[]>([]);
  const set = (key: string, patch: Partial<UploadRow>) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));

  const handle = async (files: FileList | File[]) => {
    const list = Array.from(files);
    const fresh = list.map((f, i) => ({ key: `${Date.now()}-${i}-${f.name}`, name: f.name, phase: 'queued' as UploadPhase }));
    setRows((rs) => [...fresh, ...rs].slice(0, 12));
    for (let i = 0; i < list.length; i++) {
      const f = list[i]!;
      const key = fresh[i]!.key;
      const bad = precheck(f);
      if (bad) {
        set(key, { phase: 'rejected', message: bad });
        continue;
      }
      try {
        const asset = await uploadAsset(brandId, f, (p) => set(key, { phase: p }));
        set(key, { phase: asset.status === 'ready' ? 'ready' : asset.status === 'rejected' ? 'rejected' : 'validating', message: asset.rejection_reason ?? undefined });
        onUploaded(asset);
      } catch (e) {
        set(key, { phase: 'error', message: errorMessage(e) });
      }
    }
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    if (disabledReason) return;
    if (e.dataTransfer.files?.length) void handle(e.dataTransfer.files);
  };

  return (
    <div className="flex flex-col gap-3">
      <div
        onDragOver={(e) => { e.preventDefault(); if (!disabledReason) setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={onDrop}
        className={cn(
          'flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed text-center transition-colors',
          compact ? 'px-4 py-5' : 'px-6 py-10',
          over ? 'border-[var(--focus)] bg-accent-soft' : 'border-border-strong bg-sunken',
        )}
      >
        <ImageUp aria-hidden className="size-6 text-muted" />
        <p className="text-[13px]">
          Drag images here, or{' '}
          <Button size="sm" variant="secondary" className="ml-1" onClick={() => input.current?.click()} disabledReason={disabledReason}>Choose files</Button>
        </p>
        <p className="text-xs text-muted">JPEG or PNG. Files are checked before they can be used.</p>
        <input
          ref={input}
          type="file"
          accept={ACCEPTED_IMAGE_TYPES.join(',')}
          multiple
          className="sr-only"
          tabIndex={-1}
          aria-hidden
          onChange={(e) => {
            if (e.target.files?.length) void handle(e.target.files);
            e.target.value = '';
          }}
        />
      </div>
      {rows.length ? (
        <ul className="flex flex-col gap-1.5" aria-live="polite" aria-label="Uploads">
          {rows.map((r) => (
            <li key={r.key} className="flex items-start gap-2.5 rounded-lg border border-border bg-surface px-3 py-2 text-[13px]">
              {r.phase === 'ready' ? <CircleCheck aria-hidden className="mt-0.5 size-4 text-success" />
                : r.phase === 'rejected' || r.phase === 'error' ? <OctagonX aria-hidden className="mt-0.5 size-4 text-danger" />
                  : <LoaderCircle aria-hidden className="mt-0.5 size-4 anim-spin text-info" />}
              <div className="min-w-0 flex-1">
                <p className="truncate">{r.name}</p>
                <p className={cn('text-xs', r.phase === 'rejected' || r.phase === 'error' ? 'text-danger' : 'text-muted')}>
                  {PHASE_LABEL[r.phase]}{r.message ? ` — ${r.message}` : ''}
                </p>
              </div>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
