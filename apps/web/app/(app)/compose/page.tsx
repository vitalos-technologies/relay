'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { ArrowRight, FileText, SquarePen } from 'lucide-react';
import { api } from '@/lib/client/api';
import { useSession } from '@/lib/client/session';
import { useApi } from '@/lib/client/use-api';
import { CsvImportDialog } from '@/components/import/csv-import-dialog';
import { SourceImportButton } from '@/components/content-hub/source-import-button';
import { useBrandFilter } from '@/lib/client/hooks';
import { fmtRelative, postTitle } from '@/lib/client/format';
import type { Page, PostDetail, PostSummary, Template } from '@/lib/client/types';
import {
  Banner, Button, Card, CardHeader, EmptyState, ErrorNotice, ErrorState, Field, LinkButton, PageHeader, PlatformStack,
  PostStatusBadge, Select, SkeletonRows,
} from '@/components/ui';

export default function ComposePage() {
  const { session, can } = useSession();
  const router = useRouter();
  const [brandFilter] = useBrandFilter();
  const [brandId, setBrandId] = useState(brandFilter || session.brands[0]?.id || '');
  const [templateId, setTemplateId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    if (brandFilter) setBrandId(brandFilter);
  }, [brandFilter]);
  useEffect(() => setTemplateId(''), [brandId]);

  const templates = useApi<{ items: Template[] }>(brandId ? `/api/brands/${brandId}/templates` : null);
  const drafts = useApi<Page<PostSummary>>(brandId ? `/api/brands/${brandId}/posts?status=draft` : null);

  if (!can('drafts.edit')) {
    return (
      <>
        <PageHeader title="Create" />
        <EmptyState icon={<SquarePen aria-hidden />} title="View-only access" />
      </>
    );
  }
  if (!session.brands.length) {
    return (
      <>
        <PageHeader title="Create" />
        <EmptyState icon={<SquarePen aria-hidden />} title="No brands yet" action={can('brands.manage') ? <LinkButton href="/settings/workspace/branding" variant="primary">Create brand</LinkButton> : null} />
      </>
    );
  }

  const create = async () => {
    if (!brandId) return;
    setBusy(true);
    setError(null);
    try {
      const p = await api.post<PostDetail>(`/api/brands/${brandId}/posts`, templateId ? { template_id: templateId } : {}, { idempotent: true });
      router.push(`/posts/${p.id}`);
    } catch (e) {
      setError(e);
      setBusy(false);
    }
  };

  const brand = session.brands.find((b) => b.id === brandId);

  return (
    <>
      <PageHeader title="Create" />
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <Card aria-labelledby="h-new">
          <CardHeader id="h-new" title="New post" />
          <div className="flex flex-col gap-4 p-4">
            <Field label="Brand">
              <Select value={brandId} onChange={(e) => setBrandId(e.target.value)}>
                {session.brands.map((b) => <option key={b.id} value={b.id}>{b.name}{b.publishing_paused ? ' (paused)' : ''}</option>)}
              </Select>
            </Field>
            {brand?.publishing_paused ? <Banner tone="warn" title="Brand paused" /> : null}
            {brand?.approval_required ? <Banner tone="info" title="Approval required" /> : null}
            <Field label="Template" optional error={templates.error ? 'Templates couldn’t load.' : undefined}>
              <Select value={templateId} onChange={(e) => setTemplateId(e.target.value)} disabled={!templates.data?.items.length}>
                <option value="">{templates.loading ? 'Loading…' : templates.data?.items.length ? 'Blank post' : 'No templates'}</option>
                {templates.data?.items.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </Select>
            </Field>
            {error ? <ErrorNotice error={error} /> : null}
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="primary" onClick={create} loading={busy} disabledReason={!brandId ? 'Choose a brand.' : null}>
                Create draft <ArrowRight aria-hidden className="size-4" />
              </Button>
              <CsvImportDialog brandId={brandId} />
              <SourceImportButton brandId={brandId} />
            </div>
          </div>
        </Card>

        <Card aria-labelledby="h-drafts">
          <CardHeader id="h-drafts" title="Drafts" />
          <div className="px-2 pb-2">
            {drafts.error && !drafts.data ? <ErrorState error={drafts.error} onRetry={drafts.refetch} /> : drafts.loading ? <SkeletonRows rows={3} /> : !drafts.data?.items.length ? (
              <EmptyState compact icon={<FileText aria-hidden />} title="No drafts yet" />
            ) : (
              <ul className="flex flex-col">
                {drafts.data.items.slice(0, 10).map((p) => (
                  <li key={p.id}>
                    <Link href={`/posts/${p.id}`} className="flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-raised/60">
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[13px] font-medium">{postTitle(p)}</p>
                        <p className="text-xs text-muted">Edited {fmtRelative(p.updated_at)}</p>
                      </div>
                      {p.destinations.length ? <PlatformStack providers={p.destinations.map((d) => d.provider)} /> : null}
                      <span className="hidden shrink-0 sm:block"><PostStatusBadge status={p.status} simulated={p.destinations.length > 0 && p.destinations.every((d) => d.is_mock)} size="sm" /></span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Card>
      </div>
    </>
  );
}
