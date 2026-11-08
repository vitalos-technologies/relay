'use client';
// Integrations area: left navigation of the seven business integrations (≥1024 px); smaller screens use the hub list
// and a back link. Status dots come from stored installation state (no provider calls while rendering).
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { ChevronLeft, LayoutDashboard } from 'lucide-react';
import { CONNECTOR_SLUG, HUB_CONNECTORS, type HubOverviewJson } from '@social-lite/core/contracts/v35-integrations';
import { useApi } from '@/lib/client/use-api';
import { cn } from '@/components/ui';
import { CONNECTOR_META } from './meta';

export function useHub() {
  return useApi<HubOverviewJson>('/api/connectors/hub');
}

function dot(c: HubOverviewJson['connectors'][number] | undefined): string {
  if (!c) return 'bg-border';
  const live = c.installations.filter((i) => !i.disconnected_at);
  if (live.some((i) => i.status === 'reconnect_required' || i.status === 'needs_attention')) return 'bg-warn';
  if (live.some((i) => i.status === 'active' && !i.is_simulated)) return 'bg-success';
  if (live.some((i) => i.status === 'active')) return 'bg-subtle';   // simulated only: neutral (lead review)
  return 'bg-border';
}

export function IntegrationsShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const hub = useHub();
  const onIndex = pathname === '/integrations';
  return (
    <div className="lg:grid lg:grid-cols-[232px_minmax(0,1fr)] lg:gap-10">
      <aside aria-label="Integrations" className="hidden lg:block">
        <div className="sticky top-[88px] max-h-[calc(100dvh-112px)] overflow-y-auto pb-6 pr-1">
          <p className="mb-3 text-[13px] font-semibold text-muted">Integrations</p>
          <nav aria-label="Integrations">
            <ul className="flex flex-col gap-0.5">
              <li>
                <Link href="/integrations" aria-current={onIndex ? 'page' : undefined}
                  className={cn('flex h-9 items-center gap-2 rounded-lg px-2.5 text-[13px] font-medium', onIndex ? 'bg-raised text-fg' : 'text-muted hover:bg-raised hover:text-fg')}>
                  <LayoutDashboard aria-hidden className="size-4" />All integrations
                </Link>
              </li>
              {HUB_CONNECTORS.map((c) => {
                const href = `/integrations/${CONNECTOR_SLUG[c]}`;
                const active = pathname === href || pathname.startsWith(`${href}/`);
                const M = CONNECTOR_META[c];
                return (
                  <li key={c}>
                    <Link href={href} aria-current={active ? 'page' : undefined}
                      className={cn('flex h-9 items-center gap-2 rounded-lg px-2.5 text-[13px] font-medium', active ? 'bg-raised text-fg' : 'text-muted hover:bg-raised hover:text-fg')}>
                      <M.icon aria-hidden className="size-4 shrink-0" />
                      <span className="min-w-0 flex-1 truncate">{M.name}</span>
                      <span aria-hidden className={cn('size-2 shrink-0 rounded-full', dot(hub.data?.connectors.find((x) => x.connector === c)))} />
                    </Link>
                  </li>
                );
              })}
            </ul>
          </nav>
        </div>
      </aside>
      <div className="min-w-0">
        {!onIndex ? (
          <Link href="/integrations" className="touch-target -ml-2 mb-1 inline-flex h-9 items-center gap-1 rounded-lg px-2 text-[13px] font-medium text-muted hover:bg-raised hover:text-fg lg:hidden">
            <ChevronLeft aria-hidden className="size-4" />Integrations
          </Link>
        ) : null}
        {children}
      </div>
    </div>
  );
}
