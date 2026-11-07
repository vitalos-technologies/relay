'use client';
import Link from 'next/link';
import { CircleCheck, Globe, OctagonPause, Plug, Plus } from 'lucide-react';
import { PROVIDER_LABEL } from '@social-lite/core';
import { useSession } from '@/lib/client/session';
import { useApi } from '@/lib/client/use-api';
import { useBrandFilter, useHrefWithBrand } from '@/lib/client/hooks';
import { connectionFix } from '@/lib/client/connection-fix';
import { postTitle } from '@/lib/client/format';
import type { Dashboard, Delivery } from '@/lib/client/types';
import {
  Banner, buttonClass, Card, CardHeader, ConnectionStatusBadge, DeliveryStateBadge, EmptyState, ErrorState, LinkButton, PageHeader,
  PlatformIcon, SimulatedBadge, Skeleton, SkeletonRows, TimeWithZone,
} from '@/components/ui';
import { AgendaItem } from '@/components/planner/agenda-item';

function AllClear({ children }: { children: string }) {
  return (
    <p className="flex items-center gap-2 pb-2 text-[13px] text-muted">
      <CircleCheck aria-hidden className="size-4 text-success" /> {children}
    </p>
  );
}

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
        { key: 'unknown', label: 'Unknown', items: data.attention.unknown },
        { key: 'failed', label: 'Failed', items: data.attention.failed },
        { key: 'blocked', label: 'Blocked', items: data.attention.blocked },
        { key: 'expired', label: 'Expired', items: data.attention.expired },
      ].filter((g) => g.items.length > 0)
    : [];
  const attentionCount = attention.reduce((n, g) => n + g.items.length, 0);

  return (
    <>
      <PageHeader
        title="Home"
        meta={<><Globe aria-hidden className="size-3.5 shrink-0" /><span className="truncate">Today · {tz.replace(/_/g, ' ')} · {brand ? brandName(brand) : 'All brands'}</span></>}
        actions={can('drafts.edit') && !noBrands ? (
          <LinkButton href={withBrand('/compose')} variant="primary" icon={<Plus aria-hidden className="size-4" />}>New post</LinkButton>
        ) : null}
      />

      {noBrands ? (
        <EmptyState
          icon={<Plug aria-hidden />}
          title="No brands yet"
          action={can('brands.manage') ? <LinkButton href="/settings?tab=brand" variant="primary">Create brand</LinkButton> : null}
        />
      ) : error && !data ? (
        <ErrorState error={error} onRetry={refetch} />
      ) : (
        <div className="flex flex-col gap-6">
          {data?.paused.workspace ? (
            <Banner tone="danger" icon={<OctagonPause aria-hidden className="size-4 text-danger" />} title="Workspace paused" />
          ) : null}
          {data && data.paused.brands.length ? (
            <Banner tone="warn" icon={<OctagonPause aria-hidden className="size-4 text-warn" />} title={`Paused: ${data.paused.brands.map(brandName).join(', ')}`} />
          ) : null}

          <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1.45fr)_minmax(0,1fr)]">
            <div className="flex min-w-0 flex-col gap-6">
              <Card aria-labelledby="h-attention">
                <CardHeader
                  id="h-attention"
                  title={<>Needs attention{attentionCount ? <span className="ml-2 text-muted tabular">{attentionCount}</span> : null}</>}
                />
                <div className="px-4 pb-4">
                  {loading ? <SkeletonRows rows={2} /> : attention.length === 0 ? (
                    <AllClear>All clear</AllClear>
                  ) : (
                    <ul className="flex flex-col divide-y divide-border">
                      {attention.flatMap((g) => g.items).map((d) => (
                        <li key={d.id} className="flex items-center gap-3 py-3 first:pt-0 last:pb-0">
                          <PlatformIcon provider={d.provider} size="sm" />
                          <div className="min-w-0 flex-1">
                            <p className="flex min-w-0 items-center gap-2 text-[13px] font-medium">
                              <span className="truncate">{d.display_name}</span> {d.is_mock ? <SimulatedBadge className="shrink-0" /> : null}
                            </p>
                            <p className="truncate text-xs text-muted" title={d.blocked_reason ?? d.last_error_message ?? undefined}>
                              {d.blocked_reason ?? d.last_error_message ?? (d.state === 'unknown' ? 'Not confirmed' : d.state === 'expired' ? 'Missed deadline' : '—')}
                            </p>
                          </div>
                          <span className="hidden shrink-0 sm:block"><DeliveryStateBadge state={d.state} isMock={d.is_mock} size="sm" /></span>
                          <Link href={`/posts/${d.post_id}#deliveries`} className={buttonClass('secondary', 'sm')}>
                            Resolve<span className="sr-only"> {d.display_name} ({d.state})</span>
                          </Link>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </Card>

              <Card aria-labelledby="h-today">
                <CardHeader
                  id="h-today"
                  title="Today"
                  actions={<LinkButton href={withBrand('/planner')} size="sm" variant="quiet">Planner</LinkButton>}
                />
                <div className="px-2 pb-2">
                  {loading ? <SkeletonRows rows={3} /> : !data?.today.length ? (
                    <EmptyState compact title="Nothing today" action={can('drafts.edit') ? <LinkButton href={withBrand('/compose')} size="sm" variant="secondary">New post</LinkButton> : null} />
                  ) : (
                    <ul className="flex flex-col">
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
                <CardHeader id="h-accounts" title="Accounts" actions={<LinkButton href={withBrand('/accounts')} size="sm" variant="quiet">View<span className="sr-only"> accounts</span></LinkButton>} />
                <div className="px-4 pb-4">
                  {loading ? <Skeleton className="h-16 w-full" /> : !data?.account_warnings.length ? (
                    <AllClear>All healthy</AllClear>
                  ) : (
                    <ul className="flex flex-col divide-y divide-border">
                      {data.account_warnings.map((c) => {
                        const fix = connectionFix(c);
                        return (
                          <li key={c.id} className="flex items-center gap-3 py-3 first:pt-0 last:pb-0">
                            <PlatformIcon provider={c.provider} size="sm" />
                            <div className="min-w-0 flex-1">
                              <p className="truncate text-[13px] font-medium">{c.display_name}</p>
                              <p className="truncate text-xs text-muted" title={fix ?? undefined}>{fix ?? `${PROVIDER_LABEL[c.provider]} · ${brandName(c.brand_id)}`}</p>
                            </div>
                            <ConnectionStatusBadge status={c.status} label={c.status_label} size="sm" />
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>
              </Card>

              <Card aria-labelledby="h-recent">
                <CardHeader id="h-recent" title="Recent" actions={can('history.read') ? <LinkButton href={withBrand('/history')} size="sm" variant="quiet">History</LinkButton> : null} />
                <div className="px-4 pb-4">
                  {loading ? <SkeletonRows rows={3} /> : !data?.recent.length ? (
                    <p className="pb-2 text-[13px] text-muted">No results yet</p>
                  ) : (
                    <ul className="flex flex-col divide-y divide-border">
                      {data.recent.map((r) => (
                        <li key={r.id} className="flex items-center gap-3 py-3 first:pt-0 last:pb-0">
                          <PlatformIcon provider={r.provider} size="sm" />
                          <div className="min-w-0 flex-1">
                            <Link href={`/posts/${r.post_id}`} className="block truncate text-[13px] font-medium hover:underline">{postTitle(r)}</Link>
                            <p className="truncate text-xs text-muted">
                              <TimeWithZone instant={r.published_at ?? r.due_at} tz={r.input_timezone || tz} /> · {r.display_name}
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
