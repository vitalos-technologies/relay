'use client';
// Admin overview (V3.1 Admin §6): what needs an admin now. Every tile drills into its records with filters in the URL.
import Link from 'next/link';
import { LifeBuoy, Pause, RefreshCw } from 'lucide-react';
import type { AdminOverview } from '@social-lite/core/contracts/v31-admin';
import { useApi } from '@/lib/client/use-api';
import { Banner, Button, Card, CardHeader, ErrorState, LinkButton, PageHeader, Skeleton } from '@/components/ui';
import { useAdminTopics } from '@/components/admin/sync';
import { Ago, StatTile } from '@/components/admin/ui';

export default function AdminOverviewPage() {
  const { data, error, loading, refetch, refreshing } = useApi<AdminOverview>('/api/admin/overview', { keepPrevious: true });
  useAdminTopics(['publishing', 'approvals', 'connections', 'audit', 'jobs', 'support', 'access'], refetch);
  return (
    <>
      <PageHeader title="Overview" meta={data ? <>Updated <Ago at={data.generated_at} /></> : undefined}
        actions={<Button size="sm" icon={<RefreshCw aria-hidden className="size-4" />} loading={refreshing} onClick={() => void refetch()}>Refresh</Button>} />
      {error && !data ? <ErrorState error={error} onRetry={refetch} /> : loading || !data ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">{Array.from({ length: 8 }, (_, i) => <Skeleton key={i} className="h-[132px] rounded-[var(--radius-card)]" />)}</div>
      ) : (
        <div className="flex flex-col gap-6">
          {data.workspace.paused ? (
            <Banner tone="warn" icon={<Pause aria-hidden className="size-4 text-warn" />} title="Publishing is paused for this workspace"
              actions={<LinkButton size="sm" href="/admin/operations">Manage</LinkButton>}>{data.workspace.paused_reason ?? undefined}</Banner>
          ) : null}
          {data.support_access.some((s) => s.status === 'requested') ? (
            <Banner tone="info" icon={<LifeBuoy aria-hidden className="size-4 text-info" />} title="Relay support asked for access"
              actions={<LinkButton size="sm" variant="primary" href="/admin/security/support">Review</LinkButton>} />
          ) : null}
          <section aria-label="Health" className="grid grid-cols-1 gap-3 min-[480px]:grid-cols-2 xl:grid-cols-4">
            {data.cards.map((c) => <StatTile key={c.key} label={c.label} state={c.state} value={c.value} detail={c.detail} href={c.href} />)}
          </section>
          {data.activity.length ? (
            <Card aria-labelledby="h-act">
              <CardHeader id="h-act" title="Recent admin activity" actions={<Link href="/admin/security/audit" className="text-[13px] font-medium text-accent-text hover:underline">Audit log</Link>} />
              <ul className="divide-y divide-border px-4 pb-2">
                {data.activity.map((a) => (
                  <li key={a.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 py-2.5 text-[13px]">
                    <span className="font-mono text-[12px]">{a.action}</span>
                    <span className="min-w-0 flex-1 truncate text-muted">{a.actor ?? 'system'}</span>
                    <Ago at={a.at} className="text-xs text-muted" />
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}
          {data.workspace.is_demo ? <p className="text-xs text-muted">Demo workspace · simulated activity is never counted as live.</p> : null}
        </div>
      )}
    </>
  );
}
