'use client';
// Admin → Listening coverage (stream F over stream D's listeningAdminOverview): sources and their state, ingestion
// backlog and failures, alert volume. Counts only — mention text never appears in the admin app.
import Link from 'next/link';
import { useApi } from '@/lib/client/use-api';
import { Badge, Card, CardHeader, ErrorState, InfoTip, PageHeader, SkeletonRows } from '@/components/ui';
import { Ago } from '@/components/admin/ui';
import type { ListeningAdminOverview } from '@social-lite/services/listening/admin';

const STATE: Record<string, { label: string; tone: 'success' | 'warn' | 'neutral' | 'info' }> = {
  active: { label: 'Collecting', tone: 'success' }, needs_attention: { label: 'Needs attention', tone: 'warn' }, paused: { label: 'Paused', tone: 'neutral' },
  not_connected: { label: 'Not connected', tone: 'neutral' }, awaiting_activation: { label: 'Awaiting activation', tone: 'info' },
};

export default function AdminListeningPage() {
  const { data, error, loading, refetch } = useApi<ListeningAdminOverview>('/api/listening/admin', { poll: 60_000 });
  return (
    <>
      <PageHeader title="Listening coverage" meta={<InfoTip label="About this page">Connected sources come from inbox channels. Broader sources stay “Awaiting activation” until a provider is licensed.</InfoTip>} />
      {error && !data ? <ErrorState error={error} onRetry={refetch} /> : loading || !data ? <SkeletonRows rows={6} /> : (
        <div className="flex flex-col gap-6" data-testid="admin-listening">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {([['Mentions (24 h)', data.observations.last_24h], ['Mentions stored', data.observations.total], ['Removed at source', data.observations.removed_at_source], ['Open alerts', data.alerts.open]] as const).map(([k, v]) => (
              <Card key={k} className="p-4"><p className="text-[13px] text-muted">{k}</p><p className="mt-2 text-[24px] font-semibold tabular">{v.toLocaleString()}</p></Card>
            ))}
          </div>
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <Card aria-labelledby="h-src">
              <CardHeader id="h-src" title="Sources" actions={<Link href="/admin/settings/listening/sources" className="text-[13px] text-[var(--accent-text)]">Manage</Link>} />
              <ul className="flex flex-col px-2 pb-2">
                {data.sources.map((s) => {
                  const st = STATE[s.status] ?? { label: s.status, tone: 'neutral' as const };
                  return (
                    <li key={s.key} className="flex flex-wrap items-center gap-2 rounded-md px-2 py-2 text-[13px]">
                      <span className="min-w-0 flex-1 truncate font-medium">{s.label}</span>
                      {s.channels ? <span className="text-xs text-muted">{s.channels} channel{s.channels === 1 ? '' : 's'}</span> : null}
                      <Badge tone={st.tone}>{st.label}</Badge>
                    </li>
                  );
                })}
              </ul>
            </Card>
            <Card aria-labelledby="h-bl">
              <CardHeader id="h-bl" title="Ingestion" />
              <dl className="grid grid-cols-2 gap-3 px-4 pb-2 text-[13px]">
                <div><dt className="text-muted">Collected up to</dt><dd><Ago at={data.backlog.cursor_at} /></dd></div>
                <div><dt className="text-muted">Searches re-matching</dt><dd className="tabular">{data.backlog.pending_rematch}</dd></div>
                <div><dt className="text-muted">Waiting to re-process</dt><dd className="tabular">{data.backlog.pending_reprocess}</dd></div>
                <div><dt className="text-muted">Backfills requested</dt><dd className="tabular">{data.backlog.pending_backfill}</dd></div>
                <div><dt className="text-muted">Alerts (7 days)</dt><dd className="tabular">{data.alerts.last_7d}</dd></div>
                <div><dt className="text-muted">Alert rules on</dt><dd className="tabular">{data.alerts.rules}</dd></div>
              </dl>
              <h3 className="px-4 pt-2 text-xs font-medium text-muted">Recent failures</h3>
              <ul className="flex flex-col px-2 pb-3 text-xs">
                {data.failures.slice(0, 8).map((f, i) => (
                  <li key={i} className="flex flex-wrap gap-x-2 rounded-md px-2 py-1.5"><span className="font-medium">{f.source}</span><code className="[overflow-wrap:anywhere]">{f.code}</code><span className="text-muted"><Ago at={f.at} /></span></li>
                ))}
                {!data.failures.length ? <li className="px-2 py-1.5 text-muted">None</li> : null}
              </ul>
            </Card>
          </div>
        </div>
      )}
    </>
  );
}
