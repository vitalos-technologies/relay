'use client';
// Inbox thread: header actions (assign, resolve, snooze, spam), presence + collision warnings, the timeline (messages,
// internal notes, pending/failed/unconfirmed sends) and the composer (Public reply / Private message / Internal note).
// Send-once: one idempotency key per send action; the server re-checks the thread version and answers 409 with what
// changed — the agent reviews, then explicitly sends anyway. Drafts are kept per conversation (browser + server).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlarmClock, ArrowLeft, CheckCircle2, ChevronDown, Info, MoreHorizontal, RotateCcw, ShieldAlert, UserRound, Users } from 'lucide-react';
import type { ConversationDetail, PersonRef, ReplyAttemptDto, ReplyMode, ThreadChangedDetails } from '@social-lite/core/contracts/v35-inbox';
import { api, isApiError } from '@/lib/client/api';
import { useApi } from '@/lib/client/use-api';
import { useSession } from '@/lib/client/session';
import { Badge, Banner, Button, IconButton, Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger, SimulatedBadge, useToast } from '@/components/ui';
import { ConversationComposer, type ComposerMode } from '@/components/conversation/composer';
import { ConversationTimeline, type TimelineEntryView } from '@/components/conversation/timeline';
import { ATTEMPT_LABEL, CHANNEL_LABEL, KIND_LABEL, MODE_LABEL, STATUS_LABEL, newKey } from './labels';

type Mode = ReplyMode | 'note';
const DRAFT_KEY = (id: string) => `relay.inbox.draft.${id}`;

function readLocalDraft(id: string): { mode: Mode; body: string } | null {
  try { const v = localStorage.getItem(DRAFT_KEY(id)); return v ? JSON.parse(v) : null; } catch { return null; }
}
function writeLocalDraft(id: string, d: { mode: Mode; body: string } | null) {
  try { if (d && d.body.trim()) localStorage.setItem(DRAFT_KEY(id), JSON.stringify(d)); else localStorage.removeItem(DRAFT_KEY(id)); } catch { /* storage unavailable */ }
}

function personName(p: PersonRef | null | undefined) { return p ? (p.name || p.email || 'Teammate') : 'Unassigned'; }

export function InboxThread({ id, onBack, onDetails, onChanged }: { id: string; onBack?: () => void; onDetails?: () => void; onChanged: () => void }) {
  const toast = useToast();
  const { session } = useSession();
  const me = session.user?.id;
  const { data: c, error, refetch } = useApi<ConversationDetail>(`/api/inbox/conversations/${id}`, { poll: 8_000 });
  const assignees = useApi<{ items: PersonRef[] }>(c?.reply.can_assign ? `/api/inbox/conversations/${id}/assignees` : null);
  const [mode, setMode] = useState<Mode>('private_message');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState<(ThreadChangedDetails & { message: string; reason: string }) | null>(null);
  const sendKey = useRef<string | null>(null);
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  // The thread version the agent was looking at when they STARTED writing (not the latest poll): a reply that lands while
  // they type must stop their send and be reviewed, even though polling already shows it.
  const [composeBase, setComposeBase] = useState<number | null>(null);

  // Load the draft once per conversation (state adjusted during render, not in an effect): browser copy first, then the
  // server copy. Default mode = first allowed reply mode.
  if (c && loadedFor !== id) {
    setLoadedFor(id);
    const local = readLocalDraft(id);
    const firstAllowed = c.reply.modes.find((m) => m.allowed)?.mode ?? (c.kind === 'dm' ? 'private_message' : 'public_reply');
    if (local?.body) { setMode(local.mode); setBody(local.body); setComposeBase(c.version); } else if (c.draft) { setMode(c.draft.mode); setBody(c.draft.body); setComposeBase(c.draft.base_version); } else { setMode(c.reply.can_reply ? firstAllowed : 'note'); setBody(''); setComposeBase(null); }
    setConflict(null);
  }

  // Persist the draft: browser immediately, server (reply modes only) debounced. Changing mode keeps the text.
  useEffect(() => {
    if (loadedFor !== id) return;
    writeLocalDraft(id, { mode, body });
    if (mode === 'note' || !c?.reply.can_reply) return;
    const t = setTimeout(() => { void api.put(`/api/inbox/conversations/${id}/draft`, { mode, body, base_version: composeBase ?? c.version }).catch(() => undefined); }, 1500);
    return () => clearTimeout(t);
  }, [body, mode, id, loadedFor]); // eslint-disable-line react-hooks/exhaustive-deps

  // Presence heartbeat (informational): composing while there is text.
  useEffect(() => {
    const beat = () => void api.post(`/api/inbox/conversations/${id}/presence`, { state: body.trim() ? 'composing' : 'viewing' }).catch(() => undefined);
    beat();
    const t = setInterval(beat, 20_000);
    return () => clearInterval(t);
  }, [id, !!body.trim()]); // eslint-disable-line react-hooks/exhaustive-deps

  const act = useCallback(async (fn: () => Promise<unknown>, ok?: string) => {
    try { await fn(); if (ok) toast.success(ok); await refetch(); onChanged(); } catch (e) { toast.error(e); }
  }, [refetch, onChanged, toast]);

  const send = useCallback(async (acknowledge?: number) => {
    if (!c || !body.trim()) return;
    setBusy(true);
    try {
      if (mode === 'note') {
        await api.post(`/api/inbox/conversations/${id}/notes`, { body });
        toast.success('Note added');
      } else {
        sendKey.current ??= newKey();
        const r = await api.post<{ attempt: ReplyAttemptDto }>(`/api/inbox/conversations/${id}/replies`, { mode, body, base_version: composeBase ?? c.version, idempotency_key: sendKey.current, acknowledge_version: acknowledge ?? null });
        toast.info(r.attempt.state === 'queued' ? 'Sending…' : ATTEMPT_LABEL[r.attempt.state]);
      }
      sendKey.current = null;
      setBody('');
      setComposeBase(null);
      setConflict(null);
      writeLocalDraft(id, null);
      await refetch();
      onChanged();
    } catch (e) {
      if (isApiError(e) && e.code === 'conflict' && e.details && typeof e.details.current_version === 'number') {
        setConflict({ ...(e.details as unknown as ThreadChangedDetails), message: e.message, reason: String(e.details.reason) });
        sendKey.current = null; // nothing was queued: a new decision gets a new key
        await refetch();
      } else {
        if (isApiError(e) && !e.isTransient) sendKey.current = null;
        toast.error(e, 'Not sent');
      }
    } finally { setBusy(false); }
  }, [c, body, mode, id, refetch, onChanged, toast, composeBase]);

  const entries = useMemo<TimelineEntryView[]>(() => {
    if (!c) return [];
    return c.timeline.map((t): TimelineEntryView => {
      if (t.type === 'message') {
        const m = t.message;
        const sim = c.channel.is_simulated ? ' (simulated)' : '';
        const meta = m.direction === 'outbound' ? <span>· {m.delivery === 'read' ? 'Read' : m.delivery === 'delivered' ? 'Delivered' : 'Sent'}{sim}</span> : undefined;
        return { key: `m${m.id}`, kind: 'message', side: m.direction === 'inbound' ? 'them' : 'us', author: m.author.name ?? (m.direction === 'inbound' ? c.contact.name ?? 'Customer' : 'Outside Relay'), body: m.body, at: m.at, meta, edited: !!m.edited_at, deleted: !!m.deleted_at, attachments: m.attachments.map((a) => a.name ?? a.type) };
      }
      if (t.type === 'note') return { key: `n${t.note.id}`, kind: 'note', author: personName(t.note.author), body: t.note.body, at: t.at };
      if (t.type === 'attempt') {
        const a = t.attempt;
        const tone = a.state === 'failed' || a.state === 'cancelled' ? 'danger' : a.state === 'unknown' ? 'warn' : 'info';
        return {
          key: `a${a.id}`, kind: 'pending', author: personName(a.created_by), body: a.body, at: a.created_at,
          status: <Badge tone={tone}>{ATTEMPT_LABEL[a.state]}{a.error ? ` · ${a.error.message}` : ''}</Badge>,
          actions: a.state === 'unknown' && c.reply.can_reply ? (
            <span className="flex gap-1">
              <Button size="sm" variant="ghost" onClick={() => act(() => api.post(`/api/inbox/replies/${a.id}/resolve`, { outcome: 'sent' }), 'Marked as sent')}>It was sent</Button>
              <Button size="sm" variant="ghost" onClick={() => act(() => api.post(`/api/inbox/replies/${a.id}/resolve`, { outcome: 'not_sent' }), 'Marked as not sent')}>Not sent</Button>
            </span>
          ) : (a.state === 'failed' || a.state === 'cancelled') && c.reply.can_reply ? (
            <Button size="sm" variant="ghost" onClick={() => { setMode(a.mode); setBody(a.body); }}>Edit and resend</Button>
          ) : null,
        };
      }
      const e = t.event;
      const who = e.actor ? personName(e.actor) : 'Relay';
      const text = e.kind === 'assigned' ? (!e.data.to ? `${who} unassigned this` : e.actor && e.data.to === e.actor.id ? `${who} took this conversation` : `${who} assigned ${e.data.to === me ? 'you' : 'a teammate'}`)
        : e.kind === 'status_changed' ? `${who} marked ${STATUS_LABEL[(e.data.to as keyof typeof STATUS_LABEL) ?? 'open'] ?? e.data.to}`
          : e.kind === 'priority_changed' ? `${who} set priority ${String(e.data.to)}` : e.kind;
      return { key: `e${t.at}${e.kind}`, kind: 'system', text, at: t.at };
    });
  }, [c, me, act]);

  const scroller = useRef<HTMLDivElement>(null);
  const count = entries.length;
  useEffect(() => { const el = scroller.current; if (el) el.scrollTop = el.scrollHeight; }, [count]);

  if (error && !c) return <div className="p-6"><Banner tone="danger" title="This conversation could not be loaded">{error.message}</Banner></div>;
  if (!c) return <div className="p-6 text-[13px] text-muted">Loading…</div>;

  const modes: Array<ComposerMode<Mode>> = [
    ...c.reply.modes.filter((m) => m.allowed || (c.kind === 'dm' ? m.mode === 'private_message' : true))
      .map((m) => ({ value: m.mode as Mode, label: MODE_LABEL[m.mode], audience: m.mode === 'public_reply' ? 'public' as const : 'private' as const, disabled: !m.allowed || !c.reply.can_reply, reason: !c.reply.can_reply ? 'You can read but not reply here.' : m.reason })),
    { value: 'note', label: 'Internal note', audience: 'internal' },
  ];
  const composing = c.presence.filter((p) => p.state === 'composing');
  const setStatus = (status: string, extra: Record<string, unknown> = {}) => act(() => api.patch(`/api/inbox/conversations/${id}`, { status, ...extra }), status === 'resolved' ? 'Resolved' : undefined);
  const tomorrow9 = () => { const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(9, 0, 0, 0); return d.toISOString(); };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center gap-2 border-b border-border px-3 py-2.5 sm:px-4">
        {onBack ? <IconButton label="Back to conversations" icon={<ArrowLeft className="size-4" />} onClick={onBack} variant="ghost" className="md:hidden" /> : null}
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-[15px] font-semibold">{c.contact.name ?? c.contact.handle ?? 'Customer'}</h2>
          <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted">
            <span>{CHANNEL_LABEL[c.channel.kind]} · {KIND_LABEL[c.kind]}</span>
            <Badge tone={c.visibility === 'public' ? 'info' : 'neutral'} className="h-5 px-1.5 text-[11px]">{c.visibility === 'public' ? 'Public' : 'Private'}</Badge>
            {c.channel.is_simulated ? <SimulatedBadge /> : null}
            {c.status !== 'open' ? <Badge tone="neutral" className="h-5 px-1.5 text-[11px]">{STATUS_LABEL[c.status]}</Badge> : null}
          </p>
        </div>
        {c.reply.can_assign ? (
          <Menu>
            <MenuTrigger asChild><Button size="sm" variant="ghost" aria-label={`Assignee: ${personName(c.assignee)}`} icon={<UserRound aria-hidden className="size-4" />}><span className="max-w-[8rem] truncate max-sm:sr-only">{personName(c.assignee)}</span><ChevronDown aria-hidden className="size-3.5" /></Button></MenuTrigger>
            <MenuContent>
              <MenuLabel>Assign to</MenuLabel>
              {me ? <MenuItem onSelect={() => act(() => api.post(`/api/inbox/conversations/${id}/assign`, { assignee_id: me }), 'Assigned to you')}>Me</MenuItem> : null}
              {(assignees.data?.items ?? []).filter((p) => p.id !== me).slice(0, 12).map((p) => (
                <MenuItem key={p.id} onSelect={() => act(() => api.post(`/api/inbox/conversations/${id}/assign`, { assignee_id: p.id }), `Assigned to ${personName(p)}`)}>{personName(p)}</MenuItem>
              ))}
              <MenuSeparator />
              <MenuItem onSelect={() => act(() => api.post(`/api/inbox/conversations/${id}/assign`, { assignee_id: null }), 'Unassigned')}>Unassign</MenuItem>
            </MenuContent>
          </Menu>
        ) : null}
        {c.reply.can_reply ? (
          c.status === 'resolved' || c.status === 'spam'
            ? <Button size="sm" variant="secondary" icon={<RotateCcw aria-hidden className="size-4" />} onClick={() => setStatus('open')}>Reopen</Button>
            : <Button size="sm" variant="secondary" icon={<CheckCircle2 aria-hidden className="size-4" />} onClick={() => setStatus('resolved')}><span className="max-sm:sr-only">Resolve</span></Button>
        ) : null}
        <Menu>
          <MenuTrigger asChild><IconButton label="More actions" icon={<MoreHorizontal className="size-4" />} variant="ghost" /></MenuTrigger>
          <MenuContent>
            {c.reply.can_reply ? (
              <>
                <MenuItem icon={<Users aria-hidden className="size-4" />} onSelect={() => setStatus('waiting')}>Waiting on customer</MenuItem>
                <MenuItem icon={<AlarmClock aria-hidden className="size-4" />} onSelect={() => setStatus('snoozed', { snoozed_until: new Date(Date.now() + 3600_000).toISOString() })}>Snooze 1 hour</MenuItem>
                <MenuItem icon={<AlarmClock aria-hidden className="size-4" />} onSelect={() => setStatus('snoozed', { snoozed_until: tomorrow9() })}>Snooze until tomorrow 9:00</MenuItem>
                <MenuItem icon={<ShieldAlert aria-hidden className="size-4" />} onSelect={() => setStatus('spam')}>Mark as spam</MenuItem>
                <MenuSeparator />
              </>
            ) : null}
            {onDetails ? <MenuItem icon={<Info aria-hidden className="size-4" />} onSelect={onDetails}>Customer and case</MenuItem> : null}
          </MenuContent>
        </Menu>
        {onDetails ? <Button size="sm" variant="ghost" className="2xl:hidden max-sm:hidden" onClick={onDetails}>Details</Button> : null}
      </header>

      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto px-3 py-4 sm:px-4" aria-live="polite">
        {c.has_more ? <p className="mb-3 text-center text-xs text-subtle">Older messages are not shown</p> : null}
        <ConversationTimeline entries={entries} />
      </div>

      <div className="sticky bottom-[calc(64px+env(safe-area-inset-bottom))] border-t border-border bg-surface px-3 py-3 sm:px-4 md:static">
        <ConversationComposer modes={modes} mode={mode} onModeChange={setMode} body={body} onBodyChange={(v) => { if (!body.trim() && v.trim()) setComposeBase(c.version); if (!v.trim()) setComposeBase(null); setBody(v); }}
          busy={busy} onSubmit={() => void send()}
          banner={conflict ? (
            <Banner tone="warn" title={conflict.reason === 'reply_collision' ? 'Someone else replied' : 'New messages arrived'}>
              <ul className="mt-1 text-[13px]">
                {conflict.changes.slice(0, 3).map((x, i) => <li key={i}>{x.by ?? 'Someone'} · {x.kind === 'customer_message' ? 'customer message' : x.kind === 'pending_reply' ? `sending (${ATTEMPT_LABEL[x.state ?? 'queued']})` : 'replied'} · {new Date(x.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</li>)}
              </ul>
              <div className="mt-2 flex gap-2">
                <Button size="sm" variant="secondary" onClick={() => { setConflict(null); setComposeBase(conflict.current_version); }}>Reviewed</Button>
                {!conflict.changes.some((x) => x.kind === 'pending_reply') ? <Button size="sm" variant="primary" onClick={() => void send(conflict.current_version)}>Send anyway</Button> : null}
              </div>
            </Banner>
          ) : composing.length ? (
            <p className="flex items-center gap-1.5 text-xs text-warn"><Users aria-hidden className="size-3.5" />{composing.map((p) => personName(p.user)).join(', ')} {composing.length > 1 ? 'are' : 'is'} writing a reply</p>
          ) : null} />
      </div>
    </div>
  );
}

export function useConversationPatch(id: string) {
  return (patch: Record<string, unknown>) => api.patch(`/api/inbox/conversations/${id}`, patch);
}
