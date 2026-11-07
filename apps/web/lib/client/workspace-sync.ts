'use client';
// Workspace isolation on the client (spec §2, §12.16). On a workspace switch nothing cached from the
// previous workspace may survive: in-memory caches (idempotency keys, hook state), session-scoped
// storage and other open tabs are all reset. Requests carry the workspace the tab rendered
// (X-Workspace-Id); the server refuses a mismatch so a stale tab reloads instead of mixing data.
import { clearPendingKeys, setExpectedWorkspace } from './api';

const CHANNEL = 'sl-workspace';

/** Drop every client cache that could hold data from the current workspace. */
export function clearClientCaches(): void {
  clearPendingKeys();
  setExpectedWorkspace(null);
  try {
    for (const k of Object.keys(sessionStorage)) if (k.startsWith('sl')) sessionStorage.removeItem(k);
  } catch { /* storage unavailable */ }
  try {
    // Per-workspace data must never live in localStorage; only UI preferences (theme) are kept.
    for (const k of Object.keys(localStorage)) if (k.startsWith('sl:')) localStorage.removeItem(k);
  } catch { /* storage unavailable */ }
  if (typeof caches !== 'undefined') void caches.keys().then((ks) => Promise.all(ks.map((k) => caches.delete(k)))).catch(() => undefined);
}

/** Tell other tabs the active workspace changed: they must reload (their data belongs to the old one). */
export function broadcastWorkspaceChange(workspaceId: string): void {
  try {
    const bc = new BroadcastChannel(CHANNEL);
    bc.postMessage({ type: 'workspace_changed', workspaceId });
    bc.close();
  } catch { /* unsupported */ }
}

export function onWorkspaceChangedElsewhere(currentWorkspaceId: string | null, cb: () => void): () => void {
  let bc: BroadcastChannel | null = null;
  try {
    bc = new BroadcastChannel(CHANNEL);
    bc.onmessage = (e: MessageEvent<{ type?: string; workspaceId?: string }>) => {
      if (e.data?.type === 'workspace_changed' && e.data.workspaceId !== currentWorkspaceId) cb();
    };
  } catch { /* unsupported */ }
  return () => bc?.close();
}

/** Hard reload into the new workspace after clearing caches (no client state is carried over). */
export function enterWorkspace(workspaceId: string, path = '/'): void {
  clearClientCaches();
  broadcastWorkspaceChange(workspaceId);
  window.location.replace(path);
}
