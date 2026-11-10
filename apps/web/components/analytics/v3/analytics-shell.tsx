'use client';
import { usePathname } from 'next/navigation';
import { useState, type ReactNode } from 'react';
import { ChartColumn, Download } from 'lucide-react';
import type { AnalyticsView, ReportExportDto } from '@social-lite/core/contracts/analytics';
import { api } from '@/lib/client/api';
import { useSession } from '@/lib/client/session';
import { Button, EmptyState, Menu, MenuContent, MenuItem, MenuTrigger, PageHeader, useToast } from '@/components/ui';
import { AnalyticsTabs, useAnalyticsQuery } from './shared';
import { AssistantButton } from '@/components/assistant/assistant-panel'; // V3.5 stream E
import { useBrandFilter } from '@/lib/client/hooks';
import { HelpLink } from '@/components/help/help-link';
import { FeatureGate } from '@/components/entitlements/feature-gate'; // D33: Free has no analytics
import { useEntitlements } from '@/components/entitlements/use-entitlements';

export function AnalyticsShell({ children }: { children: ReactNode }) {
  const { canV2 } = useSession();
  const [brand] = useBrandFilter();
  const ent = useEntitlements();
  const inPlan = !ent.data || ent.check('analytics_standard').ok; // D33: no export / assistant actions on a page Free can't use
  if (!canV2('analytics.read')) return <><PageHeader title="Analytics" /><EmptyState icon={<ChartColumn aria-hidden />} title="No access" /></>;
  return (
    <>
      <PageHeader title="Analytics" actions={<><HelpLink slug="analytics-metric-dictionary" label="What each metric means" />{inPlan ? <AssistantButton surface="analytics" size="md" brandId={brand || null} /> : null}{inPlan && canV2('exports.create') ? <ExportMenu /> : null}</>} />
      <FeatureGate feature="analytics_standard"><AnalyticsTabs />{children}</FeatureGate>
    </>
  );
}

/** Queue a CSV/PDF export of the current view + filters (rendered by the worker), then download it when ready. */
function ExportMenu() {
  const pathname = usePathname();
  const toast = useToast();
  const { qs } = useAnalyticsQuery();
  const [busy, setBusy] = useState(false);
  const view = (pathname.split('/')[2] || 'overview') as AnalyticsView;
  const run = async (format: 'csv' | 'pdf') => {
    setBusy(true);
    try {
      let x = await api.post<ReportExportDto>('/api/analytics/exports', { view, format, query_string: qs }, { idempotent: true });
      for (let i = 0; i < 20 && (x.status === 'queued' || x.status === 'running'); i++) {
        await new Promise((r) => setTimeout(r, 1500));
        x = await api.get<ReportExportDto>(`/api/analytics/exports/${x.id}`);
      }
      if (x.status === 'succeeded' && x.download_path) { window.location.assign(x.download_path); toast.success('Export ready', x.delivered_format && x.delivered_format !== format ? `Delivered as ${x.delivered_format.toUpperCase()}` : undefined); }
      else if (x.status === 'failed') toast.error(new Error(x.error?.message ?? 'Export failed'), 'Export failed');
      else toast.info('Export queued', 'It will finish in the background.');
    } catch (e) {
      toast.error(e, 'Couldn’t export');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Menu>
      <MenuTrigger asChild>
        <Button icon={<Download aria-hidden className="size-4" />} loading={busy}>Export</Button>
      </MenuTrigger>
      <MenuContent>
        <MenuItem onSelect={() => void run('csv')}>CSV</MenuItem>
        <MenuItem onSelect={() => void run('pdf')}>PDF</MenuItem>
      </MenuContent>
    </Menu>
  );
}
