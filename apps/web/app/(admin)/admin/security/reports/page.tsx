'use client';
// Problem reports (V3.1 §16 support reports) sent from "Report a problem": already redacted on the server; shown with
// their safe correlation references so an admin can match them to the audit log and operations data.
import { MessageSquareWarning } from 'lucide-react';
import type { SupportReportDto } from '@social-lite/core/contracts/v31-gov';
import { useApi } from '@/lib/client/use-api';
import { Badge, Card, EmptyState, ErrorState, PageHeader, SkeletonRows } from '@/components/ui';
import { Ago } from '@/components/admin/ui';

export default function AdminReportsPage() {
  const { data, error, loading, refetch } = useApi<{ items: Array<SupportReportDto & { created_at?: string; reporter_email?: string | null }> }>('/api/support/reports');
  return (
    <>
      <PageHeader title="Problem reports" />
      {error && !data ? <ErrorState error={error} onRetry={refetch} /> : loading || !data ? <SkeletonRows rows={4} /> : !data.items.length ? <EmptyState icon={<MessageSquareWarning aria-hidden />} title="No reports" /> : (
        <ul className="flex flex-col gap-3">
          {data.items.map((r) => (
            <Card as="li" key={r.id} className="p-4">
              <p className="flex flex-wrap items-center gap-2 text-[13px]"><Badge>{r.category}</Badge>{r.route ? <code className="text-[12px] text-muted">{r.route}</code> : null}{r.app_version ? <span className="text-xs text-muted">v{r.app_version}</span> : null}<span className="ml-auto text-xs text-muted"><Ago at={r.created_at ?? r.occurred_at} /></span></p>
              <p className="mt-2 whitespace-pre-wrap break-words text-[14px]">{r.summary}</p>
              {r.correlation_ids.length ? <p className="mt-2 break-all text-xs text-muted">References: {r.correlation_ids.join(', ')}</p> : null}
            </Card>
          ))}
        </ul>
      )}
    </>
  );
}
