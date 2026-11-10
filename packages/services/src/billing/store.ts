// workspace_billing row access + lifecycle history + outbox emission. Every billing mutation goes through here so the
// derived access level, the lifecycle history and the BILLING_EVENTS outbox rows stay consistent (one transaction).
import { getPool, maybeOne, type Queryable } from '@social-lite/db';
import type { BillingEvent } from '@social-lite/core/contracts/v4-billing';
import type { PlanId } from '@social-lite/core/contracts/v4-plans';
import { writeOutbox } from '../outbox.js';
import { log } from '../log.js';
import { deriveAccess, isDocumentedTransition, liveProviderSubscription, type BillingStatus } from './policy.js';

export interface BillingRow {
  workspace_id: string;
  plan_id: PlanId;
  plan_version_id: string | null;
  status: BillingStatus;
  seats: number;
  provider: 'stripe' | 'test' | null;
  livemode: boolean | null;
  provider_customer_ref: string | null;
  provider_subscription_ref: string | null;
  provider_item_ref: string | null;
  provider_price_ref: string | null;
  provider_status: string | null;
  trial_started_at: Date | null;
  trial_ends_at: Date | null;
  trial_plan_id: PlanId | null;
  current_period_start: Date | null;
  current_period_end: Date | null;
  cancel_at_period_end: boolean;
  cancel_at: Date | null;
  cancelled_at: Date | null;
  ended_at: Date | null;
  scheduled_plan_version_id: string | null;
  scheduled_seats: number | null;
  scheduled_effective_at: Date | null;
  past_due_since: Date | null;
  grace_ends_at: Date | null;
  payment_action_required: boolean;
  payment_method: { brand: string; last4: string; exp_month: number | null; exp_year: number | null } | null;
  provider_synced_at: Date | null;
  access_level: 'full' | 'restricted' | 'suspended';
  access_reason: string | null;
  created_at: Date;
  updated_at: Date;
  version: number;
}

/** A workspace without a row was created outside the product signup path (seed/CLI/tests): read as legacy. */
export function legacyRow(workspaceId: string): BillingRow {
  const epoch = new Date(0);
  return {
    workspace_id: workspaceId, plan_id: 'legacy', plan_version_id: null, status: 'legacy', seats: 0, provider: null, livemode: null,
    provider_customer_ref: null, provider_subscription_ref: null, provider_item_ref: null, provider_price_ref: null, provider_status: null,
    trial_started_at: null, trial_ends_at: null, trial_plan_id: null, current_period_start: null, current_period_end: null,
    cancel_at_period_end: false, cancel_at: null, cancelled_at: null, ended_at: null, scheduled_plan_version_id: null, scheduled_seats: null,
    scheduled_effective_at: null, past_due_since: null, grace_ends_at: null, payment_action_required: false, payment_method: null,
    provider_synced_at: null, access_level: 'full', access_reason: null, created_at: epoch, updated_at: epoch, version: 0,
  };
}

export async function loadBilling(db: Queryable, workspaceId: string, opts: { lock?: boolean } = {}): Promise<BillingRow | null> {
  return maybeOne<BillingRow>(db, `SELECT * FROM workspace_billing WHERE workspace_id=$1 ${opts.lock ? 'FOR UPDATE' : ''}`, [workspaceId]);
}

/** Lock (creating a legacy row if absent) — used by mutations that need a row to exist. */
export async function lockBilling(db: Queryable, workspaceId: string): Promise<BillingRow> {
  const r = await loadBilling(db, workspaceId, { lock: true });
  if (r) return r;
  await db.query(
    `INSERT INTO workspace_billing(workspace_id, plan_id, plan_version_id, status, seats)
     VALUES ($1,'legacy',(SELECT id FROM billing_plan_versions WHERE plan_id='legacy' ORDER BY version DESC LIMIT 1),'legacy',0) ON CONFLICT DO NOTHING`, [workspaceId]);
  return (await loadBilling(db, workspaceId, { lock: true }))!;
}

export async function serviceSuspended(db: Queryable, workspaceId: string): Promise<boolean> {
  const w = await maybeOne<{ state: string }>(db, `SELECT state FROM workspaces WHERE id=$1`, [workspaceId]);
  return w?.state === 'suspended';
}

export interface LifecycleEntry {
  kind: string;
  source: 'user' | 'staff' | 'webhook' | 'reconcile' | 'system' | 'signup' | 'migration';
  actorUserId?: string | null;
  actorService?: string | null;
  providerEventId?: string | null;
  reason?: string | null;
  detail?: Record<string, unknown>;
}

const COLUMNS: ReadonlyArray<keyof BillingRow> = [
  'plan_id', 'plan_version_id', 'status', 'seats', 'provider', 'livemode', 'provider_customer_ref', 'provider_subscription_ref', 'provider_item_ref',
  'provider_price_ref', 'provider_status', 'trial_started_at', 'trial_ends_at', 'trial_plan_id', 'current_period_start', 'current_period_end',
  'cancel_at_period_end', 'cancel_at', 'cancelled_at', 'ended_at', 'scheduled_plan_version_id', 'scheduled_seats', 'scheduled_effective_at',
  'past_due_since', 'grace_ends_at', 'payment_action_required', 'payment_method', 'provider_synced_at',
];

const same = (a: unknown, b: unknown) => (a instanceof Date || b instanceof Date)
  ? (a instanceof Date ? a.getTime() : a == null ? null : new Date(a as string).getTime()) === (b instanceof Date ? b.getTime() : b == null ? null : new Date(b as string).getTime())
  : JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * Persist `next` (a modified copy of `prev`, which must have been read FOR UPDATE in this transaction): recompute the
 * access level, append lifecycle history and write outbox events. Returns the derived access and whether it changed.
 */
export async function saveBilling(tx: Queryable, prev: BillingRow, next: BillingRow, entry: LifecycleEntry, events: BillingEvent[] = []): Promise<{ row: BillingRow; accessChanged: boolean }> {
  const suspended = await serviceSuspended(tx, prev.workspace_id);
  const { access, reason } = deriveAccess({ status: next.status, serviceSuspended: suspended, graceEndsAt: next.grace_ends_at, trialEndsAt: next.trial_ends_at, cancelAt: next.cancel_at, now: new Date(),
    liveSubscription: liveProviderSubscription(next) });
  const changed = COLUMNS.filter((c) => !same(prev[c], next[c]));
  const accessChanged = access !== prev.access_level || reason !== prev.access_reason;
  if (changed.length || accessChanged) {
    const sets = changed.map((c, i) => `${c}=$${i + 2}`);
    const vals = changed.map((c) => (c === 'payment_method' ? (next[c] ? JSON.stringify(next[c]) : null) : next[c]));
    await tx.query(
      `UPDATE workspace_billing SET ${[...sets, `access_level=$${vals.length + 2}`, `access_reason=$${vals.length + 3}`, 'updated_at=now()', 'version=version+1'].join(', ')} WHERE workspace_id=$1`,
      [prev.workspace_id, ...vals, access, reason]);
  }
  if (prev.status !== next.status && !isDocumentedTransition(prev.status, next.status)) {
    log.warn('billing_undocumented_transition', { workspaceId: prev.workspace_id, from: prev.status, to: next.status, kind: entry.kind });
  }
  const meaningful = changed.filter((c) => c !== 'provider_synced_at' && c !== 'payment_method');
  if (meaningful.length || entry.kind.startsWith('staff.') || entry.source === 'user' || entry.source === 'signup') {
    await tx.query(
      `INSERT INTO billing_lifecycle_events(workspace_id, kind, from_status, to_status, from_plan, to_plan, seats, source, actor_user_id, actor_service, provider_event_id, reason, detail)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [prev.workspace_id, entry.kind, prev.status, next.status, prev.plan_id, next.plan_id, next.seats, entry.source, entry.actorUserId ?? null,
        entry.actorService ?? null, entry.providerEventId ?? null, entry.reason ?? null, JSON.stringify({ changed: meaningful, ...(entry.detail ?? {}) })]);
  }
  const all = new Set(events);
  if (accessChanged) all.add('billing.access_changed');
  for (const e of all) {
    await writeOutbox(tx, { workspaceId: prev.workspace_id, aggregateType: 'workspace_billing', aggregateId: prev.workspace_id, eventType: e,
      payload: { status: next.status, plan_id: next.plan_id, seats: next.seats, access, access_reason: reason, kind: entry.kind } });
  }
  return { row: { ...next, access_level: access, access_reason: reason }, accessChanged };
}

/** Session-level advisory lock held across a provider call: one billing change per workspace at a time. */
export async function withBillingLock<T>(workspaceId: string, fn: () => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  const key = `billing:${workspaceId}`;
  try {
    const got = await client.query<{ ok: boolean }>(`SELECT pg_try_advisory_lock(hashtext($1)) ok`, [key]);
    if (!got.rows[0]?.ok) {
      const { AppError } = await import('@social-lite/core');
      throw new AppError('conflict', 'Another billing change is in progress. Try again in a moment.');
    }
    try { return await fn(); } finally { await client.query(`SELECT pg_advisory_unlock(hashtext($1))`, [key]).catch(() => undefined); }
  } finally {
    client.release();
  }
}
