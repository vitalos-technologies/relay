'use client';
// V5 support widget — private attachments (support quarantine pipeline). Files are checked on the server before they can
// be attached; rejected files say why. Limits come from the session (types, size, count).
import { useCallback, useRef, useState } from 'react';
import { Loader2, Paperclip, X } from 'lucide-react';
import type { SupportAttachmentDto } from '@social-lite/core/contracts/v4-support';
import { friendly, uploadFile, type Csrf } from './client';

export interface PickedFile { key: string; name: string; size: number; state: 'uploading' | 'ready' | 'error'; id?: string; error?: string }

export interface FileLimits { attachments_per_message: number; attachment_max_bytes: number; attachment_types: readonly string[] }

export function useFiles(limits: FileLimits | null) {
  const [files, setFiles] = useState<PickedFile[]>([]);
  const seq = useRef(0);
  const add = useCallback(async (list: FileList | File[], opts: { csrf: Csrf | null; workspaceId?: string | null; reference?: string | null }) => {
    if (!limits) return;
    for (const f of Array.from(list)) {
      const key = `f${++seq.current}`;
      const base: PickedFile = { key, name: f.name, size: f.size, state: 'uploading' };
      let early: string | null = null;
      if (!limits.attachment_types.includes(f.type)) early = 'Use an image (PNG, JPEG, GIF, WebP), a PDF or a text file.';
      else if (f.size > limits.attachment_max_bytes) early = `Files can be up to ${Math.round(limits.attachment_max_bytes / 1048576)} MB.`;
      setFiles((cur) => {
        if (cur.filter((x) => x.state !== 'error').length >= limits.attachments_per_message) {
          return [...cur, { ...base, state: 'error', error: `Attach up to ${limits.attachments_per_message} files.` }];
        }
        return [...cur, early ? { ...base, state: 'error', error: early } : base];
      });
      if (early) continue;
      try {
        const r: SupportAttachmentDto = await uploadFile(f, opts);
        setFiles((cur) => cur.map((x) => (x.key === key ? (r.state === 'ready' ? { ...x, state: 'ready', id: r.id } : { ...x, state: 'error', error: r.error ?? 'This file can’t be used.' }) : x)));
      } catch (e) {
        setFiles((cur) => cur.map((x) => (x.key === key ? { ...x, state: 'error', error: friendly(e) } : x)));
      }
    }
  }, [limits]);
  const remove = useCallback((key: string) => setFiles((cur) => cur.filter((x) => x.key !== key)), []);
  const clear = useCallback(() => setFiles([]), []);
  return { files, add, remove, clear, readyIds: files.filter((f) => f.state === 'ready').map((f) => f.id!), busy: files.some((f) => f.state === 'uploading') };
}

export function FilePicker({ onPick, disabled, accept, id }: { onPick: (files: FileList) => void; disabled?: boolean; accept: readonly string[]; id: string }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <input ref={input} id={id} type="file" multiple accept={accept.join(',')} className="sr-only" tabIndex={-1} aria-hidden
        onChange={(e) => { if (e.target.files?.length) onPick(e.target.files); e.target.value = ''; }} />
      <button type="button" disabled={disabled} onClick={() => input.current?.click()}
        className="inline-flex size-10 shrink-0 items-center justify-center rounded-full text-v5-muted outline-none hover:bg-v5-raised hover:text-v5-fg focus-visible:outline-2 focus-visible:outline-v5-ring disabled:opacity-50">
        <Paperclip aria-hidden className="size-5" />
        <span className="sr-only">Attach a file</span>
      </button>
    </>
  );
}

export function FileChips({ files, onRemove }: { files: PickedFile[]; onRemove: (key: string) => void }) {
  if (!files.length) return null;
  return (
    <ul className="flex flex-wrap gap-1.5" aria-label="Attachments">
      {files.map((f) => (
        <li key={f.key} className={`inline-flex max-w-full items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs ${f.state === 'error' ? 'border-[color:var(--v5-warn)] text-[color:var(--v5-warn)]' : 'border-v5-border text-v5-fg'}`}>
          {f.state === 'uploading' ? <Loader2 aria-hidden className="size-3.5 animate-spin motion-reduce:animate-none" /> : null}
          <span className="min-w-0 truncate">{f.name}</span>
          <span className="sr-only">{f.state === 'uploading' ? ' — checking' : f.state === 'error' ? ` — ${f.error}` : ' — ready'}</span>
          {f.state === 'error' ? <span aria-hidden className="hidden truncate sm:inline">· {f.error}</span> : null}
          <button type="button" onClick={() => onRemove(f.key)} className="-mr-1 inline-flex size-6 items-center justify-center rounded-full hover:bg-v5-raised focus-visible:outline-2 focus-visible:outline-v5-ring">
            <X aria-hidden className="size-3.5" /><span className="sr-only">Remove {f.name}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

export function AttachmentLinks({ files }: { files: SupportAttachmentDto[] }) {
  if (!files.length) return null;
  return (
    <ul className="mt-1.5 flex flex-col gap-1">
      {files.map((f) => (
        <li key={f.id}>
          {f.url ? (
            <a href={f.url} target="_blank" rel="noopener noreferrer" className="inline-flex max-w-full items-center gap-1.5 text-xs font-medium underline underline-offset-2">
              <Paperclip aria-hidden className="size-3.5 shrink-0" /><span className="truncate">{f.filename}</span>
              {f.size ? <span className="shrink-0 text-v5-muted">({Math.max(1, Math.round(f.size / 1024))} KB)</span> : null}
            </a>
          ) : <span className="text-xs text-v5-muted">{f.filename}</span>}
        </li>
      ))}
    </ul>
  );
}
