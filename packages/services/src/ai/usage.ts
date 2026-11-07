// Per-workspace monthly AI token cap (usage_counters meter 'ai.tokens'). A call RESERVES
// max_tokens + an input estimate under a row lock before contacting the model, so concurrent
// requests can never jointly exceed the cap; afterwards the reservation is settled to the actual
// usage (or released on failure) and the call is recorded in ai_usage (IDs and counts only).
import { AppError } from '@social-lite/core';
import { getPool, maybeOne, withTx, type Queryable } from '@social-lite/db';
import { period } from '../engine/budget.js';
import type { AiTask } from './types.js';

export const AI_METER = 'ai.tokens';
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

export interface Reservation { workspaceId: string; period: string; amount: number; cap: number }

export async function readUsage(workspaceId: string, db: Queryable = getPool()): Promise<{ period: string; used: number; cap: number; remaining: number }> {
  const p = period();
  const row = await maybeOne<{ limits: Record<string, unknown>; used: string | null }>(db,
    `SELECT w.limits, u.used FROM workspaces w
       LEFT JOIN usage_counters u ON u.workspace_id = w.id AND u.meter = $2 AND u.period = $3
      WHERE w.id = $1`, [workspaceId, AI_METER, p]);
  const cap = capFromLimits(row?.limits);
  const used = Number(row?.used ?? 0);
  return { period: p, used, cap, remaining: Math.max(0, cap - used) };
}

/** Atomically reserve `amount` tokens or throw budget_exhausted. Runs in its own transaction. */
export async function reserveTokens(workspaceId: string, amount: number): Promise<Reservation> {
  return withTx(async (tx) => {
    const p = period();
    const ws = await maybeOne<{ limits: Record<string, unknown> }>(tx, `SELECT limits FROM workspaces WHERE id=$1`, [workspaceId]);
    const cap = capFromLimits(ws?.limits);
    await tx.query(`INSERT INTO usage_counters(workspace_id, meter, period, used) VALUES ($1,$2,$3,0) ON CONFLICT DO NOTHING`, [workspaceId, AI_METER, p]);
    const cur = await maybeOne<{ used: string }>(tx,
      `SELECT used FROM usage_counters WHERE workspace_id=$1 AND meter=$2 AND period=$3 FOR UPDATE`, [workspaceId, AI_METER, p]);
    const used = Number(cur?.used ?? 0);
    if (used + amount > cap) {
      throw new AppError('budget_exhausted', `This workspace’s monthly AI allowance is used up (${Math.max(0, cap - used).toLocaleString('en')} of ${cap.toLocaleString('en')} tokens left; one suggestion needs up to ${amount.toLocaleString('en')}). It resets next month, or an owner can raise it.`,
        undefined, { cap, used, needed: amount, period: p });
    }
    await tx.query(`UPDATE usage_counters SET used = used + $4 WHERE workspace_id=$1 AND meter=$2 AND period=$3`, [workspaceId, AI_METER, p, amount]);
    return { workspaceId, period: p, amount, cap };
  });
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
  return withTx(async (tx) => {
    const row = await maybeOne<{ used: string }>(tx,
      `UPDATE usage_counters SET used = greatest(0, used - $4 + $5) WHERE workspace_id=$1 AND meter=$2 AND period=$3 RETURNING used`,
      [r.workspaceId, AI_METER, r.period, r.amount, actual]);
    await tx.query(
      `INSERT INTO ai_usage(workspace_id, brand_id, post_id, user_id, model, task, status, period, reserved_tokens, input_tokens, output_tokens, cost_estimate_usd, correlation_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [r.workspaceId, rec.brandId, rec.postId, rec.userId, rec.model, rec.task, rec.status, r.period, r.amount,
        Math.round(rec.inputTokens), Math.round(rec.outputTokens), costEstimateUsd(rec.model, rec.inputTokens, rec.outputTokens), rec.correlationId.slice(0, 64)]);
    const used = Number(row?.used ?? 0);
    return { used, remaining: Math.max(0, r.cap - used) };
  });
}
