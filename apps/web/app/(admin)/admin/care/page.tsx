'use client';
// Admin → Inbox, listening and AI (stream F): one overview over every V3.5 module, each tile from that stream's own
// admin service (inbox, integrations, listening, AI + automation) plus V3.5 audit counts. Counts and states only —
// message, mention and prompt text never appear in the admin app.
import Link from 'next/link';
import { useApi } from '@/lib/client/use-api';
import { Card, CardHeader, ErrorState, InfoTip, PageHeader, SkeletonRows } from '@/components/ui';
import { StatTile, duration } from '@/components/admin/ui';
import type { CareAdminSummary } from '@social-lite/services/admin/v35';


export default function AdminCarePage() {
  const { data, error, loading, refetch } = useApi<CareAdminSummary>('/api/admin/care', { poll: 30_000 });
  const d = data;
  const lag = d?.integrations ? Math.max(0, ...d.integrations.integrations.map((i) => i.sync.lag_seconds ?? 0)) : null;
  const syncFailed = d?.integrations ? d.integrations.integrations.reduce((n, i) => n + i.sync.failed_24h + i.sync.unknown, 0) : null;
  const sourcesAttention = d?.listening ? d.listening.sources.filter((s) => s.status === 'needs_attention').length : null;
  const sourcesActive = d?.listening ? d.listening.sources.filter((s) => s.status === 'active').length : 0;
  const aiFailed = d?.ai ? (d.ai.ai.runs_24h.failed ?? 0) + (d.ai.ai.runs_24h.blocked ?? 0) : null;
  const autoFailed = d?.ai ? (d.ai.automation.runs_24h.failed ?? 0) + (d.ai.automation.runs_24h.partial ?? 0) : null;
  return (
    <>
      <PageHeader title="Inbox, listening and AI" meta={<InfoTip label="About this page">Each number comes from the same records people use in Relay. Message, mention and prompt text are never shown here.</InfoTip>} />
      {error && !d ? <ErrorState error={error} onRetry={refetch} /> : loading || !d ? <SkeletonRows rows={6} /> : (
        <div className="flex flex-col gap-6" data-testid="care-admin">
          <section aria-labelledby="h-inbox" className="flex flex-col gap-3">
            <h2 id="h-inbox" className="text-[13px] font-medium text-muted">Inbox</h2>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <StatTile label="Waiting for a reply" state={!d.inbox ? 'unknown' : d.inbox.backlog.unanswered ? 'degraded' : 'healthy'} value={d.inbox?.backlog.unanswered ?? null}
                detail={d.inbox ? `${d.inbox.backlog.unassigned} unassigned${d.inbox.backlog.oldest_unanswered_minutes !== null ? ` · oldest ${duration(d.inbox.backlog.oldest_unanswered_minutes * 60)}` : ''}` : null} href="/admin/inbox" />
              <StatTile label="Failed replies (24 h)" state={!d.inbox ? 'unknown' : d.inbox.replies.failed_24h ? 'failed' : 'healthy'} value={d.inbox?.replies.failed_24h ?? null}
                detail={d.inbox ? `${d.inbox.replies.unknown} not confirmed · ${d.inbox.replies.sent_24h} sent` : null} href="/admin/inbox" />
              <StatTile label="Service-level breaches" state={!d.inbox ? 'unknown' : d.inbox.sla.breached_open ? 'failed' : d.inbox.sla.at_risk_1h ? 'degraded' : 'healthy'} value={d.inbox?.sla.breached_open ?? null}
                detail={d.inbox ? `${d.inbox.sla.at_risk_1h} due within an hour` : null} href="/admin/inbox" />
              <StatTile label="Channels needing attention" state={!d.inbox ? 'unknown' : d.inbox.channels.some((c) => c.status !== 'active' && c.status !== 'paused') ? 'degraded' : 'healthy'}
                value={d.inbox ? d.inbox.channels.filter((c) => c.status !== 'active' && c.status !== 'paused').length : null} detail={d.inbox ? `${d.inbox.channels.length} channels` : null} href="/admin/inbox" />
            </div>
          </section>
          <section aria-labelledby="h-int" className="flex flex-col gap-3">
            <h2 id="h-int" className="text-[13px] font-medium text-muted">Integrations, listening and AI</h2>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <StatTile label="Sync problems (24 h)" state={syncFailed === null ? 'unknown' : syncFailed ? 'degraded' : 'healthy'} value={syncFailed}
                detail={lag !== null ? `Sync lag ${lag ? duration(lag) : 'none'}` : null} href="/admin/integrations" />
              <StatTile label="Listening sources needing attention" state={sourcesAttention === null ? 'unknown' : sourcesAttention || d.listening!.failures.length ? 'degraded' : sourcesActive ? 'healthy' : 'awaiting_setup'} value={sourcesAttention}
                detail={d.listening ? `${sourcesActive} active · ${d.listening.observations.last_24h} mentions (24 h)` : null} href="/admin/listening" />
              <StatTile label="AI budget used" state={!d.ai ? 'unknown' : !d.ai.ai.configured ? 'awaiting_setup' : d.ai.ai.budget.remaining <= 0 ? 'failed' : aiFailed ? 'degraded' : 'healthy'}
                value={d.ai ? d.ai.ai.budget.used : null} detail={d.ai ? (d.ai.ai.configured ? `of ${d.ai.ai.budget.cap.toLocaleString()} tokens this month` : 'AI is not set up') : null} href="/admin/ai" />
              <StatTile label="Automation problems (24 h)" state={!d.ai ? 'unknown' : d.ai.automation.emergency_stop.active ? 'paused' : autoFailed ? 'degraded' : 'healthy'} value={autoFailed}
                detail={d.ai ? (d.ai.automation.emergency_stop.active ? 'Emergency stop is on' : `${Object.values(d.ai.automation.runs_24h).reduce((a, b) => a + b, 0)} runs · ${d.ai.automation.automated_replies_24h} automatic replies`) : null} href="/admin/ai" />
            </div>
          </section>
          {d.security_events_24h ? (
            <Card aria-labelledby="h-sec">
              <CardHeader id="h-sec" title="Security and audit (24 h)" actions={<Link href="/admin/security/audit?category=care" className="text-[13px] text-[var(--accent-text)]">Open audit log</Link>} />
              <dl className="grid grid-cols-2 gap-3 px-4 pb-4 text-[13px] sm:grid-cols-4">
                {[['Inbox and cases', (d.security_events_24h.by_area.inbox ?? 0) + (d.security_events_24h.by_area.case ?? 0)], ['Integrations', d.security_events_24h.by_area.integration ?? 0],
                  ['Listening, AI, automation', (d.security_events_24h.by_area.listening ?? 0) + (d.security_events_24h.by_area.ai ?? 0) + (d.security_events_24h.by_area.automation ?? 0)],
                  ['MCP calls denied', d.security_events_24h.denied_mcp]].map(([k, v]) => (
                  <div key={String(k)}><dt className="text-muted">{k}</dt><dd className="text-[20px] font-semibold tabular">{Number(v).toLocaleString()}</dd></div>
                ))}
              </dl>
            </Card>
          ) : null}
        </div>
      )}
    </>
  );
}
