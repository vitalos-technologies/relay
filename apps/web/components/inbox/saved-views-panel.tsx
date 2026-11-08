'use client';
// Saved views (stream B): personal named filter sets (queue, type, priority, channel, search). Applying a view only
// changes the URL filters; nothing is shared with other people.
import { useState } from 'react';
import { Bookmark, BookmarkPlus, X } from 'lucide-react';
import { api } from '@/lib/client/api';
import { useApi } from '@/lib/client/use-api';
import { Button, Dialog, Field, Input, Select, cn, useToast } from '@/components/ui';

export const VIEW_KEYS = ['queue', 'kind', 'priority', 'channel_id', 'q'] as const;
interface View { id: string; name: string; filters: Record<string, string> }

export function useSavedViews() { return useApi<{ items: View[] }>('/api/inbox/views'); }

const same = (a: Record<string, string>, b: Record<string, string>) => VIEW_KEYS.every((k) => (a[k] ?? '') === (b[k] ?? ''));

export function SavedViewsPanel({ current, onApply }: { current: Record<string, string>; onApply: (f: Record<string, string>) => void }) {
  const toast = useToast();
  const views = useSavedViews();
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');
  const hasFilters = VIEW_KEYS.some((k) => current[k] && !(k === 'queue' && current[k] === 'unassigned'));
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between px-1">
        <p className="text-xs font-medium text-subtle">Saved views</p>
        <button type="button" className="rounded p-0.5 text-muted hover:bg-raised hover:text-fg disabled:opacity-40" aria-label="Save current filters as a view" disabled={!hasFilters} title={hasFilters ? 'Save current filters' : 'Choose filters first'} onClick={() => { setName(''); setNaming(true); }}><BookmarkPlus aria-hidden className="size-4" /></button>
      </div>
      {(views.data?.items ?? []).map((v) => (
        <div key={v.id} className={cn('group flex h-8 items-center rounded-md pl-2.5 text-[13px]', same(v.filters, current) ? 'bg-raised font-medium text-fg' : 'text-muted hover:bg-raised hover:text-fg')}>
          <button type="button" className="flex min-w-0 flex-1 items-center gap-1.5 text-left" onClick={() => onApply(v.filters)}><Bookmark aria-hidden className="size-3.5 shrink-0" /><span className="truncate">{v.name}</span></button>
          <button type="button" aria-label={`Delete view ${v.name}`} className="mr-1 rounded p-1 opacity-0 hover:bg-surface group-hover:opacity-100 focus:opacity-100" onClick={async () => { try { await api.del(`/api/inbox/views/${v.id}`); await views.refetch(); } catch (e) { toast.error(e); } }}><X aria-hidden className="size-3.5" /></button>
        </div>
      ))}
      {views.data && !views.data.items.length ? <p className="px-1 text-xs text-subtle">Filter the list, then save it here.</p> : null}
      <Dialog open={naming} onOpenChange={setNaming} title="Save view" footer={<>
        <Button variant="ghost" onClick={() => setNaming(false)}>Cancel</Button>
        <Button variant="primary" disabledReason={!name.trim() ? 'Name the view' : null} onClick={async () => {
          try { await api.post('/api/inbox/views', { name: name.trim(), filters: Object.fromEntries(VIEW_KEYS.filter((k) => current[k]).map((k) => [k, current[k]!])) }); toast.success('View saved'); setNaming(false); await views.refetch(); } catch (e) { toast.error(e); }
        }}>Save</Button>
      </>}>
        <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} placeholder="e.g. Urgent reviews" /></Field>
      </Dialog>
    </div>
  );
}

/** Compact picker for narrow layouts (< 1280 px). */
export function SavedViewsSelect({ current, onApply }: { current: Record<string, string>; onApply: (f: Record<string, string>) => void }) {
  const views = useSavedViews();
  if (!views.data?.items.length) return null;
  const cur = views.data.items.find((v) => same(v.filters, current));
  return (
    <Select aria-label="Saved view" className="w-28" value={cur?.id ?? ''} onChange={(e) => { const v = views.data!.items.find((x) => x.id === e.target.value); if (v) onApply(v.filters); }}>
      <option value="">Views</option>
      {views.data.items.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
    </Select>
  );
}
