'use client';
// V3.1 §11 bulk workflows. Selection → preview (POST /api/bulk/preview: per-item eligibility + permission/policy
// consequences) → start (POST /api/bulk/jobs with Idempotency-Key + preview_hash; a stale preview comes back with a
// fresh one) → durable job progress (GET /api/bulk/jobs/:id) with per-item results, retry failed (all or one),
// cancel and undo. The server re-checks authority when the job runs; nothing here is trusted for permissions.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Archive, ArchiveRestore, CalendarClock, CircleCheck, Copy, Flag, LoaderCircle, OctagonX, RotateCcw, Tag, Tags, Trash2, Undo2, UserRound, X,
  type LucideIcon,
} from 'lucide-react';
import type { BulkAction, BulkJobView, BulkParams, BulkPreview, BulkPreviewItem } from '@social-lite/core/contracts/v31-data';
import { api, isApiError } from '@/lib/client/api';
import { useApi } from '@/lib/client/use-api';
import { Badge, Button, Drawer, ErrorNotice, Field, InfoTip, Input, Menu, MenuContent, MenuItem, MenuTrigger, Select, Skeleton, ToneIcon, cn, useToast } from '@/components/ui';

// ------------------------------------------------------------------ selection
export interface Selectable { id: string; brand_id?: string | null; title?: string | null }

export interface Selection<T extends Selectable> {
  items: T[];
  ids: string[];
  size: number;
  has: (id: string) => boolean;
  toggle: (item: T) => void;
  setAll: (list: T[], on: boolean) => void;
  clear: () => void;
}

export function useSelection<T extends Selectable>(): Selection<T> {
  const [map, setMap] = useState<Map<string, T>>(() => new Map());
  const toggle = useCallback((item: T) => setMap((m) => {
    const n = new Map(m);
    if (n.has(item.id)) n.delete(item.id); else n.set(item.id, item);
    return n;
  }), []);
  const setAll = useCallback((list: T[], on: boolean) => setMap((m) => {
    const n = new Map(m);
    for (const i of list) { if (on) n.set(i.id, i); else n.delete(i.id); }
    return n;
  }), []);
  const clear = useCallback(() => setMap(new Map()), []);
  return useMemo(() => ({
    items: [...map.values()], ids: [...map.keys()], size: map.size, has: (id: string) => map.has(id), toggle, setAll, clear,
  }), [map, toggle, setAll, clear]);
}

/** Header checkbox for a visible page of rows. */
export function SelectAll<T extends Selectable>({ rows, selection, label = 'Select all on this page' }: { rows: T[]; selection: Selection<T>; label?: string }) {
  const ref = useRef<HTMLInputElement | null>(null);
  const on = rows.length > 0 && rows.every((r) => selection.has(r.id));
  const some = !on && rows.some((r) => selection.has(r.id));
  useEffect(() => { if (ref.current) ref.current.indeterminate = some; }, [some]);
  return <input ref={ref} type="checkbox" aria-label={label} className="size-4 accent-[var(--text)]" checked={on} onChange={() => selection.setAll(rows, !on)} />;
}

// ------------------------------------------------------------------ actions
type PostOrAssetAction = Exclude<BulkAction, 'undo'>;

const ACTION: Record<PostOrAssetAction, { label: string; verb: string; icon: LucideIcon; danger?: boolean; oneBrand?: boolean }> = {
  assign: { label: 'Assign', verb: 'Assign', icon: UserRound, oneBrand: true },
  add_tags: { label: 'Add tags', verb: 'Add tags to', icon: Tag },
  remove_tags: { label: 'Remove tags', verb: 'Remove tags from', icon: Tags },
  set_campaign: { label: 'Set campaign', verb: 'Set campaign for', icon: Flag, oneBrand: true },
  duplicate: { label: 'Duplicate as drafts', verb: 'Duplicate', icon: Copy },
  archive: { label: 'Archive', verb: 'Archive', icon: Archive, danger: true },
  unarchive: { label: 'Unarchive', verb: 'Unarchive', icon: ArchiveRestore },
  reschedule: { label: 'Reschedule', verb: 'Reschedule', icon: CalendarClock },
  trash: { label: 'Move to Trash', verb: 'Move to Trash', icon: Trash2, danger: true },
  restore: { label: 'Restore', verb: 'Restore', icon: RotateCcw },
};

const UNDO_LABEL: Partial<Record<string, string>> = { duplicate: 'Undo (trash copies)' };

/**
 * Sticky bar for a selection. `actions` lists what this surface offers; each one still goes through preview,
 * where the server marks items it won't change and why.
 */
export function BulkBar<T extends Selectable>({
  targetKind, selection, actions, onDone, noun, describe,
}: {
  targetKind: 'post' | 'asset'; selection: Selection<T>; actions: PostOrAssetAction[]; onDone: () => void; noun?: string;
  /** What this page already shows about an item (e.g. its status), added next to a skip reason. Display only. */
  describe?: (id: string) => string | null;
}) {
  const [action, setAction] = useState<PostOrAssetAction | null>(null);
  if (!selection.size && !action) return null;
  const brands = new Set(selection.items.map((i) => i.brand_id ?? ''));
  const primary = actions.slice(0, 2);
  const more = actions.slice(2);
  const reason = (a: PostOrAssetAction) => (ACTION[a].oneBrand && brands.size > 1 ? 'Select items from one brand.' : null);
  return (
    <>
      {selection.size ? (
        <div role="region" aria-label="Bulk actions" className="anim-pop fixed inset-x-3 bottom-[76px] z-40 mx-auto flex max-w-[720px] flex-wrap items-center gap-2 rounded-xl border border-border-strong bg-raised px-3 py-2 shadow-[var(--shadow)] md:bottom-5 md:left-[calc(var(--rail-w)+24px)] xl:left-[calc(var(--nav-w)+24px)]">
          <span className="px-1 text-[13px] font-medium tabular" aria-live="polite">{selection.size} selected</span>
          <Button size="sm" variant="quiet" icon={<X aria-hidden className="size-4" />} onClick={selection.clear}>Clear</Button>
          <span className="flex-1" />
          {primary.map((a) => {
            const A = ACTION[a];
            return <Button key={a} size="sm" variant={A.danger ? 'danger' : 'secondary'} icon={<A.icon aria-hidden className="size-4" />} disabledReason={reason(a)} onClick={() => setAction(a)}>{A.label}</Button>;
          })}
          {more.length ? (
            <Menu>
              <MenuTrigger asChild><Button size="sm" variant="secondary">More</Button></MenuTrigger>
              <MenuContent align="end">
                {more.map((a) => {
                  const A = ACTION[a];
                  return <MenuItem key={a} icon={<A.icon aria-hidden />} danger={A.danger} disabled={!!reason(a)} onSelect={() => setAction(a)}>{A.label}</MenuItem>;
                })}
              </MenuContent>
            </Menu>
          ) : null}
        </div>
      ) : null}
      {action ? (
        <BulkSheet
          targetKind={targetKind}
          action={action}
          ids={selection.ids}
          brandId={brands.size === 1 ? [...brands][0] || null : null}
          noun={noun ?? `${targetKind === 'post' ? 'post' : 'file'}${selection.size === 1 ? '' : 's'}`}
          onClose={(changed) => { setAction(null); if (changed) onDone(); }}
          describe={describe}
        />
      ) : null}
    </>
  );
}

// ------------------------------------------------------------------ preview + job sheet
function BulkSheet({
  targetKind, action, ids, brandId, noun, onClose, describe,
}: {
  targetKind: 'post' | 'asset'; action: PostOrAssetAction; ids: string[]; brandId: string | null; noun: string; onClose: (changed: boolean) => void;
  describe?: (id: string) => string | null;
}) {
  const A = ACTION[action];
  const [params, setParams] = useState<BulkParams>({});
  const [preview, setPreview] = useState<BulkPreview | null>(null);
  const [previewErr, setPreviewErr] = useState<unknown>(null);
  const [previewing, setPreviewing] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const [startErr, setStartErr] = useState<unknown>(null);
  const [starting, setStarting] = useState(false);
  const [stale, setStale] = useState(false);
  const idemKey = useRef<string>(newKey());
  const titles = useRef(new Map<string, string | null>());
  const needsParams = action === 'assign' || action === 'add_tags' || action === 'remove_tags' || action === 'set_campaign' || action === 'reschedule';
  const paramsReady = !needsParams || paramsValid(action, params);

  // Preview whenever the parameters settle (the server decides eligibility, not the client).
  const paramsKey = JSON.stringify(params);
  useEffect(() => {
    if (jobId || !paramsReady) { if (!paramsReady) setPreview(null); return; }
    const ctl = new AbortController();
    setPreviewing(true);
    setPreviewErr(null);
    const t = setTimeout(() => {
      api.post<BulkPreview>('/api/bulk/preview', { target_kind: targetKind, action, item_ids: ids, params }, { signal: ctl.signal })
        .then((p) => { for (const i of p.items) titles.current.set(i.id, i.title); setPreview(p); idemKey.current = newKey(); })
        .catch((e) => { if (!ctl.signal.aborted) setPreviewErr(e); })
        .finally(() => { if (!ctl.signal.aborted) setPreviewing(false); });
    }, needsParams ? 300 : 0);
    return () => { clearTimeout(t); ctl.abort(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paramsKey, paramsReady, jobId]);

  const start = async () => {
    if (!preview) return;
    setStarting(true);
    setStartErr(null);
    setStale(false);
    try {
      const job = await api.post<BulkJobView>('/api/bulk/jobs', { target_kind: targetKind, action, item_ids: ids, params, preview_hash: preview.preview_hash }, { idempotent: idemKey.current });
      setJobId(job.id);
    } catch (e) {
      if (isApiError(e) && e.details?.reason === 'preview_stale' && e.details.preview) {
        const p = e.details.preview as BulkPreview;
        for (const i of p.items) titles.current.set(i.id, i.title);
        setPreview(p);
        idemKey.current = newKey();
        setStale(true);
      } else setStartErr(e);
    } finally {
      setStarting(false);
    }
  };

  return (
    <Drawer
      open
      onOpenChange={(o) => !o && onClose(!!jobId)}
      title={jobId ? `${A.label} · ${ids.length} ${noun}` : `${A.verb} ${ids.length} ${noun}?`}
      footer={jobId ? null : (
        <>
          <Button variant="ghost" onClick={() => onClose(false)}>Cancel</Button>
          <Button
            variant={A.danger ? 'danger' : 'primary'}
            loading={starting}
            onClick={() => void start()}
            disabledReason={!paramsReady ? 'Fill in the details.' : !preview ? (previewing ? 'Checking…' : 'Preview failed.') : preview.eligible === 0 ? 'Nothing can be changed.' : null}
          >
            {preview ? `${A.label} ${preview.eligible}` : A.label}
          </Button>
        </>
      )}
    >
      {jobId ? (
        <JobProgress jobId={jobId} titles={titles.current} onFollow={setJobId} />
      ) : (
        <div className="flex flex-col gap-5">
          {needsParams ? <ParamsForm action={action} brandId={brandId} params={params} onChange={setParams} /> : null}
          {stale ? <ErrorNotice error={new Error('Items changed since the preview. Check again.')} /> : null}
          {previewErr ? <ErrorNotice error={previewErr} /> : !paramsReady ? null : !preview ? <Skeleton className="h-32 w-full rounded-lg" /> : <PreviewView preview={preview} describe={describe} />}
          {startErr ? <ErrorNotice error={startErr} /> : null}
        </div>
      )}
    </Drawer>
  );
}

function paramsValid(action: PostOrAssetAction, p: BulkParams): boolean {
  if (action === 'add_tags' || action === 'remove_tags') return (p.tags?.length ?? 0) > 0;
  if (action === 'assign') return p.assignee_user_id !== undefined || p.team_id !== undefined;
  if (action === 'set_campaign') return p.campaign_id !== undefined;
  if (action === 'reschedule') return Number.isInteger(p.shift_minutes) && p.shift_minutes !== 0;
  return true;
}

interface Options { people: Array<{ id: string; email: string; name: string | null }>; teams: Array<{ id: string; name: string }> }
interface Campaigns { items: Array<{ id: string; name: string; archived: boolean }> }

function ParamsForm({ action, brandId, params, onChange }: { action: PostOrAssetAction; brandId: string | null; params: BulkParams; onChange: (p: BulkParams) => void }) {
  const opts = useApi<Options>(action === 'assign' && brandId ? `/api/brands/${brandId}/assignment-options` : null);
  const camps = useApi<Campaigns>(action === 'set_campaign' && brandId ? `/api/brands/${brandId}/campaigns` : null);
  const [tags, setTags] = useState('');
  const [shift, setShift] = useState({ n: '1', unit: '1440' });
  if (action === 'add_tags' || action === 'remove_tags') {
    return (
      <Field label="Tags" hint="Comma-separated">
        <Input value={tags} autoFocus onChange={(e) => { setTags(e.target.value); onChange({ tags: e.target.value.split(',').map((t) => t.trim()).filter(Boolean).slice(0, 20) }); }} />
      </Field>
    );
  }
  if (action === 'assign') {
    if (!opts.data) return <Skeleton className="h-20 w-full rounded-lg" />;
    return (
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Assignee">
          <Select value={params.assignee_user_id === undefined ? '' : params.assignee_user_id ?? '-'} onChange={(e) => onChange({ ...params, assignee_user_id: e.target.value === '' ? undefined : e.target.value === '-' ? null : e.target.value })}>
            <option value="">Leave as is</option>
            <option value="-">Unassigned</option>
            {opts.data.people.map((p) => <option key={p.id} value={p.id}>{p.name || p.email}</option>)}
          </Select>
        </Field>
        <Field label="Team">
          <Select value={params.team_id === undefined ? '' : params.team_id ?? '-'} onChange={(e) => onChange({ ...params, team_id: e.target.value === '' ? undefined : e.target.value === '-' ? null : e.target.value })}>
            <option value="">Leave as is</option>
            <option value="-">No team</option>
            {opts.data.teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </Select>
        </Field>
      </div>
    );
  }
  if (action === 'set_campaign') {
    if (!camps.data) return <Skeleton className="h-10 w-full rounded-lg" />;
    return (
      <Field label="Campaign">
        <Select value={params.campaign_id === undefined ? '' : params.campaign_id ?? '-'} onChange={(e) => onChange({ campaign_id: e.target.value === '' ? undefined : e.target.value === '-' ? null : e.target.value })}>
          <option value="">Choose…</option>
          <option value="-">No campaign</option>
          {camps.data.items.filter((c) => !c.archived).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </Select>
      </Field>
    );
  }
  if (action === 'reschedule') {
    const set = (n: string, unit: string) => { setShift({ n, unit }); const v = Math.round(Number(n) * Number(unit)); onChange({ shift_minutes: Number.isFinite(v) ? v : 0 }); };
    return (
      <div>
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Move by">
          <Input type="number" inputMode="numeric" value={shift.n} onChange={(e) => set(e.target.value, shift.unit)} className="w-[120px] tabular" />
        </Field>
        <Field label="Unit" labelHidden>
          <Select value={shift.unit} onChange={(e) => set(shift.n, e.target.value)} className="w-[120px]">
            <option value="60">hours</option>
            <option value="1440">days</option>
            <option value="10080">weeks</option>
          </Select>
        </Field>
        {params.shift_minutes === undefined ? <InitShift onInit={() => set(shift.n, shift.unit)} /> : null}
      </div>
      <p className="mt-2 text-xs text-muted">Negative moves earlier. Each post keeps its own time zone.</p>
      </div>
    );
  }
  return null;
}
function InitShift({ onInit }: { onInit: () => void }) {
  useEffect(() => { onInit(); }, [onInit]);
  return null;
}

const SHORT_CONSEQUENCE: Partial<Record<string, string>> = {
  reschedule: 'Approval rules still apply.', trash: 'Nothing on networks changes.', archive: 'Nothing on networks changes.',
  restore: 'Nothing is scheduled or published.', assign: 'Access isn’t extended.', duplicate: 'Copies are drafts, never scheduled.',
};

function PreviewView({ preview, describe }: { preview: BulkPreview; describe?: (id: string) => string | null }) {
  const ineligible = preview.items.filter((i) => i.eligibility !== 'eligible');
  const eligible = preview.items.filter((i) => i.eligibility === 'eligible');
  return (
    <div className="flex flex-col gap-4" data-testid="bulk-preview">
      <div className="flex flex-wrap gap-2">
        <Badge tone="success" icon={<CircleCheck aria-hidden className="size-3.5" />}>{preview.eligible} will change</Badge>
        {preview.ineligible ? <Badge tone="warn" icon={<ToneIcon tone="warn" className="size-3.5" />}>{preview.ineligible} skipped</Badge> : null}
      </div>
      {preview.consequences.length ? (
        <p className="flex items-center gap-1.5 text-[13px] text-muted">
          {SHORT_CONSEQUENCE[preview.action] ?? 'Each item is checked again when it runs.'}
          <InfoTip label="What this does"><ul className="flex flex-col gap-1">{preview.consequences.map((c) => <li key={c}>{c}</li>)}</ul></InfoTip>
        </p>
      ) : null}
      {ineligible.length ? <ItemList title="Skipped" items={ineligible} describe={describe} /> : null}
      {eligible.length ? <ItemList title="Will change" items={eligible} /> : null}
    </div>
  );
}

function ItemList({ title, items, describe }: { title: string; items: BulkPreviewItem[]; describe?: (id: string) => string | null }) {
  return (
    <section>
      <h3 className="mb-1.5 text-xs font-medium uppercase tracking-[0.06em] text-subtle">{title}</h3>
      <ul className="flex max-h-[40dvh] flex-col divide-y divide-border overflow-y-auto rounded-lg border border-border">
        {items.map((i) => (
          <li key={i.id} className="px-3 py-2 text-[13px]">
            <p className="truncate font-medium">{i.title?.trim() || 'Untitled'}</p>
            {i.reason ? <p className="text-xs text-warn">{i.reason}{describe?.(i.id) ? <span className="text-muted"> · {describe(i.id)}</span> : null}</p> : null}
            {i.consequences.map((c) => <p key={c} className="text-xs text-muted">{c}</p>)}
          </li>
        ))}
      </ul>
    </section>
  );
}

const TERMINAL = new Set(['completed', 'completed_with_errors', 'failed', 'cancelled']);
const STATUS_LABEL: Record<string, string> = {
  queued: 'Queued', running: 'Running', completed: 'Done', completed_with_errors: 'Done with errors', failed: 'Failed', cancelled: 'Cancelled',
};

/** Live job view (polls while running). Retry failed (all or one), cancel, undo. */
export function JobProgress({ jobId, titles, onFollow }: { jobId: string; titles: Map<string, string | null>; onFollow?: (id: string) => void }) {
  const toast = useToast();
  const { data, error, refetch, setData } = useApi<BulkJobView>(`/api/bulk/jobs/${jobId}`, { poll: (d) => (d && TERMINAL.has(d.status) ? false : 1000) });
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const undoKey = useRef(newKey());
  if (error && !data) return <ErrorNotice error={error} />;
  if (!data) return <Skeleton className="h-40 w-full rounded-lg" />;
  const c = data.counts;
  const done = c.succeeded + c.failed + c.skipped;
  const pct = c.total ? Math.round((done / c.total) * 100) : 0;
  const run = async (k: string, f: () => Promise<BulkJobView | void>) => {
    setBusy(k);
    setErr(null);
    try {
      const v = await f();
      if (v) { if (v.id !== data.id && onFollow) onFollow(v.id); else setData(v); }
      await refetch();
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(null);
    }
  };
  const failed = data.items.filter((i) => i.status === 'failed');
  return (
    <div className="flex flex-col gap-5" data-testid="bulk-job" data-status={data.status}>
      <div>
        <div className="mb-2 flex items-center justify-between gap-2 text-[13px]">
          <span className="flex items-center gap-2 font-medium">
            {TERMINAL.has(data.status) ? null : <LoaderCircle aria-hidden className="size-4 anim-spin text-info" />}
            {data.action === 'undo' ? 'Undo · ' : ''}{STATUS_LABEL[data.status] ?? data.status}
          </span>
          <span className="text-muted tabular" aria-live="polite">{done}/{c.total}</span>
        </div>
        <div className="h-2 overflow-hidden rounded-full bg-sunken" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label="Progress">
          <div className="h-full rounded-full bg-[var(--text)] transition-[width] duration-200" style={{ width: `${pct}%` }} />
        </div>
        <div className="mt-2 flex flex-wrap gap-2">
          <Badge tone="success">{c.succeeded} done</Badge>
          {c.failed ? <Badge tone="danger">{c.failed} failed</Badge> : null}
          {c.skipped ? <Badge tone="neutral">{c.skipped} skipped</Badge> : null}
          {c.pending ? <Badge tone="info">{c.pending} pending</Badge> : null}
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        {data.can_retry && failed.length ? <Button size="sm" variant="primary" icon={<RotateCcw aria-hidden className="size-4" />} loading={busy === 'retry'} onClick={() => void run('retry', () => api.post<BulkJobView>(`/api/bulk/jobs/${data.id}/retry`, {}))}>Retry {failed.length} failed</Button> : null}
        {data.can_cancel ? <Button size="sm" variant="secondary" icon={<OctagonX aria-hidden className="size-4" />} loading={busy === 'cancel'} onClick={() => void run('cancel', () => api.post<BulkJobView>(`/api/bulk/jobs/${data.id}/cancel`, {}))}>Cancel rest</Button> : null}
        {data.can_undo ? (
          <Button size="sm" variant="secondary" icon={<Undo2 aria-hidden className="size-4" />} loading={busy === 'undo'}
            onClick={() => void run('undo', async () => { const v = await api.post<BulkJobView>(`/api/bulk/jobs/${data.id}/undo`, {}, { idempotent: undoKey.current }); toast.info('Undo started'); return v; })}>
            {UNDO_LABEL[data.action] ?? 'Undo'}
          </Button>
        ) : null}
      </div>
      {err ? <ErrorNotice error={err} /> : null}
      <ul aria-label="Items" className="flex flex-col divide-y divide-border rounded-lg border border-border">
        {data.items.map((i) => (
          <li key={i.id} className="flex items-start gap-3 px-3 py-2 text-[13px]" data-item-status={i.status}>
            <ItemIcon status={i.status} />
            <div className="min-w-0 flex-1">
              <p className="truncate">{titles.get(i.id)?.trim() || 'Untitled'}</p>
              {i.error_message ? <p className="text-xs text-danger">{i.error_message}</p> : null}
            </div>
            {i.status === 'failed' && data.can_retry ? (
              <Button size="sm" variant="quiet" loading={busy === i.id} onClick={() => void run(i.id, () => api.post<BulkJobView>(`/api/bulk/jobs/${data.id}/retry`, { item_ids: [i.id] }))}>Retry</Button>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

function ItemIcon({ status }: { status: string }) {
  if (status === 'succeeded') return <CircleCheck aria-label="Done" className="mt-0.5 size-4 shrink-0 text-success" />;
  if (status === 'failed') return <OctagonX aria-label="Failed" className="mt-0.5 size-4 shrink-0 text-danger" />;
  if (status === 'skipped') return <span aria-label="Skipped" className="mt-1 size-3 shrink-0 rounded-full border border-border-strong" />;
  return <LoaderCircle aria-label="Pending" className={cn('mt-0.5 size-4 shrink-0 anim-spin text-info')} />;
}

function newKey(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `k-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** One-item bulk run (e.g. Undo of an archive): preview, then start with a fresh Idempotency-Key. */
export async function runSingleBulk(targetKind: 'post' | 'asset', action: PostOrAssetAction, id: string, params: BulkParams = {}): Promise<BulkJobView> {
  const p = await api.post<BulkPreview>('/api/bulk/preview', { target_kind: targetKind, action, item_ids: [id], params });
  if (!p.eligible) throw new Error(p.items[0]?.reason ?? 'Can’t be changed.');
  return api.post<BulkJobView>('/api/bulk/jobs', { target_kind: targetKind, action, item_ids: [id], params, preview_hash: p.preview_hash }, { idempotent: newKey() });
}
