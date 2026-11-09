'use client';
import { useRef, useState } from 'react';
import { CircleCheck, Film, LoaderCircle, OctagonX } from 'lucide-react';
import { api, errorMessage } from '@/lib/client/api';
import type { Asset, UploadIntent } from '@/lib/client/types';
import { Button, cn } from '@/components/ui';

export const VIDEO_TYPES = ['video/mp4', 'video/quicktime'];
export const MAX_VIDEO_BYTES = 300 * 1024 * 1024;

type Phase = 'uploading' | 'processing' | 'ready' | 'rejected' | 'error';
interface Row { key: string; name: string; phase: Phase; pct?: number; message?: string }

const LABEL: Record<Phase, string> = { uploading: 'Uploading', processing: 'Processing', ready: 'Ready', rejected: 'Rejected', error: 'Failed' };

/** Presigned POST with upload progress (XHR; fetch has none). */
function postWithProgress(url: string, fd: FormData, onPct: (n: number) => void): Promise<number> {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open('POST', url);
    x.upload.onprogress = (e) => { if (e.lengthComputable) onPct(Math.round((e.loaded / e.total) * 100)); };
    x.onload = () => resolve(x.status);
    x.onerror = () => reject(new Error('Upload failed. Check your connection and try again.'));
    x.send(fd);
  });
}

/**
 * MP4 / MOV upload (≤ 300 MB). The server only quarantines the file; the worker validates and converts it,
 * so this polls the asset until it is ready or rejected.
 */
export function VideoUpload({ brandId, onUploaded, disabledReason }: { brandId: string; onUploaded: (a: Asset) => void; disabledReason?: string | null }) {
  const input = useRef<HTMLInputElement>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const set = (key: string, patch: Partial<Row>) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));

  const handle = async (file: File) => {
    const key = `${Date.now()}-${file.name}`;
    setRows((rs) => [{ key, name: file.name, phase: 'uploading' as Phase, pct: 0 }, ...rs].slice(0, 6));
    if (!VIDEO_TYPES.includes(file.type)) { set(key, { phase: 'rejected', message: 'MP4 or MOV only.' }); return; }
    if (file.size > MAX_VIDEO_BYTES) { set(key, { phase: 'rejected', message: 'Videos must be 300 MB or smaller.' }); return; }
    try {
      const intent = await api.post<UploadIntent>('/api/assets/upload-intent', { brand_id: brandId, filename: file.name, content_type: file.type, bytes: file.size });
      const fd = new FormData();
      for (const [k, v] of Object.entries(intent.upload.fields ?? {})) fd.append(k, v);
      fd.append('file', file);
      const status = await postWithProgress(intent.upload.url, fd, (pct) => set(key, { pct }));
      if (status >= 300) throw new Error(`Storage refused the file (${status}). Try again.`);
      set(key, { phase: 'processing', pct: undefined });
      let asset = await api.post<Asset>(`/api/assets/${intent.asset_id}/complete`, {});
      const deadline = Date.now() + 15 * 60_000;
      while (asset.status !== 'ready' && asset.status !== 'rejected' && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 2000));
        asset = await api.get<Asset>(`/api/assets/${intent.asset_id}`);
      }
      set(key, { phase: asset.status === 'ready' ? 'ready' : asset.status === 'rejected' ? 'rejected' : 'processing', message: asset.rejection_reason ?? undefined });
      onUploaded(asset);
    } catch (e) {
      set(key, { phase: 'error', message: errorMessage(e) });
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <Button size="sm" variant="secondary" icon={<Film aria-hidden className="size-4" />} onClick={() => input.current?.click()} disabledReason={disabledReason}>
        Video
      </Button>
      <input ref={input} type="file" accept={VIDEO_TYPES.join(',')} className="sr-only" tabIndex={-1} aria-hidden
        onChange={(e) => { const f = e.target.files?.[0]; if (f) void handle(f); e.target.value = ''; }} />
      {rows.length ? (
        <ul className="flex flex-col gap-1" aria-live="polite" aria-label="Video uploads">
          {rows.map((r) => (
            <li key={r.key} className="flex items-start gap-2 px-1 py-1 text-[13px]">
              {r.phase === 'ready' ? <CircleCheck aria-hidden className="mt-0.5 size-4 text-success" />
                : r.phase === 'rejected' || r.phase === 'error' ? <OctagonX aria-hidden className="mt-0.5 size-4 text-danger" />
                  : <LoaderCircle aria-hidden className="mt-0.5 size-4 anim-spin text-info" />}
              <div className="min-w-0 flex-1">
                <p className="truncate">{r.name}</p>
                <p className={cn('text-xs', r.phase === 'rejected' || r.phase === 'error' ? 'text-danger' : 'text-muted')}>
                  {LABEL[r.phase]}{r.pct !== undefined ? ` ${r.pct}%` : ''}{r.message ? ` — ${r.message}` : ''}
                </p>
              </div>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
