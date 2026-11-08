'use client';
// Problem reports (V3.1 §16 support reports) sent from "Report a problem": already redacted on the server; shown with
// their safe correlation references so an admin can match them to the audit log and operations data.
// V4: reports stay workspace-local until someone explicitly sends one to Relay support (review → submit).
import Link from 'next/link';
import { useState } from 'react';
import { MessageSquareWarning, Send } from 'lucide-react';
import type { SupportReportDto } from '@social-lite/core/contracts/v31-gov';
import { useApi } from '@/lib/client/use-api';
import { Badge, Button, Card, EmptyState, ErrorState, PageHeader, SkeletonRows } from '@/components/ui';
import { Ago } from '@/components/admin/ui';
import { ShareReportDialog } from '@/components/support/share-report';

type Row = SupportReportDto & { reporter_email?: string | null; browser_family?: string | null; error_code?: string | null; shared?: { ticket_id: string; reference: string | null; at: string | null } | null };

export default function AdminReportsPage() {
  const { data, error, loading, refetch } = useApi<{ items: Row[] }>('/api/support/reports');
  const [sharing, setSharing] = useState<string | null>(null);
  return (
    <>
      <PageHeader title="Problem reports" />
      {error && !data ? <ErrorState error={error} onRetry={refetch} /> : loading || !data ? <SkeletonRows rows={4} /> : !data.items.length ? <EmptyState icon={<MessageSquareWarning aria-hidden />} title="No reports" /> : (
        <ul className="flex flex-col gap-3">
          {data.items.map((r) => (
            <Card as="li" key={r.id} className="p-4">
              <p className="flex flex-wrap items-center gap-2 text-[13px]"><Badge>{r.category}</Badge>{r.route ? <code className="text-[12px] text-muted">{r.route}</code> : null}{r.app_version ? <span className="text-xs text-muted">v{r.app_version}</span> : null}{r.reporter_email ? <span className="text-xs text-muted">{r.reporter_email}</span> : null}<span className="ml-auto text-xs text-muted"><Ago at={r.created_at ?? r.occurred_at} /></span></p>
              <p className="mt-2 whitespace-pre-wrap break-words text-[14px]">{r.summary}</p>
              {r.correlation_ids.length ? <p className="mt-2 break-all text-xs text-muted">References: {r.correlation_ids.join(', ')}</p> : null}
              <div className="mt-3 flex flex-wrap items-center gap-2">
                {r.shared ? (
                  <Badge tone="success">Sent to Relay{r.shared.reference ? <> · <Link href={`/help/requests/${r.shared.reference}`} className="underline">{r.shared.reference}</Link></> : null}</Badge>
                ) : <Button size="sm" icon={<Send aria-hidden className="size-4" />} onClick={() => setSharing(r.id)}>Send to Relay support</Button>}
              </div>
            </Card>
          ))}
        </ul>
      )}
      <ShareReportDialog reportId={sharing} open={!!sharing} onOpenChange={(o) => { if (!o) { setSharing(null); void refetch(); } }} />
    </>
  );
}
