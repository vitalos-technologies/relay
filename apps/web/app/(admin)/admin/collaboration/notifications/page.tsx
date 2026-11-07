'use client';
// Admin → Notification delivery: email outcomes for the last 7 days and the problems (failed, not configured, skipped),
// with the reason code. Metadata only — never notification or comment content. In-app notifications work without email.
import { useState } from 'react';
import { api } from '@/lib/client/api';
import { useApi } from '@/lib/client/use-api';
import { Badge, Banner, Button, Card, ErrorState, FilterBar, FilterSelect, MetricCard, PageHeader, SkeletonRows, useToast } from '@/components/ui';
import { Ago, RecordList } from '@/components/admin/ui';

interface Diag {
  stats: { window_days: number; created: number; emailed: number; pending: number; digest: number; failed: number; not_configured: number; skipped: number; email_configured: boolean };
  items: Array<{ id: string; type: string; recipient: string; state: string; error: string | null; attempts: number; created_at: string; next_attempt_at: string | null }>;
  next_cursor: string | null;
}
const ERR: Record<string, string> = {
  smtp_not_configured: 'Email isn’t set up on this installation', smtp_rejected: 'The mail server refused or was unreachable', recipient_not_entitled: 'The person no longer has access',
};
const STATE: Record<string, ['neutral' | 'warn' | 'danger' | 'info', string]> = {
  failed: ['danger', 'Failed'], not_configured: ['warn', 'Not set up'], skipped: ['neutral', 'Skipped'], pending: ['info', 'Waiting'],
};

export default function NotificationDeliveryPage() {
  const toast = useToast();
  const [state, setState] = useState('');
  const { data, error, loading, refetch } = useApi<Diag>(`/api/admin/collaboration/notifications${state ? `?state=${state}` : ''}`, { keepPrevious: true });
  return (
    <>
      <PageHeader title="Notification delivery" />
      {error && !data ? <ErrorState error={error} onRetry={refetch} /> : loading || !data ? <SkeletonRows rows={6} /> : (
        <div className="flex flex-col gap-6">
          {!data.stats.email_configured ? <Banner tone="warn" title="Email isn’t set up">In-app notifications still work. Set SMTP in Instance setup to send email.</Banner> : null}
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <MetricCard label="Notifications (7 days)" value={data.stats.created} />
            <MetricCard label="Emailed" value={data.stats.emailed} />
            <MetricCard label="Waiting (quiet hours / retry)" value={data.stats.pending} />
            <MetricCard label="Failed" value={data.stats.failed} tone={data.stats.failed ? 'danger' : null} />
          </div>
          <FilterBar label="Filters">
            <FilterSelect id="st" label="Show" value={state} onChange={setState}>
              <option value="">All problems</option><option value="failed">Failed</option><option value="not_configured">Not set up</option><option value="skipped">Skipped</option><option value="pending">Waiting</option>
            </FilterSelect>
          </FilterBar>
          <Card className="overflow-hidden">
            {!data.items.length ? <p className="px-4 py-6 text-[13px] text-muted">No delivery problems</p> : (
              <RecordList caption="Delivery problems" rows={data.items} rowKey={(r) => r.id}
                columns={[
                  { key: 't', label: 'Type', cell: (r) => r.type.replace(/_/g, ' ') },
                  { key: 'r', label: 'Recipient', cell: (r) => <span className="break-all">{r.recipient}</span> },
                  { key: 's', label: 'State', cell: (r) => <Badge tone={STATE[r.state]?.[0] ?? 'neutral'}>{STATE[r.state]?.[1] ?? r.state}</Badge> },
                  { key: 'e', label: 'Reason', cell: (r) => <span className="text-xs text-muted">{r.error ? ERR[r.error] ?? r.error : '—'}</span> },
                  { key: 'c', label: 'When', secondary: true, cell: (r) => <Ago at={r.created_at} /> },
                  { key: 'a', label: '', cell: (r) => (r.state === 'failed' || r.state === 'not_configured') ? <Button size="sm" variant="ghost" onClick={async () => {
                    try { const x = await api.post<{ outcome: string }>(`/api/admin/collaboration/notifications/${r.id}/retry`, {}); toast.info(`Retry: ${x.outcome.replace(/_/g, ' ')}`); await refetch(); } catch (e) { toast.error(e, 'Retry failed'); }
                  }}>Retry</Button> : null },
                ]}
                card={(r) => <span className="flex flex-col gap-1"><span className="flex items-center gap-2"><span className="min-w-0 flex-1 truncate">{r.recipient}</span><Badge tone={STATE[r.state]?.[0] ?? 'neutral'}>{STATE[r.state]?.[1] ?? r.state}</Badge></span><span className="text-xs text-muted">{r.type.replace(/_/g, ' ')} · {r.error ? ERR[r.error] ?? r.error : ''}</span></span>} />
            )}
          </Card>
        </div>
      )}
    </>
  );
}
