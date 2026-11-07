'use client';
import { useState } from 'react';
import { AtSign, Lock, MessageSquare, Trash2, Users, X } from 'lucide-react';
import { api } from '@/lib/client/api';
import { useApi } from '@/lib/client/use-api';
import { fmtRelative } from '@/lib/client/format';
import { Badge, Button, EmptyState, ErrorNotice, IconButton, Popover, PopoverContent, PopoverTrigger, Segmented, Skeleton, Textarea, cn } from '@/components/ui';
import type { CommentDto } from './types';

type Vis = 'internal' | 'shared';

/** Staff comments: internal notes (team only) and shared comments (also visible to shared client guests). */
export function CommentsPanel({ postId, approvalId }: { postId: string; approvalId?: string }) {
  const { data, error, loading, refetch } = useApi<{ items: CommentDto[]; can: { internal: boolean; shared: boolean } }>(`/api/posts/${postId}/comments`, { poll: 30_000 });
  const [vis, setVis] = useState<Vis>('internal');
  const [body, setBody] = useState('');
  const [mentions, setMentions] = useState<Array<{ id: string; label: string }>>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const candidates = useApi<{ items: Array<{ id: string; email: string; name: string | null; guest: boolean }> }>(`/api/posts/${postId}/mentions?visibility=${vis}`);

  if (error && !data) return <ErrorNotice error={error} />;
  if (loading || !data) return <Skeleton className="h-40 w-full rounded-lg" />;
  const effective: Vis = vis === 'internal' && !data.can.internal ? 'shared' : vis;
  const canPost = effective === 'internal' ? data.can.internal : data.can.shared;

  const send = async () => {
    setBusy(true); setErr(null);
    try {
      await api.post(`/api/posts/${postId}/comments`, { body: body.trim(), visibility: effective, mention_user_ids: mentions.map((m) => m.id), approval_id: approvalId ?? null });
      setBody(''); setMentions([]);
      await refetch();
    } catch (e) { setErr(e); } finally { setBusy(false); }
  };

  return (
    <div className="flex flex-col gap-3">
      {data.items.length === 0 ? <EmptyState compact icon={<MessageSquare aria-hidden />} title="No comments" /> : (
        <ul className="flex max-h-[420px] flex-col gap-3 overflow-y-auto" aria-label="Comments">
          {data.items.map((c) => (
            <li key={c.id} className={cn('rounded-lg px-3 py-2', c.visibility === 'internal' ? 'bg-sunken' : 'border border-border')}>
              <div className="mb-1 flex items-center gap-2 text-xs text-muted">
                <span className="truncate font-medium text-fg">{c.author?.name || c.author?.email || 'Someone'}</span>
                {c.visibility === 'internal' ? <Badge tone="neutral" icon={<Lock aria-hidden className="size-3" />}>Internal</Badge> : <Badge tone="info" icon={<Users aria-hidden className="size-3" />}>Shared</Badge>}
                <span className="ml-auto shrink-0">{fmtRelative(c.created_at)}</span>
                {c.mine ? <IconButton label="Delete comment" size="sm" icon={<Trash2 aria-hidden className="size-3.5" />} onClick={async () => { await api.del(`/api/comments/${c.id}`); await refetch(); }} /> : null}
              </div>
              <p className="whitespace-pre-wrap break-words text-[13px]">{c.body}</p>
            </li>
          ))}
        </ul>
      )}
      {data.can.internal || data.can.shared ? (
        <div className="flex flex-col gap-2">
          {data.can.internal && data.can.shared ? (
            <Segmented label="Comment visibility" value={effective} onChange={(v) => { setVis(v); setMentions([]); }}
              options={[{ value: 'internal', label: 'Internal' }, { value: 'shared', label: 'Shared' }]} />
          ) : null}
          <label htmlFor={`c-${postId}`} className="sr-only">{effective === 'internal' ? 'Internal note' : 'Shared comment'}</label>
          <Textarea id={`c-${postId}`} value={body} onChange={(e) => setBody(e.target.value)} rows={3} maxLength={5000}
            placeholder={effective === 'internal' ? 'Internal note — team only' : 'Visible to shared client reviewers'} />
          <div className="flex flex-wrap items-center gap-1.5">
            {mentions.map((m) => (
              <span key={m.id} className="inline-flex items-center gap-1 rounded-full bg-raised px-2 py-0.5 text-xs">
                @{m.label}
                <button type="button" aria-label={`Remove mention ${m.label}`} onClick={() => setMentions((l) => l.filter((x) => x.id !== m.id))}><X aria-hidden className="size-3" /></button>
              </span>
            ))}
            <Popover>
              <PopoverTrigger asChild><Button size="sm" variant="ghost" icon={<AtSign aria-hidden className="size-4" />}>Mention</Button></PopoverTrigger>
              <PopoverContent label="Mention someone" align="start">
                <ul className="max-h-56 overflow-y-auto py-1">
                  {(candidates.data?.items ?? []).filter((p) => !mentions.some((m) => m.id === p.id)).map((p) => (
                    <li key={p.id}>
                      <button type="button" className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[13px] hover:bg-raised"
                        onClick={() => setMentions((l) => [...l, { id: p.id, label: p.name || p.email }])}>
                        <span className="truncate">{p.name || p.email}</span>{p.guest ? <Badge tone="info">Client</Badge> : null}
                      </button>
                    </li>
                  ))}
                  {candidates.data && !candidates.data.items.length ? <li className="px-2 py-1.5 text-xs text-muted">Nobody else can see this</li> : null}
                </ul>
              </PopoverContent>
            </Popover>
            <span className="flex-1" />
            <Button size="sm" variant="primary" onClick={send} loading={busy} disabledReason={!body.trim() ? 'Write something first.' : !canPost ? 'You can’t post this kind of comment.' : null}>Post</Button>
          </div>
          {err ? <ErrorNotice error={err} /> : null}
        </div>
      ) : null}
    </div>
  );
}
