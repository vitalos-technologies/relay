'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { ArrowRight, FileText, SquarePen } from 'lucide-react';
import { api } from '@/lib/client/api';
import { useSession } from '@/lib/client/session';
import { useApi } from '@/lib/client/use-api';
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
        <PageHeader title="Compose" />
        <EmptyState icon={<SquarePen aria-hidden />} title="You can’t create posts">Your role can view content but not create drafts. Ask a workspace admin if you need editor access.</EmptyState>
      </>
    );
  }
  if (!session.brands.length) {
    return (
      <>
        <PageHeader title="Compose" />
        <EmptyState icon={<SquarePen aria-hidden />} title="Create a brand first" action={can('brands.manage') ? <LinkButton href="/settings?tab=brand" variant="primary">Create a brand</LinkButton> : null}>
          Posts belong to a brand, which holds its connected accounts and media.
        </EmptyState>
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
      <PageHeader title="Compose" description="Start a post for one brand. You’ll choose destinations and tailor each one next." />
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <Card aria-labelledby="h-new">
          <CardHeader id="h-new" title="New post" />
          <div className="flex flex-col gap-5 p-5">
            <Field label="Brand">
              <Select value={brandId} onChange={(e) => setBrandId(e.target.value)}>
                {session.brands.map((b) => <option key={b.id} value={b.id}>{b.name}{b.publishing_paused ? ' (paused)' : ''}</option>)}
              </Select>
            </Field>
            {brand?.publishing_paused ? <Banner tone="warn">Publishing is paused for {brand.name}. You can still write and schedule.</Banner> : null}
            {brand?.approval_required ? <Banner tone="info">{brand.name} requires approval before anything is published.</Banner> : null}
            <Field label="Start from a template" optional hint={templates.error ? 'Templates couldn’t be loaded.' : undefined}>
              <Select value={templateId} onChange={(e) => setTemplateId(e.target.value)} disabled={!templates.data?.items.length}>
                <option value="">{templates.loading ? 'Loading…' : templates.data?.items.length ? 'Blank post' : 'No templates for this brand'}</option>
                {templates.data?.items.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </Select>
            </Field>
            {error ? <ErrorNotice error={error} /> : null}
            <Button variant="primary" size="lg" onClick={create} loading={busy} disabledReason={!brandId ? 'Choose a brand.' : null}>
              Create draft <ArrowRight aria-hidden className="size-4" />
            </Button>
          </div>
        </Card>

        <Card aria-labelledby="h-drafts">
          <CardHeader id="h-drafts" title="Continue a draft" description={brand ? brand.name : undefined} />
          <div className="p-4">
            {drafts.error && !drafts.data ? <ErrorState error={drafts.error} onRetry={drafts.refetch} /> : drafts.loading ? <SkeletonRows rows={3} /> : !drafts.data?.items.length ? (
              <EmptyState compact icon={<FileText aria-hidden />} title="No drafts yet">Drafts you start are saved automatically and listed here.</EmptyState>
            ) : (
              <ul className="flex flex-col gap-2">
                {drafts.data.items.slice(0, 10).map((p) => (
                  <li key={p.id}>
                    <Link href={`/posts/${p.id}`} className="flex items-center gap-3 rounded-lg border border-border bg-sunken px-3 py-2.5 hover:border-border-strong">
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[13px] font-medium">{postTitle(p)}</p>
                        <p className="text-xs text-muted">Edited {fmtRelative(p.updated_at)}</p>
                      </div>
                      {p.destinations.length ? <PlatformStack providers={p.destinations.map((d) => d.provider)} /> : null}
                      <PostStatusBadge status={p.status} size="sm" />
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
