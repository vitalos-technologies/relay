// Per-workspace (and V2: per-team) provider budgets (spec §15 cost model). X API calls are billable:
// writes are metered before sending; reconciliation reads are metered separately. Caps live in
// workspaces.limits, e.g. {"x_monthly_writes": 500, "x_monthly_reads": 2000}, and team caps in
// usage_budgets. No cap => unmetered. The accounting itself is the shared reservation mechanism in
// product/budgets.ts (one implementation for AI, storage, exports and provider calls).
import type { Provider } from '@social-lite/core';
import { maybeOne, type Queryable } from '@social-lite/db';
import { consumeUsage } from '../product/budgets.js';

export type Meter = 'x.write' | 'x.read';

export function budgetMeterFor(provider: Provider, isMock: boolean): Meter | null {
  return provider === 'x' && !isMock ? 'x.write' : null;
}

export const period = (d = new Date()) => d.toISOString().slice(0, 7);

/** Who a provider call is attributed to (team budgets): the schedule's creator for a delivery. */
export interface BudgetAttribution { userId?: string | null; deliveryId?: string | null }

/**
 * Atomically check the caps (workspace + attributed teams) and consume `amount`. Emits threshold
 * notifications at 50/80/100%. Must be called inside the caller's transaction.
 */
export async function checkAndConsumeBudget(tx: Queryable, workspaceId: string, meter: Meter, amount: number, attribution: BudgetAttribution = {}): Promise<{ ok: true } | { ok: false; message: string }> {
  let userId = attribution.userId ?? null;
  if (!userId && attribution.deliveryId) {
    const r = await maybeOne<{ created_by: string | null }>(tx,
      `SELECT s.created_by FROM deliveries d JOIN schedules s ON s.id = d.schedule_id WHERE d.id = $1 AND d.workspace_id = $2`, [attribution.deliveryId, workspaceId]);
    userId = r?.created_by ?? null;
  }
  const r = await consumeUsage(tx, { workspaceId, meter, amount, userId });
  return r.ok ? { ok: true } : { ok: false, message: r.message };
}
