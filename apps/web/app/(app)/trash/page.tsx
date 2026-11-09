'use client';
// V3.1 §10 Trash: trashed posts and files on brands the caller can read (GET /api/trash). Restore goes through
// POST /api/trash/restore with the deleted_at it saw (a changed item fails instead of being overwritten); restoring a
// post brings it back as a draft — nothing is scheduled or published.
import { useState } from 'react';
import { FileText, Image as ImageIcon, Lock, RotateCcw, ShieldAlert, Trash2 } from 'lucide-react';
import { TRASH_RETENTION_DAYS, type TrashItemView, type TrashKind } from '@social-lite/core/contracts/v31-data';
import { useApi } from '@/lib/client/use-api';
import { useBrandFilter, useQueryState } from '@/lib/client/hooks';
import { useSession } from '@/lib/client/session';
import { fmtRelative } from '@/lib/client/format';
import { Badge, Button, Card, ConfirmDialog, EmptyState, ErrorState, PageHeader, Segmented, SkeletonRows, Tooltip } from '@/components/ui';
import { useTrashActions } from '@/components/trash/trash-actions';
import { BulkBar, useSelection } from '@/components/bulk/bulk';
import { HelpLink } from '@/components/help/help-link';

interface TrashPage { items: TrashItemView[]; next_cursor: string | null; retention_days: Record<TrashKind, number> }

const DAY = 86_400_000;

export default function TrashPage() {
  const { session } = useSession();
  const [brand] = useBrandFilter();
  const [params, setParams] = useQueryState();
  const kind = (params.get('kind') === 'post' || params.get('kind') === 'asset' ? params.get('kind') : '') as TrashKind | '';
  const [cursor, setCursor] = useState<string | null>(null);
  const qs = new URLSearchParams();
  if (kind) qs.set('kind', kind);
  if (brand) qs.set('brand_id', brand);
  if (cursor) qs.set('cursor', cursor);
  qs.set('limit', '50');
  const { data, error, loading, refetch, setData } = useApi<TrashPage>(`/api/trash?${qs}`, { keepPrevious: true });
  const { restore } = useTrashActions();
  const [pending, setPending] = useState<TrashItemView | null>(null);
  const sel = useSelection<TrashItemView>();
  const brandName = (id: string) => session.brands.find((b) => b.id === id)?.name ?? '';

  const drop = (id: string) => setData((d) => ({ ...(d ?? { next_cursor: null, retention_days: TRASH_RETENTION_DAYS }), items: (d?.items ?? []).filter((x) => x.id !== id) }));
  const selKind = kind || (sel.items.length && sel.items.every((x) => x.kind === sel.items[0]!.kind) ? sel.items[0]!.kind : null);

  return (
    <>
      <PageHeader title="Trash" meta={`Kept ${TRASH_RETENTION_DAYS.post} days`} actions={<HelpLink slug="archive-trash-and-delete" label="About archive, trash and delete" />} />
      <div className="mb-6 flex flex-wrap items-center gap-2">
        <Segmented
          label="Show"
          value={kind || 'all'}
          onChange={(v) => { setCursor(null); sel.clear(); setParams({ kind: v === 'all' ? null : v }); }}
          options={[{ value: 'all', label: 'All' }, { value: 'post', label: 'Posts' }, { value: 'asset', label: 'Files' }]}
        />
      </div>

      {error && !data ? <ErrorState error={error} onRetry={refetch} /> : loading || !data ? (
        <Card><SkeletonRows rows={5} className="p-2" /></Card>
      ) : !data.items.length ? (
        <EmptyState icon={<Trash2 aria-hidden />} title="Trash is empty" />
      ) : (
        <Card>
          <ul aria-label="Trashed items" className="divide-y divide-border">
            {data.items.map((it) => {
              const left = Math.max(0, Math.ceil((Date.parse(it.purge_after) - Date.now()) / DAY));
              const Icon = it.kind === 'post' ? FileText : ImageIcon;
              const selectable = it.can_restore && (!selKind || selKind === it.kind);
              return (
                <li key={`${it.kind}:${it.id}`} data-testid={`trash-${it.id}`} className="flex flex-wrap items-center gap-3 px-4 py-3 sm:flex-nowrap">
                  <input
                    type="checkbox"
                    aria-label={`Select ${it.title ?? 'item'}`}
                    className="size-4 shrink-0 accent-[var(--text)] disabled:opacity-40"
                    checked={sel.has(it.id)}
                    disabled={!selectable}
                    onChange={() => sel.toggle(it)}
                  />
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-raised text-muted"><Icon aria-hidden className="size-4" /></span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[14px] font-medium">{it.title?.trim() || (it.kind === 'post' ? 'Untitled post' : 'Untitled file')}</p>
                    <p className="truncate text-xs text-muted">
                      {brandName(it.brand_id)} · Deleted {fmtRelative(it.deleted_at)}{it.deleted_by ? ` by ${it.deleted_by}` : ''}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2 max-sm:w-full max-sm:justify-end">
                    {it.purge_blocked_reason ? (
                      <Tooltip content={it.purge_blocked_reason}><span tabIndex={0}><Badge tone="info" icon={<ShieldAlert aria-hidden className="size-3.5" />}>In use · kept</Badge></span></Tooltip>
                    ) : (
                      <Badge tone={left <= 3 ? 'warn' : 'neutral'}>{left === 0 ? 'Deletes today' : `${left} day${left === 1 ? '' : 's'} left`}</Badge>
                    )}
                    {it.can_restore ? (
                      <Button size="sm" variant="secondary" icon={<RotateCcw aria-hidden className="size-4" />} onClick={() => setPending(it)}>Restore</Button>
                    ) : (
                      <Tooltip content="You can’t restore this"><span tabIndex={0} className="inline-flex size-8 items-center justify-center text-subtle"><Lock aria-hidden className="size-4" /><span className="sr-only">Can’t restore</span></span></Tooltip>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
          {data.next_cursor ? (
            <div className="border-t border-border p-3 text-center">
              <Button variant="ghost" size="sm" onClick={() => setCursor(data.next_cursor)}>Next page</Button>
            </div>
          ) : cursor ? (
            <div className="border-t border-border p-3 text-center"><Button variant="ghost" size="sm" onClick={() => setCursor(null)}>First page</Button></div>
          ) : null}
        </Card>
      )}

      {selKind ? (
        <BulkBar
          targetKind={selKind}
          selection={sel}
          actions={['restore']}
          onDone={() => { sel.clear(); void refetch(); }}
        />
      ) : null}

      <ConfirmDialog
        open={!!pending}
        onOpenChange={(o) => !o && setPending(null)}
        title={pending?.kind === 'post' ? 'Restore as a draft?' : 'Restore this file?'}
        description={pending?.kind === 'post' ? 'Nothing is scheduled or published.' : 'It returns to the library.'}
        confirmLabel="Restore"
        onConfirm={async () => {
          const it = pending!;
          await restore(it.kind, it.id, { expectedDeletedAt: it.deleted_at, onUndone: () => void refetch() });
          drop(it.id);
        }}
      />
    </>
  );
}
