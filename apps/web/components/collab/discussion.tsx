'use client';
// Discussion: threads on a post (or one review request). Internal threads = team only; shared threads = also client
// reviewers the review was shared with. Replies, resolve/reopen, edit (with history) and delete (tombstone), unread dots,
// anchors to selected text / an earlier version, deep links (?thread=), explicit visibility change with a count to confirm.
// A comment never approves anything — approvals happen only in Review.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, CornerDownRight, Ellipsis, Eye, History, Lock, MessageSquare, Pencil, Quote, RotateCcw, Trash2, Users } from 'lucide-react';
import { api, isApiError } from '@/lib/client/api';
import { useApi } from '@/lib/client/use-api';
import { newClientKey } from '@/lib/client/collab';
import { fmtRelative } from '@/lib/client/format';
import {
  Badge, Button, ConfirmDialog, Dialog, EmptyState, ErrorNotice, IconButton, InfoTip, Menu, MenuContent, MenuItem, MenuTrigger, Segmented, Skeleton, cn, useToast,
} from '@/components/ui';
import { CommentBody, MentionTextarea, decodeMentions, encodeMentions, type MentionTextareaHandle } from './comment-text';
import type { People, ThreadAnchor, ThreadComment, ThreadDto, ThreadList } from './types';

type Vis = 'internal' | 'shared';

const ANCHOR_LABEL: Record<ThreadDto['anchor_status'], string | null> = {
  none: null, current: null, moved: 'From', outdated: 'Outdated',
};

export interface DiscussionProps {
  postId: string;
  approvalId?: string | null;
  /** thread to open + highlight (deep link) */
  focusThread?: string | null;
  /** bump to refetch (realtime events) */
  refreshKey?: number;
  /** a text selection the user can attach to a new thread */
  selection?: ThreadAnchor | null;
  onClearSelection?: () => void;
  onCounts?: (c: { open: number; unread: number }) => void;
  onCursor?: (cursor: number) => void;
}

export function Discussion({ postId, approvalId, focusThread, refreshKey = 0, selection, onClearSelection, onCounts, onCursor }: DiscussionProps) {
  const [status, setStatus] = useState<'open' | 'resolved'>('open');
  const base = `/api/posts/${postId}/threads?status=${status}${approvalId ? `&approval_id=${approvalId}` : ''}`;
  const { data, error, loading, refetch, setData } = useApi<ThreadList>(base, { keepPrevious: true });
  const [extra, setExtra] = useState<ThreadDto[]>([]);
  const [more, setMore] = useState<string | null>(null);
  const [focused, setFocused] = useState<ThreadDto | null>(null);
  const [people, setPeople] = useState<People>({});

  useEffect(() => { if (refreshKey) void refetch(); }, [refreshKey, refetch]);
  useEffect(() => {
    if (!data) return;
    setExtra([]); setMore(data.next_cursor);
    setPeople((p) => ({ ...p, ...data.people }));
    onCounts?.({ open: data.counts.open, unread: data.counts.unread });
    onCursor?.(data.cursor);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  // Deep link: make sure the thread is shown even when it is not on the first page (or is resolved).
  useEffect(() => {
    if (!focusThread || !data) return;
    if (data.items.some((t) => t.id === focusThread)) { setFocused(null); return; }
    let live = true;
    api.get<{ thread: ThreadDto; people: People }>(`/api/threads/${focusThread}`).then((r) => {
      if (!live) return;
      setFocused(r.thread); setPeople((p) => ({ ...p, ...r.people }));
    }).catch(() => undefined);
    return () => { live = false; };
  }, [focusThread, data]);
  useEffect(() => {
    if (!focusThread) return;
    const t = setTimeout(() => {
      const el = document.getElementById(`thread-${focusThread}`);
      if (el) { el.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }); el.focus({ preventScroll: true }); }
    }, 250);
    return () => clearTimeout(t);
  }, [focusThread, focused, data]);

  const threads = useMemo(() => {
    const list = [...(focused ? [focused] : []), ...(data?.items ?? []), ...extra];
    const seen = new Set<string>();
    return list.filter((t) => (seen.has(t.id) ? false : (seen.add(t.id), true)));
  }, [data, extra, focused]);

  // Mark what is on screen as read (after a short dwell), once per load.
  const unreadIds = threads.filter((t) => t.unread).map((t) => t.id).join(',');
  useEffect(() => {
    if (!unreadIds) return;
    const t = setTimeout(() => {
      void api.post(`/api/posts/${postId}/threads/read`, { thread_ids: unreadIds.split(',') }).then(() => {
        setData((d) => d ? { ...d, items: d.items.map((x) => ({ ...x, unread: false })), counts: { ...d.counts, unread: 0 } } : d!);
        onCounts?.({ open: data?.counts.open ?? 0, unread: 0 });
      }).catch(() => undefined);
    }, 1500);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unreadIds, postId]);

  const replace = useCallback((t: ThreadDto, p?: People) => {
    if (p) setPeople((x) => ({ ...x, ...p }));
    setData((d) => d ? { ...d, items: d.items.map((x) => (x.id === t.id ? t : x)) } : d!);
    setExtra((l) => l.map((x) => (x.id === t.id ? t : x)));
    setFocused((f) => (f?.id === t.id ? t : f));
  }, [setData]);

  if (error && !data) return <ErrorNotice error={error} />;
  if (loading && !data) return <div className="flex flex-col gap-3"><Skeleton className="h-24 w-full rounded-lg" /><Skeleton className="h-16 w-full rounded-lg" /></div>;
  if (!data) return null;

  return (
    <div className="flex flex-col gap-4">
      {data.can.internal || data.can.shared ? (
        <NewThread postId={postId} approvalId={approvalId ?? null} can={data.can} selection={selection ?? null} onClearSelection={onClearSelection}
          onCreated={async (r) => { setPeople((p) => ({ ...p, ...r.people })); if (status !== 'open') setStatus('open'); await refetch(); }} />
      ) : null}
      <div className="flex items-center justify-between gap-2">
        <Segmented label="Show discussions" value={status} onChange={setStatus}
          options={[{ value: 'open', label: <>Open <span className="tabular text-muted">{data.counts.open}</span></> }, { value: 'resolved', label: <>Resolved <span className="tabular text-muted">{data.counts.resolved}</span></> }]} />
        <InfoTip label="About discussions">Internal: your team only. Shared: also clients you shared the review with. Comments never approve a post.</InfoTip>
      </div>
      {!threads.length ? (
        <EmptyState compact icon={<MessageSquare aria-hidden />} title={status === 'open' ? 'No open discussions' : 'Nothing resolved yet'} />
      ) : (
        <ul className="flex flex-col gap-3" aria-label={status === 'open' ? 'Open discussions' : 'Resolved discussions'}>
          {threads.map((t) => (
            <li key={t.id}>
              <ThreadCard thread={t} people={people} highlight={t.id === focusThread} onChanged={replace} onRemoved={() => void refetch()} />
            </li>
          ))}
        </ul>
      )}
      {more ? (
        <Button size="sm" variant="ghost" className="self-center" onClick={async () => {
          const r = await api.get<ThreadList>(`${base}&cursor=${encodeURIComponent(more)}`);
          setExtra((l) => [...l, ...r.items]); setMore(r.next_cursor); setPeople((p) => ({ ...p, ...r.people }));
        }}>Load more</Button>
      ) : null}
    </div>
  );
}

function NewThread({ postId, approvalId, can, selection, onClearSelection, onCreated }: {
  postId: string; approvalId: string | null; can: ThreadList['can']; selection: ThreadAnchor | null; onClearSelection?: () => void;
  onCreated: (r: { thread: ThreadDto; people: People }) => Promise<void>;
}) {
  const [vis, setVis] = useState<Vis>(can.internal ? 'internal' : 'shared');
  const [text, setText] = useState('');
  const [picked, setPicked] = useState(() => new Map<string, string>());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const key = useRef(newClientKey('t'));
  const effective: Vis = vis === 'internal' && !can.internal ? 'shared' : vis === 'shared' && !can.shared ? 'internal' : vis;
  const send = async () => {
    if (!text.trim() || busy) return;
    setBusy(true); setErr(null);
    try {
      const r = await api.post<{ thread: ThreadDto; people: People }>(`/api/posts/${postId}/threads`, {
        visibility: effective, body: encodeMentions(text.trim(), picked), anchor: selection ?? null, approval_id: approvalId, client_key: key.current,
      });
      setText(''); setPicked(new Map()); key.current = newClientKey('t'); onClearSelection?.();
      await onCreated(r);
    } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border p-3">
      {can.internal && can.shared ? (
        <Segmented label="Who can see this" value={effective} onChange={(v) => { setVis(v); }}
          options={[{ value: 'internal', label: <><Lock aria-hidden className="size-3.5" /> Internal</> }, { value: 'shared', label: <><Users aria-hidden className="size-3.5" /> Shared with client</> }]} />
      ) : null}
      {selection ? (
        <div className="flex items-start gap-2 rounded-md bg-sunken px-2.5 py-2 text-xs text-muted">
          <Quote aria-hidden className="mt-0.5 size-3.5 shrink-0" />
          <span className="line-clamp-2 min-w-0 flex-1">{selection.kind === 'text' ? `“${selection.quote}”` : 'Selected media'}</span>
          <button type="button" className="shrink-0 underline" onClick={onClearSelection}>Remove</button>
        </div>
      ) : null}
      <MentionTextarea id={`new-thread-${postId}`} value={text} onChange={setText} picked={picked} onPick={(l, id) => setPicked((m) => new Map(m).set(l, id))}
        searchUrl={`/api/posts/${postId}/mentions?visibility=${effective}`} label={effective === 'internal' ? 'New internal comment' : 'New shared comment'}
        placeholder={effective === 'internal' ? 'Comment for your team… Type @ to mention' : 'Visible to client reviewers… Type @ to mention'} onSubmit={() => void send()} />
      <div className="flex items-center justify-end gap-2">
        {err ? <ErrorNotice error={err} className="mr-auto" /> : null}
        <Button size="sm" variant="primary" onClick={() => void send()} loading={busy} disabledReason={!text.trim() ? 'Write something first.' : null}>Comment</Button>
      </div>
    </div>
  );
}

function ThreadCard({ thread: t, people, highlight, onChanged, onRemoved }: {
  thread: ThreadDto; people: People; highlight: boolean; onChanged: (t: ThreadDto, p?: People) => void; onRemoved: () => void;
}) {
  const toast = useToast();
  const [replying, setReplying] = useState(false);
  const [text, setText] = useState('');
  const [picked, setPicked] = useState(() => new Map<string, string>());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const [visConfirm, setVisConfirm] = useState<null | Vis>(null);
  const box = useRef<MentionTextareaHandle>(null);
  const key = useRef(newClientKey('r'));
  const anchorLabel = ANCHOR_LABEL[t.anchor_status];

  const reply = async () => {
    if (!text.trim() || busy) return;
    setBusy(true); setErr(null);
    try {
      const r = await api.post<{ thread: ThreadDto; people: People }>(`/api/threads/${t.id}/replies`, { body: encodeMentions(text.trim(), picked), client_key: key.current });
      setText(''); setPicked(new Map()); key.current = newClientKey('r'); setReplying(false);
      onChanged(r.thread, r.people);
    } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  const patch = async (body: Record<string, unknown>) => {
    try {
      const r = await api.patch<{ thread: ThreadDto; people: People }>(`/api/threads/${t.id}`, body);
      if ('resolved' in body) { toast.success(body.resolved ? 'Resolved' : 'Reopened'); onRemoved(); } else onChanged(r.thread, r.people);
    } catch (e) { toast.error(e, 'Couldn’t update the discussion'); throw e; }
  };
  const showAll = async () => {
    const r = await api.get<{ thread: ThreadDto; people: People }>(`/api/threads/${t.id}`);
    onChanged(r.thread, r.people);
  };
  const live = t.comments.filter((c) => !c.deleted).length;

  return (
    <article id={`thread-${t.id}`} tabIndex={-1} aria-label={`${t.visibility === 'internal' ? 'Internal' : 'Shared'} discussion`}
      className={cn('rounded-lg border px-3 py-2.5 outline-none', t.visibility === 'internal' ? 'border-border bg-sunken/60' : 'border-border', highlight && 'ring-2 ring-[var(--accent)]')}>
      <header className="mb-2 flex flex-wrap items-center gap-1.5 text-xs text-muted">
        {t.visibility === 'internal' ? <Badge tone="neutral" icon={<Lock aria-hidden className="size-3" />}>Internal</Badge> : <Badge tone="info" icon={<Users aria-hidden className="size-3" />}>Shared</Badge>}
        {t.revision_number ? <Badge tone="neutral">Review r{t.revision_number}</Badge> : null}
        {anchorLabel ? <Badge tone={t.anchor_status === 'outdated' ? 'warn' : 'neutral'}>{t.anchor_status === 'moved' ? `From v${t.anchor_version ?? '?'}` : `${anchorLabel}${t.anchor_version ? ` · v${t.anchor_version}` : ''}`}</Badge> : null}
        {t.resolved ? <Badge tone="success" icon={<Check aria-hidden className="size-3" />}>Resolved</Badge> : null}
        {t.unread ? <span className="inline-flex items-center gap-1 font-medium text-fg"><span aria-hidden className="size-2 rounded-full bg-[var(--accent)]" />New</span> : null}
        <span className="flex-1" />
        {t.can.resolve ? (
          <Button size="sm" variant="quiet" icon={t.resolved ? <RotateCcw aria-hidden className="size-3.5" /> : <Check aria-hidden className="size-3.5" />}
            onClick={() => void patch({ resolved: !t.resolved }).catch(() => undefined)}>{t.resolved ? 'Reopen' : 'Resolve'}</Button>
        ) : null}
        {t.can.change_visibility ? (
          <Menu>
            <MenuTrigger asChild><IconButton size="sm" label="Discussion options" icon={<Ellipsis aria-hidden className="size-4" />} /></MenuTrigger>
            <MenuContent>
              {t.visibility === 'internal'
                ? <MenuItem icon={<Eye aria-hidden />} onSelect={() => setVisConfirm('shared')}>Share with client…</MenuItem>
                : <MenuItem icon={<Lock aria-hidden />} onSelect={() => setVisConfirm('internal')}>Make internal…</MenuItem>}
            </MenuContent>
          </Menu>
        ) : null}
      </header>
      {t.anchor?.kind === 'text' ? (
        <blockquote className={cn('mb-2 border-l-2 pl-2 text-xs', t.anchor_status === 'outdated' ? 'border-warn text-muted line-through decoration-1' : 'border-[var(--accent)] text-muted')}>
          “{t.anchor.quote}”
        </blockquote>
      ) : t.anchor?.kind === 'media' ? <p className="mb-2 text-xs text-muted">On a media item{t.anchor_status === 'outdated' ? ' (removed since)' : ''}</p> : null}
      <ol className="flex flex-col gap-2.5">
        {t.comments.slice(0, 1).map((c) => <CommentItem key={c.id} c={c} people={people} onChanged={() => void showAll()} />)}
        {t.hidden_replies > 0 ? (
          <li><button type="button" className="text-xs font-medium text-[var(--accent-text)] underline-offset-2 hover:underline" onClick={() => void showAll()}>Show {t.hidden_replies} earlier repl{t.hidden_replies === 1 ? 'y' : 'ies'}</button></li>
        ) : null}
        {t.comments.slice(1).map((c) => <CommentItem key={c.id} c={c} people={people} reply onChanged={() => void showAll()} />)}
      </ol>
      {t.can.reply ? (
        replying ? (
          <div className="mt-2.5 flex flex-col gap-2">
            <MentionTextarea ref={box} id={`reply-${t.id}`} value={text} onChange={setText} picked={picked} onPick={(l, id) => setPicked((m) => new Map(m).set(l, id))}
              searchUrl={`/api/posts/${t.post_id}/mentions?visibility=${t.visibility}`} label="Reply" rows={2} placeholder="Reply… Type @ to mention" onSubmit={() => void reply()} />
            <div className="flex items-center justify-end gap-2">
              {err ? <ErrorNotice error={err} className="mr-auto" /> : null}
              <Button size="sm" variant="ghost" onClick={() => { setReplying(false); setText(''); }}>Cancel</Button>
              <Button size="sm" variant="primary" loading={busy} onClick={() => void reply()} disabledReason={!text.trim() ? 'Write something first.' : null}>Reply</Button>
            </div>
          </div>
        ) : (
          <Button size="sm" variant="ghost" className="mt-1.5" icon={<CornerDownRight aria-hidden className="size-4" />} onClick={() => { setReplying(true); requestAnimationFrame(() => box.current?.focus()); }}>Reply</Button>
        )
      ) : null}
      <ConfirmDialog
        open={!!visConfirm}
        onOpenChange={(o) => !o && setVisConfirm(null)}
        title={visConfirm === 'shared' ? 'Share this discussion with clients?' : 'Make this discussion internal?'}
        description={visConfirm === 'shared'
          ? `All ${live} comment${live === 1 ? '' : 's'} in it, including replies, become visible to client reviewers of this post.`
          : 'Client reviewers will no longer see it. Notifications they already received stay in their inbox.'}
        confirmLabel={visConfirm === 'shared' ? `Share ${live} comment${live === 1 ? '' : 's'}` : 'Make internal'}
        onConfirm={async () => {
          try { await patch({ visibility: visConfirm, confirm_count: live }); }
          catch (e) { if (isApiError(e) && e.code === 'conflict') { await showAll(); } throw e; }
        }}
      />
    </article>
  );
}

function CommentItem({ c, people, reply, onChanged }: { c: ThreadComment; people: People; reply?: boolean; onChanged: () => void }) {
  const toast = useToast();
  const [editing, setEditing] = useState<null | { text: string; picked: Map<string, string> }>(null);
  const [busy, setBusy] = useState(false);
  const [del, setDel] = useState(false);
  const [hist, setHist] = useState<null | Array<{ body: string; replaced_at: string }>>(null);
  const who = c.author ? (c.author.name || c.author.email || 'Someone') : 'Former member';
  if (c.deleted) {
    return <li className={cn('text-xs italic text-subtle', reply && 'pl-4')}>Comment deleted</li>;
  }
  const save = async () => {
    if (!editing) return;
    setBusy(true);
    try {
      await api.patch(`/api/comments/${c.id}`, { body: encodeMentions(editing.text.trim(), editing.picked) });
      setEditing(null); onChanged();
    } catch (e) { toast.error(e, 'Couldn’t save the edit'); } finally { setBusy(false); }
  };
  return (
    <li className={cn('flex flex-col gap-1', reply && 'border-l border-border pl-3')}>
      <div className="flex items-center gap-2 text-xs text-muted">
        <span className="truncate font-medium text-fg" title={c.author?.email ?? undefined}>{who}</span>
        <time dateTime={c.created_at}>{fmtRelative(c.created_at)}</time>
        {c.edited ? <button type="button" className="underline-offset-2 hover:underline" onClick={async () => setHist((await api.get<{ items: Array<{ body: string; replaced_at: string }> }>(`/api/comments/${c.id}/history`)).items)}>Edited</button> : null}
        <span className="flex-1" />
        {c.can_edit || c.can_delete ? (
          <Menu>
            <MenuTrigger asChild><IconButton size="sm" label="Comment options" icon={<Ellipsis aria-hidden className="size-3.5" />} /></MenuTrigger>
            <MenuContent>
              {c.can_edit ? <MenuItem icon={<Pencil aria-hidden />} onSelect={() => setEditing(decodeMentions(c.body ?? '', people))}>Edit</MenuItem> : null}
              {c.edited ? <MenuItem icon={<History aria-hidden />} onSelect={async () => setHist((await api.get<{ items: Array<{ body: string; replaced_at: string }> }>(`/api/comments/${c.id}/history`)).items)}>Edit history</MenuItem> : null}
              {c.can_delete ? <MenuItem icon={<Trash2 aria-hidden />} danger onSelect={() => setDel(true)}>Delete</MenuItem> : null}
            </MenuContent>
          </Menu>
        ) : null}
      </div>
      {editing ? (
        <div className="flex flex-col gap-2">
          <MentionTextarea id={`edit-${c.id}`} value={editing.text} onChange={(v) => setEditing((e) => e && { ...e, text: v })} picked={editing.picked}
            onPick={(l, id) => setEditing((e) => e && { ...e, picked: new Map(e.picked).set(l, id) })}
            searchUrl={`/api/posts/${c.post_id}/mentions?visibility=${c.visibility}`} label="Edit comment" rows={2} onSubmit={() => void save()} />
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
            <Button size="sm" variant="primary" loading={busy} onClick={() => void save()} disabledReason={!editing.text.trim() ? 'Write something first.' : null}>Save</Button>
          </div>
        </div>
      ) : <CommentBody body={c.body ?? ''} people={people} />}
      <ConfirmDialog open={del} onOpenChange={setDel} title="Delete this comment?" description="Its text and edit history are removed. A placeholder stays in the discussion."
        confirmLabel="Delete" confirmVariant="danger" onConfirm={async () => { await api.del(`/api/comments/${c.id}`); onChanged(); }} />
      <Dialog open={!!hist} onOpenChange={(o) => !o && setHist(null)} title="Edit history">
        <ol className="flex flex-col gap-3">
          <li><p className="mb-1 text-xs text-muted">Current</p><CommentBody body={c.body ?? ''} people={people} className="rounded-md bg-sunken px-2.5 py-2" /></li>
          {(hist ?? []).map((h, i) => (
            <li key={i}><p className="mb-1 text-xs text-muted">Before {fmtRelative(h.replaced_at)}</p><CommentBody body={h.body} people={people} className="rounded-md bg-sunken px-2.5 py-2" /></li>
          ))}
        </ol>
      </Dialog>
    </li>
  );
}
