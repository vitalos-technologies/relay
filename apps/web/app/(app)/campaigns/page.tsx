'use client';
// Campaigns: per-brand list (GET/POST /api/brands/:id/campaigns, PATCH /api/campaigns/:id). Opening a campaign shows
// its posts in the Planner (list view, campaign filter).
import Link from 'next/link';
import { useState } from 'react';
import { Archive, ArchiveRestore, CalendarRange, Ellipsis, Flag, Plus } from 'lucide-react';
import { api } from '@/lib/client/api';
import { useSession } from '@/lib/client/session';
import { useApi } from '@/lib/client/use-api';
import { useBrandFilter, useQueryState } from '@/lib/client/hooks';
import type { SessionBrand } from '@/lib/client/types';
import {
  Button, Dialog, EmptyState, ErrorNotice, ErrorState, Field, FilterBar, IconButton, Input, Menu, MenuContent, MenuItem, MenuTrigger, PageHeader,
  SectionHeader, Segmented, SkeletonRows, Textarea, useToast,
} from '@/components/ui';

interface Campaign { id: string; brand_id: string; name: string; description: string | null; starts_on: string | null; ends_on: string | null; archived: boolean; created_at: string; post_count: number }

const fmt = (d: string) => new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${d}T12:00:00Z`));

export default function CampaignsPage() {
  const { session } = useSession();
  const [brand] = useBrandFilter();
  const [params, setParams] = useQueryState();
  const archived = params.get('archived') === '1';
  const brands = brand ? session.brands.filter((b) => b.id === brand) : session.brands;
  return (
    <>
      <PageHeader title="Campaigns" />
      <FilterBar>
        <Segmented size="sm" label="Show" value={archived ? 'archived' : 'active'} onChange={(v) => setParams({ archived: v === 'archived' ? '1' : null })}
          options={[{ value: 'active', label: 'Active' }, { value: 'archived', label: 'Archived' }]} />
      </FilterBar>
      {!brands.length ? <EmptyState icon={<Flag aria-hidden />} title="No brands yet" /> : (
        <div className="flex flex-col gap-6">
          {brands.map((b) => <BrandCampaigns key={b.id} brand={b} archived={archived} showHeading={brands.length > 1} />)}
        </div>
      )}
    </>
  );
}

function BrandCampaigns({ brand, archived, showHeading }: { brand: SessionBrand; archived: boolean; showHeading: boolean }) {
  const toast = useToast();
  const { data, error, loading, refetch } = useApi<{ items: Campaign[]; can_manage: boolean }>(`/api/brands/${brand.id}/campaigns${archived ? '?archived=1' : ''}`);
  const [editing, setEditing] = useState<Campaign | 'new' | null>(null);
  const today = new Date().toISOString().slice(0, 10);
  const setArchived = async (c: Campaign, a: boolean) => {
    try {
      await api.patch(`/api/campaigns/${c.id}`, { archived: a });
      toast.success(a ? 'Campaign archived' : 'Campaign restored');
      await refetch();
    } catch (e) {
      toast.error(e, 'Couldn’t update the campaign');
    }
  };
  // A brand without campaigns is one compact row, not a full empty-state block.
  if (showHeading && data && !data.items.length && !error) {
    return (
      <section aria-labelledby={`cb-${brand.id}`} className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-[var(--radius-card)] border border-dashed border-border px-4 py-3">
        <h2 id={`cb-${brand.id}`} className="text-[14px] font-semibold">{brand.name}</h2>
        <span className="text-[13px] text-muted">{archived ? 'No archived campaigns' : 'No campaigns'}</span>
        {data.can_manage && !archived ? <Button size="sm" variant="ghost" className="ml-auto" icon={<Plus aria-hidden className="size-4" />} onClick={() => setEditing('new')}>New campaign<span className="sr-only"> for {brand.name}</span></Button> : null}
        <CampaignDialog brandId={brand.id} campaign={editing} onClose={() => setEditing(null)} onSaved={() => void refetch()} />
      </section>
    );
  }
  return (
    <section aria-labelledby={`cb-${brand.id}`}>
      <SectionHeader
        id={`cb-${brand.id}`}
        title={showHeading ? brand.name : <span className="sr-only">{brand.name}</span>}
        count={showHeading && data ? data.items.length : null}
        actions={data?.can_manage && !archived ? <Button variant="primary" icon={<Plus aria-hidden className="size-4" />} onClick={() => setEditing('new')}>New campaign<span className="sr-only"> for {brand.name}</span></Button> : null}
      />
      {error && !data ? <ErrorState error={error} onRetry={refetch} /> : loading ? <SkeletonRows rows={2} /> : !data?.items.length ? (
        <EmptyState compact icon={<Flag aria-hidden />} title={archived ? 'No archived campaigns' : 'No campaigns yet'} />
      ) : (
        <ul className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {data.items.map((c) => {
            const live = (!c.starts_on || c.starts_on <= today) && (!c.ends_on || c.ends_on >= today);
            const upcoming = !!c.starts_on && c.starts_on > today;
            return (
              <li key={c.id} className="flex flex-col rounded-[var(--radius-card)] border border-border bg-surface p-4">
                <div className="flex items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <Link href={`/planner?view=agenda&brand=${brand.id}&campaign=${c.id}${c.starts_on ? `&date=${c.starts_on}` : ''}`} className="block truncate text-[15px] font-semibold hover:underline">{c.name}</Link>
                    <p className="mt-1 flex items-center gap-1.5 text-xs text-muted">
                      <CalendarRange aria-hidden className="size-3.5" />
                      {c.starts_on || c.ends_on ? `${c.starts_on ? fmt(c.starts_on) : '…'} – ${c.ends_on ? fmt(c.ends_on) : 'ongoing'}` : 'No dates'}
                    </p>
                  </div>
                  {data.can_manage ? (
                    <Menu>
                      <MenuTrigger asChild><IconButton label={`Actions for ${c.name}`} icon={<Ellipsis aria-hidden className="size-4" />} /></MenuTrigger>
                      <MenuContent>
                        {!c.archived ? <MenuItem onSelect={() => setEditing(c)}>Edit</MenuItem> : null}
                        {c.archived
                          ? <MenuItem icon={<ArchiveRestore aria-hidden />} onSelect={() => void setArchived(c, false)}>Restore</MenuItem>
                          : <MenuItem icon={<Archive aria-hidden />} onSelect={() => void setArchived(c, true)}>Archive</MenuItem>}
                      </MenuContent>
                    </Menu>
                  ) : null}
                </div>
                {c.description ? <p className="mt-2 line-clamp-2 text-[13px] text-muted">{c.description}</p> : null}
                <div className="mt-auto flex items-center justify-between gap-2 pt-4 text-xs">
                  <span className="tabular text-muted">{c.post_count} {c.post_count === 1 ? 'post' : 'posts'}</span>
                  {!c.archived ? <span className={live ? 'font-medium text-success' : 'text-muted'}>{live ? 'Running' : upcoming ? 'Upcoming' : 'Ended'}</span> : <span className="text-muted">Archived</span>}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <CampaignDialog brandId={brand.id} campaign={editing} onClose={() => setEditing(null)} onSaved={() => void refetch()} />
    </section>
  );
}

function CampaignDialog({ brandId, campaign, onClose, onSaved }: { brandId: string; campaign: Campaign | 'new' | null; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const c = campaign && campaign !== 'new' ? campaign : null;
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [lastKey, setLastKey] = useState<string | null>(null);
  const key = campaign === 'new' ? 'new' : c?.id ?? null;
  if (key !== lastKey) {
    setLastKey(key);
    setName(c?.name ?? ''); setDescription(c?.description ?? ''); setStart(c?.starts_on ?? ''); setEnd(c?.ends_on ?? ''); setError(null);
  }
  const bad = !!start && !!end && end < start;
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const body = { name: name.trim(), description: description.trim() || null, starts_on: start || null, ends_on: end || null };
      if (c) await api.patch(`/api/campaigns/${c.id}`, body);
      else await api.post(`/api/brands/${brandId}/campaigns`, body);
      toast.success(c ? 'Campaign saved' : 'Campaign created');
      onSaved();
      onClose();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={!!campaign} onOpenChange={(o) => !o && onClose()} busy={busy} title={c ? 'Edit campaign' : 'New campaign'}
      footer={<>
        <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
        <Button variant="primary" onClick={save} loading={busy} disabledReason={!name.trim() ? 'Enter a name.' : bad ? 'End must be after start.' : null}>{c ? 'Save' : 'Create'}</Button>
      </>}>
      <div className="flex flex-col gap-4">
        <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} autoFocus /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Starts" optional><Input type="date" value={start} onChange={(e) => setStart(e.target.value)} /></Field>
          <Field label="Ends" optional error={bad ? 'Before the start' : null}><Input type="date" value={end} min={start || undefined} onChange={(e) => setEnd(e.target.value)} /></Field>
        </div>
        <Field label="Description" optional><Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} maxLength={2000} className="min-h-20" /></Field>
        {error ? <ErrorNotice error={error} /> : null}
      </div>
    </Dialog>
  );
}
