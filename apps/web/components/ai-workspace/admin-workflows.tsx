'use client';
// Workspace admin → AI workflows (V5 §16): feature availability, budget, runs by workflow and recent failures —
// statuses, step names and Relay-written outcome text only (never prompts, documents, messages or generated text).
import Link from 'next/link';
import type { AiWorkflowAdminDto } from '@social-lite/services/ai-workflows/admin';
import { useApi } from '@/lib/client/use-api';
import { Badge, Card, CardHeader, ErrorNotice, SkeletonRows } from '@/components/ui';

const OUTCOME: Record<string, string> = { not_configured: 'AI not set up', budget_exhausted: 'Budget used up', blocked: 'Access revoked', timeout: 'Timed out', entitlement: 'Not in plan', step_failed: 'A step failed', cancelled: 'Stopped', interrupted: 'Interrupted' };

export function AiWorkflowsAdmin() {
  const { data, error } = useApi<AiWorkflowAdminDto>('/api/assistant/admin', { poll: 30_000 });
  if (error && !data) return <ErrorNotice error={error} />;
  if (!data) return <SkeletonRows rows={3} />;
  const pct = data.budget.cap ? Math.min(100, Math.round((data.budget.used / data.budget.cap) * 100)) : 0;
  return (
    <div className="flex flex-col gap-6" data-testid="admin-ai-workflows">
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card aria-labelledby="h-aw-feat">
          <CardHeader id="h-aw-feat" title="AI workspace availability" actions={<Link href="/admin/usage" className="text-[13px] text-[var(--accent-text)]">Budget and limits</Link>} />
          <div className="flex flex-col gap-3 px-4 pb-4 text-[13px]">
            <dl className="grid grid-cols-2 gap-3">
              <div><dt className="text-muted">Plan</dt><dd>{data.features.plan}</dd></div>
              <div><dt className="text-muted">AI provider</dt><dd>{data.configured ? <Badge tone="success">Set up</Badge> : <Badge tone="info">Not set up</Badge>}</dd></div>
              <div><dt className="text-muted">AI drafting</dt><dd>{data.features.ai_drafting ? 'Included' : 'Not available'}</dd></div>
              <div><dt className="text-muted">Multi-step workflows</dt><dd>{data.features.ai_workflows ? 'Included' : 'Professional plan'}</dd></div>
            </dl>
            <div>
              <div className="flex justify-between text-xs text-muted"><span>Budget {data.budget.period}</span><span className="tabular">{data.budget.used.toLocaleString()} / {data.budget.cap.toLocaleString()} tokens</span></div>
              <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-sunken" role="meter" aria-label="AI budget used" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
                <div className={`h-full rounded-full ${pct >= 90 ? 'bg-danger' : pct >= 70 ? 'bg-warn' : 'bg-accent'}`} style={{ width: `${pct}%` }} />
              </div>
            </div>
            <p className="text-xs text-muted">30 days: {data.usage_30d.model_calls.toLocaleString()} model calls · {data.usage_30d.tokens.toLocaleString()} tokens · est. ${data.usage_30d.cost_estimate_usd.toFixed(2)}. Active now: {data.active}.</p>
          </div>
        </Card>
        <Card aria-labelledby="h-aw-runs">
          <CardHeader id="h-aw-runs" title="Workflow runs (7 days)" />
          {data.runs_7d.by_workflow.length ? (
            <div className="overflow-x-auto px-4 pb-4">
              <table className="w-full min-w-[420px] text-[13px]">
                <thead><tr className="text-left text-xs text-muted"><th className="py-1 font-medium">Workflow</th><th className="font-medium">Runs</th><th className="font-medium">Done</th><th className="font-medium">Partly</th><th className="font-medium">Failed</th><th className="font-medium">Tokens</th></tr></thead>
                <tbody>{data.runs_7d.by_workflow.map((w) => (
                  <tr key={w.workflow} className="border-t border-border"><td className="py-1.5">{w.label}</td><td className="tabular">{w.total}</td><td className="tabular">{w.completed}</td><td className="tabular">{w.partial}</td><td className="tabular">{w.failed}</td><td className="tabular">{w.tokens.toLocaleString()}</td></tr>
                ))}</tbody>
              </table>
            </div>
          ) : <p className="px-4 pb-4 text-[13px] text-muted">No workflow runs in the last 7 days</p>}
        </Card>
      </div>
      <Card aria-labelledby="h-aw-fail">
        <CardHeader id="h-aw-fail" title="Recent failures and partial runs" />
        {data.failures.length ? (
          <ul className="divide-y divide-border px-4 pb-2 text-[13px]">
            {data.failures.map((f) => (
              <li key={f.id} className="flex flex-col gap-0.5 py-2.5 sm:flex-row sm:items-center sm:gap-3">
                <span className="min-w-0 flex-1"><span className="font-medium">{f.label}</span>{f.failed_step ? <span className="text-muted"> · {f.failed_step}</span> : null}<span className="block break-words text-xs text-muted">{f.detail}</span></span>
                <Badge tone={f.status === 'failed' ? 'danger' : 'warn'}>{f.outcome_code ? OUTCOME[f.outcome_code] ?? f.outcome_code : f.status}</Badge>
                <span className="text-xs text-subtle">{f.requested_by ?? '—'} · {new Date(f.created_at).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}</span>
              </li>
            ))}
          </ul>
        ) : <p className="px-4 pb-4 text-[13px] text-muted">None</p>}
      </Card>
    </div>
  );
}
