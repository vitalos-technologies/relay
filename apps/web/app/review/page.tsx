'use client';
import Link from 'next/link';
import { ArrowRight, Inbox } from 'lucide-react';
import { useApi } from '@/lib/client/use-api';
import { fmtRelative } from '@/lib/client/format';
import type { Provider } from '@social-lite/core';
import { Badge, EmptyState, ErrorState, PageHeader, PlatformStack, SkeletonRows, TimeWithZone } from '@/components/ui';

interface Item {
  id: string; brand: { id: string; name: string }; decision: string; excerpt: string; requested_at: string; review_due_at: string | null;
  publish_at: string | null; input_timezone: string; current_stage: number; stage_count: number; providers: Provider[];
}
const TONE: Record<string, { label: string; tone: 'info' | 'success' | 'danger' | 'neutral' }> = {
  pending: { label: 'Waiting', tone: 'info' }, approved: { label: 'Approved', tone: 'success' }, rejected: { label: 'Changes requested', tone: 'danger' },
};

/** Only the review requests explicitly shared with the signed-in client. */
export default function ReviewListPage() {
  const { data, error, loading, refetch } = useApi<{ items: Item[] }>('/api/review', { poll: 60_000 });
  return (
    <>
      <PageHeader title="For your review" />
      {error && !data ? <ErrorState error={error} onRetry={refetch} /> : loading || !data ? <SkeletonRows rows={3} /> : !data.items.length ? (
        <EmptyState icon={<Inbox aria-hidden />} title="Nothing to review" />
      ) : (
        <ul className="flex flex-col divide-y divide-border rounded-xl border border-border bg-surface">
          {data.items.map((r) => {
            const t = TONE[r.decision] ?? TONE.pending!;
            return (
              <li key={r.id}>
                <Link href={`/review/${r.id}`} className="focus-inset flex items-center gap-3 px-4 py-4 hover:bg-raised/50">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{r.excerpt || 'Post'}</p>
                    <p className="mt-1 truncate text-xs text-muted">
                      {r.brand.name}
                      {r.publish_at ? <> · goes out <TimeWithZone instant={r.publish_at} tz={r.input_timezone} /></> : null}
                      {r.review_due_at ? <> · review by <TimeWithZone instant={r.review_due_at} tz={r.input_timezone} /></> : null}
                      {' · '}{fmtRelative(r.requested_at)}
                    </p>
                  </div>
                  {r.providers.length ? <span className="hidden sm:block"><PlatformStack providers={r.providers} size="sm" /></span> : null}
                  <Badge tone={t.tone}>{t.label}</Badge>
                  <ArrowRight aria-hidden className="hidden size-4 text-subtle sm:block" />
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
