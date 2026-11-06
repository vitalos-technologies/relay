// Per-workspace provider budgets (spec §15 cost model). X API calls are billable: writes are
// metered before sending; reconciliation reads are metered separately. Caps live in
// workspaces.limits, e.g. {"x_monthly_writes": 500, "x_monthly_reads": 2000}. No cap => unmetered.
import type { Provider } from '@social-lite/core';
import { maybeOne, type Queryable } from '@social-lite/db';
import { writeOutbox } from '../outbox.js';

export type Meter = 'x.write' | 'x.read';

const LIMIT_KEY: Record<Meter, string> = { 'x.write': 'x_monthly_writes', 'x.read': 'x_monthly_reads' };

export function budgetMeterFor(provider: Provider, isMock: boolean): Meter | null {
  return provider === 'x' && !isMock ? 'x.write' : null;
}

export const period = (d = new Date()) => d.toISOString().slice(0, 7);

/**
 * Atomically check the cap and consume `amount`. Emits threshold notifications at 50/80/100%.
 * Must be called inside the caller's transaction.
 */
export async function checkAndConsumeBudget(tx: Queryable, workspaceId: string, meter: Meter, amount: number): Promise<{ ok: true } | { ok: false; message: string }> {
  const ws = await maybeOne<{ limits: Record<string, number> }>(tx, `SELECT limits FROM workspaces WHERE id=$1`, [workspaceId]);
  const cap = Number(ws?.limits?.[LIMIT_KEY[meter]] ?? NaN);
  const p = period();
  await tx.query(`INSERT INTO usage_counters(workspace_id, meter, period, used) VALUES ($1,$2,$3,0) ON CONFLICT DO NOTHING`, [workspaceId, meter, p]);
  const cur = await maybeOne<{ used: string }>(tx, `SELECT used FROM usage_counters WHERE workspace_id=$1 AND meter=$2 AND period=$3 FOR UPDATE`, [workspaceId, meter, p]);
  const used = Number(cur?.used ?? 0);
  if (Number.isFinite(cap) && used + amount > cap) {
    return { ok: false, message: `The monthly X API ${meter === 'x.write' ? 'post' : 'read'} budget (${cap}) is used up. X posts are paused until next month or until the cap is raised; other channels continue.` };
  }
  await tx.query(`UPDATE usage_counters SET used=used+$4 WHERE workspace_id=$1 AND meter=$2 AND period=$3`, [workspaceId, meter, p, amount]);
  if (Number.isFinite(cap) && cap > 0) {
    for (const pct of [50, 80, 100]) {
      const threshold = Math.ceil((cap * pct) / 100);
      if (used < threshold && used + amount >= threshold) {
        await writeOutbox(tx, { workspaceId, aggregateType: 'budget', aggregateId: `${meter}:${p}`, eventType: 'notification.created',
          payload: { kind: 'budget_threshold', meter, percent: pct, cap, period: p } });
      }
    }
  }
  return { ok: true };
}
