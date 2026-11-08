'use client';
// Collaboration sync on the client.
//  - useCollabSync: one EventSource per post page (/api/collab/stream). Events are small and content-free; handlers refetch
//    through the normal APIs. Duplicates / out-of-order events are ignored by id. On disconnect it reconnects from the last
//    id; after repeated failures it falls back to polling /api/collab/events (10 s), and goes back to the stream later.
//    `revoked` stops everything (access changed: the page reloads its data and shows what the server allows).
//  - usePresence: heartbeat every 20 s while the tab is visible ("left" on hide/close). Informational only.
import { useEffect, useRef, useState } from 'react';
import { api } from './api';
import { editorClientId } from './draft-recovery';

export interface CollabEvent { id: number; kind: string; post_id: string | null; ref_id: string | null; actor_id: string | null; mine: boolean; at: string }
export type SyncStatus = 'connecting' | 'live' | 'polling' | 'offline' | 'revoked';

export function newClientKey(prefix = 'c'): string {
  const r = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID().replace(/-/g, '') : `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  return `${prefix}_${r.slice(0, 24)}`;
}

export function useCollabSync(postId: string | null, startCursor: number | null, onEvents: (events: CollabEvent[], meta: { reset: boolean }) => void): SyncStatus {
  const [status, setStatus] = useState<SyncStatus>('connecting');
  const cb = useRef(onEvents);
  cb.current = onEvents;
  useEffect(() => {
    if (startCursor === null) return;
    let cursor = startCursor;
    let stopped = false;
    let es: EventSource | null = null;
    let failures = 0;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    const seen = new Set<number>();
    const deliver = (evts: CollabEvent[], reset = false) => {
      const fresh = evts.filter((e) => e.id > 0 && !seen.has(e.id)).sort((a, b) => a.id - b.id);
      for (const e of fresh) { seen.add(e.id); cursor = Math.max(cursor, e.id); }
      if (seen.size > 2000) seen.clear();
      if (fresh.length || reset) cb.current(fresh, { reset });
    };
    const qs = () => `${postId ? `post=${postId}&` : ''}after=${cursor}`;
    const poll = async () => {
      if (stopped) return;
      try {
        const r = await api.get<{ events: CollabEvent[]; cursor: number; more: boolean; reset: boolean; visible: boolean }>(`/api/collab/events?${qs()}`, undefined, { redirectOn401: false });
        if (r.reset) { cursor = r.cursor; deliver([], true); }
        else deliver(r.events);
        cursor = Math.max(cursor, r.cursor);
        if (postId && !r.visible) { setStatus('revoked'); stopped = true; return; }
        setStatus('polling');
        pollTimer = setTimeout(poll, r.more ? 200 : 10_000);
      } catch {
        setStatus(navigator.onLine ? 'polling' : 'offline');
        pollTimer = setTimeout(poll, 15_000);
      }
    };
    const open = () => {
      if (stopped) return;
      if (typeof EventSource === 'undefined' || failures >= 3) {
        void poll();
        // Try the stream again later.
        retryTimer = setTimeout(() => { if (pollTimer) clearTimeout(pollTimer); failures = 0; open(); }, 120_000);
        return;
      }
      es = new EventSource(`/api/collab/stream?${qs()}`);
      es.onopen = () => { failures = 0; setStatus('live'); };
      es.onmessage = (m) => { try { deliver([JSON.parse(m.data) as CollabEvent]); } catch { /* ignore malformed */ } };
      es.addEventListener('reset', (m) => {
        try { cursor = (JSON.parse((m as MessageEvent).data) as { cursor: number }).cursor; } catch { /* keep */ }
        deliver([], true);
      });
      es.addEventListener('revoked', () => { setStatus('revoked'); stopped = true; es?.close(); deliver([], true); });
      es.addEventListener('end', () => { es?.close(); es = null; if (!stopped) open(); });
      es.onerror = () => {
        es?.close(); es = null;
        if (stopped) return;
        failures++;
        setStatus(navigator.onLine ? 'connecting' : 'offline');
        retryTimer = setTimeout(open, Math.min(30_000, 1000 * 2 ** failures));
      };
    };
    const onOnline = () => { if (!stopped && !es) { if (pollTimer) clearTimeout(pollTimer); if (retryTimer) clearTimeout(retryTimer); failures = 0; open(); deliver([], true); } };
    const onOffline = () => setStatus('offline');
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    open();
    return () => {
      stopped = true;
      es?.close();
      if (pollTimer) clearTimeout(pollTimer);
      if (retryTimer) clearTimeout(retryTimer);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, [postId, startCursor]);
  return status;
}

export interface PresencePerson { user_id: string; name: string; state: 'viewing' | 'editing' | 'recent'; last_seen_at: string; me: boolean }

/** Heartbeats while visible; returns other people on the post (never yourself). */
export function usePresence(postId: string, editing: boolean): { people: PresencePerson[]; enabled: boolean } {
  const [state, setState] = useState<{ people: PresencePerson[]; enabled: boolean }>({ people: [], enabled: true });
  const editingRef = useRef(editing);
  editingRef.current = editing;
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;
    const clientId = `${editorClientId()}`;
    const beat = async (st?: 'left') => {
      try {
        const r = await api.post<{ enabled: boolean; people: PresencePerson[]; heartbeat_seconds?: number }>(`/api/posts/${postId}/presence`,
          { client_id: clientId, state: st ?? (editingRef.current ? 'editing' : 'viewing') }, { redirectOn401: false, keepalive: st === 'left' });
        if (!stopped && st !== 'left') setState({ enabled: r.enabled, people: r.people.filter((p) => !p.me) });
        return r;
      } catch { return null; }
    };
    const loop = async () => {
      if (stopped || document.visibilityState !== 'visible') return;
      const r = await beat();
      if (r && !r.enabled) return; // turned off for the workspace
      timer = setTimeout(loop, (r?.heartbeat_seconds ?? 20) * 1000);
    };
    const vis = () => {
      if (timer) clearTimeout(timer);
      if (document.visibilityState === 'visible') void loop();
      else void beat('left');
    };
    const hide = () => { void beat('left'); };
    void loop();
    document.addEventListener('visibilitychange', vis);
    window.addEventListener('pagehide', hide);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener('visibilitychange', vis);
      window.removeEventListener('pagehide', hide);
      void beat('left');
    };
  }, [postId]);
  // An edit state change is sent with the next heartbeat (≤ 20 s); send it now when it flips to editing.
  const prev = useRef(editing);
  useEffect(() => {
    if (editing && !prev.current) {
      void api.post(`/api/posts/${postId}/presence`, { client_id: editorClientId(), state: 'editing' }, { redirectOn401: false }).catch(() => undefined);
    }
    prev.current = editing;
  }, [editing, postId]);
  return state;
}
