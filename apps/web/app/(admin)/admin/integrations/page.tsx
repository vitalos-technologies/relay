'use client';
// Admin → Integrations and sync (stream F): per installation, the same health the integrations hub shows
// (integrationHealth): sync jobs, sync lag (age of the oldest waiting job), unconfirmed writes, webhook events, recent
// error codes; plus Slack delivery and Cloud Translation usage. Counts, states and safe codes only.
import Link from 'next/link';
import { useApi } from '@/lib/client/use-api';
import { Badge, Card, CardHeader, EmptyState, ErrorState, InfoTip, PageHeader, SimulatedBadge, SkeletonRows } from '@/components/ui';
import { Ago, duration } from '@/components/admin/ui';
import type { IntegrationsAdminOverview } from '@social-lite/services/admin/v35';
import { CONNECTOR_SLUG } from '@social-lite/core/contracts/v35-integrations';

const lag = (s: number | null) => (s === null ? 'None waiting' : duration(s));
const STATUS: Record<string, { label: string; tone: 'success' | 'warn' | 'danger' | 'neutral' }> = {
  active: { label: 'Active', tone: 'success' }, needs_attention: { label: 'Needs attention', tone: 'warn' }, reconnect_required: { label: 'Reconnect', tone: 'danger' }, paused: { label: 'Paused', tone: 'neutral' },
};

export default function AdminIntegrationsPage() {
  const { data, error, loading, refetch } = useApi<IntegrationsAdminOverview>('/api/admin/integrations', { poll: 30_000 });
  return (
    <>
      <PageHeader title="Integrations and sync" meta={<InfoTip label="About this page">Sync lag is the age of the oldest write waiting to reach the other app. Not confirmed = Relay is checking whether a write landed before trying again.</InfoTip>} />
      {error && !data ? <ErrorState error={error} onRetry={refetch} /> : loading || !data ? <SkeletonRows rows={6} /> : (
        <div className="flex flex-col gap-6">
          <Card aria-labelledby="h-i">
            <CardHeader id="h-i" title="Installations" actions={<Link href="/integrations" className="text-[13px] text-[var(--accent-text)]">Open Business apps</Link>} />
            {!data.integrations.length ? <EmptyState title="No integrations connected" /> : (
              <ul className="flex flex-col divide-y divide-border px-2 pb-2" data-testid="admin-integrations">
                {data.integrations.map((i) => {
                  const st = STATUS[i.status] ?? { label: i.status, tone: 'neutral' as const };
                  return (
                    <li key={i.id} className="flex flex-col gap-1.5 px-2 py-3 text-[13px]">
                      <div className="flex flex-wrap items-center gap-2">
                        <Link href={`/integrations/${CONNECTOR_SLUG[i.connector as keyof typeof CONNECTOR_SLUG] ?? i.connector}`} className="min-w-0 truncate font-medium hover:underline">{i.display_name.startsWith(i.name) ? i.display_name : `${i.name} · ${i.display_name}`}</Link>
                        {i.is_simulated && i.status === 'active' ? null : <Badge tone={st.tone}>{st.label}</Badge>}
                        {i.is_simulated ? <SimulatedBadge /> : null}
                      </div>
                      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-5">
                        <div><dt className="text-muted">Sync lag</dt><dd className="tabular">{lag(i.sync.lag_seconds)}</dd></div>
                        <div><dt className="text-muted">Waiting · running</dt><dd className="tabular">{i.sync.queued} · {i.sync.running}</dd></div>
                        <div><dt className="text-muted">Failed (24 h)</dt><dd className={`tabular ${i.sync.failed_24h ? 'text-danger' : ''}`}>{i.sync.failed_24h}</dd></div>
                        <div><dt className="text-muted">Not confirmed</dt><dd className={`tabular ${i.sync.unknown ? 'text-warn' : ''}`}>{i.sync.unknown}</dd></div>
                        <div><dt className="text-muted">Events waiting</dt><dd className="tabular">{i.events.pending}{i.events.failed_24h ? ` · ${i.events.failed_24h} failed` : ''}</dd></div>
                      </dl>
                      <p className="text-xs text-muted">Last success <Ago at={i.last_success_at} />{i.recent_errors[0] ? <> · last error <code className="[overflow-wrap:anywhere]">{i.recent_errors[0].code ?? 'error'}</code></> : null}</p>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <Card aria-labelledby="h-s">
              <CardHeader id="h-s" title="Slack alerts" />
              <dl className="grid grid-cols-2 gap-3 px-4 pb-4 text-[13px] sm:grid-cols-3">
                {([['Sent (24 h)', data.slack.sent_24h], ['Waiting', data.slack.queued], ['Held (quiet hours)', data.slack.deferred], ['Failed (24 h)', data.slack.failed_24h], ['Not confirmed', data.slack.unknown]] as const).map(([k, v]) => (
                  <div key={k}><dt className="text-muted">{k}</dt><dd className="text-[20px] font-semibold tabular">{v}</dd></div>
                ))}
              </dl>
            </Card>
            <Card aria-labelledby="h-t">
              <CardHeader id="h-t" title="Translation (30 days)" />
              <dl className="grid grid-cols-2 gap-3 px-4 pb-4 text-[13px]">
                <div><dt className="text-muted">Characters</dt><dd className="text-[20px] font-semibold tabular">{data.translation.characters_30d.toLocaleString()}</dd></div>
                <div><dt className="text-muted">Estimated cost</dt><dd className="text-[20px] font-semibold tabular">${data.translation.cost_estimate_usd_30d.toFixed(2)}</dd></div>
                {data.translation.simulated_characters_30d ? <div className="col-span-2 text-xs text-muted">Plus {data.translation.simulated_characters_30d.toLocaleString()} simulated characters (not billed)</div> : null}
              </dl>
            </Card>
          </div>
        </div>
      )}
    </>
  );
}
