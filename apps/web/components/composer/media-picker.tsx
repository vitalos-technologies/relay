'use client';
import { useEffect, useState } from 'react';
import { Check, ImageOff, Search } from 'lucide-react';
import { useApi } from '@/lib/client/use-api';
import { useDebouncedValue } from '@/lib/client/hooks';
import type { Asset, Page } from '@/lib/client/types';
import { Button, cn, Dialog, EmptyState, ErrorState, Input, Skeleton, Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui';
import { UploadDropzone } from '@/components/library/upload-dropzone';

/** Choose ready images from the brand library or upload new ones. */
export function MediaPicker({
  open, onOpenChange, brandId, selected, max, onConfirm, onAssetsSeen, canUpload,
}: {
  open: boolean; onOpenChange: (o: boolean) => void; brandId: string; selected: string[]; max: number;
  onConfirm: (ids: string[]) => void; onAssetsSeen: (a: Asset[]) => void; canUpload: boolean;
}) {
  const [picked, setPicked] = useState<string[]>(selected);
  const [q, setQ] = useState('');
  const dq = useDebouncedValue(q, 300);
  const [tab, setTab] = useState('library');
  useEffect(() => {
    if (open) setPicked(selected);
  }, [open, selected]);

  const path = open ? `/api/brands/${brandId}/assets?status=ready${dq ? `&q=${encodeURIComponent(dq)}` : ''}` : null;
  const { data, error, loading, refetch } = useApi<Page<Asset>>(path, { keepPrevious: true });
  useEffect(() => {
    if (data?.items) onAssetsSeen(data.items);
  }, [data, onAssetsSeen]);

  const toggle = (id: string) => {
    setPicked((p) => {
      if (p.includes(id)) return p.filter((x) => x !== id);
      if (max === 1) return [id];
      if (p.length >= max) return p;
      return [...p, id];
    });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      title="Add media"
      description={max === 1 ? 'Choose one image. Destinations in this release accept one image per post.' : `Choose up to ${max} images.`}
      footer={
        <>
          <span className="mr-auto text-xs text-muted" aria-live="polite">{picked.length} selected</span>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" onClick={() => { onConfirm(picked); onOpenChange(false); }}>Use selected</Button>
        </>
      }
    >
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList label="Media source">
          <TabsTrigger value="library">Library</TabsTrigger>
          <TabsTrigger value="upload" disabled={!canUpload}>Upload</TabsTrigger>
        </TabsList>
        <TabsContent value="library">
          <div className="relative mb-4">
            <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" />
            <label htmlFor="mp-q" className="sr-only">Search library</label>
            <Input id="mp-q" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by name or tag" className="pl-9" />
          </div>
          {error && !data ? <ErrorState error={error} onRetry={refetch} /> : loading ? (
            <div className="grid grid-cols-3 gap-3 sm:grid-cols-4">{Array.from({ length: 8 }, (_, i) => <Skeleton key={i} className="aspect-square h-auto w-full rounded-lg" />)}</div>
          ) : !data?.items.length ? (
            <EmptyState compact icon={<ImageOff aria-hidden />} title={dq ? 'No matching images' : 'No ready images yet'} action={canUpload ? <Button size="sm" onClick={() => setTab('upload')}>Upload an image</Button> : null}>
              Only images that passed checks can be used.
            </EmptyState>
          ) : (
            <ul className="grid grid-cols-3 gap-3 sm:grid-cols-4" aria-label="Library images">
              {data.items.map((a) => {
                const on = picked.includes(a.id);
                return (
                  <li key={a.id}>
                    <button
                      type="button"
                      aria-pressed={on}
                      onClick={() => toggle(a.id)}
                      className={cn('group relative block aspect-square w-full overflow-hidden rounded-lg border-2 bg-sunken', on ? 'border-[var(--focus)]' : 'border-transparent hover:border-border-strong')}
                    >
                      {a.thumb_url ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={a.thumb_url} alt={a.alt_text || a.original_filename} className="size-full object-cover" loading="lazy" />
                      ) : <span className="flex size-full items-center justify-center text-xs text-muted">{a.original_filename}</span>}
                      {on ? <span className="absolute right-1.5 top-1.5 flex size-6 items-center justify-center rounded-full bg-accent text-on-accent"><Check aria-hidden className="size-4" /></span> : null}
                      <span className="sr-only">{a.original_filename}{on ? ', selected' : ''}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </TabsContent>
        <TabsContent value="upload">
          <UploadDropzone
            brandId={brandId}
            onUploaded={(a) => {
              onAssetsSeen([a]);
              if (a.status === 'ready') {
                setPicked((p) => (max === 1 ? [a.id] : p.length < max ? [...p, a.id] : p));
                void refetch();
              }
            }}
          />
        </TabsContent>
      </Tabs>
    </Dialog>
  );
}
