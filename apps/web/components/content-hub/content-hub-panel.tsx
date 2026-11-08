'use client';
// Library → Sources (Content Hub): linked Drive/Docs/Notion items for a brand as source cards, explicit selection
// (Google Picker / Notion search), import previews, refresh, and export of the content plan. Reads stored data only;
// source calls happen on explicit actions (selection, preview) or in worker jobs (imports, refresh, exports).
import { useState } from 'react';
import { Download, FolderInput, Plus, Search } from 'lucide-react';
import type { ContentConnectionDto, ContentHubOverviewDto, ImportDto, NotionSearchResultDto, SourceItemDto } from '@social-lite/core/contracts/content-hub';
import type { ExportJob } from '@social-lite/core/contracts/exports';
import { api } from '@/lib/client/api';
import { useApi } from '@/lib/client/use-api';
import { useSession } from '@/lib/client/session';
import { fmtRelative } from '@/lib/client/format';
import { Banner, Button, ConfirmDialog, Dialog, EmptyState, ErrorNotice, ErrorState, Input, LinkButton, Segmented, Select, SkeletonRows, useToast } from '@/components/ui';
import { SourceCard } from './source-card';
import { SourceImportDialog } from './import-dialogs';
import type { PickerConfig, PickMode } from './google-picker';

type SelectionResult = { items: SourceItemDto[]; destinations: Array<{ id: string; title: string | null; writable: boolean }>; rejected: Array<{ id: string; reason: string }> };

/** Explicit Drive selection → server-side verification with the saved authorization. */
export async function selectFromDrive(conn: ContentConnectionDto, brandId: string, mode: PickMode, purpose: 'import' | 'export_destination' = 'import'): Promise<SelectionResult | null> {
  const cfg = await api.get<PickerConfig>(`/api/content-hub/connections/${conn.id}/picker`, { brand_id: brandId });
  // The picker module (and Google's scripts, which it loads itself) is fetched only when someone opens it.
  const picker = await import('./google-picker');
  const ids = cfg.test ? picker.TEST_PICKS[mode] : await picker.pickFromDrive(cfg, mode);
  if (!ids.length) return null;
  return api.post<SelectionResult>('/api/content-hub/selection', { connection_id: conn.id, brand_id: brandId, purpose, items: ids.map((id) => ({ id })) });
}

export function NotionPickerDialog({ conn, brandId, open, onOpenChange, onSelected, purpose = 'import' }: {
  conn: ContentConnectionDto; brandId: string; open: boolean; onOpenChange: (o: boolean) => void; onSelected: (r: SelectionResult) => void; purpose?: 'import' | 'export_destination';
}) {
  const [type, setType] = useState<'page' | 'data_source'>('page');
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const { data, error, loading, refetch } = useApi<{ items: NotionSearchResultDto[] }>(open ? `/api/content-hub/notion/search?connection_id=${conn.id}&brand_id=${brandId}&type=${purpose === 'export_destination' ? 'page' : type}&q=${encodeURIComponent(query)}` : null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const pick = async (r: NotionSearchResultDto) => {
    setBusy(r.id); setErr(null);
    try {
      onSelected(await api.post<SelectionResult>('/api/content-hub/selection', { connection_id: conn.id, brand_id: brandId, purpose, items: [{ id: r.id, kind: r.kind === 'page' ? 'notion_page' : 'notion_data_source' }] }));
      onOpenChange(false);
    } catch (e) { setErr(e); } finally { setBusy(null); }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={purpose === 'export_destination' ? 'Choose a parent page' : 'Choose from Notion'} description="Only pages shared with the connection appear.">
      <div className="flex flex-col gap-3">
        {purpose === 'import' ? <Segmented label="Type" size="sm" value={type} onChange={setType} options={[{ value: 'page', label: 'Pages' }, { value: 'data_source', label: 'Data sources' }]} /> : null}
        <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); setQuery(q); }}>
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search" aria-label="Search Notion" />
          <Button type="submit" icon={<Search aria-hidden className="size-4" />}>Search</Button>
        </form>
        {err ? <ErrorNotice error={err} /> : null}
        {error && !data ? <ErrorState error={error} onRetry={refetch} /> : loading ? <SkeletonRows rows={4} /> : !data?.items.length ? <EmptyState compact icon={<Search aria-hidden />} title="Nothing shared yet" /> : (
          <ul className="flex max-h-[360px] flex-col overflow-auto">
            {data.items.map((r) => (
              <li key={r.id} className="flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-raised/60">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px] font-medium">{r.title}</p>
                  <p className="text-xs text-muted">{r.kind === 'page' ? 'Page' : 'Data source'}{r.last_edited_time ? ` · edited ${fmtRelative(r.last_edited_time)}` : ''}{r.already_linked ? ' · linked' : ''}</p>
                </div>
                <Button size="sm" onClick={() => pick(r)} loading={busy === r.id}>Select</Button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Dialog>
  );
}

function ExportPlanDialog({ brandId, connections, open, onOpenChange }: { brandId: string; connections: ContentConnectionDto[]; open: boolean; onOpenChange: (o: boolean) => void }) {
  const usable = connections.filter((c) => c.status === 'active');
  const [connId, setConnId] = useState(usable[0]?.id ?? '');
  const conn = usable.find((c) => c.id === connId);
  const [parent, setParent] = useState<{ id: string; title: string | null } | null>(null);
  const [notionOpen, setNotionOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const [job, setJob] = useState<ExportJob | null>(null);
  const live = useApi<ExportJob>(job ? `/api/content-hub/exports/${job.id}` : null, { poll: (d) => (d && (d.status === 'completed' || d.status === 'failed') ? false : 2_000) });
  const current = live.data ?? job;
  const chooseFolder = async () => {
    if (!conn) return;
    setErr(null);
    try {
      const r = await selectFromDrive(conn, brandId, 'folder', 'export_destination');
      if (r?.destinations[0]) setParent(r.destinations[0]);
    } catch (e) { setErr(e); }
  };
  const go = async () => {
    if (!conn) return;
    setBusy(true); setErr(null);
    try {
      setJob(await api.post<ExportJob>('/api/content-hub/exports/content-plan', {
        brand_id: brandId, destination: { kind: conn.source === 'notion' ? 'notion_page' : 'google_doc', connectionId: conn.id, parentId: parent?.id ?? null },
      }, { idempotent: true }));
    } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Export content plan" description="Creates a new document. Sharing is never changed.">
      <div className="flex flex-col gap-3">
        {!usable.length ? <Banner tone="info" title="Connect Google Drive or Notion in Settings → Sources" /> : (
          <>
            <Select aria-label="Destination account" value={connId} onChange={(e) => { setConnId(e.target.value); setParent(null); }}>
              {usable.map((c) => <option key={c.id} value={c.id}>{c.source === 'google' ? 'Google Docs' : 'Notion'} · {c.account_label}</option>)}
            </Select>
            <div className="flex items-center gap-2">
              <Button size="sm" icon={<FolderInput aria-hidden className="size-4" />} onClick={() => (conn?.source === 'notion' ? setNotionOpen(true) : chooseFolder())}>
                {conn?.source === 'notion' ? 'Choose parent page' : 'Choose folder'}
              </Button>
              <span className="truncate text-[13px] text-muted">{parent?.title ?? (conn?.source === 'notion' ? 'Required' : 'My Drive')}</span>
            </div>
            {current ? (
              current.status === 'completed' ? <Banner tone="success" title="Exported">{current.result_url ? <a className="underline" href={current.result_url} target="_blank" rel="noreferrer noopener">Open</a> : null}</Banner>
                : current.status === 'failed' ? <Banner tone="danger" title={current.error?.message ?? 'Export failed'} />
                  : <Banner tone="info" title="Exporting…">{current.sharing_warning}</Banner>
            ) : null}
            {err ? <ErrorNotice error={err} /> : null}
            <div><Button variant="primary" onClick={go} loading={busy} disabledReason={conn?.source === 'notion' && !parent ? 'Choose a parent page' : null} icon={<Download aria-hidden className="size-4" />}>Export</Button></div>
            {conn && conn.source === 'notion' ? <NotionPickerDialog conn={conn} brandId={brandId} open={notionOpen} onOpenChange={setNotionOpen} purpose="export_destination" onSelected={(r) => r.destinations[0] && setParent(r.destinations[0])} /> : null}
          </>
        )}
      </div>
    </Dialog>
  );
}

export function ContentHubPanel({ brandId }: { brandId: string }) {
  const { canV2 } = useSession();
  const toast = useToast();
  const { data, error, loading, refetch } = useApi<ContentHubOverviewDto>(`/api/content-hub?brand_id=${brandId}`, { keepPrevious: true });
  const [open, setOpen] = useState<SourceItemDto | null>(null);
  const [notionConn, setNotionConn] = useState<ContentConnectionDto | null>(null);
  const [refreshing, setRefreshing] = useState<string | null>(null);
  const [del, setDel] = useState<SourceItemDto | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const [rejected, setRejected] = useState<SelectionResult['rejected']>([]);
  if (error && !data) return <ErrorState error={error} onRetry={refetch} />;
  if (loading || !data) return <SkeletonRows rows={5} />;
  const active = data.connections.filter((c) => c.status === 'active');
  const canAdd = canV2('content.create');
  const afterSelect = async (r: SelectionResult | null) => {
    if (!r) return;
    setRejected(r.rejected);
    await refetch();
    if (r.items.length === 1) setOpen(r.items[0]!);
  };
  const addDrive = async (c: ContentConnectionDto, mode: PickMode) => {
    setErr(null);
    try { await afterSelect(await selectFromDrive(c, brandId, mode)); } catch (e) { setErr(e); }
  };
  const refresh = async (item: SourceItemDto) => {
    setRefreshing(item.id);
    try {
      const r = await api.post<ImportDto>(`/api/content-hub/items/${item.id}/refresh`, {}, { idempotent: true });
      toast.success(r.deduplicated ? 'Refresh already running' : 'Refresh queued');
    } catch (e) { setErr(e); } finally { setRefreshing(null); }
  };
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-2">
        {canAdd ? active.map((c) => (c.source === 'google' ? (
          <span key={c.id} className="contents">
            <Button size="sm" icon={<Plus aria-hidden className="size-4" />} onClick={() => addDrive(c, 'media')}>Drive media{active.filter((x) => x.source === 'google').length > 1 ? ` · ${c.account_label}` : ''}</Button>
            <Button size="sm" icon={<Plus aria-hidden className="size-4" />} onClick={() => addDrive(c, 'documents')}>Google Doc</Button>
          </span>
        ) : (
          <Button key={c.id} size="sm" icon={<Plus aria-hidden className="size-4" />} onClick={() => setNotionConn(c)}>Notion{active.filter((x) => x.source === 'notion').length > 1 ? ` · ${c.account_label}` : ''}</Button>
        ))) : null}
        {!active.length ? <LinkButton href="/settings/connections/google" size="sm">Connect Drive or Notion</LinkButton> : null}
        <span className="flex-1" />
        {canV2('exports.create') ? <Button size="sm" icon={<Download aria-hidden className="size-4" />} onClick={() => setExportOpen(true)}>Export plan</Button> : null}
      </div>
      {data.connections.some((c) => c.is_test) ? <Banner tone="warn" title="Test data">A test source connection is active. Its content is sample data, not your Drive or Notion.</Banner> : null}
      {rejected.length ? <Banner tone="warn" title={`${rejected.length} item(s) not added`}>{rejected.map((r) => r.reason.replace(/_/g, ' ')).join(', ')}</Banner> : null}
      {err ? <ErrorNotice error={err} /> : null}
      {!data.items.length ? <EmptyState icon={<FolderInput aria-hidden />} title="No sources yet" /> : (
        <ul className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {data.items.map((i) => (
            <SourceCard key={i.id} item={i} onOpen={() => setOpen(i)} refreshing={refreshing === i.id}
              onRefresh={canV2('content.edit') ? () => refresh(i) : undefined} onDelete={canV2('content.archive') ? () => setDel(i) : undefined} />
          ))}
        </ul>
      )}
      {data.recent_imports.length ? (
        <section aria-labelledby="ch-history">
          <h3 id="ch-history" className="mb-2 text-[13px] font-semibold">Import history</h3>
          <ul className="flex flex-col gap-1 text-[13px]">
            {data.recent_imports.slice(0, 8).map((i) => (
              <li key={i.id} className="flex gap-2"><span className="text-muted">{fmtRelative(i.created_at)}</span><span>{i.action.replace(/_/g, ' ')}</span><span className="text-muted">· {i.status}{i.error ? ` — ${i.error.message}` : ''}</span></li>
            ))}
          </ul>
        </section>
      ) : null}
      <SourceImportDialog key={open?.id ?? 'none'} item={open} open={!!open} onOpenChange={(o) => { if (!o) { setOpen(null); void refetch(); } }}
        writebackAllowed={!!open && data.connections.some((c) => c.id === open.connection_id && c.writeback_enabled)} />
      {notionConn ? <NotionPickerDialog conn={notionConn} brandId={brandId} open onOpenChange={(o) => !o && setNotionConn(null)} onSelected={afterSelect} /> : null}
      <ExportPlanDialog brandId={brandId} connections={data.connections} open={exportOpen} onOpenChange={setExportOpen} />
      <ConfirmDialog open={!!del} onOpenChange={(o) => !o && setDel(null)} title="Delete source?" confirmVariant="danger"
        description="Removes the link and its stored snapshots. Drafts and library media created from it stay." confirmLabel="Delete"
        onConfirm={async () => { await api.del(`/api/content-hub/items/${del!.id}`); await refetch(); }} />
    </div>
  );
}
