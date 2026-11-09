'use client';
// Listening home: what is monitored (coverage), open alerts, saved searches with their recent volume, share of voice
// (own vs competitors, observed data only) and saved dashboards. Brand scope follows the global brand filter.
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { BellRing, Plus, Radar, Settings2 } from 'lucide-react';
import type { AlertDto, DashboardDto, ListeningSourceState, SavedSearchDto } from '@social-lite/core/contracts/v35-listening';
import { useApi } from '@/lib/client/use-api';
import { useBrandFilter } from '@/lib/client/hooks';
import { useSession } from '@/lib/client/session';
import { Badge, Banner, BarList, Button, Card, CardHeader, EmptyState, ErrorState, LinkButton, PageHeader, SkeletonRows, cn } from '@/components/ui';
import { CoverageNote, Definition, ROLE_LABEL, fmtDay, fmtWhen, pct } from './shared';
import { SearchForm } from './search-form';
import type { ShareOfVoiceResponse } from './types';
import { HelpLink } from '@/components/help/help-link';

export function ListeningOverview() {
  const router = useRouter();
  const { session, canOn } = useSession();
  const [brand] = useBrandFilter();
  const q = brand ? `?brand_id=${brand}` : '';
  const searches = useApi<{ items: SavedSearchDto[] }>(`/api/listening/searches${q}`, { keepPrevious: true });
  const alerts = useApi<{ items: Array<AlertDto & { is_simulated: boolean }> }>(`/api/listening/alerts${q}${q ? '&' : '?'}state=open`, { poll: 60_000 });
  const sources = useApi<{ items: ListeningSourceState[] }>(`/api/listening/sources${q}`);
  const dashboards = useApi<{ items: DashboardDto[] }>(`/api/listening/dashboards${q}`);
  const [creating, setCreating] = useState(false);
  const canCreate = session.brands.some((b) => canOn(b.id, 'listening.manage'));

  // Share of voice: own vs competitor searches of the first brand that has both.
  const items = searches.data?.items ?? [];
  const sovBrand = [...new Set(items.map((s) => s.brand_id))].find((b) => items.some((s) => s.brand_id === b && s.role === 'own') && items.some((s) => s.brand_id === b && s.role === 'competitor'));
  const sovIds = sovBrand ? items.filter((s) => s.brand_id === sovBrand && s.role !== 'topic').slice(0, 6).map((s) => s.id) : [];
  const sov = useApi<ShareOfVoiceResponse>(sovIds.length >= 2 ? `/api/listening/share-of-voice?search_ids=${sovIds.join(',')}&days=30` : null);

  const connected = (sources.data?.items ?? []).filter((s) => s.layer === 'connected');
  const monitoring = connected.flatMap((s) => s.channels.filter((c) => !c.excluded));
  const awaiting = (sources.data?.items ?? []).filter((s) => s.status === 'awaiting_activation');
  const attention = connected.filter((s) => s.status === 'needs_attention');
  const simulatedOnly = monitoring.length > 0 && monitoring.every((c) => c.is_simulated);
  const since = monitoring.map((c) => c.monitoring_since).sort()[0];

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Listening" actions={<>
        <HelpLink slug="read-listening-results" label="About listening results" />
        <LinkButton href="/settings/listening/sources" variant="ghost" icon={<Settings2 aria-hidden />}>Sources</LinkButton>
        {canCreate ? <Button variant="primary" icon={<Plus aria-hidden />} onClick={() => setCreating(true)}>New search</Button> : null}
      </>} />

      <Card className="p-4">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div className="min-w-0">
            <p className="text-[14px] font-semibold">
              {monitoring.length ? `Monitoring ${monitoring.length} connected channel${monitoring.length === 1 ? '' : 's'}` : 'No channel monitored yet'}
              {simulatedOnly ? <Badge tone="info" className="ml-2 align-middle">Simulated</Badge> : null}
            </p>
            <p className="mt-1 text-[13px] text-muted">
              {monitoring.length ? `Public comments, mentions and reviews${since ? ` since ${fmtDay(since)}` : ''}. Private messages are never included.` : 'Add an inbox channel to collect public comments and reviews.'}
            </p>
          </div>
          <div className="flex flex-wrap gap-2 text-xs">
            {connected.filter((s) => s.channels.length).map((s) => <Badge key={s.key} tone={s.status === 'active' ? 'success' : 'warn'}>{s.label} · {s.channels.length}</Badge>)}
            {awaiting.length ? <Link href="/settings/listening/sources"><Badge tone="neutral">{awaiting.length} broader sources awaiting activation</Badge></Link> : null}
          </div>
        </div>
        {attention.length ? <Banner tone="warn" className="mt-3" title="Collection incomplete">{attention.map((a) => a.status_detail).filter(Boolean).join(' · ')}</Banner> : null}
      </Card>

      {alerts.data?.items.length ? (
        <section aria-labelledby="alerts-h" className="flex flex-col gap-2">
          <h2 id="alerts-h" className="flex items-center gap-2 text-[14px] font-semibold"><BellRing aria-hidden className="size-4 text-warn" />Open alerts</h2>
          <ul className="grid gap-2 md:grid-cols-2">
            {alerts.data.items.slice(0, 6).map((a) => (
              <li key={a.id}>
                <Link href={`/listening/alerts/${a.id}`} className="block rounded-[var(--radius-card)] border border-[color-mix(in_srgb,var(--warn)_40%,transparent)] bg-warn-soft/40 p-3 hover:bg-warn-soft">
                  <p className="text-[13px] font-medium">{a.rule.metric === 'negative' ? 'Negative spike' : 'Mention spike'} · {a.search.name}{a.is_simulated ? ' (simulated)' : ''}</p>
                  <p className="mt-0.5 text-xs text-muted">{a.observed} in {a.window.minutes} min · usual {a.baseline.mean} · {fmtWhen(a.created_at)}</p>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <div className="grid grid-cols-[minmax(0,1fr)] gap-6 xl:grid-cols-[minmax(0,1fr)_380px]">
        <Card className="self-start">
          <CardHeader title="Saved searches" />
          {searches.error && !searches.data ? <ErrorState error={searches.error} onRetry={searches.refetch} /> : !searches.data ? <SkeletonRows rows={4} className="p-4" /> : !items.length ? (
            <EmptyState compact icon={<Radar aria-hidden />} title="No saved searches" action={canCreate ? <Button variant="secondary" onClick={() => setCreating(true)}>New search</Button> : undefined} />
          ) : (
            <ul className="divide-y divide-border">
              {items.map((s) => (
                <li key={s.id}>
                  <Link href={`/listening/searches/${s.id}`} className="flex items-center gap-3 px-4 py-3 hover:bg-raised/50">
                    <div className="min-w-0 flex-1">
                      <p className="flex flex-wrap items-center gap-2 text-[14px] font-medium"><span className="truncate">{s.name}</span><Badge className="h-5 px-1.5 text-[11px]" tone={s.role === 'own' ? 'accent' : 'neutral'}>{ROLE_LABEL[s.role]}</Badge></p>
                      <p className="mt-0.5 truncate text-xs text-muted">{[...s.terms, ...s.keywords].slice(0, 4).join(', ') || s.boolean} · v{s.version}{s.rematch.state !== 'idle' ? ' · updating…' : ''}{s.alert_rules ? ` · ${s.alert_rules} alert${s.alert_rules > 1 ? 's' : ''}` : ''}</p>
                    </div>
                    <div className="shrink-0 text-right">
                      <p className="text-[15px] font-semibold tabular">{s.totals.last_7d}</p>
                      <p className="text-[11px] text-subtle">7 days · {s.totals.last_24h} today</p>
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <div className="flex flex-col gap-6">
          <Card>
            <CardHeader title={<span className="inline-flex items-center gap-1">Share of voice<Definition>Each search’s mentions ÷ the sum across compared searches, over the same sources and window. Observed data only.</Definition></span>}
              actions={sovIds.length >= 2 ? <LinkButton size="sm" variant="ghost" href={`/listening/compare?search_ids=${sovIds.join(',')}`}>Compare</LinkButton> : undefined} />
            <div className="px-4 pb-4">
              {!sovIds.length ? <p className="text-[13px] text-muted">Add an own-brand and a competitor search to compare.</p> : !sov.data ? <SkeletonRows rows={3} /> : (
                <>
                  <BarList label="Share of voice, last 30 days" rows={sov.data.rows.map((r) => ({ key: r.search.id, label: r.search.name, value: r.count, note: r.share === null ? 'No data' : undefined }))} />
                  <p className="mt-2 text-xs text-muted">{sov.data.rows.map((r) => `${r.search.name} ${pct(r.share)}`).join(' · ')} · of {sov.data.denominator}</p>
                  <CoverageNote coverage={sov.data.coverage} compact className="mt-2" />
                </>
              )}
            </div>
          </Card>
          <Card>
            <CardHeader title="Dashboards" actions={items.length ? <LinkButton size="sm" variant="ghost" href="/listening/dashboards/new">New</LinkButton> : undefined} />
            <div className="px-4 pb-4">
              {!dashboards.data?.items.length ? <p className="text-[13px] text-muted">No dashboards</p> : (
                <ul className="flex flex-col gap-1">{dashboards.data.items.map((d) => <li key={d.id}><Link className={cn('text-[13px] hover:underline')} href={`/listening/dashboards/${d.id}`}>{d.name}</Link>{!d.shared ? <span className="ml-2 text-xs text-subtle">Only you</span> : null}</li>)}</ul>
              )}
            </div>
          </Card>
        </div>
      </div>
      {creating ? <SearchForm open={creating} onOpenChange={setCreating} defaultBrand={brand || undefined} onSaved={(s) => router.push(`/listening/searches/${s.id}`)} /> : null}
    </div>
  );
}
