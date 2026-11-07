'use client';
import { useState } from 'react';
import { GitCompare, History, RotateCcw } from 'lucide-react';
import { api } from '@/lib/client/api';
import { useApi } from '@/lib/client/use-api';
import { diffWords } from '@/lib/client/diff';
import { fmtRelative } from '@/lib/client/format';
import { Badge, Button, ConfirmDialog, EmptyState, ErrorNotice, Skeleton, cn, useToast } from '@/components/ui';
import type { VersionDto } from './types';

interface History { current_version: number; versions: VersionDto[]; revisions: Array<{ id: string; revision_number: number; created_at: string; created_by_email: string | null; schedule_statuses: string[] }> }

const KIND: Record<VersionDto['kind'], { label: string; tone: 'neutral' | 'warn' | 'info' | 'success' }> = {
  created: { label: 'Created', tone: 'neutral' }, saved: { label: 'Saved', tone: 'neutral' },
  conflict: { label: 'Unsaved copy', tone: 'warn' }, restored: { label: 'Restored', tone: 'info' },
  recovered: { label: 'Recovered', tone: 'info' },
};

export function DiffText({ before, after }: { before: string; after: string }) {
  return (
    <p className="whitespace-pre-wrap break-words rounded-lg bg-sunken px-3 py-2.5 text-[13px] leading-relaxed">
      {diffWords(before, after).map((p, i) =>
        p.kind === 'same' ? <span key={i}>{p.text}</span>
          : p.kind === 'add' ? <ins key={i} className="rounded bg-success-soft text-success no-underline"><span className="sr-only">[added: </span>{p.text}<span className="sr-only">]</span></ins>
            : <del key={i} className="rounded bg-danger-soft text-danger"><span className="sr-only">[removed: </span>{p.text}<span className="sr-only">]</span></del>)}
    </p>
  );
}

/**
 * Version history: every save, restores and kept conflict copies ("Unsaved copy" = someone's edit that lost a
 * concurrent save — never discarded). Compare any version with the current draft and restore it explicitly.
 */
export function HistoryPanel({ postId, currentText, version, canEdit, onRestored, highlight, tall }: {
  postId: string; currentText: string; version: number; canEdit: boolean; onRestored: () => Promise<void> | void; highlight?: string | null;
  /** In the version-history drawer: no inner scroll cap. */
  tall?: boolean;
}) {
  const toast = useToast();
  const { data, error, loading, refetch } = useApi<History>(`/api/posts/${postId}/versions?v=${version}`);
  const [sel, setSel] = useState<string | null>(highlight ?? null);
  const [restore, setRestore] = useState<VersionDto | null>(null);
  if (error && !data) return <ErrorNotice error={error} />;
  if (loading || !data) return <Skeleton className="h-40 w-full rounded-lg" />;
  if (!data.versions.length) return <EmptyState compact icon={<History aria-hidden />} title="No history yet" />;
  const picked = data.versions.find((v) => v.id === (sel ?? highlight));
  return (
    <div className="flex flex-col gap-3">
      <ul className={cn('flex flex-col overflow-y-auto', tall ? 'max-h-[50dvh]' : 'max-h-[300px]')} aria-label="Versions">
        {data.versions.map((v) => {
          const k = KIND[v.kind];
          const current = v.version === data.current_version;
          return (
            <li key={v.id}>
              <button type="button" onClick={() => setSel(v.id === sel ? null : v.id)} aria-pressed={v.id === sel}
                className={cn('flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-raised', v.id === sel && 'bg-raised')}>
                <span className="w-9 shrink-0 tabular text-xs text-muted">{v.version ? `v${v.version}` : '—'}</span>
                <span className="min-w-0 flex-1 truncate">{v.saved_by_email ?? 'Someone'}</span>
                {current ? <Badge tone="success">Current</Badge> : <Badge tone={k.tone}>{k.label}</Badge>}
                <span className="shrink-0 text-xs text-subtle">{fmtRelative(v.created_at)}</span>
              </button>
            </li>
          );
        })}
      </ul>
      {picked ? (
        <div className="flex flex-col gap-2" aria-live="polite">
          <p className="flex items-center gap-1.5 text-xs text-muted"><GitCompare aria-hidden className="size-3.5" /> {picked.version ? `v${picked.version}` : 'Unsaved copy'} → current</p>
          <DiffText before={picked.draft.baseText ?? ''} after={currentText} />
          {canEdit && picked.version !== data.current_version ? (
            <Button size="sm" variant="secondary" className="self-start" icon={<RotateCcw aria-hidden className="size-4" />} onClick={() => setRestore(picked)}>Restore this</Button>
          ) : null}
        </div>
      ) : null}
      {data.revisions.length ? (
        <p className="text-[11px] text-subtle">{data.revisions.length} submitted revision{data.revisions.length === 1 ? '' : 's'} · latest r{data.revisions[0]!.revision_number}</p>
      ) : null}
      <ConfirmDialog
        open={!!restore}
        onOpenChange={(o) => !o && setRestore(null)}
        title="Restore this version?"
        description="It becomes the new draft. The current one stays in history."
        confirmLabel="Restore"
        onConfirm={async () => {
          await api.post(`/api/posts/${postId}/versions/${restore!.id}/restore`, { expected_version: data.current_version });
          toast.success('Restored');
          setSel(null);
          await refetch();
          await onRestored();
        }}
      />
    </div>
  );
}
