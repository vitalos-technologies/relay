'use client';
// V5 support widget — one conversation. Live updates by polling with the server cursor while the panel is open and the
// tab is visible; after a disconnect the next poll returns everything published since the last cursor (missed-message
// recovery). Sends are optimistic with a stable submission id: a failed send keeps its id, so "Retry" can never post twice.
// No typing or read indicators (no real events back them for visitors).
import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, RotateCcw, SendHorizontal, WifiOff } from 'lucide-react';
import { WIDGET_POLL_MS, type WidgetConversation, type WidgetMessage, type WidgetSessionInfo } from '@social-lite/core/contracts/v5-widget';
import type { SupportTicketStatus } from '@social-lite/core/contracts/v4-support';
import { friendly, newId, wcall, WidgetError } from './client';
import { AttachmentLinks, FileChips, FilePicker, useFiles } from './files';

export const STATUS_LABEL: Record<SupportTicketStatus, string> = {
  new: 'Sent', waiting_on_relay: 'Waiting for Relay', waiting_on_customer: 'Relay replied', resolved: 'Resolved', archived: 'Closed',
};

interface Pending { client_id: string; body: string; attachment_ids: string[]; state: 'sending' | 'failed'; error?: string }

const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const dayTime = (iso: string) => new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });

export function ConversationView({ reference, info, initial, announce, onStatus }: {
  reference: string; info: WidgetSessionInfo; initial: WidgetConversation | null; announce: (text: string) => void; onStatus?: (c: WidgetConversation) => void;
}) {
  const [conv, setConv] = useState<WidgetConversation | null>(initial);
  const [msgs, setMsgs] = useState<WidgetMessage[]>(initial?.messages ?? []);
  const [pending, setPending] = useState<Pending[]>([]);
  const [conn, setConn] = useState<'ok' | 'reconnecting' | 'offline'>(typeof navigator !== 'undefined' && navigator.onLine === false ? 'offline' : 'ok');
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [body, setBody] = useState('');
  const cursor = useRef(initial?.cursor ?? 0);
  const fails = useRef(0);
  const list = useRef<HTMLOListElement>(null);
  const files = useFiles(info.limits);
  const csrf = info.csrf;

  const merge = useCallback((c: WidgetConversation) => {
    cursor.current = Math.max(cursor.current, c.cursor);
    setConv(c);
    onStatus?.(c);
    setMsgs((prev) => {
      const byId = new Map(prev.map((m) => [m.id, m]));
      const fresh = c.messages.filter((m) => !byId.has(m.id));
      const staff = fresh.filter((m) => m.author.kind === 'staff');
      if (c.delta && staff.length) announce(`New reply from ${staff[staff.length - 1]!.author.name}`);
      const next = c.delta ? [...prev, ...fresh] : c.messages;
      return next.slice().sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
    });
  }, [announce, onStatus]);

  const poll = useCallback(async () => {
    try {
      merge(await wcall<WidgetConversation>(`/api/widget/conversations/${encodeURIComponent(reference)}?after=${cursor.current}`));
      fails.current = 0; setConn('ok'); setLoadErr(null);
    } catch (e) {
      fails.current += 1;
      if (e instanceof WidgetError && (e.code === 'not_found' || e.code === 'unauthenticated')) { setLoadErr('This conversation isn’t available in this browser any more.'); return; }
      setConn(e instanceof WidgetError && e.code === 'offline' ? 'offline' : fails.current >= 2 ? 'reconnecting' : 'ok');
      if (!cursor.current) setLoadErr(friendly(e));
    }
  }, [merge, reference]);

  // First load (when not handed a fresh conversation) + polling loop with back-off; paused while the tab is hidden.
  useEffect(() => {
    let stop = false;
    let timer: number | undefined;
    const loop = async () => {
      if (stop) return;
      if (document.visibilityState === 'visible') await poll();
      const wait = Math.min(WIDGET_POLL_MS * 2 ** Math.min(fails.current, 4), 60_000);
      timer = window.setTimeout(loop, wait);
    };
    if (!initial) void poll().then(() => { timer = window.setTimeout(loop, WIDGET_POLL_MS); });
    else timer = window.setTimeout(loop, WIDGET_POLL_MS);
    const wake = () => { if (document.visibilityState === 'visible') { window.clearTimeout(timer); void loop(); } };
    const online = () => { setConn('ok'); fails.current = 0; wake(); };
    const offline = () => setConn('offline');
    document.addEventListener('visibilitychange', wake);
    window.addEventListener('online', online);
    window.addEventListener('offline', offline);
    return () => { stop = true; window.clearTimeout(timer); document.removeEventListener('visibilitychange', wake); window.removeEventListener('online', online); window.removeEventListener('offline', offline); };
  }, [initial, poll]);

  useEffect(() => { const el = list.current?.parentElement; if (el) el.scrollTop = el.scrollHeight; }, [msgs.length, pending.length]);

  const deliver = useCallback(async (p: Pending) => {
    setPending((cur) => cur.map((x) => (x.client_id === p.client_id ? { ...x, state: 'sending', error: undefined } : x)));
    try {
      const r = await wcall<WidgetConversation>(`/api/widget/conversations/${encodeURIComponent(reference)}/messages`, { method: 'POST', csrf,
        body: { client_id: p.client_id, body: p.body, attachment_ids: p.attachment_ids, after: cursor.current } });
      merge(r);
      setPending((cur) => cur.filter((x) => x.client_id !== p.client_id));
    } catch (e) {
      setPending((cur) => cur.map((x) => (x.client_id === p.client_id ? { ...x, state: 'failed', error: friendly(e) } : x)));
    }
  }, [csrf, merge, reference]);

  const submit = () => {
    const text = body.trim();
    if (!text || files.busy) return;
    const p: Pending = { client_id: newId(), body: text, attachment_ids: files.readyIds, state: 'sending' };
    setPending((cur) => [...cur, p]);
    setBody(''); files.clear();
    void deliver(p);
  };

  if (!conv && loadErr) return <p role="alert" className="p-5 text-sm text-v5-muted">{loadErr}</p>;
  if (!conv) return <div className="flex flex-1 items-center justify-center p-6" role="status"><Loader2 aria-hidden className="size-5 animate-spin text-v5-muted motion-reduce:animate-none" /><span className="sr-only">Loading conversation</span></div>;
  const max = info.limits.message_max;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between gap-2 border-b border-v5-border px-5 py-2 text-xs text-v5-muted">
        <span>{conv.reference}{conv.workspace ? ` · ${conv.workspace.name}` : ''}</span>
        <span data-testid="conversation-status" className="font-medium text-v5-fg">{STATUS_LABEL[conv.status]}</span>
      </div>
      {conn !== 'ok' ? (
        <p role="status" className="flex items-center gap-2 bg-v5-warn-soft px-5 py-2 text-xs text-[color:var(--v5-warn)]">
          <WifiOff aria-hidden className="size-3.5" />{conn === 'offline' ? 'You’re offline. New replies will appear when you reconnect.' : 'Reconnecting…'}
        </p>
      ) : null}
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4" tabIndex={0} aria-label="Messages">
        <ol ref={list} className="flex flex-col gap-3">
          {msgs.map((m) => <Bubble key={m.id} m={m} />)}
          {pending.map((p) => (
            <li key={p.client_id} className="flex flex-col items-end">
              <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-v5-primary-soft px-3.5 py-2 text-[15px] text-v5-fg opacity-80">{p.body}</div>
              {p.state === 'sending' ? <span className="mt-1 text-xs text-v5-muted">Sending…</span> : (
                <span className="mt-1 flex flex-wrap items-center justify-end gap-2 text-xs text-[color:var(--v5-warn)]" role="alert">
                  Not sent. {p.error}
                  <button type="button" onClick={() => void deliver(p)} className="inline-flex items-center gap-1 font-semibold underline underline-offset-2"><RotateCcw aria-hidden className="size-3" />Retry</button>
                  <button type="button" onClick={() => setPending((cur) => cur.filter((x) => x.client_id !== p.client_id))} className="font-semibold underline underline-offset-2">Remove</button>
                </span>
              )}
            </li>
          ))}
        </ol>
        {conv.notice ? <p className="mt-4 text-center text-xs text-v5-muted">{conv.notice}</p> : null}
      </div>
      {conv.can_reply ? (
        <form className="border-t border-v5-border px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-2" onSubmit={(e) => { e.preventDefault(); submit(); }}>
          <FileChips files={files.files} onRemove={files.remove} />
          <div className="mt-1 flex items-end gap-1">
            <FilePicker id={`wid-file-${conv.reference}`} accept={info.limits.attachment_types} disabled={files.files.length >= info.limits.attachments_per_message}
              onPick={(l) => void files.add(l, { csrf, reference: conv.reference })} />
            <label htmlFor={`wid-reply-${conv.reference}`} className="sr-only">Reply</label>
            <textarea id={`wid-reply-${conv.reference}`} value={body} maxLength={max} rows={1} placeholder="Write a reply…" enterKeyHint="send"
              onChange={(e) => setBody(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey || (!e.shiftKey && !window.matchMedia('(pointer: coarse)').matches))) { e.preventDefault(); submit(); } }}
              className="max-h-32 min-h-10 flex-1 resize-none rounded-2xl border border-v5-border-strong bg-v5-surface px-3.5 py-2 text-[15px] text-v5-fg outline-none placeholder:text-v5-muted focus-visible:border-v5-ring focus-visible:ring-2 focus-visible:ring-v5-ring/30" />
            <button type="submit" disabled={!body.trim() || files.busy}
              className="inline-flex size-10 shrink-0 items-center justify-center rounded-full bg-v5-primary text-v5-on-primary outline-none hover:bg-v5-primary-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-v5-ring disabled:opacity-40">
              <SendHorizontal aria-hidden className="size-4" /><span className="sr-only">{files.busy ? 'Files are still being checked' : 'Send'}</span>
            </button>
          </div>
        </form>
      ) : null}
    </div>
  );
}

function Bubble({ m }: { m: WidgetMessage }) {
  const mine = m.author.mine;
  return (
    <li className={`flex flex-col ${mine ? 'items-end' : 'items-start'}`}>
      {!mine ? <span className="mb-1 text-xs font-medium text-v5-muted">{m.author.name}</span> : null}
      <div className={`max-w-[85%] whitespace-pre-wrap break-words px-3.5 py-2 text-[15px] ${mine ? 'rounded-2xl rounded-br-md bg-v5-primary-soft text-v5-fg' : 'rounded-2xl rounded-bl-md bg-v5-raised text-v5-fg'}`}>
        <span className="sr-only">{mine ? 'You: ' : `${m.author.name}: `}</span>{m.body}
        <AttachmentLinks files={m.attachments} />
      </div>
      <time dateTime={m.created_at} title={dayTime(m.created_at)} className="mt-1 text-[11px] text-v5-muted">{time(m.created_at)}</time>
    </li>
  );
}
