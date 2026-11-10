// D33 Free plan in billing. A Free workspace has NO provider customer, subscription, checkout or charge: its
// workspace_billing row says status 'free', plan 'free' and points at the current Free plan version (price 0, never
// purchasable, no provider price). Workspaces arrive on Free by:
//   - signup with ?plan=free, or onboarding without a plan (startFreeTx);
//   - a no-card trial that ends without a subscription (trials.ts sweepTrials);
//   - a subscription that ends — "downgrade to Free" is cancel-at-period-end, then Free (sync.ts applySubscription and
//     the billing sweep).
// Moving to Free never deletes anything: provider references and trial dates stay on the row as history, so a later
// checkout reuses the provider customer. Over-limit resources are held by the entitlement service (holds.ts).
import type { BillingEvent } from '@social-lite/core/contracts/v4-billing';
import type { Queryable } from '@social-lite/db';
import { currentVersion } from './catalogue.js';
import { loadBilling, saveBilling, type BillingRow, type LifecycleEntry } from './store.js';

/** The row as it reads once on Free (pure; the caller persists it with saveBilling). */
export function freeRow(prev: BillingRow, freeVersionId: string): BillingRow {
  return {
    ...prev, status: 'free', plan_id: 'free', plan_version_id: freeVersionId, seats: 0,
    cancel_at_period_end: false, cancel_at: null,
    scheduled_plan_version_id: null, scheduled_seats: null, scheduled_effective_at: null,
    past_due_since: null, grace_ends_at: null, payment_action_required: false,
  };
}

/** Persist a move to Free (prev must be locked FOR UPDATE in `tx`). Idempotent for a row already on Free. */
export async function moveToFreeTx(tx: Queryable, prev: BillingRow, entry: LifecycleEntry, events: BillingEvent[] = []): Promise<BillingRow> {
  const v = await currentVersion(tx, 'free');
  if (prev.status === 'free' && prev.plan_version_id) return prev;
  const saved = await saveBilling(tx, prev, freeRow(prev, v.id), entry, [...new Set<BillingEvent>([...events, 'billing.subscription_changed'])]);
  return saved.row;
}

/**
 * Create a NEW workspace on Free (signup ?plan=free / onboarding without a plan). No trial is redeemed, no card, no
 * provider objects. Runs in the workspace-creation transaction.
 */
export async function startFreeTx(tx: Queryable, p: { workspaceId: string; userId: string; source: 'signup' | 'onboarding' }): Promise<BillingRow> {
  const v = await currentVersion(tx, 'free');
  await tx.query(`INSERT INTO workspace_billing(workspace_id, plan_id, plan_version_id, status, seats) VALUES ($1,'free',$2,'none',0) ON CONFLICT DO NOTHING`, [p.workspaceId, v.id]);
  const prev = (await loadBilling(tx, p.workspaceId, { lock: true }))!;
  if (prev.status !== 'none') return prev;
  const saved = await saveBilling(tx, prev, freeRow(prev, v.id), { kind: 'free_started', source: 'signup', actorUserId: p.userId, detail: { source: p.source } });
  return saved.row;
}
