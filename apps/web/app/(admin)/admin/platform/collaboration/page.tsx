'use client';
// Platform → Collaboration pipeline: installation-wide counts and ages only (no workspace content, names or discussions).
import { useApi } from '@/lib/client/use-api';
import { Card, CardHeader, ErrorState, Facts, MetricCard, PageHeader, SkeletonRows } from '@/components/ui';
import { HealthBadge, duration } from '@/components/admin/ui';

interface Health {
  window_hours: number; email_configured: boolean;
  notifications: { created: number; emailed: number; failed: number; not_configured: number; pending: number; oldest_pending: string | null; workspaces_with_failures: number };
  outbox: { pending: number; dead: number; oldest_pending_seconds: number };
  feed: { events: number; presence: number; overdue_tasks: number; overdue_reviews: number };
}

export default function PlatformCollaborationPage() {
  const { data, error, loading, refetch } = useApi<Health>('/api/platform/collaboration', { poll: 30_000 });
  return (
    <>
      <PageHeader title="Collaboration pipeline" />
      {error && !data ? <ErrorState error={error} onRetry={refetch} /> : loading || !data ? <SkeletonRows rows={6} /> : (
        <div className="flex flex-col gap-6">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <MetricCard label="Notifications (24 h)" value={data.notifications.created} />
            <MetricCard label="Emails sent (24 h)" value={data.notifications.emailed} />
            <MetricCard label="Email failures (24 h)" value={data.notifications.failed} tone={data.notifications.failed ? 'danger' : null} />
            <MetricCard label="Events waiting" value={data.outbox.pending} tone={data.outbox.oldest_pending_seconds > 120 ? 'warn' : null} />
          </div>
          <Card aria-labelledby="h-p">
            <CardHeader id="h-p" title="Health" actions={<HealthBadge state={data.outbox.dead || data.notifications.failed ? 'degraded' : !data.email_configured ? 'awaiting_setup' : 'healthy'} />} />
            <div className="px-4 pb-4">
              <Facts items={[
                ['Email', data.email_configured ? 'Configured' : 'Not configured (in-app only)'],
                ['Oldest waiting event', data.outbox.pending ? duration(data.outbox.oldest_pending_seconds) : '—'],
                ['Dead-lettered events', String(data.outbox.dead)],
                ['Workspaces with email failures', String(data.notifications.workspaces_with_failures)],
                ['Not configured (24 h)', String(data.notifications.not_configured)],
                ['Change-feed events (24 h)', String(data.feed.events)],
                ['Open presence sessions', String(data.feed.presence)],
                ['Overdue tasks · reviews', `${data.feed.overdue_tasks} · ${data.feed.overdue_reviews}`],
              ]} />
            </div>
          </Card>
        </div>
      )}
    </>
  );
}
