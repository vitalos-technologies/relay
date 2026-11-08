'use client';
// POST a request and save the binary/text response as a file (exports). Errors come back as ApiError.
import { ApiError } from '@/lib/client/api';

export async function postDownload(path: string, body: unknown, csrfToken: string): Promise<{ filename: string; bytes: number }> {
  const res = await fetch(path, {
    method: 'POST', credentials: 'same-origin', cache: 'no-store',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken, Accept: '*/*' },
    body: JSON.stringify(body ?? {}),
  });
  if (!res.ok) {
    let env: { error?: { code?: string; message?: string; details?: Record<string, unknown> }; correlation_id?: string } = {};
    try { env = await res.json(); } catch { /* non-JSON */ }
    throw new ApiError(res.status, env.error?.code ?? 'internal', env.error?.message ?? `Request failed (${res.status}).`, undefined, env.error?.details, env.correlation_id ?? res.headers.get('x-correlation-id'));
  }
  const blob = await res.blob();
  const cd = res.headers.get('content-disposition') ?? '';
  const filename = /filename="([^"]+)"/.exec(cd)?.[1] ?? 'export';
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.rel = 'noopener';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return { filename, bytes: blob.size };
}
