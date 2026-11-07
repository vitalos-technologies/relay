'use client';
// V3.1 §15 test centre: every connection's stored diagnostics (read-only; never posts).
import { useState } from 'react';
import { ChevronDown, Stethoscope } from 'lucide-react';
import { PROVIDER_LABEL } from '@social-lite/core';
import type { IntegrationDiagnosticsResponse } from '@social-lite/core/contracts/v31-gov';
import { useApi } from '@/lib/client/use-api';
import { useBrandFilter, useQueryState } from '@/lib/client/hooks';
import { useFlag } from '@/lib/client/flags';
import { useSession } from '@/lib/client/session';
import { Card, EmptyState, ErrorState, LinkButton, PageHeader, PlatformIcon, SimulatedBadge, SkeletonRows, cn } from '@/components/ui';
import { DiagIcon, DiagnosticsDetail, OverallBadge } from '@/components/integrations/diagnostics';

export default function DiagnosticsPage() {
  const on = useFlag('v31.integration_diagnostics');
  const { session } = useSession();
  const [brand] = useBrandFilter();
  const [params] = useQueryState();
  const focus = params.get('connection');
  const { data, error, loading, refetch } = useApi<IntegrationDiagnosticsResponse>(on ? `/api/integrations/diagnostics${brand ? `?brand_id=${brand}` : ''}` : null);
  const [open, setOpen] = useState<Set<string>>(() => new Set(focus ? [focus] : []));
  const brandName = (id: string) => session.brands.find((b) => b.id === id)?.name ?? '';
  const header = <PageHeader eyebrow="Connections" title="Test centre" meta="Read-only" actions={<LinkButton href="/accounts" variant="ghost">Connections</LinkButton>} />;
  if (!on) return <>{header}<EmptyState icon={<Stethoscope aria-hidden />} title="Not turned on" /></>;
  return (
    <>
      {header}
      {error && !data ? <ErrorState error={error} onRetry={refetch} /> : loading || !data ? <Card><SkeletonRows rows={5} className="p-2" /></Card> : !data.items.length ? (
        <EmptyState icon={<Stethoscope aria-hidden />} title="No connections" action={<LinkButton href="/accounts" variant="primary">Connect</LinkButton>} />
      ) : (
        <Card>
          <ul className="divide-y divide-border">
            {data.items.map((d) => {
              const isOpen = open.has(d.connection.id);
              return (
                <li key={d.connection.id}>
                  <button type="button" aria-expanded={isOpen} onClick={() => setOpen((s) => { const n = new Set(s); if (n.has(d.connection.id)) n.delete(d.connection.id); else n.add(d.connection.id); return n; })}
                    className="flex w-full flex-wrap items-center gap-3 px-4 py-3 text-left hover:bg-raised/60">
                    <PlatformIcon provider={d.connection.provider} size="sm" />
                    <span className="min-w-0 flex-1 max-sm:basis-[calc(100%-4.5rem)]">
                      <span className="block truncate text-[14px] font-medium">{d.connection.display_name}</span>
                      <span className="block truncate text-xs text-muted">{PROVIDER_LABEL[d.connection.provider]} · {brandName(d.connection.brand_id)}</span>
                    </span>
                    <ChevronDown aria-hidden className={cn('size-4 shrink-0 text-muted transition-transform sm:order-last', isOpen && 'rotate-180')} />
                    {/* Phones: chips wrap onto their own line under the name. */}
                    <span className="flex flex-wrap items-center gap-2 max-sm:w-full max-sm:pl-11">
                      <span className="hidden items-center gap-1 lg:flex" aria-hidden>{d.checks.map((c) => <DiagIcon key={c.key} status={c.status} className="size-3.5" />)}</span>
                      {d.connection.simulated ? <SimulatedBadge /> : null}
                      <OverallBadge status={d.overall} />
                    </span>
                  </button>
                  {isOpen ? <div className="px-4 pb-5 pt-1 sm:pl-14"><DiagnosticsDetail d={d} /></div> : null}
                </li>
              );
            })}
          </ul>
        </Card>
      )}
    </>
  );
}
