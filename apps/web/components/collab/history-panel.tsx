'use client';
// Version history: paginated versions (author, time, change summary), submitted revisions with their review decisions and
// publication links, and a lazy comparison of any version (or submitted revision) against the current draft — base text,
// per-network text, media, links, destinations, publishing options and scheduling. Restoring makes a NEW version; old
// approvals are never restored and history is never rewritten.
import { useEffect, useState } from 'react';
import { ExternalLink, GitCompare, History, MessageSquare, RotateCcw } from 'lucide-react';
import { PROVIDER_LABEL, type Provider } from '@social-lite/core';
import { api } from '@/lib/client/api';
import { useApi } from '@/lib/client/use-api';
import { diffWords } from '@/lib/client/diff';
import { fmtDateTime, fmtRelative } from '@/lib/client/format';
import { Badge, Button, ConfirmDialog, EmptyState, ErrorNotice, PlatformIcon, Skeleton, cn, useToast } from '@/components/ui';
import type { CompareDto, HistoryItem, HistoryPage } from './types';

export function DiffText({ before, after }: { before: string; after: string }) {
  return (
    <p className="whitespace-pre-wrap break-words rounded-lg bg-sunken px-3 py-2.5 text-[13px] leading-relaxed">
      {diffWords(before, after).map((p, i, all) =>
        p.kind === 'same' ? <span key={i}>{p.text}</span>
          : p.kind === 'add' && all[i - 1]?.kind === 'del' ? <span key={i}><span aria-hidden> </span><ins className="rounded bg-success-soft text-success no-underline"><span className="sr-only">[added: </span>{p.text}<span className="sr-only">]</span></ins></span>
          : p.kind === 'add' ? <ins key={i} className="rounded bg-success-soft text-success no-underline"><span className="sr-only">[added: </span>{p.text}<span className="sr-only">]</span></ins>
            : <del key={i} className="rounded bg-danger-soft text-danger"><span className="sr-only">[removed: </span>{p.text}<span className="sr-only">]</span></del>)}
    </p>
  );
}

const KIND: Record<string, { label: string; tone: 'neutral' | 'warn' | 'info' | 'success' }> = {
  created: { label: 'Created', tone: 'neutral' }, saved: { label: 'Saved', tone: 'neutral' }, conflict: { label: 'Unsaved copy', tone: 'warn' },
  restored: { label: 'Restored', tone: 'info' }, recovered: { label: 'Recovered', tone: 'info' },
};
const DECISION: Record<string, { label: string; tone: 'neutral' | 'warn' | 'info' | 'success' | 'danger' }> = {
  pending: { label: 'Waiting for review', tone: 'info' }, approved: { label: 'Approved', tone: 'success' }, rejected: { label: 'Changes requested', tone: 'danger' },
  invalidated: { label: 'Reset', tone: 'warn' },
};

export function HistoryPanel({ postId, version, canEdit, onRestored, highlight, tall, currentText: _ct }: {
  postId: string; version: number; canEdit: boolean; onRestored: () => Promise<void> | void; highlight?: string | null; tall?: boolean; currentText?: string;
}) {
  const toast = useToast();
  const { data, error, loading, refetch } = useApi<HistoryPage>(`/api/posts/${postId}/history?v=${version}`);
  const [extra, setExtra] = useState<HistoryItem[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [sel, setSel] = useState<string | null>(highlight ?? null);
  const [restore, setRestore] = useState<HistoryItem | null>(null);
  useEffect(() => { if (data) { setExtra([]); setNext(data.next_cursor); } }, [data]);
  useEffect(() => { if (highlight) setSel(highlight); }, [highlight]);
  if (error && !data) return <ErrorNotice error={error} />;
  if (loading || !data) return <Skeleton className="h-40 w-full rounded-lg" />;
  const items = [...data.items, ...extra];
  if (!items.length) return <EmptyState compact icon={<History aria-hidden />} title="No history yet" />;
  const picked = items.find((v) => v.id === sel) ?? null;
  const pickedRevision = sel?.startsWith('revision:') ? data.revisions.find((r) => `revision:${r.id}` === sel) ?? null : null;

  return (
    <div className="flex flex-col gap-4">
      <ul className={cn('flex flex-col overflow-y-auto', tall ? 'max-h-[45dvh]' : 'max-h-[320px]')} aria-label="Versions">
        {items.map((v) => {
          const k = KIND[v.kind] ?? KIND.saved!;
          return (
            <li key={v.id}>
              <button type="button" onClick={() => setSel(v.id === sel ? null : v.id)} aria-pressed={v.id === sel}
                className={cn('flex w-full flex-col gap-0.5 rounded-md px-2 py-2 text-left hover:bg-raised', v.id === sel && 'bg-raised')}>
                <span className="flex w-full items-center gap-2 text-[13px]">
                  <span className="w-9 shrink-0 tabular text-xs text-muted">{v.version ? `v${v.version}` : '—'}</span>
                  <span className="min-w-0 flex-1 truncate">{v.author?.name || v.author?.email || 'Someone'}</span>
                  {v.current ? <Badge tone="success">Current</Badge> : <Badge tone={k.tone}>{k.label}</Badge>}
                </span>
                <span className="flex items-center gap-2 pl-11 text-xs text-muted">
                  <span className="min-w-0 flex-1 truncate">{v.summary}</span>
                  {v.open_threads ? <span className="inline-flex items-center gap-1" title="Open discussions started on this version"><MessageSquare aria-hidden className="size-3" />{v.open_threads}</span> : null}
                  <span className="shrink-0 text-subtle">{fmtRelative(v.created_at)}</span>
                </span>
              </button>
            </li>
          );
        })}
        {next ? (
          <li className="pt-1"><Button size="sm" variant="ghost" onClick={async () => { const r = await api.get<HistoryPage>(`/api/posts/${postId}/history?cursor=${encodeURIComponent(next)}`); setExtra((l) => [...l, ...r.items]); setNext(r.next_cursor); }}>Load older versions</Button></li>
        ) : null}
      </ul>

      {data.revisions.length ? (
        <section aria-label="Submitted versions" className="flex flex-col gap-2">
          <h3 className="text-xs font-medium text-muted">Submitted for review or scheduled</h3>
          <ul className="flex flex-col gap-2">
            {data.revisions.slice(0, 6).map((r) => (
              <li key={r.id} className="rounded-md border border-border px-2.5 py-2 text-xs">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="font-medium text-fg">r{r.revision_number}</span>
                  {r.post_version ? <span className="text-muted">from v{r.post_version}</span> : null}
                  {r.older_than_current ? <Badge tone="neutral">Older than current</Badge> : null}
                  {r.approvals.slice(0, 1).map((a) => <Badge key={a.id} tone={DECISION[a.decision]?.tone ?? 'neutral'}>{DECISION[a.decision]?.label ?? a.decision}{a.applies_to_current ? '' : a.decision === 'approved' ? ' (earlier version)' : ''}</Badge>)}
                  <span className="flex-1" />
                  <button type="button" className="text-[var(--accent-text)] underline-offset-2 hover:underline" onClick={() => setSel(`revision:${r.id}`)}>Compare</button>
                </div>
                {r.approvals[0]?.reason ? <p className="mt-1 text-muted">“{r.approvals[0].reason}”</p> : null}
                {r.publications.length ? (
                  <ul className="mt-1 flex flex-wrap gap-2">
                    {r.publications.map((p, i) => (
                      <li key={i} className="inline-flex items-center gap-1 text-muted">
                        <PlatformIcon provider={p.provider as Provider} size="xs" decorative className="size-4 rounded-[4px] [&>svg]:size-2.5" />
                        {p.url ? <a href={p.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-0.5 underline">{p.account}<ExternalLink aria-hidden className="size-3" /></a> : <span>{p.account}</span>}
                        {p.simulated ? <span>(simulated)</span> : null}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {picked || pickedRevision ? (
        <Comparison postId={postId} from={sel!} label={picked ? (picked.version ? `v${picked.version}` : 'Unsaved copy') : `r${pickedRevision!.revision_number}`}
          canRestore={canEdit && data.can_restore && !!picked && !picked.current} onRestore={() => picked && setRestore(picked)} />
      ) : <p className="text-xs text-muted">Choose a version to compare it with the current draft.</p>}

      <ConfirmDialog
        open={!!restore}
        onOpenChange={(o) => !o && setRestore(null)}
        title="Restore this version?"
        description="It becomes a new version of the draft. Nothing is deleted, and earlier approvals don’t carry over."
        confirmLabel="Restore as new version"
        onConfirm={async () => {
          await api.post(`/api/posts/${postId}/versions/${restore!.id}/restore`, { expected_version: data.current_version });
          toast.success('Restored as a new version');
          setSel(null);
          await refetch();
          await onRestored();
        }}
      />
    </div>
  );
}

function Comparison({ postId, from, label, canRestore, onRestore }: { postId: string; from: string; label: string; canRestore: boolean; onRestore: () => void }) {
  const { data, error, loading } = useApi<CompareDto>(`/api/posts/${postId}/compare?from=${encodeURIComponent(from)}&to=current`);
  if (error) return <ErrorNotice error={error} />;
  if (loading || !data) return <Skeleton className="h-32 w-full rounded-lg" />;
  const thumb = (id: string) => data.assets.find((a) => a.id === id);
  return (
    <section aria-label={`Compare ${label} with current`} aria-live="polite" className="flex flex-col gap-3" data-testid="version-compare">
      <div className="flex flex-wrap items-center gap-2">
        <p className="flex items-center gap-1.5 text-xs text-muted"><GitCompare aria-hidden className="size-3.5" /> {data.from.label} → {data.to.label} · {data.summary}</p>
        <span className="flex-1" />
        {canRestore ? <Button size="sm" variant="secondary" icon={<RotateCcw aria-hidden className="size-4" />} onClick={onRestore}>Restore this</Button> : null}
      </div>
      {data.title.before !== data.title.after ? <Row label="Title"><DiffText before={data.title.before} after={data.title.after} /></Row> : null}
      <Row label="Text"><DiffText before={data.text.before} after={data.text.after} /></Row>
      {data.link.before !== data.link.after ? <Row label="Link"><p className="break-all text-[13px]"><del className="text-danger">{data.link.before ?? 'none'}</del> → <ins className="text-success no-underline">{data.link.after ?? 'none'}</ins></p></Row> : null}
      {JSON.stringify(data.media.before) !== JSON.stringify(data.media.after) ? (
        <Row label="Media">
          <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted">
            {data.media.before.map((id) => <Thumb key={`b${id}`} a={thumb(id)} removed={!data.media.after.includes(id)} />)}
            <span aria-hidden>→</span>
            {data.media.after.map((id) => <Thumb key={`a${id}`} a={thumb(id)} added={!data.media.before.includes(id)} />)}
            {!data.media.after.length ? <span>none</span> : null}
          </div>
        </Row>
      ) : null}
      {data.destinations.added.length || data.destinations.removed.length ? (
        <Row label="Destinations">
          <p className="text-[13px]">
            {data.destinations.added.length ? <span className="text-success">+{data.destinations.added.length} added </span> : null}
            {data.destinations.removed.length ? <span className="text-danger">−{data.destinations.removed.length} removed</span> : null}
          </p>
        </Row>
      ) : null}
      {data.variants.filter((v) => v.changed).map((v) => (
        <Row key={v.connection_id} label={<span className="inline-flex items-center gap-1">{v.provider ? <PlatformIcon provider={v.provider as Provider} size="xs" decorative className="size-4 rounded-[4px] [&>svg]:size-2.5" /> : null}{v.provider ? PROVIDER_LABEL[v.provider as Provider] : ''} · {v.account}</span>}>
          {v.before_text === null ? <p className="text-xs text-success">Added</p> : v.after_text === null ? <p className="text-xs text-danger">Removed</p> : (
            v.before_text !== v.after_text ? <DiffText before={v.before_text} after={v.after_text} /> : null
          )}
          {v.options_changed.length ? <p className="mt-1 text-xs text-muted">Publishing options changed: {v.options_changed.join(', ')}</p> : null}
          {v.link_before !== v.link_after ? <p className="mt-1 break-all text-xs text-muted">Link: {v.link_before ?? 'none'} → {v.link_after ?? 'none'}</p> : null}
        </Row>
      ))}
      {data.from.schedule || data.to.schedule ? (
        <Row label="Schedule">
          <p className="text-[13px]">{data.from.schedule ? (data.from.schedule.due_at ? fmtDateTime(data.from.schedule.due_at, data.from.schedule.timezone) : 'On approval') : '—'} → {data.to.schedule ? (data.to.schedule.due_at ? fmtDateTime(data.to.schedule.due_at, data.to.schedule.timezone) : 'On approval') : 'not scheduled from the draft'}</p>
        </Row>
      ) : null}
    </section>
  );
}

function Row({ label, children }: { label: React.ReactNode; children: React.ReactNode }) {
  return <div className="flex flex-col gap-1"><p className="text-xs font-medium text-muted">{label}</p>{children}</div>;
}

function Thumb({ a, added, removed }: { a?: { thumb_url: string | null; alt_text: string | null }; added?: boolean; removed?: boolean }) {
  return (
    <span className={cn('relative inline-block size-10 overflow-hidden rounded-md border', added ? 'border-success' : removed ? 'border-danger opacity-60' : 'border-border')}>
      {a?.thumb_url ? <img src={a.thumb_url} alt={a.alt_text ?? ''} className="size-full object-cover" loading="lazy" /> : <span className="block size-full bg-sunken" />}
      <span className="sr-only">{added ? 'added' : removed ? 'removed' : 'unchanged'}</span>
    </span>
  );
}
