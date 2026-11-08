'use client';
// Support attachments (customer + staff): pick → upload intent → direct upload to private storage → server validation.
// Only files the server marked "ready" are sent with a message. Allowed: PNG, JPEG, GIF, WebP, PDF, plain text; ≤ 10 MB.
import { useRef, useState } from 'react';
import { FileText, ImageIcon, Paperclip, X } from 'lucide-react';
import { SUPPORT_ATTACHMENT_MAX_BYTES, SUPPORT_ATTACHMENT_TYPES, SUPPORT_ATTACHMENTS_PER_MESSAGE, type SupportAttachmentDto, type SupportUploadIntent } from '@social-lite/core/contracts/v4-support';
import { ApiError, api, errorMessage } from '@/lib/client/api';
import { Button, cn } from '@/components/ui';

export type AttachmentBase = '/api/support/attachments' | '/api/platform/support/attachments';
interface Item { key: string; name: string; state: 'uploading' | 'ready' | 'rejected' | 'error'; att?: SupportAttachmentDto; error?: string }

const fmtSize = (n: number) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

async function uploadOne(base: AttachmentBase, file: File): Promise<SupportAttachmentDto> {
  const intent = await api.post<SupportUploadIntent>(base, { filename: file.name, content_type: file.type, size: file.size });
  const fd = new FormData();
  for (const [k, v] of Object.entries(intent.upload.fields)) fd.append(k, v);
  fd.append('file', file);
  let res: Response;
  try { res = await fetch(intent.upload.url, { method: 'POST', body: fd, credentials: 'omit' }); } catch {
    throw new ApiError(0, 'network', 'The upload could not reach storage. Check your connection and try again.', undefined, undefined, null);
  }
  if (!res.ok) throw new ApiError(res.status, 'upload_failed', 'Storage refused the file. Try again.', undefined, undefined, null);
  return api.post<SupportAttachmentDto>(`${base}/${intent.attachment.id}/complete`, {});
}

/** Controlled list of uploads; `onChange` receives the ids of ready files. */
export function useAttachments(base: AttachmentBase) {
  const [items, setItems] = useState<Item[]>([]);
  const add = async (files: FileList | File[]) => {
    const list = [...files].slice(0, Math.max(0, SUPPORT_ATTACHMENTS_PER_MESSAGE - items.length));
    for (const file of list) {
      const key = `${file.name}-${file.size}-${Math.random().toString(36).slice(2)}`;
      if (!(SUPPORT_ATTACHMENT_TYPES as readonly string[]).includes(file.type)) { setItems((p) => [...p, { key, name: file.name, state: 'rejected', error: 'Use an image, PDF or text file' }]); continue; }
      if (file.size > SUPPORT_ATTACHMENT_MAX_BYTES) { setItems((p) => [...p, { key, name: file.name, state: 'rejected', error: 'Up to 10 MB' }]); continue; }
      setItems((p) => [...p, { key, name: file.name, state: 'uploading' }]);
      try {
        const att = await uploadOne(base, file);
        setItems((p) => p.map((i) => (i.key === key ? { ...i, att, state: att.state === 'ready' ? 'ready' : 'rejected', error: att.error ?? undefined } : i)));
      } catch (e) {
        setItems((p) => p.map((i) => (i.key === key ? { ...i, state: 'error', error: errorMessage(e) } : i)));
      }
    }
  };
  return {
    items, add,
    remove: (key: string) => setItems((p) => p.filter((i) => i.key !== key)),
    clear: () => setItems([]),
    readyIds: items.filter((i) => i.state === 'ready' && i.att).map((i) => i.att!.id),
    busy: items.some((i) => i.state === 'uploading'),
  };
}

export function AttachmentPicker({ state, label = 'Attach', compact }: { state: ReturnType<typeof useAttachments>; label?: string; compact?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  const full = state.items.length >= SUPPORT_ATTACHMENTS_PER_MESSAGE;
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <input ref={input} type="file" multiple className="sr-only" tabIndex={-1} aria-hidden accept={SUPPORT_ATTACHMENT_TYPES.join(',')}
          onChange={(e) => { if (e.target.files?.length) void state.add(e.target.files); e.target.value = ''; }} data-testid="support-file-input" />
        <Button size="sm" variant="ghost" icon={<Paperclip aria-hidden className="size-4" />} onClick={() => input.current?.click()} disabledReason={full ? `Up to ${SUPPORT_ATTACHMENTS_PER_MESSAGE} files` : null}>
          {compact ? <span className="sr-only">{label}</span> : label}
        </Button>
        {!compact && !state.items.length ? <span className="text-xs text-subtle">Images, PDF or text · 10 MB</span> : null}
      </div>
      {state.items.length ? (
        <ul className="flex flex-wrap gap-2" aria-label="Attachments">
          {state.items.map((i) => (
            <li key={i.key} className={cn('flex min-w-0 max-w-full items-center gap-1.5 rounded-lg border px-2 py-1 text-xs',
              i.state === 'ready' ? 'border-border bg-raised' : i.state === 'uploading' ? 'border-dashed border-border text-muted' : 'border-[color-mix(in_srgb,var(--danger)_40%,var(--border))] text-danger')}>
              {i.att?.mime?.startsWith('image/') ? <ImageIcon aria-hidden className="size-3.5 shrink-0" /> : <FileText aria-hidden className="size-3.5 shrink-0" />}
              <span className="max-w-[180px] truncate">{i.name}</span>
              <span className="shrink-0 text-subtle">{i.state === 'uploading' ? 'Checking…' : i.state === 'ready' && i.att?.size ? fmtSize(i.att.size) : i.error ?? ''}</span>
              <button type="button" aria-label={`Remove ${i.name}`} onClick={() => state.remove(i.key)} className="touch-target -mr-1 inline-flex size-6 shrink-0 items-center justify-center rounded text-muted hover:text-fg">
                <X aria-hidden className="size-3.5" />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** Read-only file chips for a message (authorized download links). */
export function AttachmentLinks({ files }: { files: SupportAttachmentDto[] }) {
  return files.map((f) => (
    <a key={f.id} href={f.url ?? undefined} target="_blank" rel="noopener noreferrer" className="inline-flex max-w-full items-center gap-1 underline-offset-2 hover:underline">
      {f.mime?.startsWith('image/') ? <ImageIcon aria-hidden className="size-3.5 shrink-0" /> : <FileText aria-hidden className="size-3.5 shrink-0" />}
      <span className="truncate">{f.filename}</span>
    </a>
  ));
}
