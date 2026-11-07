'use client';
import { useEffect, useState } from 'react';
import { Archive, CircleCheck, FileText, Hourglass, ImageOff, Images, OctagonX, Pencil, Plus, Search, Trash2 } from 'lucide-react';
import { api, isApiError } from '@/lib/client/api';
import { useSession } from '@/lib/client/session';
import { useApi } from '@/lib/client/use-api';
import { useBrandFilter, useDebouncedValue, useQueryState } from '@/lib/client/hooks';
import { fmtBytes, fmtRelative } from '@/lib/client/format';
import type { Asset, Page, Template } from '@/lib/client/types';
import {
  Badge, Banner, Button, Card, ConfirmDialog, Dialog, Drawer, EmptyState, ErrorNotice, ErrorState, Facts, Field, IconButton, Input,
  PageHeader, Pagination, Select, Skeleton, Tabs, TabsContent, TabsList, TabsTrigger, Textarea, useToast,
} from '@/components/ui';
import { UploadDropzone } from '@/components/library/upload-dropzone';

export default function LibraryPage() {
  const { session } = useSession();
  const [brandFilter] = useBrandFilter();
  const [params, setParams] = useQueryState();
  const tab = params.get('tab') === 'templates' ? 'templates' : 'assets';
  const [localBrand, setLocalBrand] = useState(session.brands[0]?.id ?? '');
  const brandId = brandFilter || localBrand;

  if (!session.brands.length) {
    return (
      <>
        <PageHeader title="Library" />
        <EmptyState icon={<Images aria-hidden />} title="No brands yet" />
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Library"
        actions={!brandFilter ? (
          <div className="w-[220px]">
            <label htmlFor="lib-brand" className="sr-only">Brand</label>
            <Select id="lib-brand" value={localBrand} onChange={(e) => setLocalBrand(e.target.value)}>
              {session.brands.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </Select>
          </div>
        ) : null}
      />
      <Tabs value={tab} onValueChange={(v) => setParams({ tab: v === 'assets' ? null : v })}>
        <TabsList label="Library sections">
          <TabsTrigger value="assets"><Images aria-hidden className="size-4" /> Media</TabsTrigger>
          <TabsTrigger value="templates"><FileText aria-hidden className="size-4" /> Templates</TabsTrigger>
        </TabsList>
        <TabsContent value="assets">{brandId ? <AssetsTab brandId={brandId} key={brandId} /> : null}</TabsContent>
        <TabsContent value="templates">{brandId ? <TemplatesTab brandId={brandId} key={brandId} /> : null}</TabsContent>
      </Tabs>
    </>
  );
}

// ------------------------------------------------------------------ assets
function AssetStatusChip({ a }: { a: Asset }) {
  switch (a.status) {
    case 'ready': return <Badge tone="success" icon={<CircleCheck aria-hidden className="size-3.5" />}>Ready</Badge>;
    case 'rejected': return <Badge tone="danger" icon={<OctagonX aria-hidden className="size-3.5" />} title={a.rejection_reason ?? undefined}>Rejected</Badge>;
    case 'archived': return <Badge icon={<Archive aria-hidden className="size-3.5" />}>Archived</Badge>;
    case 'pending_upload': return <Badge tone="info" icon={<Hourglass aria-hidden className="size-3.5" />}>Uploading</Badge>;
    default: return <Badge tone="info" icon={<Hourglass aria-hidden className="size-3.5" />}>Processing</Badge>;
  }
}

function AssetsTab({ brandId }: { brandId: string }) {
  const { can } = useSession();
  const [status, setStatus] = useState('');
  const [q, setQ] = useState('');
  const dq = useDebouncedValue(q, 300);
  const [cursors, setCursors] = useState<Array<string | null>>([null]);
  const cursor = cursors[cursors.length - 1];
  useEffect(() => setCursors([null]), [status, dq]);
  const qs = new URLSearchParams();
  if (status) qs.set('status', status);
  if (dq) qs.set('q', dq);
  if (cursor) qs.set('cursor', cursor);
  const { data, error, loading, refetch, setData } = useApi<Page<Asset>>(`/api/brands/${brandId}/assets${qs.size ? `?${qs}` : ''}`, {
    keepPrevious: true,
    poll: (d) => (d?.items.some((a) => a.status === 'quarantined' || a.status === 'pending_upload') ? 5_000 : false),
  });
  const [open, setOpen] = useState<Asset | null>(null);

  const upsert = (a: Asset) => setData((d) => ({ items: d?.items.some((x) => x.id === a.id) ? d.items.map((x) => (x.id === a.id ? a : x)) : [a, ...(d?.items ?? [])], next_cursor: d?.next_cursor ?? null }));

  return (
    <div className="flex flex-col gap-6">
      {can('assets.upload') ? <UploadDropzone brandId={brandId} compact onUploaded={(a) => { upsert(a); }} /> : null}
      <div className="flex flex-wrap gap-2">
        <div className="relative min-w-[200px] flex-1">
          <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" />
          <label htmlFor="lib-q" className="sr-only">Search media</label>
          <Input id="lib-q" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search" className="pl-9" />
        </div>
        <div className="w-[160px]">
          <label htmlFor="lib-status" className="sr-only">Status</label>
          <Select id="lib-status" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All statuses</option>
            <option value="ready">Ready</option>
            <option value="quarantined">Processing</option>
            <option value="rejected">Rejected</option>
            <option value="archived">Archived</option>
          </Select>
        </div>
      </div>

      {error && !data ? <ErrorState error={error} onRetry={refetch} /> : loading ? (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">{Array.from({ length: 10 }, (_, i) => <Skeleton key={i} className="aspect-[4/5] h-auto w-full rounded-xl" />)}</div>
      ) : !data?.items.length ? (
        <EmptyState icon={<ImageOff aria-hidden />} title={dq || status ? 'No matches' : 'No media yet'} />
      ) : (
        <>
          <ul className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
            {data.items.map((a) => (
              <li key={a.id}>
                <button type="button" onClick={() => setOpen(a)} className="group block w-full rounded-xl text-left">
                  <div className="relative aspect-square overflow-hidden rounded-xl bg-sunken transition-opacity group-hover:opacity-90">
                    {a.thumb_url ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={a.thumb_url} alt="" className="size-full object-cover" loading="lazy" />
                    ) : <span className="flex size-full items-center justify-center text-muted"><ImageOff aria-hidden className="size-6" /></span>}
                    {a.status !== 'ready' ? <span className="absolute left-2 top-2"><AssetStatusChip a={a} /></span> : null}
                  </div>
                  <div className="px-1 pt-2">
                    <p className="truncate text-[13px] font-medium">{a.original_filename}</p>
                    <p className="truncate text-xs text-muted tabular">
                      {a.width && a.height ? `${a.width}×${a.height} · ` : ''}{fmtBytes(a.bytes)}
                    </p>
                    {a.status === 'rejected' && a.rejection_reason ? <p className="mt-1 truncate text-xs text-danger" title={a.rejection_reason}>{a.rejection_reason}</p> : null}
                    {!a.alt_text && a.status === 'ready' ? <p className="mt-1 text-xs text-warn">No alt text</p> : null}
                  </div>
                </button>
              </li>
            ))}
          </ul>
          {data.next_cursor || cursors.length > 1 ? (
            <Pagination page={cursors.length} hasPrev={cursors.length > 1} hasNext={!!data.next_cursor} onPrev={() => setCursors((c) => c.slice(0, -1))} onNext={() => data.next_cursor && setCursors((c) => [...c, data.next_cursor!])} />
          ) : null}
        </>
      )}
      <AssetDrawer asset={open} onClose={() => setOpen(null)} onChanged={(a) => { upsert(a); setOpen(a); }} canEdit={can('assets.upload')} />
    </div>
  );
}

function AssetDrawer({ asset, onClose, onChanged, canEdit }: { asset: Asset | null; onClose: () => void; onChanged: (a: Asset) => void; canEdit: boolean }) {
  const toast = useToast();
  const [alt, setAlt] = useState('');
  const [tags, setTags] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [archiveOpen, setArchiveOpen] = useState(false);
  useEffect(() => {
    setAlt(asset?.alt_text ?? '');
    setTags((asset?.tags ?? []).join(', '));
    setError(null);
  }, [asset]);
  if (!asset) return null;
  const parsedTags = tags.split(',').map((t) => t.trim()).filter(Boolean);
  const changed = alt !== (asset.alt_text ?? '') || parsedTags.join(',') !== asset.tags.join(',');

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const a = await api.patch<Asset>(`/api/assets/${asset.id}`, { alt_text: alt.trim() || null, tags: parsedTags });
      onChanged(a);
      toast.success('Saved');
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Drawer
      open={!!asset}
      onOpenChange={(o) => !o && onClose()}
      title={asset.original_filename}
      description={`Added ${fmtRelative(asset.created_at)}`}
      footer={canEdit && asset.status !== 'archived' ? (
        <>
          <Button variant="quiet" icon={<Archive aria-hidden className="size-4" />} onClick={() => setArchiveOpen(true)} className="mr-auto">Archive</Button>
          <Button variant="primary" onClick={save} loading={busy} disabled={!changed}>Save</Button>
        </>
      ) : null}
    >
      <div className="flex flex-col gap-5">
        <div className="overflow-hidden rounded-xl bg-sunken">
          {asset.preview_url || asset.thumb_url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={(asset.preview_url || asset.thumb_url)!} alt={asset.alt_text || ''} className="max-h-[360px] w-full object-contain" />
          ) : <div className="flex h-48 items-center justify-center text-muted"><ImageOff aria-hidden className="size-6" /></div>}
        </div>
        {asset.status === 'rejected' ? <Banner tone="danger" title="Rejected">{asset.rejection_reason ?? 'Failed validation.'}</Banner> : null}
        {asset.status === 'quarantined' || asset.status === 'pending_upload' ? <Banner tone="info" title="Processing" /> : null}
        <Facts
          items={[
            ['Status', <AssetStatusChip key="s" a={asset} />],
            ['Type', asset.mime ?? '—'],
            ['Size (px)', asset.width && asset.height ? `${asset.width} × ${asset.height}` : '—'],
            ['File size', fmtBytes(asset.bytes)],
            ['Used in', `${asset.usage_count} post${asset.usage_count === 1 ? '' : 's'}`],
          ]}
        />
        <Field label="Alt text" info="Describes the image for screen readers. Sent where the network supports it.">
          <Textarea value={alt} onChange={(e) => setAlt(e.target.value)} rows={3} maxLength={1000} readOnly={!canEdit} />
        </Field>
        <Field label="Tags">
          <Input placeholder="Comma-separated" value={tags} onChange={(e) => setTags(e.target.value)} readOnly={!canEdit} />
        </Field>
        {error ? <ErrorNotice error={error} /> : null}
      </div>
      <ConfirmDialog
        open={archiveOpen}
        onOpenChange={setArchiveOpen}
        title="Archive image?"
        description="It can’t be added to new posts."
        confirmLabel="Archive"
        confirmVariant="danger"
        onConfirm={async () => {
          try {
            const a = await api.post<Asset>(`/api/assets/${asset.id}/archive`, {});
            onChanged(a);
            toast.success('Image archived');
          } catch (e) {
            if (isApiError(e) && e.status === 409) {
              throw new Error(`${e.message} Cancel that schedule first.`);
            }
            throw e;
          }
        }}
      />
    </Drawer>
  );
}

// ------------------------------------------------------------------ templates
function TemplatesTab({ brandId }: { brandId: string }) {
  const { can } = useSession();
  const toast = useToast();
  const { data, error, loading, refetch } = useApi<{ items: Template[] }>(`/api/brands/${brandId}/templates`);
  const [editing, setEditing] = useState<Template | 'new' | null>(null);
  const [deleting, setDeleting] = useState<Template | null>(null);
  const mayEdit = can('drafts.edit');

  return (
    <div className="flex flex-col gap-4">
      {mayEdit ? (
        <div className="flex justify-end">
          <Button variant="primary" icon={<Plus aria-hidden className="size-4" />} onClick={() => setEditing('new')}>New<span className="sr-only"> template</span></Button>
        </div>
      ) : null}
      {error && !data ? <ErrorState error={error} onRetry={refetch} /> : loading ? <Skeleton className="h-40 w-full rounded-xl" /> : !data?.items.length ? (
        <EmptyState icon={<FileText aria-hidden />} title="No templates yet" />
      ) : (
        <ul className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {data.items.map((t) => (
            <Card key={t.id} as="li" className="flex flex-col p-4">
              <div className="flex items-start justify-between gap-2">
                <h3 className="text-sm font-semibold">{t.name}</h3>
                {mayEdit ? (
                  <div className="-mr-1.5 -mt-1 flex">
                    <IconButton size="sm" label={`Edit ${t.name}`} icon={<Pencil aria-hidden className="size-4" />} onClick={() => setEditing(t)} />
                    <IconButton size="sm" label={`Delete ${t.name}`} icon={<Trash2 aria-hidden className="size-4" />} onClick={() => setDeleting(t)} />
                  </div>
                ) : null}
              </div>
              <p className="mt-2 line-clamp-4 whitespace-pre-wrap text-[13px] text-muted">{t.body}</p>
              {t.tags?.length ? <div className="mt-3 flex flex-wrap gap-1.5">{t.tags.map((g) => <Badge key={g}>{g}</Badge>)}</div> : null}
            </Card>
          ))}
        </ul>
      )}
      <TemplateDialog brandId={brandId} value={editing} onClose={() => setEditing(null)} onSaved={() => { void refetch(); }} />
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={`Delete “${deleting?.name ?? ''}”?`}
        description="Existing posts are unaffected."
        confirmLabel="Delete"
        confirmVariant="danger"
        onConfirm={async () => {
          if (!deleting) return;
          await api.del(`/api/templates/${deleting.id}`);
          toast.success('Template deleted');
          void refetch();
        }}
      />
    </div>
  );
}

function TemplateDialog({ brandId, value, onClose, onSaved }: { brandId: string; value: Template | 'new' | null; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState('');
  const [body, setBody] = useState('');
  const [tags, setTags] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    const t = value && value !== 'new' ? value : null;
    setName(t?.name ?? '');
    setBody(t?.body ?? '');
    setTags((t?.tags ?? []).join(', '));
    setError(null);
  }, [value]);
  const submit = async () => {
    setBusy(true);
    setError(null);
    const payload = { name: name.trim(), body, tags: tags.split(',').map((x) => x.trim()).filter(Boolean) };
    try {
      if (value === 'new') await api.post(`/api/brands/${brandId}/templates`, payload);
      else if (value) await api.patch(`/api/templates/${value.id}`, payload);
      onSaved();
      onClose();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  const fe = isApiError(error) ? error.fieldErrors : undefined;
  return (
    <Dialog
      open={!!value}
      onOpenChange={(o) => !o && onClose()}
      busy={busy}
      size="lg"
      title={value === 'new' ? 'New template' : 'Edit template'}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="primary" onClick={submit} loading={busy} disabledReason={!name.trim() ? 'Add a name.' : !body.trim() ? 'Add some text.' : null}>Save</Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="Name" error={fe?.name}><Input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} /></Field>
        <Field label="Text" error={fe?.body}><Textarea value={body} onChange={(e) => setBody(e.target.value)} rows={8} /></Field>
        <Field label="Tags" optional><Input placeholder="Comma-separated" value={tags} onChange={(e) => setTags(e.target.value)} /></Field>
        {error && !fe ? <ErrorNotice error={error} /> : null}
      </div>
    </Dialog>
  );
}
