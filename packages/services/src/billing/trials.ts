// Trials (V5 §7): 14-day, no card, on the selected plan, ONCE per workspace (billing_trial_redemptions PK). Joining a
// workspace, changing plan, refreshing, repeating checkout or replaying a request never creates or extends a trial; only an
// audited staff extension moves the end (bounded). Exact started_at / ends_at are stored server-side.
// D33: trials are for the paid plans only (never Free). A trial that ends without a subscription moves the workspace to
// Free (sweepTrials); a Free workspace that never redeemed a trial may still start one (Settings or checkout).
import { AppError } from '@social-lite/core';
import type { PlanId, PublicPlanId } from '@social-lite/core/contracts/v4-plans';
import { maybeOne, type Queryable } from '@social-lite/db';
import { currentVersion, isPaidPlan } from './catalogue.js';
import { moveToFreeTx } from './free.js';
import { MAX_TRIAL_EXTENSIONS, MAX_TRIAL_EXTENSION_DAYS, TRIAL_ENDING_NOTICE_DAYS } from './policy.js';
import { billableSeats } from './seats.js';
import { legacyRow, loadBilling, saveBilling, type BillingRow } from './store.js';

export interface Redemption { workspace_id: string; plan_id: PlanId; redeemed_by: string | null; source: string; started_at: Date; ends_at: Date; original_ends_at: Date; extensions: number }

export async function trialRedemption(db: Queryable, workspaceId: string, lock = false): Promise<Redemption | null> {
  return maybeOne<Redemption>(db, `SELECT * FROM billing_trial_redemptions WHERE workspace_id=$1 ${lock ? 'FOR UPDATE' : ''}`, [workspaceId]);
}

/**
 * Start the workspace's one trial (inside the caller's transaction). Eligible: a workspace with no billing row yet (just
 * created through signup/onboarding) or status 'none'. Legacy workspaces keep their legacy plan (no trial needed); any
 * workspace that ever redeemed a trial gets `trial_already_used`.
 */
export async function startTrialTx(tx: Queryable, p: { workspaceId: string; planId: string; userId: string; source: 'signup' | 'onboarding' | 'settings'; now?: Date }): Promise<BillingRow> {
  if (!isPaidPlan(p.planId)) throw new AppError('validation_failed', 'Choose Standard or Professional', { plan: 'Unknown plan' });
  // Whole seconds: provider timestamps (trial_end, period ends) are in seconds, so dates compare exactly everywhere.
  const now = new Date(Math.floor((p.now ?? new Date()).getTime() / 1000) * 1000);
  await tx.query(`SELECT pg_advisory_xact_lock(hashtext('billing-trial:' || $1::text))`, [p.workspaceId]);
  if (await trialRedemption(tx, p.workspaceId, true)) throw new AppError('conflict', 'This workspace has already used its free trial.', undefined, { reason: 'trial_already_used' });
  const existing = await loadBilling(tx, p.workspaceId, { lock: true });
  if (existing && existing.status !== 'none' && existing.status !== 'free') {
    throw new AppError('invalid_state', existing.status === 'legacy' ? 'This workspace is on the legacy plan; choose a plan to subscribe instead.' : 'A trial cannot start for this workspace now.');
  }
  const version = await currentVersion(tx, p.planId as PublicPlanId);
  const endsAt = new Date(now.getTime() + version.trial_days * 86400_000);
  await tx.query(
    `INSERT INTO billing_trial_redemptions(workspace_id, plan_id, plan_version_id, redeemed_by, source, started_at, ends_at, original_ends_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$7)`,
    [p.workspaceId, p.planId, version.id, p.userId, p.source, now, endsAt]);
  if (!existing) {
    await tx.query(`INSERT INTO workspace_billing(workspace_id, plan_id, plan_version_id, status, seats) VALUES ($1,$2,$3,'none',0)`, [p.workspaceId, p.planId, version.id]);
  }
  const prev = (await loadBilling(tx, p.workspaceId, { lock: true }))!;
  const next: BillingRow = { ...prev, plan_id: p.planId as PlanId, plan_version_id: version.id, status: 'trialing', trial_started_at: now, trial_ends_at: endsAt,
    trial_plan_id: p.planId as PlanId, seats: await billableSeats(tx, p.workspaceId) };
  const saved = await saveBilling(tx, prev, next, { kind: 'trial_started', source: p.source === 'settings' ? 'user' : 'signup', actorUserId: p.userId,
    detail: { plan: p.planId, ends_at: endsAt.toISOString(), source: p.source } }, ['billing.trial_started']);
  return saved.row;
}

/** Switch the plan of a running no-card trial. The end date never changes (V5 §7). */
export async function changeTrialPlanTx(tx: Queryable, p: { workspaceId: string; planId: string; userId: string }): Promise<BillingRow> {
  if (!isPaidPlan(p.planId)) throw new AppError('validation_failed', p.planId === 'free' ? 'Your trial moves to Free by itself when it ends unless you subscribe.' : 'Choose Standard or Professional', { plan: 'Choose Standard or Professional' });
  const prev = await loadBilling(tx, p.workspaceId, { lock: true });
  if (!prev || prev.status !== 'trialing' || !prev.trial_ends_at || prev.trial_ends_at.getTime() <= Date.now()) throw new AppError('invalid_state', 'There is no running trial.');
  if (prev.provider_subscription_ref && prev.provider_status && !['canceled', 'incomplete_expired'].includes(prev.provider_status)) {
    throw new AppError('invalid_state', 'You have already subscribed. Change the plan of your subscription instead.');
  }
  if (prev.plan_id === p.planId) return prev;
  const version = await currentVersion(tx, p.planId as PublicPlanId);
  const next: BillingRow = { ...prev, plan_id: p.planId as PlanId, plan_version_id: version.id, trial_plan_id: p.planId as PlanId };
  return (await saveBilling(tx, prev, next, { kind: 'trial_plan_changed', source: 'user', actorUserId: p.userId, detail: { from: prev.plan_id, to: p.planId } }, ['billing.subscription_changed'])).row;
}

/**
 * Staff extension of an ELIGIBLE trial: a no-card trial (no live provider subscription), running or expired, at most
 * MAX_TRIAL_EXTENSIONS times by ≤ MAX_TRIAL_EXTENSION_DAYS each. Audit is written by the caller (platform service).
 */
export async function extendTrialTx(tx: Queryable, p: { workspaceId: string; days: number; userId: string; reason: string; now?: Date }): Promise<{ row: BillingRow; from: Date; to: Date }> {
  const now = p.now ?? new Date();
  if (!Number.isInteger(p.days) || p.days < 1 || p.days > MAX_TRIAL_EXTENSION_DAYS) throw new AppError('validation_failed', `Extend by 1–${MAX_TRIAL_EXTENSION_DAYS} days`, { days: 'Out of range' });
  const red = await trialRedemption(tx, p.workspaceId, true);
  const prev = await loadBilling(tx, p.workspaceId, { lock: true });
  if (!red || !prev) throw new AppError('invalid_state', 'This workspace has no trial to extend.');
  if (red.extensions >= MAX_TRIAL_EXTENSIONS) throw new AppError('invalid_state', `This trial was already extended ${MAX_TRIAL_EXTENSIONS} times.`);
  const liveSub = !!prev.provider_subscription_ref && !!prev.provider_status && !['canceled', 'incomplete_expired'].includes(prev.provider_status);
  // D33: an ended trial is now on Free; extending it resumes the trial on its plan (only while not subscribed).
  if (liveSub || !['trialing', 'expired', 'free'].includes(prev.status)) throw new AppError('invalid_state', 'Only a no-card trial (running or ended, not subscribed) can be extended.');
  const base = red.ends_at.getTime() > now.getTime() ? red.ends_at : now;
  const to = new Date(base.getTime() + p.days * 86400_000);
  await tx.query(`UPDATE billing_trial_redemptions SET ends_at=$2, extensions=extensions+1 WHERE workspace_id=$1`, [p.workspaceId, to]);
  const resumed = prev.status === 'trialing' ? null : await currentVersion(tx, red.plan_id as PublicPlanId);
  const next: BillingRow = { ...prev, status: 'trialing', trial_ends_at: to,
    ...(resumed ? { plan_id: red.plan_id, plan_version_id: resumed.id, trial_plan_id: red.plan_id, seats: await billableSeats(tx, p.workspaceId) } : {}) };
  const saved = await saveBilling(tx, prev, next, { kind: 'staff.trial_extended', source: 'staff', actorUserId: p.userId, reason: p.reason,
    detail: { from: red.ends_at.toISOString(), to: to.toISOString(), days: p.days } }, ['billing.subscription_changed']);
  return { row: saved.row, from: red.ends_at, to };
}

/** Sweep: no-card trials past their end → Free (D33; + billing.trial_expired); 3-day notice once (+ billing.trial_ending). */
export async function sweepTrials(db: Queryable, now = new Date()): Promise<{ expired: number; ending: number }> {
  const { withTx } = await import('@social-lite/db');
  const due = await db.query<{ workspace_id: string }>(
    `SELECT workspace_id FROM workspace_billing WHERE status='trialing' AND trial_ends_at <= $1
        AND (provider_subscription_ref IS NULL OR provider_status IN ('canceled','incomplete_expired')) LIMIT 200`, [now]);
  for (const r of due.rows) {
    await withTx(async (tx) => {
      const prev = await loadBilling(tx, r.workspace_id, { lock: true });
      if (!prev || prev.status !== 'trialing' || !prev.trial_ends_at || prev.trial_ends_at.getTime() > now.getTime()) return;
      await moveToFreeTx(tx, prev, { kind: 'trial_expired', source: 'system', actorService: 'billing-sweep', detail: { trial_plan: prev.trial_plan_id, now: 'free' } }, ['billing.trial_expired']);
    });
  }
  const soon = await db.query<{ workspace_id: string; trial_ends_at: Date }>(
    `SELECT b.workspace_id, b.trial_ends_at FROM workspace_billing b WHERE b.status='trialing' AND b.trial_ends_at > $1 AND b.trial_ends_at <= $1 + make_interval(days => $2)
        AND (b.provider_subscription_ref IS NULL OR b.provider_status IN ('canceled','incomplete_expired'))
        AND NOT EXISTS (SELECT 1 FROM billing_lifecycle_events e WHERE e.workspace_id=b.workspace_id AND e.kind='trial_ending_notice' AND e.detail->>'ends_at' = to_char(b.trial_ends_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS'))
      LIMIT 200`, [now, TRIAL_ENDING_NOTICE_DAYS]);
  for (const r of soon.rows) {
    await withTx(async (tx) => {
      const prev = (await loadBilling(tx, r.workspace_id, { lock: true })) ?? legacyRow(r.workspace_id);
      const key = r.trial_ends_at.toISOString().slice(0, 19);
      await tx.query(`INSERT INTO billing_lifecycle_events(workspace_id, kind, from_status, to_status, source, actor_service, detail) VALUES ($1,'trial_ending_notice',$2,$2,'system','billing-sweep',$3)`,
        [r.workspace_id, prev.status, JSON.stringify({ ends_at: key })]);
      const { writeOutbox } = await import('../outbox.js');
      await writeOutbox(tx, { workspaceId: r.workspace_id, aggregateType: 'workspace_billing', aggregateId: r.workspace_id, eventType: 'billing.trial_ending',
        payload: { ends_at: r.trial_ends_at.toISOString(), plan_id: prev.plan_id } });
    });
  }
  return { expired: due.rowCount ?? 0, ending: soon.rowCount ?? 0 };
}
