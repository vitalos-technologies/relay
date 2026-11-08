// Admin views for AI workflows (V5 §16): run history and failures, model usage, budget and feature availability.
// Workspace admins (diagnostics.read) see their workspace: statuses, workflow names, failed step, Relay-written status
// text, requester — never prompts, documents, customer messages or generated text. Platform staff see operational
// metadata across workspaces only (counts, codes, step keys, token totals) — no titles or status text.
import { WORKFLOW_LABEL, type AiWorkflow } from '@social-lite/core/contracts/v5-ai';
import { getPool, many, one } from '@social-lite/db';
import type { Ctx } from '../context.js';
import { requireAction } from '../tenancy.js';
import { readUsage } from '../ai/usage.js';
import { assistantConfigured } from '../assistant/client.js';
import { checkFeature, entitlementsCore } from '../entitlements/resolve.js';
import { requirePlatform, type PlatformCtx } from '../admin/platform.js';

export interface WorkflowAdminRow { workflow: AiWorkflow; label: string; total: number; completed: number; partial: number; failed: number; cancelled: number; review: number; tokens: number }

export interface AiWorkflowAdminDto {
  generated_at: string;
  configured: boolean;
  features: { ai_drafting: boolean; ai_workflows: boolean; plan: string };
  budget: { period: string; used: number; cap: number; remaining: number };
  runs_7d: { by_status: Record<string, number>; by_workflow: WorkflowAdminRow[] };
  usage_30d: { tokens: number; cost_estimate_usd: number; model_calls: number };
  failures: Array<{ id: string; workflow: AiWorkflow; label: string; status: string; outcome_code: string | null; failed_step: string | null; detail: string | null; requested_by: string | null; created_at: string }>;
  active: number;
}

const byWorkflowSql = (where: string) => `
  SELECT task AS workflow, count(*)::int AS total,
         count(*) FILTER (WHERE status='completed')::int AS completed, count(*) FILTER (WHERE status='partially_completed')::int AS partial,
         count(*) FILTER (WHERE status='failed')::int AS failed, count(*) FILTER (WHERE status='cancelled')::int AS cancelled,
         count(*) FILTER (WHERE status='needs_review')::int AS review, coalesce(sum(input_tokens + output_tokens), 0)::int AS tokens
    FROM ai_runs WHERE kind='workflow' AND created_at > now() - interval '7 days' ${where} GROUP BY task ORDER BY total DESC`;

export async function aiWorkflowAdmin(ctx: Ctx): Promise<AiWorkflowAdminDto> {
  requireAction(ctx, 'diagnostics.read');
  const db = getPool();
  const ws = ctx.access.workspaceId;
  const [configured, budget, core, status, wf, usage, failures, active] = await Promise.all([
    assistantConfigured(db), readUsage(ws, db), entitlementsCore(db, ws),
    many<{ status: string; n: number }>(db, `SELECT status, count(*)::int n FROM ai_runs WHERE workspace_id=$1 AND kind='workflow' AND created_at > now() - interval '7 days' GROUP BY status`, [ws]),
    many<Omit<WorkflowAdminRow, 'label'>>(db, byWorkflowSql('AND workspace_id=$1'), [ws]),
    one<{ tokens: number; cost: number; calls: number }>(db, `SELECT coalesce(sum(input_tokens + output_tokens), 0)::int tokens, coalesce(sum(cost_estimate_usd), 0)::float8 cost, count(*)::int calls FROM ai_usage WHERE workspace_id=$1 AND created_at > now() - interval '30 days'`, [ws]),
    many<{ id: string; task: AiWorkflow; status: string; outcome_code: string | null; status_detail: string | null; step: string | null; who: string | null; created_at: Date }>(db,
      `SELECT r.id, r.task, r.status, r.outcome_code, r.status_detail, r.created_at, coalesce(u.name, u.email) AS who,
              (SELECT s.label FROM ai_run_steps s WHERE s.run_id=r.id AND s.status IN ('failed','not_configured') ORDER BY s.seq LIMIT 1) AS step
         FROM ai_runs r LEFT JOIN users u ON u.id=r.requested_by
        WHERE r.workspace_id=$1 AND r.kind='workflow' AND r.status IN ('failed','partially_completed') ORDER BY r.created_at DESC LIMIT 20`, [ws]),
    one<{ n: number }>(db, `SELECT count(*)::int n FROM ai_runs WHERE workspace_id=$1 AND kind='workflow' AND status IN ('preparing','working','needs_input','needs_review')`, [ws]),
  ]);
  return {
    generated_at: new Date().toISOString(), configured,
    features: { ai_drafting: checkFeature(core, 'ai_drafting', { paid: true }).ok, ai_workflows: checkFeature(core, 'ai_workflows', { paid: true }).ok, plan: core.plan?.name ?? 'No plan' },
    budget,
    runs_7d: { by_status: Object.fromEntries(status.map((s) => [s.status, s.n])), by_workflow: wf.map((w) => ({ ...w, label: WORKFLOW_LABEL[w.workflow] ?? w.workflow })) },
    usage_30d: { tokens: usage.tokens, cost_estimate_usd: usage.cost, model_calls: usage.calls },
    failures: failures.map((f) => ({ id: f.id, workflow: f.task, label: WORKFLOW_LABEL[f.task] ?? f.task, status: f.status, outcome_code: f.outcome_code, failed_step: f.step, detail: f.status_detail, requested_by: f.who, created_at: f.created_at.toISOString() })),
    active: active.n,
  };
}

export interface PlatformAiDto {
  generated_at: string;
  configured: boolean;
  runs_24h: Record<string, number>;
  runs_7d: WorkflowAdminRow[];
  outcomes_7d: Array<{ outcome_code: string; n: number }>;
  failed_steps_7d: Array<{ step: string; n: number }>;
  workspaces: Array<{ workspace_id: string; name: string; runs_7d: number; failed_7d: number; tokens_30d: number; budget_stops_7d: number }>;
}

/** Platform → AI operations: operational metadata across workspaces (no customer content, no titles, no status text). */
export async function platformAiOverview(p: PlatformCtx): Promise<PlatformAiDto> {
  requirePlatform(p, 'staff');
  const db = getPool();
  const [configured, s24, wf, outcomes, steps, wss] = await Promise.all([
    assistantConfigured(db),
    many<{ status: string; n: number }>(db, `SELECT status, count(*)::int n FROM ai_runs WHERE kind='workflow' AND created_at > now() - interval '24 hours' GROUP BY status`),
    many<Omit<WorkflowAdminRow, 'label'>>(db, byWorkflowSql('')),
    many<{ outcome_code: string; n: number }>(db, `SELECT outcome_code, count(*)::int n FROM ai_runs WHERE kind='workflow' AND outcome_code IS NOT NULL AND created_at > now() - interval '7 days' GROUP BY outcome_code ORDER BY n DESC`),
    many<{ step: string; n: number }>(db, `SELECT s.key AS step, count(*)::int n FROM ai_run_steps s JOIN ai_runs r ON r.id=s.run_id WHERE s.status='failed' AND r.created_at > now() - interval '7 days' GROUP BY s.key ORDER BY n DESC LIMIT 10`),
    many<PlatformAiDto['workspaces'][number]>(db,
      `SELECT w.id AS workspace_id, w.name,
              count(r.id) FILTER (WHERE r.created_at > now() - interval '7 days')::int AS runs_7d,
              count(r.id) FILTER (WHERE r.created_at > now() - interval '7 days' AND r.status='failed')::int AS failed_7d,
              coalesce(sum(r.input_tokens + r.output_tokens) FILTER (WHERE r.created_at > now() - interval '30 days'), 0)::int AS tokens_30d,
              count(r.id) FILTER (WHERE r.created_at > now() - interval '7 days' AND r.outcome_code='budget_exhausted')::int AS budget_stops_7d
         FROM ai_runs r JOIN workspaces w ON w.id=r.workspace_id
        WHERE r.kind='workflow' AND r.created_at > now() - interval '30 days' GROUP BY w.id, w.name ORDER BY runs_7d DESC LIMIT 25`),
  ]);
  return {
    generated_at: new Date().toISOString(), configured, runs_24h: Object.fromEntries(s24.map((s) => [s.status, s.n])),
    runs_7d: wf.map((w) => ({ ...w, label: WORKFLOW_LABEL[w.workflow] ?? w.workflow })), outcomes_7d: outcomes, failed_steps_7d: steps, workspaces: wss,
  };
}
