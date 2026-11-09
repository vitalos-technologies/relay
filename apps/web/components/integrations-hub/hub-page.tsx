'use client';
// Integrations hub index: every business integration with its honest state — needs app setup, not connected,
// connected (n), needs attention. Renders from stored state only.
import { CONNECTOR_SLUG, type HubOverviewJson } from '@social-lite/core/contracts/v35-integrations';
import { ChevronRight } from 'lucide-react';
import Link from 'next/link';
import { ConnectionsTabs } from '@/components/shell/connections-tabs';
import { Badge, ErrorState, FeatureTile, IntegrationCard, PageHeader, SkeletonRows } from '@/components/ui';
import { CONNECTOR_META } from './meta';
import { useHub } from './hub-shell';
import { HelpLink } from '@/components/help/help-link';

export function stateBadge(c: HubOverviewJson['connectors'][number]) {
  const live = c.installations.filter((i) => !i.disconnected_at);
  if (live.some((i) => i.status === 'reconnect_required')) return <Badge tone="danger">Reconnect</Badge>;
  if (live.some((i) => i.status === 'needs_attention')) return <Badge tone="warn">Needs attention</Badge>;
  // Lead review: green "Connected" only for live installs; simulated-only installs show one neutral "Simulated" badge.
  const real = live.filter((i) => !i.is_simulated);
  if (real.length) return <Badge tone="success">{real.length === 1 ? 'Connected' : `${real.length} connected`}</Badge>;
  if (live.length) return <Badge tone="neutral">Simulated</Badge>;
  if (!c.configured) return <Badge tone="neutral">Needs app setup</Badge>;
  return <Badge tone="info">Not connected</Badge>;
}

export function IntegrationsHub() {
  const hub = useHub();
  return (
    <>
      <PageHeader title="Connections" actions={<HelpLink slug="business-apps-overview" label="About business apps" />} />
      <ConnectionsTabs />
      {hub.error ? <ErrorState error={hub.error} onRetry={hub.refetch} /> : !hub.data ? <SkeletonRows rows={6} /> : (
        <ul className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3" data-testid="integrations-hub">
          {hub.data.connectors.map((c) => {
            const M = CONNECTOR_META[c.connector];
            const live = c.installations.filter((i) => !i.disconnected_at);
            const mixed = live.some((i) => i.is_simulated) && live.some((i) => !i.is_simulated);
            return (
              <IntegrationCard as="li" key={c.connector} testId={`hub-${c.connector}`} className="relative hover:border-border-strong" icon={<FeatureTile><M.icon /></FeatureTile>}
                name={<Link href={`/integrations/${CONNECTOR_SLUG[c.connector]}`} className="after:absolute after:inset-0 after:rounded-[var(--radius-card)] focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-accent">{M.name}</Link>}
                detail={<><span className="flex flex-wrap items-center gap-1.5" data-testid="hub-status">{stateBadge(c)}{mixed ? <Badge tone="neutral">+ simulated</Badge> : null}</span><span className="mt-1.5 block">{M.blurb}</span></>}
                actions={<ChevronRight aria-hidden className="size-4 text-subtle" />} />
            );
          })}
        </ul>
      )}
    </>
  );
}
