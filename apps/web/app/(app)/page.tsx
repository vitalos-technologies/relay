'use client';
import Link from 'next/link';
import { ArrowRight, CalendarDays, CircleCheck, OctagonPause, Plug, Plus } from 'lucide-react';
import { PROVIDER_LABEL } from '@social-lite/core';
import { useSession } from '@/lib/client/session';
import { useApi } from '@/lib/client/use-api';
import { useBrandFilter, useHrefWithBrand } from '@/lib/client/hooks';
import { connectionFix } from '@/lib/client/connection-fix';
import { postTitle } from '@/lib/client/format';
import type { Dashboard, Delivery } from '@/lib/client/types';
import {
  Banner, Card, CardHeader, ConnectionStatusBadge, DeliveryStateBadge, EmptyState, ErrorState, LinkButton, PageHeader,
  PlatformIcon, SimulatedBadge, Skeleton, SkeletonRows, TimeWithZone,
} from '@/components/ui';
import { AgendaItem } from '@/components/planner/agenda-item';

export default function HomePage() {
  const { session, can } = useSession();
  const [brand] = useBrandFilter();
  const withBrand = useHrefWithBrand();
  const tz = session.brands.find((b) => b.id === brand)?.timezone ?? session.workspace?.timezone ?? 'Europe/London';
  const { data, error, loading, refetch } = useApi<Dashboard>(`/api/dashboard${brand ? `?brand_id=${encodeURIComponent(brand)}` : ''}`, { poll: 30_000, keepPrevious: true });
  const brandName = (id: string) => session.brands.find((b) => b.id === id)?.name ?? 'Unknown brand';

  const noBrands = session.brands.length === 0;
  const attention: Array<{ key: string; label: string; items: Delivery[] }> = data
    ? [
        { key: 'unknown', label: 'Unknown — needs review', items: data.attention.unknown },
        { key: 'failed', label: 'Failed', items: data.attention.failed },
        { key: 'blocked', label: 'Blocked', items: data.attention.blocked },
        { key: 'expired', label: 'Expired', items: data.attention.expired },
      ].filter((g) => g.items.length > 0)
    : [];
  const attentionCount = attention.reduce((n, g) => n + g.items.length, 0);

  return (
    <>
      <PageHeader
        eyebrow={session.workspace?.name}
        title="Home"
        description={<>Today in <span className="text-fg">{tz.replace(/_/g, ' ')}</span>{brand ? <> · {brandName(brand)}</> : ' · all brands'}</>}
        actions={can('drafts.edit') && !noBrands ? (
          <LinkButton href={withBrand('/compose')} variant="primary" icon={<Plus aria-hidden className="size-4" />}>New post</LinkButton>
        ) : null}
      />

      {noBrands ? (
        <EmptyState
          icon={<Plug aria-hidden />}
          title="Add your first brand"
          action={can('brands.manage') ? <LinkButton href="/settings?tab=brand" variant="primary">Create a brand</LinkButton> : null}
        >
          Brands hold connected accounts, posts and media. {can('brands.manage') ? 'Create one to get started.' : 'Ask a workspace admin to create one, or to give you access.'}
        </EmptyState>
      ) : error && !data ? (
        <ErrorState error={error} onRetry={refetch} />
      ) : (
        <div className="flex flex-col gap-6">
          {data?.paused.workspace ? (
            <Banner tone="danger" icon={<OctagonPause aria-hidden className="size-4 text-danger" />} title="Publishing is paused for the whole workspace">
              Scheduled posts won’t send until it’s resumed.
            </Banner>
          ) : null}
          {data && data.paused.brands.length ? (
            <Banner tone="warn" icon={<OctagonPause aria-hidden className="size-4 text-warn" />} title={`Publishing paused for ${data.paused.brands.length === 1 ? 'a brand' : `${data.paused.brands.length} brands`}`}>
              {data.paused.brands.map(brandName).join(', ')}. Resume in Settings → Brand.
            </Banner>
          ) : null}

          <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1.45fr)_minmax(0,1fr)]">
            <div className="flex min-w-0 flex-col gap-6">
              <Card aria-labelledby="h-attention">
                <CardHeader
                  id="h-attention"
                  title={<>Needs attention{attentionCount ? <span className="ml-2 text-muted tabular">{attentionCount}</span> : null}</>}
                  description="Destinations that didn’t publish or can’t confirm. Each one shows the exact next step."
                />
                <div className="p-4">
                  {loading ? <SkeletonRows rows={2} /> : attention.length === 0 ? (
                    <p className="flex items-center gap-2 py-2 text-[13px] text-muted">
                      <CircleCheck aria-hidden className="size-4 text-success" /> Nothing needs attention right now.
                    </p>
                  ) : (
                    <div className="flex flex-col gap-5">
                      {attention.map((g) => (
                        <section key={g.key} aria-label={g.label}>
                          <h3 className="mb-2 text-xs font-medium text-muted">{g.label} <span className="tabular">({g.items.length})</span></h3>
                          <ul className="flex flex-col gap-2">
                            {g.items.map((d) => (
                              <li key={d.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-border bg-sunken px-3 py-2.5">
                                <PlatformIcon provider={d.provider} size="sm" />
                                <div className="min-w-0 flex-1 basis-[60%]">
                                  <p className="flex items-center gap-2 truncate text-[13px] font-medium">
                                    {d.display_name} {d.is_mock ? <SimulatedBadge /> : null}
                                  </p>
                                  <p className="truncate text-xs text-muted">
                                    {d.blocked_reason ?? d.last_error_message ?? (d.state === 'unknown' ? 'Sent but not confirmed — check the destination.' : d.state === 'expired' ? 'Missed its publish-before deadline.' : 'See details')}
                                  </p>
                                </div>
                                <div className="flex w-full items-center justify-between gap-2 pl-10 sm:w-auto sm:justify-end sm:pl-0">
                                  <DeliveryStateBadge state={d.state} isMock={d.is_mock} size="sm" />
                                  <Link href={`/posts/${d.post_id}#deliveries`} className="touch-target inline-flex h-8 items-center gap-1 rounded-lg border border-border bg-raised px-2.5 text-[13px] font-medium hover:border-border-strong">
                                    Resolve <ArrowRight aria-hidden className="size-3.5" />
                                    <span className="sr-only"> {d.display_name}</span>
                                  </Link>
                                </div>
                              </li>
                            ))}
                          </ul>
                        </section>
                      ))}
                    </div>
                  )}
                </div>
              </Card>

              <Card aria-labelledby="h-today">
                <CardHeader
                  id="h-today"
                  title="Today’s schedule"
                  actions={<LinkButton href={withBrand('/planner')} size="sm" variant="quiet" icon={<CalendarDays aria-hidden className="size-4" />}>Open planner</LinkButton>}
                />
                <div className="p-4">
                  {loading ? <SkeletonRows rows={3} /> : !data?.today.length ? (
                    <EmptyState compact icon={<CalendarDays aria-hidden />} title="Nothing scheduled today" action={can('drafts.edit') ? <LinkButton href={withBrand('/compose')} size="sm" variant="secondary">Create a post</LinkButton> : null}>
                      Scheduled posts for today will appear here with their exact time and zone.
                    </EmptyState>
                  ) : (
                    <ul className="flex flex-col gap-2">
                      {data.today.map((i) => (
                        <li key={i.schedule_id}><AgendaItem item={i} brandName={brand ? undefined : brandName(i.brand_id)} /></li>
                      ))}
                    </ul>
                  )}
                </div>
              </Card>
            </div>

            <div className="flex min-w-0 flex-col gap-6">
              <Card aria-labelledby="h-accounts">
                <CardHeader id="h-accounts" title="Account warnings" actions={<LinkButton href={withBrand('/accounts')} size="sm" variant="quiet">Accounts</LinkButton>} />
                <div className="p-4">
                  {loading ? <Skeleton className="h-16 w-full" /> : !data?.account_warnings.length ? (
                    <p className="flex items-center gap-2 py-2 text-[13px] text-muted">
                      <CircleCheck aria-hidden className="size-4 text-success" /> All connected accounts are healthy.
                    </p>
                  ) : (
                    <ul className="flex flex-col gap-2">
                      {data.account_warnings.map((c) => (
                        <li key={c.id} className="rounded-lg border border-border bg-sunken px-3 py-2.5">
                          <div className="flex items-center gap-3">
                            <PlatformIcon provider={c.provider} size="sm" />
                            <div className="min-w-0 flex-1">
                              <p className="truncate text-[13px] font-medium">{c.display_name}</p>
                              <p className="truncate text-xs text-muted">{PROVIDER_LABEL[c.provider]} · {brandName(c.brand_id)}</p>
                            </div>
                            <ConnectionStatusBadge status={c.status} label={c.status_label} size="sm" />
                          </div>
                          {connectionFix(c) ? <p className="mt-2 text-xs text-muted">{connectionFix(c)}</p> : null}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </Card>

              <Card aria-labelledby="h-recent">
                <CardHeader id="h-recent" title="Recent results" actions={can('history.read') ? <LinkButton href={withBrand('/history')} size="sm" variant="quiet">History</LinkButton> : null} />
                <div className="p-4">
                  {loading ? <SkeletonRows rows={3} /> : !data?.recent.length ? (
                    <p className="py-2 text-[13px] text-muted">No results yet. Published, failed and simulated deliveries will be listed here.</p>
                  ) : (
                    <ul className="flex flex-col divide-y divide-border">
                      {data.recent.map((r) => (
                        <li key={r.id} className="flex items-center gap-3 py-2.5 first:pt-0 last:pb-0">
                          <PlatformIcon provider={r.provider} size="sm" />
                          <div className="min-w-0 flex-1">
                            <Link href={`/posts/${r.post_id}`} className="block truncate text-[13px] font-medium hover:underline">{postTitle(r)}</Link>
                            <p className="truncate text-xs text-muted">
                              {r.display_name} · <TimeWithZone instant={r.published_at ?? r.due_at} tz={r.input_timezone || tz} />
                            </p>
                          </div>
                          <DeliveryStateBadge state={r.state} isMock={r.is_mock} size="sm" />
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </Card>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
