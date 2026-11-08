'use client';
// Spike alert: why it fired (observed vs baseline, threshold, minimum sample), what was monitored (coverage snapshot at
// fire time + query version), and the exact mentions it counted (removed-at-source items are shown as removed).
import Link from 'next/link';
import { ArrowLeft, Check, ClipboardList, SquarePen, X } from 'lucide-react';
import type { AlertDto, ObservationDto } from '@social-lite/core/contracts/v35-listening';
import { LISTENING_DEFINITIONS } from '@social-lite/core/contracts/v35-listening';
import { api } from '@/lib/client/api';
import { useApi } from '@/lib/client/use-api';
import { useSession } from '@/lib/client/session';
import { Badge, Button, Card, CardHeader, ErrorState, Facts, MetricCard, PageHeader, SkeletonRows, useToast } from '@/components/ui';
import { CoverageNote, Definition, SimulatedBanner, fmtWhen } from './shared';
import { MentionList, useInsightAction } from './mentions';

type Detail = AlertDto & { is_simulated: boolean; mentions: ObservationDto[]; actions: Array<{ action: string; target_id: string; at: string }> };

const STATE: Record<AlertDto['state'], { label: string; tone: 'warn' | 'success' | 'neutral' }> = { open: { label: 'Open', tone: 'warn' }, acknowledged: { label: 'Acknowledged', tone: 'success' }, dismissed: { label: 'Dismissed', tone: 'neutral' } };

export function AlertDetail({ id }: { id: string }) {
  const toast = useToast();
  const { can } = useSession();
  const a = useApi<Detail>(`/api/listening/alerts/${id}`);
  const { run, busy } = useInsightAction();
  if (a.error && !a.data) return <ErrorState error={a.error} onRetry={a.refetch} />;
  if (!a.data) return <SkeletonRows rows={6} />;
  const d = a.data;
  const setState = async (state: AlertDto['state']) => {
    try { await api.patch(`/api/listening/alerts/${id}`, { state }); toast.success(state === 'open' ? 'Reopened' : state === 'acknowledged' ? 'Acknowledged' : 'Dismissed'); await a.refetch(); } catch (e) { toast.error(e); }
  };
  const ratio = d.baseline.mean > 0 ? `${Math.round((d.observed / d.baseline.mean) * 10) / 10}× usual` : 'Usual: none';
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow={<Link href={`/listening/searches/${d.search.id}`} className="inline-flex items-center gap-1 hover:text-fg"><ArrowLeft aria-hidden className="size-3.5" />{d.search.name}</Link>}
        title={d.rule.metric === 'negative' ? 'Negative mention spike' : 'Mention spike'}
        meta={<>{fmtWhen(d.window.from)} · {d.window.minutes} min</>}
        actions={<>
          <Badge tone={STATE[d.state].tone}>{STATE[d.state].label}</Badge>
          {d.state === 'open' ? <>
            <Button variant="primary" icon={<Check aria-hidden />} onClick={() => setState('acknowledged')}>Acknowledge</Button>
            <Button variant="ghost" icon={<X aria-hidden />} onClick={() => setState('dismissed')}>Dismiss</Button>
          </> : <Button variant="ghost" onClick={() => setState('open')}>Reopen</Button>}
        </>} />
      <SimulatedBanner coverage={d.coverage} />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <MetricCard label="In window" value={d.observed} foot={ratio} tone="warn" info={LISTENING_DEFINITIONS.spike} />
        <MetricCard label="Usual" value={String(d.baseline.mean)} foot={`± ${d.baseline.stddev} over ${d.baseline.windows} windows`} />
        <MetricCard label="Threshold" value={d.threshold} foot={`Minimum sample ${d.min_sample}`} />
        <MetricCard label="Evidence" value={d.evidence.available} foot={d.evidence.removed_at_source ? `${d.evidence.removed_at_source} removed at source since` : `of ${d.evidence.total} counted`} />
      </div>

      <div className="grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
        <Card>
          <CardHeader title={`Mentions counted (${d.evidence.total})`} />
          <MentionList items={d.mentions} onChanged={a.refetch} compact />
        </Card>
        <div className="flex flex-col gap-6">
          <Card className="p-4">
            <h2 className="mb-3 flex items-center gap-1 text-[14px] font-semibold">Coverage at fire time<Definition>{LISTENING_DEFINITIONS.coverage}</Definition></h2>
            <Facts items={[
              ['Search', <Link key="s" className="hover:underline" href={`/listening/searches/${d.search.id}`}>{d.search.name} (query v{d.search.version_at_fire})</Link>],
              ['Rule', `${d.rule.name}`],
              ['Baseline', `${d.baseline.days} days, monitored windows only`],
              ['Fired', fmtWhen(d.created_at)],
              ...(d.acknowledged ? [[d.state === 'dismissed' ? 'Dismissed' : 'Acknowledged', `${d.acknowledged.by ?? ''} · ${fmtWhen(d.acknowledged.at)}`] as [string, string]] : []),
            ]} />
            <CoverageNote coverage={d.coverage} className="mt-4" />
          </Card>
          <Card className="p-4">
            <h2 className="mb-3 text-[14px] font-semibold">Act on it</h2>
            <div className="flex flex-col gap-2">
              <Button variant="secondary" icon={<ClipboardList aria-hidden />} disabled={!!busy} onClick={() => run('task', { alert_id: id })}>Create task</Button>
              {can('drafts.edit') ? <Button variant="secondary" icon={<SquarePen aria-hidden />} disabled={!!busy} onClick={() => run('draft', { alert_id: id })}>Create content draft</Button> : null}
              <p className="text-xs text-muted">For a case, open a mention’s menu.</p>
            </div>
            {d.actions.length ? (
              <ul className="mt-3 flex flex-col gap-1 border-t border-border pt-3 text-[13px]">
                {d.actions.map((x) => <li key={x.target_id}><Link className="hover:underline" href={x.action === 'task' ? `/tasks?task=${x.target_id}` : x.action === 'draft' ? `/posts/${x.target_id}` : '/inbox'}>{x.action === 'task' ? 'Task' : x.action === 'draft' ? 'Draft' : 'Case'} · {fmtWhen(x.at)}</Link></li>)}
              </ul>
            ) : null}
          </Card>
        </div>
      </div>
    </div>
  );
}
