'use client';
// Admin → Inbox health: backlog, reply outcomes, service-level breaches, channel status, inbound event ingestion and
// integration sync health. Counts and states only — message text is never shown here (operators without inbox access
// see the same view).
import Link from 'next/link';
import { useApi } from '@/lib/client/use-api';
import { Badge, Card, CardHeader, ErrorState, InfoTip, PageHeader, SimulatedBadge, SkeletonRows } from '@/components/ui';
import { Ago, StatTile, duration } from '@/components/admin/ui';
import type { InboxAdminOverview } from '@social-lite/services/inbox/admin';
import { CHANNEL_LABEL } from '@/components/inbox/labels';

export default function AdminInboxPage() {
  const { data, error, loading, refetch } = useApi<InboxAdminOverview>('/api/admin/inbox', { poll: 30_000 });
  return (
    <>
      <PageHeader title="Inbox health" meta={<InfoTip label="About this page">Counts come from the same conversations, sends and cases agents use. Message text is never shown here.</InfoTip>} />
      {error && !data ? <ErrorState error={error} onRetry={refetch} /> : loading || !data ? <SkeletonRows rows={6} /> : (
        <div className="flex flex-col gap-6">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <StatTile label="Waiting for a reply" state={data.backlog.unanswered ? 'degraded' : 'healthy'} value={data.backlog.unanswered}
              detail={data.backlog.oldest_unanswered_minutes !== null ? `Oldest ${duration(data.backlog.oldest_unanswered_minutes * 60)} · ${data.backlog.unassigned} unassigned` : `${data.backlog.unassigned} unassigned`} href="/inbox" />
            <StatTile label="Replies not confirmed" state={data.replies.unknown ? 'degraded' : 'healthy'} value={data.replies.unknown} detail={`${data.replies.queued + data.replies.sending} sending now`} href="/inbox?queue=all" />
            <StatTile label="Failed replies (24 h)" state={data.replies.failed_24h ? 'failed' : 'healthy'} value={data.replies.failed_24h} detail={`${data.replies.sent_24h} sent in 24 h`} href="/inbox?queue=all" />
            <StatTile label="Service-level breaches" state={data.sla.breached_open ? 'failed' : data.sla.at_risk_1h ? 'degraded' : 'healthy'} value={data.sla.breached_open} detail={`${data.sla.at_risk_1h} due within an hour`} href="/inbox" />
          </div>
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <Card aria-labelledby="h-ch">
              <CardHeader id="h-ch" title="Channels" actions={<Link href="/admin/settings/inbox/channels" className="text-[13px] text-[var(--accent-text)]">Manage</Link>} />
              <ul className="flex flex-col px-2 pb-2">
                {data.channels.map((c) => (
                  <li key={c.id} className="flex flex-wrap items-center gap-2 rounded-md px-2 py-2 text-[13px]">
                    <span className="min-w-0 flex-1 truncate font-medium">{CHANNEL_LABEL[c.kind as keyof typeof CHANNEL_LABEL] ?? c.kind} · {c.display_name}</span>
                    {c.is_simulated ? <SimulatedBadge /> : null}
                    <Badge tone={c.status === 'active' ? 'success' : 'warn'}>{c.status === 'active' ? 'Receiving' : c.status === 'needs_permission' ? 'Permission missing' : c.status}</Badge>
                    <span className="w-full text-xs text-muted">Last message <Ago at={c.last_inbound_at} /></span>
                  </li>
                ))}
                {!data.channels.length ? <li className="px-2 py-3 text-[13px] text-muted">No inbox channels</li> : null}
              </ul>
            </Card>
            <Card aria-labelledby="h-in">
              <CardHeader id="h-in" title="Inbound events" />
              <dl className="grid grid-cols-2 gap-3 px-4 pb-4 text-[13px]">
                <div><dt className="text-muted">Meta webhooks waiting</dt><dd className="text-[20px] font-semibold tabular">{data.ingestion.meta_receipts_pending}</dd></div>
                <div><dt className="text-muted">Integration events waiting</dt><dd className="text-[20px] font-semibold tabular">{data.ingestion.integration_events_pending}</dd></div>
                <div><dt className="text-muted">Failed (24 h)</dt><dd className="text-[20px] font-semibold tabular">{data.ingestion.integration_events_failed_24h}</dd></div>
                <div><dt className="text-muted">Gave up</dt><dd className="text-[20px] font-semibold tabular">{data.ingestion.integration_events_dead}</dd></div>
              </dl>
            </Card>
          </div>
          <Card aria-labelledby="h-int">
            <CardHeader id="h-int" title="Integrations" />
            <ul className="flex flex-col px-2 pb-2">
              {data.integrations.map((i) => (
                <li key={i.id} className="flex flex-wrap items-center gap-2 rounded-md px-2 py-2 text-[13px]">
                  <span className="min-w-0 flex-1 truncate font-medium">{i.name}</span>
                  {i.is_simulated ? <SimulatedBadge /> : null}
                  <Badge tone={i.status === 'active' ? 'success' : i.status === 'paused' ? 'neutral' : 'warn'}>{i.status === 'active' ? 'Active' : i.status}</Badge>
                  {i.jobs_failed_24h ? <Badge tone="danger">{i.jobs_failed_24h} failed</Badge> : null}
                  {i.jobs_unknown ? <Badge tone="warn">{i.jobs_unknown} not confirmed</Badge> : null}
                  <span className="text-xs text-muted">Last success <Ago at={i.last_success_at} /></span>
                </li>
              ))}
              {!data.integrations.length ? <li className="px-2 py-3 text-[13px] text-muted">No integrations connected</li> : null}
            </ul>
          </Card>
        </div>
      )}
    </>
  );
}
