'use client';
// Webhooks (V3.1 Admin §12). Relay receives provider callbacks (signature-verified, stored as receipts) — listed here.
// Outbound customer webhook subscriptions don't exist in the product, so they are shown as not available (no fake UI).
import { useApi } from '@/lib/client/use-api';
import { Badge, Card, CardHeader, EmptyState, ErrorState, PageHeader, SkeletonRows } from '@/components/ui';
import { Ago, NotAvailable, RecordList } from '@/components/admin/ui';
import { useAdminTopics } from '@/components/admin/sync';

interface Receipt { id: string; provider: string; display_name: string | null; received_at: string; processing_state: string; processed_at: string | null; error: string | null }

export default function AdminWebhooksPage() {
  const { data, error, loading, refetch } = useApi<{ items: Receipt[] }>('/api/admin/webhooks');
  useAdminTopics(['connections', 'publishing'], refetch);
  return (
    <>
      <PageHeader title="Webhooks" />
      <div className="flex flex-col gap-6">
        <NotAvailable title="Outbound webhooks" why="Relay doesn’t send webhooks to your systems yet. Use the API with a service account, or MCP." />
        <Card className="overflow-hidden">
          <CardHeader title="Inbound provider callbacks" />
          {error && !data ? <ErrorState error={error} onRetry={refetch} /> : loading ? <SkeletonRows rows={4} /> : !data?.items.length ? <EmptyState compact title="No callbacks received" /> : (
            <RecordList caption="Inbound callbacks" rows={data.items} rowKey={(r) => r.id}
              columns={[
                { key: 'p', label: 'Network', cell: (r) => r.provider },
                { key: 'c', label: 'Account', cell: (r) => <span className="block max-w-[240px] truncate">{r.display_name ?? '—'}</span> },
                { key: 's', label: 'State', cell: (r) => <Badge tone={r.processing_state === 'failed' ? 'danger' : r.processing_state === 'processed' ? 'success' : 'neutral'}>{r.processing_state}</Badge> },
                { key: 'e', label: 'Error', secondary: true, cell: (r) => <span className="text-xs text-muted">{r.error ?? '—'}</span> },
                { key: 'at', label: 'Received', cell: (r) => <Ago at={r.received_at} className="text-muted" /> },
              ]}
              card={(r) => <span className="flex flex-col gap-1"><span className="font-medium">{r.provider} · {r.display_name ?? '—'}</span><span className="text-xs text-muted">{r.processing_state} · <Ago at={r.received_at} /></span></span>} />
          )}
        </Card>
        <p className="text-xs text-muted">Bodies are stored for processing only and never shown here. Signatures are verified before storage.</p>
      </div>
    </>
  );
}
