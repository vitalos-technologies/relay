'use client';
// Platform → Inbox and AI pipeline (stream F): installation-wide counts only. No workspace names, conversations,
// mentions, prompts or outputs — platform operators do not gain access to customer conversations.
import { useApi } from '@/lib/client/use-api';
import { Card, CardHeader, ErrorState, Facts, MetricCard, PageHeader, SkeletonRows } from '@/components/ui';
import { HealthBadge, duration } from '@/components/admin/ui';
import type { PlatformCareHealth } from '@social-lite/services/admin/v35';

const secs = (s: number | null) => duration(s);
const sum = (r: Record<string, number>) => Object.values(r).reduce((a, b) => a + b, 0);

export default function PlatformCarePage() {
  const { data: d, error, loading, refetch } = useApi<PlatformCareHealth>('/api/platform/care', { poll: 30_000 });
  return (
    <>
      <PageHeader title="Inbox and AI pipeline" />
      {error && !d ? <ErrorState error={error} onRetry={refetch} /> : loading || !d ? <SkeletonRows rows={6} /> : (
        <div className="flex flex-col gap-6" data-testid="platform-care">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <MetricCard label="Replies sent (24 h)" value={d.inbox.replies_sent} />
            <MetricCard label="Replies failed (24 h)" value={d.inbox.replies_failed} tone={d.inbox.replies_failed ? 'danger' : null} />
            <MetricCard label="Replies not confirmed" value={d.inbox.replies_unknown} tone={d.inbox.replies_unknown ? 'warn' : null} />
            <MetricCard label="Sync jobs failed (24 h)" value={d.sync.jobs_failed} tone={d.sync.jobs_failed ? 'warn' : null} />
          </div>
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <Card aria-labelledby="h-q">
              <CardHeader id="h-q" title="Queues" actions={<HealthBadge state={d.ingestion.integration_events_dead || d.inbox.replies_unknown ? 'degraded' : 'healthy'} />} />
              <div className="px-4 pb-4"><Facts items={[
                ['Replies waiting', `${d.inbox.replies_queued} · oldest ${secs(d.inbox.oldest_queued_reply_seconds)}`],
                ['Sync jobs waiting', `${d.sync.jobs_queued} · oldest ${secs(d.sync.oldest_queued_seconds)}`],
                ['Sync writes not confirmed', String(d.sync.jobs_unknown)],
                ['Integration events waiting · gave up', `${d.ingestion.integration_events_pending} · ${d.ingestion.integration_events_dead}`],
                ['Meta webhooks waiting', String(d.ingestion.meta_receipts_pending)],
                ['Channel updates waiting', String(d.ingestion.inbound_events_unprocessed)],
              ]} /></div>
            </Card>
            <Card aria-labelledby="h-u">
              <CardHeader id="h-u" title="Usage" />
              <div className="px-4 pb-4"><Facts items={[
                ['Workspaces using inbox · integrations', `${d.workspaces.with_inbox} · ${d.workspaces.with_integrations}`],
                ['Workspaces using listening · automation', `${d.workspaces.with_listening} · ${d.workspaces.with_automation}`],
                ['Channels receiving · need attention', `${d.inbox.channels_active} · ${d.inbox.channels_attention}`],
                ['Installations to reconnect', String(d.sync.installations_reconnect)],
                ['Open service-level breaches', String(d.inbox.sla_breached_open)],
                ['Mentions collected · ingest failures (24 h)', `${d.listening.observations} · ${d.listening.ingest_failures}`],
                ['Listening alerts (24 h)', String(d.listening.alerts_fired)],
                ['AI runs (24 h) · tokens (30 days)', `${sum(d.ai.runs)} · ${d.ai.tokens_30d.toLocaleString()}`],
                ['Workspaces blocked by AI budget (24 h)', String(d.ai.workspaces_budget_blocked)],
                ['Automation runs (24 h) · active policies', `${sum(d.automation.runs)} · ${d.automation.policies_active}`],
                ['Emergency stops on', String(d.automation.emergency_stops_active)],
              ]} /></div>
            </Card>
          </div>
        </div>
      )}
    </>
  );
}
