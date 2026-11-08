'use client';
// Platform → AI operations (V5 §16): workflow runs across workspaces — statuses, outcome codes, failed step keys and
// token totals. Operational metadata only: no titles, prompts, documents, customer messages or generated text.
// Budgets are changed per workspace through entitlement overrides (Plans) or by the workspace owner (Usage).
import type { PlatformAiDto } from '@social-lite/services/ai-workflows/admin';
import { useApi } from '@/lib/client/use-api';
import { Badge, Card, CardHeader, ErrorState, PageHeader, SkeletonRows } from '@/components/ui';

const STATUS: Record<string, string> = { preparing: 'Preparing', working: 'Working', needs_input: 'Needs input', needs_review: 'Ready for review', completed: 'Completed', partially_completed: 'Partly done', failed: 'Failed', cancelled: 'Stopped' };

export default function PlatformAiPage() {
  const { data, error, refetch } = useApi<PlatformAiDto>('/api/platform/ai', { poll: 60_000 });
  return (
    <>
      <PageHeader title="AI operations" meta={data ? (data.configured ? <Badge tone="success">Provider set up</Badge> : <Badge tone="info">Provider not set up</Badge>) : undefined} />
      {error && !data ? <ErrorState error={error} onRetry={refetch} /> : !data ? <SkeletonRows rows={6} /> : (
        <div className="flex flex-col gap-6" data-testid="platform-ai">
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <Card aria-labelledby="h-p24">
              <CardHeader id="h-p24" title="Workflow runs (24 h)" />
              {Object.keys(data.runs_24h).length ? (
                <dl className="grid grid-cols-2 gap-3 px-4 pb-4 text-[13px] sm:grid-cols-3">
                  {Object.entries(data.runs_24h).map(([k, n]) => <div key={k}><dt className="text-muted">{STATUS[k] ?? k}</dt><dd className="text-[20px] font-semibold tabular">{n}</dd></div>)}
                </dl>
              ) : <p className="px-4 pb-4 text-[13px] text-muted">None in the last 24 hours</p>}
            </Card>
            <Card aria-labelledby="h-pout">
              <CardHeader id="h-pout" title="Why runs stopped short (7 days)" />
              <div className="flex flex-col gap-2 px-4 pb-4 text-[13px]">
                {data.outcomes_7d.length ? data.outcomes_7d.map((o) => <div key={o.outcome_code} className="flex justify-between"><span className="font-mono text-xs">{o.outcome_code}</span><span className="tabular">{o.n}</span></div>) : <p className="text-muted">None</p>}
                {data.failed_steps_7d.length ? <p className="pt-2 text-xs text-muted">Failed steps: {data.failed_steps_7d.map((s) => `${s.step} (${s.n})`).join(', ')}</p> : null}
              </div>
            </Card>
          </div>
          <Card aria-labelledby="h-pwf">
            <CardHeader id="h-pwf" title="By workflow (7 days)" />
            <div className="overflow-x-auto px-4 pb-4">
              <table className="w-full min-w-[480px] text-[13px]">
                <thead><tr className="text-left text-xs text-muted"><th className="py-1 font-medium">Workflow</th><th className="font-medium">Runs</th><th className="font-medium">Done</th><th className="font-medium">Partly</th><th className="font-medium">Failed</th><th className="font-medium">Stopped</th><th className="font-medium">Tokens</th></tr></thead>
                <tbody>{data.runs_7d.map((w) => <tr key={w.workflow} className="border-t border-border"><td className="py-1.5">{w.label}</td><td className="tabular">{w.total}</td><td className="tabular">{w.completed}</td><td className="tabular">{w.partial}</td><td className="tabular">{w.failed}</td><td className="tabular">{w.cancelled}</td><td className="tabular">{w.tokens.toLocaleString()}</td></tr>)}</tbody>
              </table>
              {!data.runs_7d.length ? <p className="pt-2 text-[13px] text-muted">No workflow runs in the last 7 days</p> : null}
            </div>
          </Card>
          <Card aria-labelledby="h-pws">
            <CardHeader id="h-pws" title="Workspaces (most active)" />
            <div className="overflow-x-auto px-4 pb-4">
              <table className="w-full min-w-[520px] text-[13px]">
                <thead><tr className="text-left text-xs text-muted"><th className="py-1 font-medium">Workspace</th><th className="font-medium">Runs 7 d</th><th className="font-medium">Failed 7 d</th><th className="font-medium">Budget stops 7 d</th><th className="font-medium">Tokens 30 d</th></tr></thead>
                <tbody>{data.workspaces.map((w) => <tr key={w.workspace_id} className="border-t border-border"><td className="py-1.5"><a className="underline-offset-2 hover:underline" href={`/admin/platform/workspaces/${w.workspace_id}`}>{w.name}</a></td><td className="tabular">{w.runs_7d}</td><td className="tabular">{w.failed_7d}</td><td className="tabular">{w.budget_stops_7d}</td><td className="tabular">{w.tokens_30d.toLocaleString()}</td></tr>)}</tbody>
              </table>
            </div>
            <p className="px-4 pb-4 text-xs text-muted">Counts and codes only — no customer content. Change a workspace’s AI allowance with an entitlement override.</p>
          </Card>
        </div>
      )}
    </>
  );
}
