// Admin visibility for AI + automation (brief §20 "AI usage and budgets", "automation runs"). Counts and states only —
// never prompts, outputs or message text — so the shape is safe for workspace admins without inbox access.
// Permission: diagnostics.read (as the inbox admin overview). Stream F wires it into the admin app.
import { getPool, many, one } from '@social-lite/db';
import type { Ctx } from '../context.js';
import { requireAction } from '../tenancy.js';
import { readUsage } from '../ai/usage.js';
import { costEstimateForTotals } from '../ai/models.js';
import { assistantConfigured } from '../assistant/client.js';
import { emergencyStopState } from './policies.js';

export interface AiAutomationAdminOverview {
  generated_at: string;
  ai: {
    configured: boolean;
    budget: { period: string; used: number; cap: number; remaining: number };
    runs_24h: Record<string, number>;          // by status
    tokens_30d: number;
    /** At the configured prices (AI_MODEL_PRICES); null when a model used has no configured price. */
    cost_estimate_usd_30d: number | null; median_latency_ms_7d: number | null;
    knowledge_sources: { approved: number; stale: number };
  };
  automation: {
    emergency_stop: { active: boolean; at: string | null; by: string | null };
    policies: Record<string, number>;          // by status
    rules: { enabled: number; total: number };
    runs_24h: Record<string, number>;          // by outcome
    automated_replies_24h: number;
    expiring_7d: Array<{ id: string; name: string; expires_at: string }>;
  };
}

export async function aiAutomationAdminOverview(ctx: Ctx): Promise<AiAutomationAdminOverview> {
  requireAction(ctx, 'diagnostics.read');
  const db = getPool();
  const ws = ctx.access.workspaceId;
  const [runs, usage30, lat, know, pol, rules, aruns, replies, expiring] = await Promise.all([
    many<{ status: string; n: number }>(db, `SELECT status, count(*)::int n FROM ai_runs WHERE workspace_id=$1 AND created_at > now() - interval '24 hours' GROUP BY status`, [ws]),
    many<{ model: string | null; input_tokens: number; output_tokens: number }>(db, `SELECT model, coalesce(sum(input_tokens), 0)::int input_tokens, coalesce(sum(output_tokens), 0)::int output_tokens FROM ai_runs WHERE workspace_id=$1 AND created_at > now() - interval '30 days' GROUP BY model`, [ws]),
    one<{ p50: number | null }>(db, `SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY latency_ms)::float8 p50 FROM ai_runs WHERE workspace_id=$1 AND latency_ms IS NOT NULL AND created_at > now() - interval '7 days'`, [ws]),
    one<{ approved: number; stale: number }>(db, `SELECT count(*)::int approved, count(*) FILTER (WHERE review_by < current_date)::int stale FROM ai_knowledge_sources WHERE workspace_id=$1 AND revoked_at IS NULL`, [ws]),
    many<{ status: string; n: number }>(db, `SELECT CASE WHEN status='active' AND expires_at <= now() THEN 'expired' ELSE status END status, count(*)::int n FROM automation_policies WHERE workspace_id=$1 GROUP BY 1`, [ws]),
    one<{ enabled: number; total: number }>(db, `SELECT count(*) FILTER (WHERE enabled)::int enabled, count(*)::int total FROM automation_rules WHERE workspace_id=$1 AND deleted_at IS NULL`, [ws]),
    many<{ outcome: string; n: number }>(db, `SELECT outcome, count(*)::int n FROM automation_runs WHERE workspace_id=$1 AND NOT is_test AND created_at > now() - interval '24 hours' GROUP BY outcome`, [ws]),
    one<{ n: number }>(db, `SELECT count(*)::int n FROM automation_sends WHERE workspace_id=$1 AND created_at > now() - interval '24 hours'`, [ws]),
    many<{ id: string; name: string; expires_at: Date }>(db, `SELECT id, name, expires_at FROM automation_policies WHERE workspace_id=$1 AND status='active' AND expires_at BETWEEN now() AND now() + interval '7 days' ORDER BY expires_at LIMIT 20`, [ws]),
  ]);
  const by = (rows: Array<{ n: number } & Record<string, unknown>>, k: string) => Object.fromEntries(rows.map((r) => [String(r[k]), r.n]));
  const u = await readUsage(ws, db);
  return {
    generated_at: new Date().toISOString(),
    ai: {
      configured: await assistantConfigured(db), budget: u, runs_24h: by(runs, 'status'), tokens_30d: usage30.reduce((n, r) => n + r.input_tokens + r.output_tokens, 0), cost_estimate_usd_30d: costEstimateForTotals(usage30),
      median_latency_ms_7d: lat.p50 === null ? null : Math.round(lat.p50), knowledge_sources: know,
    },
    automation: {
      emergency_stop: await emergencyStopState(ws, db), policies: by(pol, 'status'), rules, runs_24h: by(aruns, 'outcome'), automated_replies_24h: replies.n,
      expiring_7d: expiring.map((e) => ({ id: e.id, name: e.name, expires_at: e.expires_at.toISOString() })),
    },
  };
}
