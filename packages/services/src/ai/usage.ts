// Per-workspace (and V2: per-team) monthly AI token cap (usage_counters meter 'ai.tokens'). A call
// RESERVES max_tokens + an input estimate under a row lock before contacting the model, so concurrent
// requests can never jointly exceed the cap; afterwards the reservation is settled to the actual
// usage (or released on failure) and the call is recorded in ai_usage (IDs and counts only).
// The reservation mechanism is shared with every other meter (product/budgets.ts).
import { getPool, maybeOne, type Queryable } from '@social-lite/db';
import { readMeterUsage, reserveUsage, settleUsage } from '../product/budgets.js';
import type { AiTask } from './types.js';

export const AI_METER = 'ai.tokens' as const;
export const DEFAULT_AI_MONTHLY_TOKENS = 200_000;

/** USD per million tokens [input, output]; unknown models are priced like the default model. */
const PRICES: Record<string, [number, number]> = {
  'claude-opus-5-5': [4, 20], 'claude-opus-5': [5, 25], 'claude-opus-4-8': [5, 25], 'claude-sonnet-5-5': [2, 10],
  'claude-sonnet-5': [2, 10], 'claude-haiku-5-5': [0.1, 0.5], 'claude-fable-5-1': [10, 50], 'test-fixture': [0, 0],
};

export function costEstimateUsd(model: string, input: number, output: number): number {
  const [i, o] = PRICES[model] ?? PRICES['claude-opus-5-5']!;
  return Math.round(((input * i + output * o) / 1_000_000) * 1e6) / 1e6;
}

export function capFromLimits(limits: Record<string, unknown> | null | undefined): number {
  const v = Number(limits?.ai_monthly_tokens);
  return Number.isFinite(v) && v >= 0 ? Math.floor(v) : DEFAULT_AI_MONTHLY_TOKENS;
}

export interface Reservation { id: string; workspaceId: string; period: string; amount: number; cap: number }

export async function readUsage(workspaceId: string, db: Queryable = getPool()): Promise<{ period: string; used: number; cap: number; remaining: number }> {
  const u = await readMeterUsage(workspaceId, AI_METER, {}, db);
  const cap = u.cap ?? DEFAULT_AI_MONTHLY_TOKENS;
  return { period: u.period, used: u.used, cap, remaining: Math.max(0, cap - u.used - u.reserved) };
}

/**
 * Atomically reserve `amount` tokens (workspace cap + the acting user's team budgets) or throw
 * budget_exhausted. Runs in its own transaction (shared mechanism: product/budgets.ts).
 */
export async function reserveTokens(workspaceId: string, amount: number, opts: { userId?: string | null; ref?: string | null } = {}): Promise<Reservation> {
  const r = await reserveUsage({ workspaceId, meter: AI_METER, amount, userId: opts.userId ?? null, ref: opts.ref ?? null, ttlSeconds: 600 });
  const ws = await maybeOne<{ limits: Record<string, unknown> }>(getPool(), `SELECT limits FROM workspaces WHERE id=$1`, [workspaceId]);
  return { id: r.id, workspaceId, period: r.period, amount: r.amount, cap: capFromLimits(ws?.limits) };
}

export interface UsageRecord {
  brandId: string; postId: string | null; userId: string; model: string; task: AiTask;
  status: 'ok' | 'failed' | 'refused' | 'fixture'; inputTokens: number; outputTokens: number; correlationId: string;
}

/**
 * Settle a reservation to the actual token usage and record the call. Pass 0/0 tokens to release a
 * reservation after a failure that consumed nothing. Never fails the caller's request on bookkeeping
 * errors (logged by the caller).
 */
export async function settleTokens(r: Reservation, rec: UsageRecord): Promise<{ used: number; remaining: number }> {
  const actual = Math.max(0, Math.round(rec.inputTokens + rec.outputTokens));
  await settleUsage(r.id, actual);
  await getPool().query(
    `INSERT INTO ai_usage(workspace_id, brand_id, post_id, user_id, model, task, status, period, reserved_tokens, input_tokens, output_tokens, cost_estimate_usd, correlation_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [r.workspaceId, rec.brandId, rec.postId, rec.userId, rec.model, rec.task, rec.status, r.period, r.amount,
      Math.round(rec.inputTokens), Math.round(rec.outputTokens), costEstimateUsd(rec.model, rec.inputTokens, rec.outputTokens), rec.correlationId.slice(0, 64)]);
  const u = await readMeterUsage(r.workspaceId, AI_METER);
  return { used: u.used, remaining: Math.max(0, r.cap - u.used - u.reserved) };
}
