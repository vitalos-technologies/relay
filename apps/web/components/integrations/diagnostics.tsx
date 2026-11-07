'use client';
// V3.1 §15 integration test centre (flag v31.integration_diagnostics). Read-only: GET /api/integrations/diagnostics
// reports stored state (authorization, selected account, capabilities, token, publishing/media, analytics sync,
// quota, affected scheduled work) with remedies and safe correlation ids. Nothing here posts or calls a network.
import { CircleCheck, CircleDashed, CircleMinus, CircleX, Copy, Eye, TriangleAlert } from 'lucide-react';
import { PROVIDER_LABEL } from '@social-lite/core';
import type { ConnectionDiagnostics, DiagnosticStatus, IntegrationDiagnosticsResponse } from '@social-lite/core/contracts/v31-gov';
import { useApi } from '@/lib/client/use-api';
import { useSession } from '@/lib/client/session';
import { fmtDateTime, fmtRelative } from '@/lib/client/format';
import { Badge, Drawer, ErrorState, PlatformIcon, SimulatedBadge, Skeleton, cn, useToast } from '@/components/ui';

export const DIAG_LABEL: Record<DiagnosticStatus, string> = { ok: 'OK', warning: 'Check', failing: 'Failing', unknown: 'Unknown', not_applicable: 'n/a' };

export function DiagIcon({ status, className }: { status: DiagnosticStatus; className?: string }) {
  const cls = cn('size-4 shrink-0', className);
  if (status === 'ok') return <CircleCheck aria-label="OK" className={cn(cls, 'text-success')} />;
  if (status === 'warning') return <TriangleAlert aria-label="Check" className={cn(cls, 'text-warn')} />;
  if (status === 'failing') return <CircleX aria-label="Failing" className={cn(cls, 'text-danger')} />;
  if (status === 'not_applicable') return <CircleMinus aria-label="Not applicable" className={cn(cls, 'text-subtle')} />;
  return <CircleDashed aria-label="Unknown" className={cn(cls, 'text-subtle')} />;
}

export function OverallBadge({ status }: { status: DiagnosticStatus }) {
  const tone = status === 'ok' ? 'success' : status === 'warning' ? 'warn' : status === 'failing' ? 'danger' : 'neutral';
  return <Badge tone={tone} icon={<DiagIcon status={status} className="size-3.5 text-current" />}>{status === 'ok' ? 'Healthy' : status === 'warning' ? 'Needs attention' : status === 'failing' ? 'Failing' : 'Unknown'}</Badge>;
}

/** One connection's checks. */
export function DiagnosticsDetail({ d }: { d: ConnectionDiagnostics }) {
  const { session } = useSession();
  const toast = useToast();
  const tz = session.workspace?.timezone ?? 'UTC';
  const copy = (v: string) => void navigator.clipboard?.writeText(v).then(() => toast.success('Reference copied'));
  return (
    <div className="flex flex-col gap-5" data-testid={`diagnostics-${d.connection.id}`}>
      <ul className="flex flex-col gap-3">
        {d.checks.map((c) => (
          <li key={c.key} className="flex items-start gap-2.5 text-[13px]" data-check={c.key} data-status={c.status}>
            <DiagIcon status={c.status} className="mt-0.5" />
            <div className="min-w-0 flex-1">
              <p className="font-medium">{c.title}</p>
              <p className="text-muted">{c.detail}</p>
              {c.remedy && c.status !== 'ok' ? <p className="mt-0.5 text-accent-text">{c.remedy}</p> : null}
            </div>
          </li>
        ))}
      </ul>
      {d.quota.throttled_until || d.capabilities.missing_scopes.length ? (
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 border-t border-border pt-4 text-[13px]">
          {d.quota.throttled_until ? <><dt className="text-muted">Throttled until</dt><dd>{fmtDateTime(d.quota.throttled_until, tz)}</dd></> : null}
          {d.capabilities.missing_scopes.length ? <><dt className="text-muted">Missing scopes</dt><dd className="break-words font-mono text-xs">{d.capabilities.missing_scopes.join(' ')}</dd></> : null}
        </dl>
      ) : null}
      <div className="flex flex-wrap items-center gap-2 border-t border-border pt-4 text-xs text-muted">
        <Eye aria-hidden className="size-3.5" />Read-only · nothing is posted
        <span className="flex-1" />
        <button type="button" className="inline-flex items-center gap-1 rounded px-1 font-mono hover:bg-raised hover:text-fg" onClick={() => copy(d.correlation.request_id)} aria-label="Copy reference">
          {d.correlation.request_id.slice(0, 8)}<Copy aria-hidden className="size-3" />
        </button>
        {d.checked_at ? <span>Checked {fmtRelative(d.checked_at)}</span> : null}
      </div>
    </div>
  );
}

export function DiagnosticsDrawer({ connectionId, open, onOpenChange }: { connectionId: string; open: boolean; onOpenChange: (o: boolean) => void }) {
  const { data, error, refetch } = useApi<IntegrationDiagnosticsResponse>(open ? `/api/integrations/diagnostics?connection_id=${connectionId}` : null);
  const d = data?.items[0];
  return (
    <Drawer
      open={open}
      onOpenChange={onOpenChange}
      title={d ? <span className="flex items-center gap-2"><PlatformIcon provider={d.connection.provider} size="xs" />{d.connection.display_name}</span> : 'Diagnostics'}
      description={d ? `${PROVIDER_LABEL[d.connection.provider]}${d.selected_account.username ? ` · @${d.selected_account.username}` : ''}` : undefined}
    >
      {error && !data ? <ErrorState error={error} onRetry={refetch} /> : !d ? <Skeleton className="h-64 w-full rounded-lg" /> : (
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap gap-2"><OverallBadge status={d.overall} />{d.connection.simulated ? <SimulatedBadge /> : null}</div>
          <DiagnosticsDetail d={d} />
        </div>
      )}
    </Drawer>
  );
}
