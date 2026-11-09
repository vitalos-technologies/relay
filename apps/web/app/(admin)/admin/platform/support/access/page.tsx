'use client';
// Platform → Support → Support access (operator side): my requests and grants. Requests are made from a ticket or a workspace's page.
import Link from 'next/link';
import { LifeBuoy } from 'lucide-react';
import type { SupportAccessDto } from '@social-lite/core/contracts/v31-admin';
import { api } from '@/lib/client/api';
import { useApi } from '@/lib/client/use-api';
import { Badge, Button, Card, EmptyState, ErrorState, PageHeader, SkeletonRows, useToast } from '@/components/ui';
import { Ago } from '@/components/admin/ui';
import { SUPPORT_LABEL, SUPPORT_TONE } from '@/components/admin/badges';

export default function PlatformSupportPage() {
  const toast = useToast();
  const { data, error, loading, refetch } = useApi<{ items: SupportAccessDto[] }>('/api/platform/support-access', { poll: 30_000 });
  return (
    <>
      <PageHeader title="My support access" actions={<Link href="/admin/platform/workspaces" className="text-[13px] font-medium text-accent-text hover:underline">Find a workspace</Link>} />
      {error && !data ? <ErrorState error={error} onRetry={refetch} /> : loading || !data ? <SkeletonRows rows={4} /> : !data.items.length ? <EmptyState icon={<LifeBuoy aria-hidden />} title="No requests yet" /> : (
        <ul className="flex flex-col gap-3">
          {data.items.map((g) => (
            <Card as="li" key={g.id} className="flex flex-wrap items-start gap-3 p-4">
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-2 text-[14px] font-medium"><Link className="hover:underline" href={`/admin/platform/workspaces/${g.workspace_id}`}>{g.workspace_name}</Link><Badge tone={SUPPORT_TONE[g.status]}>{SUPPORT_LABEL[g.status]}</Badge></p>
                <p className="mt-1 text-[13px]">{g.reason}</p>
                <p className="mt-1 text-xs text-muted">Requested <Ago at={g.requested_at} />{g.status === 'active' ? <> · ends <Ago at={g.expires_at} /></> : null}{g.decided_by ? ` · ${g.decided_by}` : ''}{g.end_reason ? ` · ${g.end_reason.replace(/_/g, ' ')}` : ''}</p>
              </div>
              {g.status === 'requested' || g.status === 'active' ? (
                <Button size="sm" variant={g.status === 'active' ? 'danger' : 'secondary'} onClick={async () => { try { await api.post(`/api/platform/support-access/${g.id}/end`, {}); toast.success(g.status === 'active' ? 'Access ended' : 'Request cancelled'); await refetch(); } catch (e) { toast.error(e, 'Couldn’t complete that'); } }}>{g.status === 'active' ? 'End now' : 'Cancel request'}</Button>
              ) : null}
            </Card>
          ))}
        </ul>
      )}
    </>
  );
}
