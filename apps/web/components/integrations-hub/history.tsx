'use client';
// History: sync jobs (state, attempts, errors, retry for failed/unconfirmed) and activity (errors, retries, rate limits).
import { RotateCcw } from 'lucide-react';
import type { IntegrationHealthJson } from '@social-lite/core/contracts/v35-connectors';
import { api } from '@/lib/client/api';
import { useApi } from '@/lib/client/use-api';
import { fmtRelative } from '@/lib/client/format';
import { Badge, Button, Card, CardHeader, EmptyState, SkeletonRows, Table, Td, Th, THead, Tr, useToast } from '@/components/ui';
import { JOB_LABEL, JOB_STATE } from './meta';

type Job = { id: string; kind: string; state: string; attempts: number; external_url: string | null; last_error_code: string | null; last_error: string | null; created_at: string; finished_at: string | null; next_attempt_at: string | null };

export function HistoryPanel({ integrationId, health }: { integrationId: string; health: IntegrationHealthJson | null }) {
  const toast = useToast();
  const jobs = useApi<{ items: Job[] }>(`/api/connectors/hub/${integrationId}/jobs`);
  return (
    <div className="flex flex-col gap-6">
      <Card aria-labelledby="h-jobs">
        <CardHeader id="h-jobs" title="Sync jobs" />
        {!jobs.data ? <SkeletonRows rows={3} className="p-4" /> : !jobs.data.items.length ? <EmptyState compact title="No sync jobs yet" /> : (
          <div className="overflow-x-auto px-1 pb-2">
            <Table caption="Sync jobs">
              <THead><Tr><Th>Action</Th><Th>State</Th><Th>Tries</Th><Th>When</Th><Th>Detail</Th><Th><span className="sr-only">Actions</span></Th></Tr></THead>
              <tbody>{jobs.data.items.map((j) => {
                const s = JOB_STATE[j.state] ?? { label: j.state, tone: 'neutral' as const };
                return (
                  <Tr key={j.id}>
                    <Td className="font-medium">{JOB_LABEL[j.kind] ?? j.kind}</Td>
                    <Td><Badge tone={s.tone}>{s.label}</Badge></Td>
                    <Td>{j.attempts}</Td>
                    <Td className="whitespace-nowrap">{fmtRelative(j.finished_at ?? j.created_at)}{j.next_attempt_at ? <span className="block text-xs text-subtle">next {fmtRelative(j.next_attempt_at)}</span> : null}</Td>
                    <Td className="max-w-[280px] text-xs text-muted">{j.last_error ?? (j.external_url ? <a className="text-accent-text underline" href={j.external_url} target="_blank" rel="noreferrer noopener">Open</a> : '—')}</Td>
                    <Td>{j.state === 'failed' || j.state === 'unknown' ? <Button size="sm" variant="ghost" icon={<RotateCcw aria-hidden className="size-4" />} onClick={async () => {
                      try { await api.post(`/api/connectors/jobs/${j.id}/retry`); toast.success('Queued again'); await jobs.refetch(); } catch (e) { toast.error(e); }
                    }}>{j.state === 'unknown' ? 'Check again' : 'Retry'}</Button> : null}</Td>
                  </Tr>
                );
              })}</tbody>
            </Table>
          </div>
        )}
      </Card>
      <Card aria-labelledby="h-act">
        <CardHeader id="h-act" title="Activity" />
        {!health ? <SkeletonRows rows={3} className="p-4" /> : !health.activity.length ? <EmptyState compact title="No activity yet" /> : (
          <ul className="divide-y divide-border" data-testid="activity">
            {health.activity.slice(0, 30).map((a, i) => (
              <li key={i} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 text-[13px]">
                <Badge tone={a.outcome === 'ok' ? 'success' : a.outcome === 'error' ? 'danger' : 'warn'}>{a.outcome === 'ok' ? 'OK' : a.outcome === 'throttled' ? 'Rate limited' : a.outcome === 'retry' ? 'Retry' : 'Error'}</Badge>
                <span className="font-medium">{a.kind}</span><span className="text-muted">{a.code ?? ''}</span>
                <span className="min-w-0 flex-1 truncate text-xs text-muted">{a.message ?? ''}</span>
                <span className="text-xs text-subtle">{fmtRelative(a.at)}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
