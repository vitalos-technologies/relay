'use client';
// Conversation history (V5 §11): my AI conversations, newest first, loaded incrementally (keyset cursor) — the next
// page loads when the end of the list scrolls into view or on "Load more".
import { useCallback, useEffect, useRef, useState } from 'react';
import { MessageSquarePlus } from 'lucide-react';
import type { ThreadDto, ThreadPageDto } from '@social-lite/core/contracts/v5-ai';
import { api } from '@/lib/client/api';
import { Button, ErrorNotice, Skeleton, cn } from '@/components/ui';
import { STATUS_LABEL, relTime } from './shared';

const DOT: Record<string, string> = {
  preparing: 'bg-info', working: 'bg-info', needs_input: 'bg-accent', needs_review: 'bg-accent', completed: 'bg-success', partially_completed: 'bg-warn', failed: 'bg-danger', cancelled: 'bg-subtle',
};

export function HistoryList({ activeId, onOpen, onNew, refreshKey }: { activeId: string | null; onOpen: (t: ThreadDto) => void; onNew: () => void; refreshKey: number }) {
  const [items, setItems] = useState<ThreadDto[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const end = useRef<HTMLDivElement>(null);

  const load = useCallback(async (from: string | null) => {
    setBusy(true);
    try {
      const p = await api.get<ThreadPageDto>('/api/assistant/threads', { limit: 20, ...(from ? { cursor: from } : {}) });
      setItems((prev) => (from && prev ? [...prev, ...p.items.filter((x) => !prev.some((y) => y.id === x.id))] : p.items));
      setCursor(p.next_cursor);
      setError(null);
    } catch (e) { setError(e); } finally { setBusy(false); }
  }, []);

  useEffect(() => { void load(null); }, [load, refreshKey]);
  useEffect(() => {
    const el = end.current;
    if (!el || !cursor || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver((e) => { if (e.some((x) => x.isIntersecting) && !busy) void load(cursor); });
    io.observe(el);
    return () => io.disconnect();
  }, [cursor, busy, load]);

  return (
    <nav aria-label="Conversation history" className="flex min-h-0 flex-1 flex-col">
      <Button variant="secondary" className="mb-3 w-full justify-start" icon={<MessageSquarePlus aria-hidden className="size-4" />} onClick={onNew}>New task</Button>
      <p className="mb-1 px-2 text-[11px] font-medium uppercase tracking-[0.06em] text-subtle">Recent</p>
      {error && !items ? <ErrorNotice error={error} /> : !items ? (
        <div className="flex flex-col gap-2 px-2">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-9" />)}</div>
      ) : !items.length ? <p className="px-2 text-[13px] text-muted">Your tasks will appear here.</p> : (
        <ul className="flex min-h-0 flex-col gap-0.5 overflow-y-auto" data-testid="ai-history">
          {items.map((t) => (
            <li key={t.id}>
              <button type="button" onClick={() => onOpen(t)} aria-current={t.id === activeId ? 'page' : undefined}
                className={cn('flex w-full items-start gap-2 rounded-lg px-2 py-2 text-left text-[13px] hover:bg-raised', t.id === activeId && 'bg-accent-soft text-accent-text hover:bg-accent-soft')}>
                <span aria-hidden className={cn('mt-1.5 size-2 shrink-0 rounded-full', DOT[t.last_status ?? ''] ?? 'bg-subtle')} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{t.title}</span>
                  <span className="block truncate text-xs text-muted">{t.brand_name} · {relTime(t.updated_at)}{t.last_status ? <span className="sr-only">, {STATUS_LABEL[t.last_status]}</span> : null}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <div ref={end} />
      {cursor ? <Button variant="quiet" size="sm" className="mt-1" loading={busy} onClick={() => void load(cursor)}>Load more</Button> : null}
    </nav>
  );
}
