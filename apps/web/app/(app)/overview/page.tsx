'use client';
// V3 Overview: ≤4 operational tiles, upcoming timeline (thumbnails → post drawer), severity-ranked attention queue
// (Overdue banner + Manual handoff group kept), channel health (healthy accounts collapsed) and a performance summary
// from the analytics contract (coverage/freshness when there is no data — never sample curves).
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import {
  AlarmClock, CalendarClock, CheckCheck, CircleCheck, Hand, OctagonPause, Plug, Plus, Send, TriangleAlert,
} from 'lucide-react';
import { PROVIDER_LABEL } from '@social-lite/core';
import type { OverviewResponse } from '@social-lite/core/contracts/analytics';
import { api } from '@/lib/client/api';
import { useSession } from '@/lib/client/session';
import { useApi } from '@/lib/client/use-api';
import { useBrandFilter, useHrefWithBrand } from '@/lib/client/hooks';
import { connectionFix } from '@/lib/client/connection-fix';
import { fmtTime, localDateKey, postTitle, zoneAbbr } from '@/lib/client/format';
import type { ApprovalSummary, Dashboard, Delivery, PlannerItem, PostDetail } from '@/lib/client/types';
import {
  Badge, Banner, buttonClass, Card, CardHeader, ConnectionStatusBadge, ContentCard, CoverageMeter, DeliveryStateBadge, EmptyState, ErrorState, fmtMetric,
  LineChart, LinkButton, MetricCard, PageHeader, PlatformIcon, PostStatusBadge, SimulatedBadge, Skeleton, SkeletonRows, Thumb, useToast,
} from '@/components/ui';
import { DestinationDots } from '@/components/planner/agenda-item';
import { PostDrawer } from '@/components/planner/post-drawer';
import { OnboardingChecklist, ResumeOnboarding, useOnboarding } from '@/components/onboarding/checklist';
import { HelpLink } from '@/components/help/help-link';

const DAY = 86_400_000;
// Severity: an unconfirmed send may already be live (reconcile first), then hard failures, then missed deadlines, then blocked.
const SEVERITY: Array<{ key: keyof Dashboard['attention']; label: string }> = [
  { key: 'unknown', label: 'Not confirmed' }, { key: 'failed', label: 'Failed' }, { key: 'expired', label: 'Missed deadline' }, { key: 'blocked', label: 'Blocked' },
];

export default function OverviewPage() {
  const { session, can, canV2 } = useSession();
  const router = useRouter();
  const toast = useToast();
  const [brand] = useBrandFilter();
  const withBrand = useHrefWithBrand();
  const tz = session.brands.find((b) => b.id === brand)?.timezone ?? session.workspace?.timezone ?? 'Europe/London';
  const brandQ = brand ? `brand_id=${encodeURIComponent(brand)}` : '';
  const { data, error, loading, refetch } = useApi<Dashboard>(`/api/dashboard${brandQ ? `?${brandQ}` : ''}`, { poll: 30_000, keepPrevious: true });
  const [now] = useState(() => Date.now());
  const range = useMemo(() => ({ from: new Date(now - 7 * DAY).toISOString(), to: new Date(now + 7 * DAY).toISOString() }), [now]);
  const plan = useApi<{ items: PlannerItem[]; truncated?: boolean }>(`/api/planner?from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}&limit=400${brandQ ? `&${brandQ}` : ''}`, { poll: 60_000, keepPrevious: true });
  const approvals = useApi<{ items: ApprovalSummary[]; next_cursor?: string | null }>('/api/approvals?status=pending', { poll: 60_000 });
  const [drawer, setDrawer] = useState<PlannerItem | null>(null);
  const [showAllHealth, setShowAllHealth] = useState(false);
  const brandName = (id: string) => session.brands.find((b) => b.id === id)?.name ?? 'Unknown brand';
  const noBrands = session.brands.length === 0;

  const upcoming = (plan.data?.items ?? []).filter((i) => new Date(i.due_at).getTime() >= now && i.status !== 'cancelled');
  const scheduledWeek = upcoming.filter((i) => i.status === 'scheduled').length;
  const published = (plan.data?.items ?? []).filter((i) => new Date(i.due_at).getTime() < now && i.destinations.some((d) => d.state === 'published'));
  const publishedSimulated = published.length > 0 && published.every((i) => i.destinations.every((d) => d.is_mock));
  const critical = data ? SEVERITY.flatMap((s) => (data.attention[s.key] ?? []).map((d) => ({ d, label: s.label }))) : [];
  const handoff = data?.attention.handoff ?? [];
  const issues = critical.length + handoff.length;
  const pending = approvals.data ? `${approvals.data.items.length}${approvals.data.next_cursor ? '+' : ''}` : null;

  const duplicate = async (i: PlannerItem) => {
    try {
      const p = await api.post<PostDetail>(`/api/posts/${i.post_id}/duplicate`, {}, { idempotent: true });
      router.push(`/posts/${p.id}`);
    } catch (e) {
      toast.error(e, 'Could not duplicate the post');
    }
  };

  const ob = useOnboarding();
  const dateLabel = new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: tz }).format(new Date(now));

  return (
    <>
      <PageHeader
        title="Overview"
        meta={<span className="truncate">{dateLabel} · {zoneAbbr(new Date(now), tz)} · {brand ? brandName(brand) : 'All brands'}</span>}
        actions={<>
          <ResumeOnboarding ob={ob} />
          {can('drafts.edit') && !noBrands ? (
            <LinkButton href={withBrand('/compose')} variant="primary" icon={<Plus aria-hidden className="size-4" />}>Create post</LinkButton>
          ) : null}
        </>}
      />
      {ob.data && !ob.data.dismissed && !ob.data.complete ? <div className="mb-6"><OnboardingChecklist ob={ob} /></div> : null}

      {noBrands ? (
        <EmptyState icon={<Plug aria-hidden />} title="No brands yet" action={can('brands.manage') ? <LinkButton href="/settings/workspace/branding" variant="primary">Create brand</LinkButton> : null} />
      ) : error && !data ? (
        <ErrorState error={error} onRetry={refetch} />
      ) : (
        <div className="flex flex-col gap-6">
          {data?.paused.workspace ? <Banner tone="danger" icon={<OctagonPause aria-hidden className="size-4 text-danger" />} title="Workspace paused" /> : null}
          {data?.delayed && data.delayed.overdue > 0 ? (
            <Banner
              tone="warn"
              icon={<AlarmClock aria-hidden className="size-4 text-warn" />}
              title={`${data.delayed.overdue} ${data.delayed.overdue === 1 ? 'post is' : 'posts are'} overdue`}
              actions={can('diagnostics.read') ? <LinkButton href="/operations" size="sm">Operations</LinkButton> : null}
            >
              {!data.delayed.dispatch_enabled ? 'Publishing is off for maintenance. They send when it is back on, unless their deadline passes.'
                : data.delayed.publisher_running ? 'Publishing is running behind. These go out shortly.'
                  : 'The publisher is not running. They send when it restarts, unless their deadline passes.'}
            </Banner>
          ) : null}
          {data && data.paused.brands.length ? (
            <Banner tone="warn" icon={<OctagonPause aria-hidden className="size-4 text-warn" />} title={`Paused: ${data.paused.brands.map(brandName).join(', ')}`} />
          ) : null}

          {/* Operational summary: ≤ 4 tiles */}
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4 lg:gap-4">
            <MetricCard icon={<CalendarClock />} label="Scheduled" value={plan.data ? (plan.data.truncated ? `${scheduledWeek}+` : scheduledWeek) : '…'} foot="Next 7 days" href={withBrand('/planner')} />
            <MetricCard icon={<CheckCheck />} label="In review" value={pending ?? '…'} foot="Awaiting a decision" href="/approvals" />
            <MetricCard icon={<Send />} label="Published" value={plan.data ? (plan.data.truncated ? `${published.length}+` : published.length) : '…'} foot={publishedSimulated ? 'Last 7 days · simulated' : 'Last 7 days'} href={can('history.read') ? withBrand('/history') : undefined} />
            <MetricCard icon={<TriangleAlert />} label="Issues" value={data ? issues : '…'} foot="Unresolved deliveries" tone={issues ? 'danger' : null} href="#attention" />
          </div>

          <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1.55fr)_minmax(0,1fr)]">
            <div className="flex min-w-0 flex-col gap-6">
              {/* Upcoming timeline */}
              <Card aria-labelledby="h-upcoming">
                <CardHeader id="h-upcoming" title="Upcoming" actions={<LinkButton href={withBrand('/planner')} size="sm" variant="quiet">Planner</LinkButton>} />
                <div className="px-2 pb-3">
                  {plan.loading && !plan.data ? <SkeletonRows rows={4} /> : !upcoming.length ? (
                    <EmptyState compact title="Nothing scheduled" action={can('drafts.edit') ? <LinkButton href={withBrand('/compose')} size="sm">Create post</LinkButton> : null} />
                  ) : (
                    <Timeline items={upcoming.slice(0, 8)} tz={tz} onOpen={setDrawer} brandName={brand ? undefined : brandName} />
                  )}
                </div>
              </Card>

              {canV2('analytics.read') ? <PerformanceSummary brand={brand} demo={!!session.workspace?.is_demo} /> : null}
            </div>

            <div className="flex min-w-0 flex-col gap-6">
              {/* Attention queue */}
              <Card aria-labelledby="h-attention" id="attention" className="scroll-mt-20">
                <CardHeader id="h-attention" title={<>Needs attention{issues ? <span className="ml-2 font-normal text-muted tabular">{issues}</span> : null}</>}
                  actions={<HelpLink slug="delivery-statuses" iconOnly label="What delivery statuses mean" />} />
                <div className="px-4 pb-4">
                  {loading && !data ? <SkeletonRows rows={2} /> : !issues ? (
                    <p className="flex items-center gap-2 pb-1 text-[13px] text-muted"><CircleCheck aria-hidden className="size-4 text-success" /> All clear</p>
                  ) : (
                    <div className="flex flex-col gap-4">
                      {critical.length ? <AttentionList rows={critical} /> : null}
                      {handoff.length ? (
                        <div>
                          <h3 className="mb-2 flex items-center gap-1.5 text-xs font-medium text-muted"><Hand aria-hidden className="size-3.5" /> Manual handoff <span className="tabular">· {handoff.length}</span></h3>
                          <AttentionList rows={handoff.map((d) => ({ d, label: 'Manual handoff' }))} action="Open" />
                        </div>
                      ) : null}
                    </div>
                  )}
                </div>
              </Card>

              {/* Channel health: only the accounts that need something */}
              <Card aria-labelledby="h-health">
                <CardHeader id="h-health" title="Channel health" actions={<LinkButton href={withBrand('/accounts')} size="sm" variant="quiet">Connections</LinkButton>} />
                <div className="px-4 pb-4">
                  {loading && !data ? <Skeleton className="h-12 w-full" /> : !data?.account_warnings.length ? (
                    <p className="flex items-center gap-2 pb-1 text-[13px] text-muted"><CircleCheck aria-hidden className="size-4 text-success" /> All connections healthy</p>
                  ) : (
                    <ul className="flex flex-col divide-y divide-border">
                      {data.account_warnings.slice(0, showAllHealth ? undefined : 4).map((c) => {
                        const fix = connectionFix(c);
                        return (
                          <li key={c.id} className="flex items-center gap-3 py-2.5 first:pt-0 last:pb-0">
                            <PlatformIcon provider={c.provider} size="sm" />
                            <div className="min-w-0 flex-1">
                              <p className="truncate text-[13px] font-medium">{c.display_name}</p>
                              <p className="truncate text-xs text-muted" title={fix ?? undefined}>{fix ?? `${PROVIDER_LABEL[c.provider]} · ${brandName(c.brand_id)}`}</p>
                            </div>
                            {c.status === 'ready' && c.paused ? <ConnectionStatusBadge status="paused" size="sm" /> : <ConnectionStatusBadge status={c.status} label={c.status_label} size="sm" />}
                          </li>
                        );
                      })}
                      {data.account_warnings.length > 4 && !showAllHealth ? (
                        <li className="pt-2.5"><button type="button" onClick={() => setShowAllHealth(true)} className="text-[13px] font-medium text-muted hover:text-fg">Show {data.account_warnings.length - 4} more</button></li>
                      ) : null}
                    </ul>
                  )}
                </div>
              </Card>
            </div>
          </div>
        </div>
      )}

      <PostDrawer
        item={drawer}
        onOpenChange={(o) => !o && setDrawer(null)}
        brandName={drawer && !brand ? brandName(drawer.brand_id) : undefined}
        onDuplicate={can('drafts.edit') ? (i) => void duplicate(i) : undefined}
      />
    </>
  );
}

function Timeline({ items, tz, onOpen, brandName }: { items: PlannerItem[]; tz: string; onOpen: (i: PlannerItem) => void; brandName?: (id: string) => string }) {
  const today = localDateKey(new Date(), tz);
  const tomorrow = localDateKey(new Date(Date.now() + DAY), tz);
  const groups = new Map<string, PlannerItem[]>();
  for (const i of items) {
    const k = localDateKey(i.due_at, tz);
    groups.set(k, [...(groups.get(k) ?? []), i]);
  }
  const label = (k: string) => (k === today ? 'Today' : k === tomorrow ? 'Tomorrow'
    : new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(`${k}T12:00:00Z`)));
  return (
    <div className="flex flex-col gap-3">
      {[...groups.entries()].map(([k, list]) => (
        <section key={k} aria-label={label(k)}>
          <h3 className="px-2 pb-1 text-xs font-medium text-subtle">{label(k)}</h3>
          <ul className="flex flex-col">
            {list.map((i) => {
              const due = new Date(i.due_at);
              const allMock = i.destinations.length > 0 && i.destinations.every((d) => d.is_mock);
              return (
                <li key={i.schedule_id}>
                  <ContentCard
                    onClick={() => onOpen(i)}
                    label={`${postTitle(i)}, ${fmtTime(due, i.input_timezone)}`}
                    thumb={<Thumb src={i.thumb_url} kind={i.media_kind} provider={i.destinations[0]?.provider} className="size-12" />}
                    title={postTitle(i)}
                    meta={<>
                      <span className="shrink-0 font-medium text-fg tabular">{fmtTime(due, i.input_timezone)} <span className="font-normal text-muted">{zoneAbbr(due, i.input_timezone)}</span></span>
                      <DestinationDots destinations={i.destinations} />
                      {brandName ? <span className="min-w-0 truncate">{brandName(i.brand_id)}</span> : null}
                    </>}
                    trailing={<span className="hidden sm:inline-flex"><PostStatusBadge status={i.status} simulated={allMock} overdue={i.overdue} size="sm" /></span>}
                  />
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}

function AttentionList({ rows, action = 'Resolve' }: { rows: Array<{ d: Delivery & { post_title?: string | null }; label: string }>; action?: string }) {
  return (
    <ul className="flex flex-col divide-y divide-border">
      {rows.map(({ d }) => (
        <li key={d.id} className="flex items-center gap-3 py-2.5 first:pt-0 last:pb-0">
          <PlatformIcon provider={d.provider} size="sm" />
          <div className="min-w-0 flex-1">
            <p className="flex min-w-0 items-center gap-2 text-[13px] font-medium">
              <span className="truncate">{d.post_title || d.display_name}</span>{d.is_mock ? <SimulatedBadge className="shrink-0" /> : null}
            </p>
            <p className="truncate text-xs text-muted" title={d.blocked_reason ?? d.last_error_message ?? undefined}>
              {d.post_title ? `${d.display_name} · ` : ''}{d.blocked_reason ?? d.last_error_message ?? (d.state === 'unknown' ? 'Not confirmed — check before retrying' : d.state === 'expired' ? 'Missed its deadline' : d.state === 'handoff' ? 'Post it in the app' : '—')}
            </p>
          </div>
          <span className="hidden shrink-0 xl:block"><DeliveryStateBadge state={d.state} isMock={d.is_mock} overdue={d.overdue} size="sm" /></span>
          <Link href={`/posts/${d.post_id}#deliveries`} className={buttonClass('secondary', 'sm')}>
            {action}<span className="sr-only"> {d.display_name} ({d.state})</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

function PerformanceSummary({ brand, demo }: { brand: string; demo: boolean }) {
  const q = new URLSearchParams();
  if (brand) q.set('brand', brand);
  if (demo) q.set('dataset', 'demo');
  const { data, error, loading, refetch } = useApi<OverviewResponse>(`/api/analytics/overview?${q}`, { keepPrevious: true });
  const href = `/analytics${q.toString() ? `?${q}` : ''}`;
  const kpis = (data?.kpis ?? []).filter((k) => k.measure !== 'posts_published').slice(0, 3);
  const combined = data?.trend.combined;
  const health = data?.data_health;
  const hasData = !!health && health.coverage.with_data > 0;
  return (
    <Card aria-labelledby="h-perf">
      <CardHeader
        id="h-perf"
        title={<span className="flex items-center gap-2">Performance <span className="hidden font-normal text-muted sm:inline">· {data ? `${data.meta.period.days} days` : '28 days'}</span>{data?.meta.synthetic ? <Badge tone="neutral" className="h-5 px-1.5 text-[11px]">Demo data</Badge> : null}</span>}
        actions={<LinkButton href={href} size="sm" variant="quiet">Analytics</LinkButton>}
      />
      <div className="px-4 pb-4">
        {error && !data ? <ErrorState error={error} onRetry={refetch} /> : loading && !data ? <Skeleton className="h-48 w-full" /> : !data || !hasData ? (
          <div className="flex flex-col gap-2 py-2">
            <p className="text-[13px] font-medium">No network data yet</p>
            {health ? <CoverageMeter ratio={health.coverage.ratio} label={`${health.coverage.with_data} of ${health.coverage.eligible} posts reporting`} /> : null}
          </div>
        ) : (
          <>
            <dl className="mb-4 grid grid-cols-3 gap-3">
              {kpis.map((k) => (
                <div key={k.measure} className="min-w-0">
                  <dt className="truncate text-xs text-muted">{k.label.replace(/ \(.*\)$/, '')}</dt>
                  <dd className="mt-0.5 flex flex-wrap items-baseline gap-x-1.5">
                    <span className="text-[17px] font-semibold tabular sm:text-[20px]">{fmtMetric(k.value, k.unit)}</span>
                    {k.comparison.state === 'up' || k.comparison.state === 'down' ? (
                      <span className={k.comparison.state === 'up' ? 'text-xs text-success' : 'text-xs text-danger'}>
                        {k.comparison.change_pct !== null ? `${k.comparison.change_pct > 0 ? '+' : ''}${Math.round(k.comparison.change_pct * 100)}%` : ''}
                        <span className="sr-only"> vs previous period</span>
                      </span>
                    ) : null}
                  </dd>
                </div>
              ))}
            </dl>
            {combined ? (
              <LineChart
                ariaLabel={`${data.trend.definition.label} per day, ${data.meta.period.from} to ${data.meta.period.to}`}
                labels={combined.points.map((p) => p.date)}
                xLabel={(d) => new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(`${d}T12:00:00Z`))}
                series={[{ key: 'cur', label: data.trend.definition.label, color: 'var(--chart-1)', values: combined.points.map((p) => p.value) }]}
                previous={data.trend.previous?.combined ? { key: 'prev', label: 'Previous period', color: 'var(--chart-prev)', dash: '4 4', values: data.trend.previous.combined.points.map((p) => p.value) } : null}
                height={170}
              />
            ) : null}
            <p className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
              <CoverageMeter ratio={health!.coverage.ratio} label={`${health!.coverage.with_data}/${health!.coverage.eligible} posts reporting`} />
              {health!.freshness.through_date ? <span>Complete through {new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(`${health!.freshness.through_date}T12:00:00Z`))}</span> : null}
            </p>
          </>
        )}
      </div>
    </Card>
  );
}
