// getBillingState(): the BIL → ENT contract (core/contracts/v4-billing.ts). Verified billing facts only (provider events +
// reconciliation, never redirects). Access is derived on read from the clock as well as the persisted row, so a trial or a
// grace period that ended before the sweep ran is already restricted here. ENT must use this and never read billing tables.
// D33: when no paid entitlement is in force (no-card trial ended, subscription ended or reached its cancellation date,
// first payment never completed after the trial) the state reads as the Free plan — plan_id 'free', access full — even
// before the sweep / webhook persists the move (policy.ts deriveAccess().free).
import type { BillingState } from '@social-lite/core/contracts/v4-billing';
import { PLANS, type PlanId } from '@social-lite/core/contracts/v4-plans';
import { getPool, maybeOne, type Queryable } from '@social-lite/db';
import { deriveAccess, liveProviderSubscription } from './policy.js';
import { legacyRow, loadBilling, type BillingRow } from './store.js';

async function planOfVersion(db: Queryable, versionId: string | null): Promise<PlanId | null> {
  if (!versionId) return null;
  const r = await maybeOne<{ plan_id: PlanId }>(db, `SELECT plan_id FROM billing_plan_versions WHERE id=$1`, [versionId]);
  return r?.plan_id ?? null;
}

/** Effective plan/seats now: a scheduled downgrade / seat reduction takes over at its effective instant. */
export async function effectivePlan(db: Queryable, row: BillingRow, now: Date): Promise<{ plan_id: PlanId; plan_version_id: string | null; seats: number; scheduled: BillingState['scheduled_change'] }> {
  const due = !!row.scheduled_effective_at && row.scheduled_effective_at.getTime() <= now.getTime();
  const scheduledPlan = await planOfVersion(db, row.scheduled_plan_version_id);
  if (due) {
    return { plan_id: scheduledPlan ?? row.plan_id, plan_version_id: row.scheduled_plan_version_id ?? row.plan_version_id, seats: row.scheduled_seats ?? row.seats, scheduled: null };
  }
  const scheduled = row.scheduled_effective_at
    ? { plan_id: scheduledPlan, seats: row.scheduled_seats, effective_at: row.scheduled_effective_at.toISOString() } : null;
  return { plan_id: row.plan_id, plan_version_id: row.plan_version_id, seats: row.seats, scheduled };
}

async function freeVersionId(db: Queryable): Promise<string | null> {
  const r = await maybeOne<{ id: string }>(db, `SELECT id FROM billing_plan_versions WHERE plan_id='free' AND retired_at IS NULL`);
  return r?.id ?? null;
}

export async function getBillingState(db: Queryable, workspaceId: string, now: Date = new Date()): Promise<BillingState> {
  const ws = await maybeOne<{ state: string }>(db, `SELECT state FROM workspaces WHERE id=$1`, [workspaceId]);
  const row = (await loadBilling(db, workspaceId)) ?? legacyRow(workspaceId);
  const eff = await effectivePlan(db, row, now);
  const suspended = ws?.state === 'suspended';
  const { access, reason, free } = deriveAccess({ status: row.status, serviceSuspended: suspended, graceEndsAt: row.grace_ends_at, trialEndsAt: row.trial_ends_at, cancelAt: row.cancel_at, now,
    liveSubscription: liveProviderSubscription(row) });
  const trial = row.trial_started_at && row.trial_ends_at
    ? { started_at: row.trial_started_at.toISOString(), ends_at: row.trial_ends_at.toISOString(), plan_id: row.trial_plan_id ?? eff.plan_id } : null;
  if (free) {
    // An 'incomplete' first payment keeps its status (Settings shows the payment problem) but Free's features apply.
    const status = row.status === 'incomplete' ? row.status : 'free';
    return {
      workspace_id: workspaceId, plan_id: 'free', plan_version_id: row.plan_id === 'free' && row.plan_version_id ? row.plan_version_id : await freeVersionId(db),
      status, seats: 0, trial, current_period: null, cancel_at: null, scheduled_change: null,
      grace_ends_at: null, service_suspended: suspended, access, access_reason: reason, as_of: now.toISOString(),
    };
  }
  return {
    workspace_id: workspaceId,
    plan_id: row.status === 'none' ? null : eff.plan_id,
    plan_version_id: eff.plan_id === 'legacy' ? null : eff.plan_version_id,
    status: row.status,
    seats: eff.seats,
    trial,
    current_period: row.current_period_start && row.current_period_end ? { start: row.current_period_start.toISOString(), end: row.current_period_end.toISOString() } : null,
    cancel_at: row.status === 'cancel_scheduled' ? (row.cancel_at ?? row.current_period_end)?.toISOString() ?? null : null,
    scheduled_change: eff.scheduled,
    grace_ends_at: row.grace_ends_at?.toISOString() ?? null,
    service_suspended: suspended,
    access,
    access_reason: reason,
    as_of: now.toISOString(),
  };
}

export interface WorkspaceCommercialSummary {
  workspace_id: string;
  plan: { id: PlanId | null; name: string | null };
  status: BillingState['status'];
  access: BillingState['access'];
  access_reason: string | null;
  seats: number;
  billable_users: number;
  trial_ends_at: string | null;
  renews_at: string | null;
  cancel_at: string | null;
  payment_issue: boolean;
  open_checkout: boolean;
}

/**
 * Metadata-only commercial summary for Platform → Support's ticket context card (SUP) and Platform workspace lists.
 * No provider references, invoice amounts or card details (support staff are not billing staff).
 */
export async function workspaceCommercialSummary(workspaceId: string, db: Queryable = getPool()): Promise<WorkspaceCommercialSummary> {
  const s = await getBillingState(db, workspaceId);
  const { billableSeats } = await import('./seats.js');
  const open = await maybeOne(db, `SELECT 1 FROM billing_checkout_sessions WHERE workspace_id=$1 AND status IN ('pending','open') AND expires_at > now()`, [workspaceId]);
  return {
    workspace_id: workspaceId,
    plan: { id: s.plan_id, name: s.plan_id ? PLANS[s.plan_id].name : null },
    status: s.status, access: s.access, access_reason: s.access_reason, seats: s.seats, billable_users: await billableSeats(db, workspaceId),
    trial_ends_at: s.trial?.ends_at ?? null,
    renews_at: s.current_period && !s.cancel_at && ['active', 'trialing'].includes(s.status) ? s.current_period.end : null, // Free: nothing renews
    cancel_at: s.cancel_at,
    payment_issue: s.status === 'past_due' || s.status === 'payment_action_required' || s.status === 'incomplete',
    open_checkout: !!open,
  };
}
