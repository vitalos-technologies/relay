'use client';
// Inbox realtime (stream B): one EventSource on /api/inbox/stream (content-free events), reconnecting from the last id;
// the stream ends with `revoked` when access was removed (the hook reports it and stops). Falls back to the existing
// polling of the list/thread when EventSource is unavailable or keeps failing. Handlers only refetch through the
// normal authorized APIs; components listen for `relay:inbox-changed` (detail: conversation id | null).
import { useEffect, useRef, useState } from 'react';

export type InboxStreamStatus = 'connecting' | 'live' | 'polling' | 'revoked';
export interface InboxStreamEvent { id: number; conversation_id: string | null; kind: string; at: string }
export const INBOX_CHANGED = 'relay:inbox-changed';

export function useInboxStream(onEvents: (events: InboxStreamEvent[]) => void): InboxStreamStatus {
  const [status, setStatus] = useState<InboxStreamStatus>(() => (typeof EventSource === 'undefined' ? 'polling' : 'connecting'));
  const cb = useRef(onEvents);
  useEffect(() => { cb.current = onEvents; });
  useEffect(() => {
    if (typeof EventSource === 'undefined') return;
    let es: EventSource | null = null;
    let stopped = false;
    let failures = 0;
    let cursor = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let batch: InboxStreamEvent[] = [];
    let flush: ReturnType<typeof setTimeout> | null = null;
    const deliver = (e: InboxStreamEvent) => {
      cursor = Math.max(cursor, e.id);
      batch.push(e);
      flush ??= setTimeout(() => { const b = batch; batch = []; flush = null; cb.current(b); for (const id of new Set(b.map((x) => x.conversation_id))) window.dispatchEvent(new CustomEvent(INBOX_CHANGED, { detail: id })); }, 250);
    };
    const open = () => {
      if (stopped) return;
      if (failures >= 4) { setStatus('polling'); timer = setTimeout(() => { failures = 0; open(); }, 120_000); return; }
      es = new EventSource(`/api/inbox/stream${cursor ? `?after=${cursor}` : ''}`);
      es.onopen = () => { failures = 0; setStatus('live'); };
      es.addEventListener('ready', (m) => { try { const c = (JSON.parse((m as MessageEvent).data) as { cursor: number }).cursor; if (!cursor) cursor = c; } catch { /* keep */ } });
      es.onmessage = (m) => { try { deliver(JSON.parse(m.data) as InboxStreamEvent); } catch { /* ignore malformed */ } };
      es.addEventListener('revoked', () => { stopped = true; es?.close(); setStatus('revoked'); });
      es.addEventListener('end', () => { es?.close(); es = null; open(); });
      es.onerror = () => { es?.close(); es = null; if (stopped) return; failures++; setStatus('connecting'); timer = setTimeout(open, Math.min(30_000, 1000 * 2 ** failures)); };
    };
    open();
    return () => { stopped = true; es?.close(); if (timer) clearTimeout(timer); if (flush) clearTimeout(flush); };
  }, []);
  return status;
}
