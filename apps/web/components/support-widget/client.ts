// V5 support widget — browser client for /api/widget/** (loaded with the panel, never in the initial page bundle).
// Every mutation carries X-Relay-Widget plus the CSRF token of each identity this browser holds; the server ignores an
// identity whose token is absent. Errors keep the server's code, message, field errors and retry hint; network failures
// become 'offline' so the UI can offer a retry with the same submission id (deduplicated server-side).
import type { SupportAttachmentDto, SupportUploadIntent } from '@social-lite/core/contracts/v4-support';

export interface Csrf { member: string | null; visitor: string | null }

export class WidgetError extends Error {
  constructor(public code: string, message: string, public fieldErrors: Record<string, string> = {}, public retryAfter: number | null = null, public status = 0) { super(message); }
}

export function friendly(e: unknown): string {
  if (!(e instanceof WidgetError)) return 'Something went wrong. Try again.';
  if (e.code === 'offline') return 'You’re offline. Check your connection and try again.';
  if (e.code === 'rate_limited') {
    const m = e.retryAfter ? Math.max(1, Math.ceil(e.retryAfter / 60)) : null;
    return m ? `Too many messages for now. Try again in ${m} minute${m === 1 ? '' : 's'}.` : 'Too many messages for now. Try again shortly.';
  }
  return e.message;
}

export async function wcall<T>(path: string, init: { method?: 'GET' | 'POST'; body?: unknown; csrf?: Csrf | null } = {}): Promise<T> {
  const method = init.method ?? 'GET';
  const headers: Record<string, string> = { accept: 'application/json' };
  if (method !== 'GET') {
    headers['content-type'] = 'application/json';
    headers['x-relay-widget'] = '1';
    if (init.csrf?.member) headers['x-csrf-token'] = init.csrf.member;
    if (init.csrf?.visitor) headers['x-widget-csrf'] = init.csrf.visitor;
  }
  let res: Response;
  try {
    res = await fetch(path, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(init.body ?? {}), credentials: 'same-origin', cache: 'no-store' });
  } catch {
    throw new WidgetError('offline', 'You’re offline.');
  }
  const data = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string; fieldErrors?: Record<string, string>; details?: { retry_after_seconds?: number } } } | null;
  if (!res.ok) {
    const er = data?.error;
    throw new WidgetError(er?.code ?? (res.status >= 500 ? 'internal' : 'error'), er?.message ?? 'Something went wrong. Try again.', er?.fieldErrors ?? {}, er?.details?.retry_after_seconds ?? null, res.status);
  }
  return data as T;
}

/** RFC 4122 v4 id for deduplicated submissions (crypto.randomUUID needs a secure context; fall back to getRandomValues). */
export function newId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6]! & 0x0f) | 0x40; b[8] = (b[8]! & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Private upload through the support quarantine pipeline: intent → direct upload → server-side validation. */
export async function uploadFile(file: File, opts: { csrf: Csrf | null; workspaceId?: string | null; reference?: string | null }): Promise<SupportAttachmentDto> {
  const intent = await wcall<SupportUploadIntent>('/api/widget/attachments', { method: 'POST', csrf: opts.csrf,
    body: { filename: file.name.slice(0, 160) || 'file', content_type: file.type, size: file.size, ...(opts.workspaceId ? { workspace_id: opts.workspaceId } : {}), ...(opts.reference ? { reference: opts.reference } : {}) } });
  const fd = new FormData();
  for (const [k, v] of Object.entries(intent.upload.fields)) fd.append(k, v);
  fd.append('file', file);
  let up: Response;
  try { up = await fetch(intent.upload.url, { method: 'POST', body: fd }); } catch { throw new WidgetError('offline', 'Upload failed. Check your connection.'); }
  if (!up.ok && up.status !== 204) throw new WidgetError('upload_failed', 'Upload failed. Try again.');
  return wcall<SupportAttachmentDto>(`/api/widget/attachments/${intent.attachment.id}/complete`, { method: 'POST', csrf: opts.csrf });
}
