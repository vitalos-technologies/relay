import { resolveWallTime } from '@social-lite/core';

// Remembers (per tab) the server-side conflict copy of a rejected save so History opens on it after reloading.
const key = (postId: string) => `sl-conflict-copy:${postId}`;

export function conflictCopyFor(postId: string): string | null {
  try { return typeof window === 'undefined' ? null : sessionStorage.getItem(key(postId)); } catch { return null; }
}

export function rememberConflictCopy(postId: string, id: string | null): void {
  try { if (id) sessionStorage.setItem(key(postId), id); else sessionStorage.removeItem(key(postId)); } catch { /* ignore */ }
}


/** datetime-local value interpreted in `tz` (not the browser zone) → ISO instant; earlier offset in a DST fold. */
export function wallToIso(local: string, tz: string): string | null {
  if (!local) return null;
  const r = resolveWallTime(local, tz);
  if (r.kind === 'ok') return r.instant.toISOString();
  if (r.kind === 'ambiguous') return r.options[0]!.instant.toISOString();
  return null;
}
