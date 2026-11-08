'use client';
// Import preview + import for one linked source: Drive media, Google Docs / Notion pages (sections), Notion data
// sources (property mapping, opted-in statuses, field-scoped writeback, row selection). Imported text is shown as
// plain text only (untrusted content). Nothing here approves or schedules anything.
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import type {
  DataSourceSchemaDto, DocumentPreviewDto, DriveFilePreviewDto, ImportDto, MappingField, NotionMappingDto, RowsPreviewDto, SourceItemDto, SuggestionsMode, WritebackField,
} from '@social-lite/core/contracts/content-hub';
import { api } from '@/lib/client/api';
import { useApi } from '@/lib/client/use-api';
import { fmtBytes, fmtRelative } from '@/lib/client/format';
import type { Connection } from '@/lib/client/types';
import { Banner, Button, Checkbox, Dialog, ErrorNotice, ErrorState, Facts, Field, Input, Segmented, Select, SkeletonRows } from '@/components/ui';
import { SourceStateBadge } from './source-card';

const TERMINAL = new Set(['completed', 'partial', 'failed', 'cancelled']);

/** Poll an import until it finishes (the worker does the fetch/validate/snapshot/draft work). */
export function useImportStatus(initial: ImportDto | null) {
  const { data } = useApi<ImportDto>(initial ? `/api/content-hub/imports/${initial.id}` : null, {
    poll: (d) => (d && TERMINAL.has(d.status) ? false : 2_000),
  });
  return data ?? initial;
}

export function ImportResult({ imp }: { imp: ImportDto }) {
  if (!TERMINAL.has(imp.status)) return <Banner tone="info" title={imp.status === 'running' ? 'Importing…' : 'Queued'} />;
  if (imp.status === 'failed' || imp.status === 'cancelled') return <Banner tone="danger" title={imp.error?.message ?? 'Import failed'} />;
  const posts = imp.result.post_ids ?? [];
  return (
    <Banner tone={imp.status === 'partial' ? 'warn' : 'success'} title={imp.deduplicated ? 'Already imported' : imp.status === 'partial' ? 'Imported with problems' : 'Imported'}>
      <div className="flex flex-col gap-1 text-[13px]">
        {posts.length ? <span>{posts.map((id, i) => <Link key={id} className="mr-2 underline" href={`/posts/${id}`}>Draft {i + 1}</Link>)}</span> : null}
        {imp.result.asset_id ? <Link className="underline" href="/library">Open in Media</Link> : null}
        {(imp.result.rows ?? []).filter((r) => r.status !== 'imported').map((r) => <span key={r.row_id}>{r.status}: {r.message}</span>)}
        {(imp.result.warnings ?? []).map((w) => <span key={w}>{w}</span>)}
      </div>
    </Banner>
  );
}

function Destinations({ brandId, value, onChange }: { brandId: string; value: string[]; onChange: (v: string[]) => void }) {
  const { data } = useApi<{ items: Connection[] }>(`/api/brands/${brandId}/connections`);
  const items = (data?.items ?? []).filter((c) => !c.disconnected_at);
  if (!items.length) return null;
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-1 text-[13px] font-medium">Destinations <span className="text-muted">(optional)</span></legend>
      {items.map((c) => (
        <Checkbox key={c.id} label={`${c.display_name} · ${c.provider}`} checked={value.includes(c.id)}
          onChange={(e) => onChange(e.target.checked ? [...value, c.id] : value.filter((x) => x !== c.id))} />
      ))}
    </fieldset>
  );
}

// ------------------------------------------------------------------ Drive media
function DriveFileImport({ item, onImported }: { item: SourceItemDto; onImported: (i: ImportDto) => void }) {
  const { data, error, loading, refetch } = useApi<DriveFilePreviewDto>(`/api/content-hub/items/${item.id}/preview?kind=file`);
  const [draft, setDraft] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  if (error && !data) return <ErrorState error={error} onRetry={refetch} />;
  if (loading || !data) return <SkeletonRows rows={4} />;
  const go = async () => {
    setBusy(true); setErr(null);
    try { onImported(await api.post<ImportDto>('/api/content-hub/imports', { source_item_id: item.id, action: 'media_asset', create_draft: draft }, { idempotent: true })); }
    catch (e) { setErr(e); } finally { setBusy(false); }
  };
  return (
    <div className="flex flex-col gap-4">
      <Facts items={[
        ['Account', data.account_label], ['File', data.file.name], ['Type', `${data.file.mime_type}${data.file.size_bytes ? ` · ${fmtBytes(data.file.size_bytes)}` : ''}`],
        ['Brand', data.brand.name], ['Modified', data.file.modified_time ? fmtRelative(data.file.modified_time) : '—'],
        ...(data.file.shared_drive ? [['Location', 'Shared Drive'] as [string, string]] : []),
      ]} />
      <Banner tone="info" title="Sharing">{data.sharing_effect}</Banner>
      {data.blocked_reason ? <Banner tone="warn" title={data.blocked_reason} /> : <Checkbox label="Also create a draft with it" checked={draft} onChange={(e) => setDraft(e.target.checked)} />}
      {err ? <ErrorNotice error={err} /> : null}
      <div><Button variant="primary" onClick={go} loading={busy} disabledReason={data.can_import ? null : data.blocked_reason}>Import copy</Button></div>
    </div>
  );
}

// ------------------------------------------------------------------ Docs / Notion pages
function DocumentImport({ item, onImported }: { item: SourceItemDto; onImported: (i: ImportDto) => void }) {
  const [mode, setMode] = useState<SuggestionsMode>('exclude');
  const { data, error, loading, refetch } = useApi<DocumentPreviewDto>(`/api/content-hub/items/${item.id}/preview?kind=document&mode=${mode}`);
  const [picked, setSelected] = useState<string[] | null>(null);
  const [shape, setShape] = useState<'drafts' | 'single' | 'campaign'>('drafts');
  const [campaign, setCampaign] = useState('');
  const [dest, setDest] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  if (error && !data) return <ErrorState error={error} onRetry={refetch} />;
  if (loading || !data) return <SkeletonRows rows={6} />;
  // Default: every section; a section that disappeared from the source drops out of the selection.
  const selected = (picked ?? data.sections.map((x) => x.id)).filter((id) => data.sections.some((x) => x.id === id));
  const go = async () => {
    setBusy(true); setErr(null);
    try {
      onImported(await api.post<ImportDto>('/api/content-hub/imports', {
        source_item_id: item.id, action: shape === 'campaign' ? 'doc_campaign' : item.item_kind === 'notion_page' ? 'notion_page_draft' : 'doc_drafts',
        fingerprint: data.fingerprint, section_ids: selected, suggestions_mode: mode, combine: shape === 'single', campaign_name: shape === 'campaign' ? campaign : null, connection_ids: dest,
      }, { idempotent: true }));
    } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  return (
    <div className="flex flex-col gap-4">
      {item.item_kind === 'google_doc' ? (
        <Segmented label="Suggested edits" size="sm" value={mode} onChange={setMode}
          options={[{ value: 'exclude', label: 'Without suggestions' }, { value: 'accept', label: 'Suggestions accepted' }, { value: 'inline', label: 'Inline' }]} />
      ) : null}
      {data.incomplete ? <Banner tone="warn" title="Incomplete: part of the source could not be read" /> : null}
      {data.warnings.length ? (
        <ul className="flex flex-col gap-1 rounded-lg bg-sunken p-3 text-[13px]">
          {data.warnings.map((w) => <li key={`${w.code}${w.section_id}${w.message}`} className="flex gap-2"><AlertTriangle aria-hidden className="mt-0.5 size-3.5 shrink-0 text-[var(--brand-amber)]" />{w.message}{w.count > 1 ? ` (${w.count})` : ''}</li>)}
        </ul>
      ) : null}
      <fieldset className="flex max-h-[320px] flex-col gap-2 overflow-auto">
        <legend className="mb-1 text-[13px] font-medium">Sections</legend>
        {data.sections.map((s) => (
          <Checkbox key={s.id} checked={selected.includes(s.id)} onChange={(e) => setSelected(e.target.checked ? [...selected, s.id] : selected.filter((x) => x !== s.id))}
            label={`${s.tab_title && s.tab_title !== s.title ? `${s.tab_title} › ` : ''}${s.title}`}
            description={`${s.word_count} words · ${s.blocks.filter((b) => b.text).slice(0, 2).map((b) => b.text).join(' ').slice(0, 120)}`} />
        ))}
      </fieldset>
      <Segmented label="Create" size="sm" value={shape} onChange={setShape}
        options={[{ value: 'drafts', label: 'Draft per section' }, { value: 'single', label: 'One draft' }, { value: 'campaign', label: 'Campaign' }]} />
      {shape === 'campaign' ? <Field label="Campaign name"><Input value={campaign} onChange={(e) => setCampaign(e.target.value)} maxLength={120} /></Field> : null}
      <Destinations brandId={item.brand_id} value={dest} onChange={setDest} />
      <Banner tone="info" title="Snapshot">{data.visibility_notice}</Banner>
      {err ? <ErrorNotice error={err} /> : null}
      <div><Button variant="primary" onClick={go} loading={busy} disabledReason={!selected.length ? 'Select sections' : shape === 'campaign' && !campaign.trim() ? 'Name the campaign' : null}>Import</Button></div>
    </div>
  );
}

// ------------------------------------------------------------------ Notion data sources
const FIELDS: Array<[MappingField, string]> = [['title', 'Title'], ['body', 'Body'], ['campaign', 'Campaign'], ['target_date', 'Target date'], ['status', 'Status'], ['external_ref', 'External ref']];
const WB: Array<[WritebackField, string]> = [['status', 'Relay status'], ['scheduled_time', 'Scheduled time'], ['post_url', 'Post URLs']];

function DataSourceImport({ item, onImported, writebackAllowed }: { item: SourceItemDto; onImported: (i: ImportDto) => void; writebackAllowed: boolean }) {
  const schema = useApi<DataSourceSchemaDto>(`/api/content-hub/items/${item.id}/schema`);
  if (schema.error && !schema.data) return <ErrorState error={schema.error} onRetry={schema.refetch} />;
  if (schema.loading || !schema.data) return <SkeletonRows rows={6} />;
  return <DataSourceForm item={item} schema={schema.data} onImported={onImported} writebackAllowed={writebackAllowed} />;
}

function DataSourceForm({ item, schema, onImported, writebackAllowed }: { item: SourceItemDto; schema: DataSourceSchemaDto; onImported: (i: ImportDto) => void; writebackAllowed: boolean }) {
  const [mapping, setMapping] = useState<NotionMappingDto['mapping']>(schema.mapping?.mapping ?? {});
  const [statuses, setStatuses] = useState<string[]>(schema.mapping?.import_statuses ?? []);
  const [wb, setWb] = useState<NotionMappingDto['writeback']>(schema.mapping?.writeback ?? {});
  const [version, setVersion] = useState<number | null>(schema.mapping?.version ?? null);
  const [saved, setSaved] = useState(!!schema.mapping);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const rows = useApi<RowsPreviewDto>(saved ? `/api/content-hub/items/${item.id}/rows` : null);
  const [picked, setPicked] = useState<string[]>([]);
  const statusOptions = useMemo(() => schema.properties.find((p) => p.id === mapping.status)?.options ?? [], [schema, mapping.status]);
  const props = schema.properties;
  const save = async () => {
    setBusy(true); setErr(null);
    try {
      const m = await api.put<NotionMappingDto>(`/api/content-hub/items/${item.id}/mapping`, { mapping, import_statuses: statuses, writeback: wb, expected_version: version });
      setVersion(m.version); setSaved(true); await rows.refetch();
    } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  const importRows = async () => {
    setBusy(true); setErr(null);
    try { onImported(await api.post<ImportDto>('/api/content-hub/imports', { source_item_id: item.id, action: 'notion_rows', row_ids: picked }, { idempotent: true })); }
    catch (e) { setErr(e); } finally { setBusy(false); }
  };
  return (
    <div className="flex flex-col gap-4">
      <Banner tone="info" title="Statuses">{schema.approval_notice}</Banner>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {FIELDS.map(([f, label]) => (
          <Field key={f} label={label} optional>
            <Select value={mapping[f] ?? ''} onChange={(e) => { setSaved(false); setMapping({ ...mapping, [f]: e.target.value || undefined }); }}>
              <option value="">—</option>
              {f === 'body' ? <option value="page_content">Page content</option> : null}
              {props.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.type})</option>)}
            </Select>
          </Field>
        ))}
      </div>
      {statusOptions.length ? (
        <fieldset className="flex flex-wrap gap-3"><legend className="mb-1 w-full text-[13px] font-medium">Import rows with status</legend>
          {statusOptions.map((s) => <Checkbox key={s} label={s} checked={statuses.includes(s)} onChange={(e) => { setSaved(false); setStatuses(e.target.checked ? [...statuses, s] : statuses.filter((x) => x !== s)); }} />)}
        </fieldset>
      ) : null}
      {writebackAllowed ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          {WB.map(([f, label]) => (
            <Field key={f} label={`Write ${label.toLowerCase()} to`} optional>
              <Select value={wb[f] ?? ''} onChange={(e) => { setSaved(false); setWb({ ...wb, [f]: e.target.value || undefined }); }}>
                <option value="">Off</option>
                {props.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.type})</option>)}
              </Select>
            </Field>
          ))}
        </div>
      ) : null}
      {err ? <ErrorNotice error={err} /> : null}
      <div><Button onClick={save} loading={busy && !saved}>{saved ? 'Mapping saved' : 'Save mapping'}</Button></div>
      {saved ? (
        rows.error ? <ErrorState error={rows.error} onRetry={rows.refetch} /> : !rows.data ? <SkeletonRows rows={4} /> : (
          <div className="flex flex-col gap-2">
            {rows.data.incomplete ? <Banner tone="warn" title="Notion returned an incomplete list" /> : null}
            <ul className="flex max-h-[300px] flex-col gap-2 overflow-auto">
              {rows.data.rows.map((r) => (
                <li key={r.row_id}>
                  <Checkbox disabled={!r.importable} checked={picked.includes(r.row_id)} onChange={(e) => setPicked(e.target.checked ? [...picked, r.row_id] : picked.filter((x) => x !== r.row_id))}
                    label={`${r.title}${r.already_imported ? ' · imported' : ''}`}
                    description={r.errors.length ? r.errors.join(' · ') : [r.status, r.target_date, r.campaign].filter(Boolean).join(' · ')} />
                </li>
              ))}
            </ul>
            <div><Button variant="primary" onClick={importRows} loading={busy} disabledReason={!picked.length ? 'Select rows' : null}>Import {picked.length || ''} rows</Button></div>
          </div>
        )
      ) : null}
    </div>
  );
}

export function SourceImportDialog({ item, open, onOpenChange, writebackAllowed }: { item: SourceItemDto | null; open: boolean; onOpenChange: (o: boolean) => void; writebackAllowed: boolean }) {
  const [started, setStarted] = useState<ImportDto | null>(null);
  const imp = useImportStatus(started);
  if (!item) return null;
  return (
    <Dialog open={open} onOpenChange={onOpenChange} size="lg" title={item.title ?? 'Import'} description={<span className="inline-flex items-center gap-2">{item.account_label} <SourceStateBadge item={item} /></span>}>
      {imp ? <ImportResult imp={imp} /> : item.state !== 'linked' ? <Banner tone="warn" title={item.state_detail ?? 'Not readable right now'} /> :
        item.item_kind === 'drive_file' ? <DriveFileImport item={item} onImported={setStarted} />
          : item.item_kind === 'notion_data_source' ? <DataSourceImport item={item} onImported={setStarted} writebackAllowed={writebackAllowed} />
            : <DocumentImport item={item} onImported={setStarted} />}
    </Dialog>
  );
}
