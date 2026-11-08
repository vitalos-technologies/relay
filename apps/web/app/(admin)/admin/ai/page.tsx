'use client';
// Admin → AI and automation (stream F over stream E's aiAutomationAdminOverview): AI setup, monthly budget, runs and
// latency, approved knowledge; automation emergency stop, policies, rules, runs by outcome, automatic replies,
// policies expiring soon. Counts and states only — never prompts, outputs or customer text.
import Link from 'next/link';
import { useApi } from '@/lib/client/use-api';
import { Badge, Card, CardHeader, ErrorState, InfoTip, PageHeader, SkeletonRows } from '@/components/ui';
import type { AiAutomationAdminOverview } from '@social-lite/services/automation/admin';
import { AiWorkflowsAdmin } from '@/components/ai-workspace/admin-workflows';

const RUN_LABEL: Record<string, string> = { queued: 'Queued', running: 'Running', succeeded: 'Done', failed: 'Failed', blocked: 'Blocked', cancelled: 'Cancelled',
  // V5 workflow runs (AIW)
  preparing: 'Preparing', working: 'Working', needs_input: 'Needs input', needs_review: 'Ready for review', completed: 'Completed', partially_completed: 'Partly done', not_configured: 'AI not set up', budget_exhausted: 'Budget used up', refused: 'Declined' };
const OUTCOME_LABEL: Record<string, string> = { succeeded: 'Done', partial: 'Partly done', failed: 'Failed', blocked: 'Blocked', skipped: 'Skipped', escalated: 'Escalated to a person', pending: 'In progress' };

function Counts({ data, labels }: { data: Record<string, number>; labels: Record<string, string> }) {
  const rows = Object.entries(data).filter(([, n]) => n > 0);
  if (!rows.length) return <p className="px-4 pb-4 text-[13px] text-muted">None in the last 24 hours</p>;
  return (
    <dl className="grid grid-cols-2 gap-3 px-4 pb-4 text-[13px] sm:grid-cols-3">
      {rows.map(([k, n]) => <div key={k}><dt className="text-muted">{labels[k] ?? k}</dt><dd className="text-[20px] font-semibold tabular">{n}</dd></div>)}
    </dl>
  );
}

export default function AdminAiPage() {
  const { data, error, loading, refetch } = useApi<AiAutomationAdminOverview>('/api/automation/admin', { poll: 30_000 });
  const pct = data && data.ai.budget.cap ? Math.min(100, Math.round((data.ai.budget.used / data.ai.budget.cap) * 100)) : 0;
  return (
    <>
      <PageHeader title="AI and automation" meta={<InfoTip label="About this page">AI usage shares the workspace’s monthly token budget. Automation runs only under an active policy.</InfoTip>} />
      <section aria-label="AI workflows" className="mb-6"><AiWorkflowsAdmin /></section>
      {error && !data ? <ErrorState error={error} onRetry={refetch} /> : loading || !data ? <SkeletonRows rows={6} /> : (
        <div className="flex flex-col gap-6" data-testid="admin-ai">
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <Card aria-labelledby="h-ai">
              <CardHeader id="h-ai" title="Relay AI" actions={data.ai.configured ? <Badge tone="success">Set up</Badge> : <Badge tone="info">Not set up</Badge>} />
              <div className="flex flex-col gap-3 px-4 pb-4 text-[13px]">
                <div>
                  <div className="flex justify-between text-xs text-muted"><span>Budget {data.ai.budget.period}</span><span className="tabular">{data.ai.budget.used.toLocaleString()} / {data.ai.budget.cap.toLocaleString()} tokens</span></div>
                  <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-sunken" role="meter" aria-label="AI budget used" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
                    <div className={`h-full rounded-full ${pct >= 90 ? 'bg-danger' : pct >= 70 ? 'bg-warn' : 'bg-accent'}`} style={{ width: `${pct}%` }} />
                  </div>
                </div>
                <dl className="grid grid-cols-2 gap-3">
                  <div><dt className="text-muted">Tokens (30 days)</dt><dd className="tabular">{data.ai.tokens_30d.toLocaleString()}</dd></div>
                  <div><dt className="text-muted">Estimated cost (30 days)</dt><dd className="tabular">${data.ai.cost_estimate_usd_30d.toFixed(2)}</dd></div>
                  <div><dt className="text-muted">Median time (7 days)</dt><dd className="tabular">{data.ai.median_latency_ms_7d === null ? '—' : `${(data.ai.median_latency_ms_7d / 1000).toFixed(1)} s`}</dd></div>
                  <div><dt className="text-muted">Approved knowledge</dt><dd className="tabular">{data.ai.knowledge_sources.approved}{data.ai.knowledge_sources.stale ? ` · ${data.ai.knowledge_sources.stale} past review` : ''}</dd></div>
                </dl>
              </div>
            </Card>
            <Card aria-labelledby="h-ar">
              <CardHeader id="h-ar" title="AI runs (24 h)" />
              <Counts data={data.ai.runs_24h} labels={RUN_LABEL} />
            </Card>
          </div>
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <Card aria-labelledby="h-au">
              <CardHeader id="h-au" title="Automation" actions={<Link href="/automation" className="text-[13px] text-[var(--accent-text)]">Open</Link>} />
              <div className="flex flex-col gap-3 px-4 pb-4 text-[13px]">
                {data.automation.emergency_stop.active ? <Badge tone="danger" className="self-start">Emergency stop on{data.automation.emergency_stop.by ? ` · ${data.automation.emergency_stop.by}` : ''}</Badge> : <Badge tone="success" className="self-start">Running</Badge>}
                <dl className="grid grid-cols-2 gap-3">
                  <div><dt className="text-muted">Active policies</dt><dd className="tabular">{data.automation.policies.active ?? 0}</dd></div>
                  <div><dt className="text-muted">Rules on</dt><dd className="tabular">{data.automation.rules.enabled} of {data.automation.rules.total}</dd></div>
                  <div><dt className="text-muted">Automatic replies (24 h)</dt><dd className="tabular">{data.automation.automated_replies_24h}</dd></div>
                  <div><dt className="text-muted">Expiring within 7 days</dt><dd className="tabular">{data.automation.expiring_7d.length}</dd></div>
                </dl>
                {data.automation.expiring_7d.length ? (
                  <ul className="flex flex-col gap-1 text-xs">{data.automation.expiring_7d.map((p) => <li key={p.id} className="flex justify-between gap-2"><span className="min-w-0 truncate">{p.name}</span><span className="text-muted">{new Date(p.expires_at).toLocaleDateString()}</span></li>)}</ul>
                ) : null}
              </div>
            </Card>
            <Card aria-labelledby="h-rr">
              <CardHeader id="h-rr" title="Automation runs (24 h)" actions={<Link href="/automation?tab=history" className="text-[13px] text-[var(--accent-text)]">History</Link>} />
              <Counts data={data.automation.runs_24h} labels={OUTCOME_LABEL} />
            </Card>
          </div>
        </div>
      )}
    </>
  );
}
