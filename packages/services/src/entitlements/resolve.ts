// Shared entitlement resolution (V4 §12). ONE function answers, for a workspace: plan, features, allowance limits,
// access level + reason and the current usage period. Every gate (API routes, services, workers, MCP, AI, integrations)
// calls `entitlementsCore` inside its own transaction, so a dispatch-time check sees committed billing state and
// overrides. Billing facts come only from getBillingState (source.ts); nothing a client sends can grant a capability.
//
// Layering (customers can lower, never raise):  plan / trial allowance  →  platform override  →  customer budget
// (workspaces.limits / team budgets in product/budgets.ts, applied as min(customer cap, plan ceiling)).
import { AppError } from '@social-lite/core';
import {
  ALLOWANCES, ALWAYS_AVAILABLE, FEATURES, PLANS, PUBLIC_PLAN_IDS, allowanceFor,
  type AccessLevel, type Allowance, type Feature, type PlanDefinition, type PlanId,
} from '@social-lite/core/contracts/v4-plans';
import type { BillingState } from '@social-lite/core/contracts/v4-billing';
import {
  ALLOWANCE_METER, FEATURE_LABEL, type AllowanceSource, type BlockReason, type EntitlementErrorDetails, type FeatureState, type PeriodInfo,
} from '@social-lite/core/contracts/v4-entitlements';
import { featureUpgradeMessage } from '@social-lite/core/contracts/plan-copy';
import { getPool, many, type Queryable } from '@social-lite/db';
import { billingStateFor } from './source.js';

export interface OverrideRow {
  id: string; workspace_id: string; kind: 'feature' | 'allowance' | 'access'; key: string;
  value: { enabled?: boolean; limit?: number | null; level?: 'full' }; reason: string; expires_at: Date | null;
  created_by: string | null; created_at: Date; revoked_at: Date | null; revoked_by: string | null; revoked_reason: string | null;
}

export interface AllowanceLimit { limit: number | null; included: number | null; source: AllowanceSource }

export interface EntitlementsCore {
  workspaceId: string;
  billing: BillingState;
  plan: PlanDefinition | null;
  trialActive: boolean;
  access: AccessLevel;
  accessReason: string | null;
  /** Temporary full access granted by a platform override (billing problem being resolved). */
  accessOverridden: boolean;
  features: Record<Feature, FeatureState>;
  limits: Record<Allowance, AllowanceLimit>;
  period: PeriodInfo;
  overrides: OverrideRow[];
}

const DAY = 86_400_000;

function calendarPeriod(now: Date): PeriodInfo {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { key: now.toISOString().slice(0, 7), kind: 'calendar_month', start: start.toISOString(), resets_at: next.toISOString() };
}

/**
 * Usage period (reset policy): during a trial ONE bucket covers the whole trial (trial allowances never reset);
 * with a subscription period the bucket is that period (resets at renewal); otherwise (legacy / no plan) the UTC
 * calendar month — the pre-V4 behaviour, so existing counters keep their keys.
 */
export function periodOf(b: BillingState, now = new Date()): PeriodInfo {
  if (isTrialActive(b, now)) return { key: `trial:${b.trial!.started_at.slice(0, 10)}`, kind: 'trial', start: b.trial!.started_at, resets_at: null };
  const cp = b.current_period;
  if (cp && new Date(cp.start).getTime() <= now.getTime() && now.getTime() < new Date(cp.end).getTime()) {
    return { key: `p:${cp.start.slice(0, 10)}`, kind: 'subscription', start: cp.start, resets_at: cp.end };
  }
  return calendarPeriod(now);
}

export function isTrialActive(b: BillingState, now = new Date()): boolean {
  return b.status === 'trialing' && !!b.trial && now.getTime() < new Date(b.trial.ends_at).getTime();
}

const activeOverride = (o: OverrideRow, now: Date) => !o.revoked_at && (!o.expires_at || o.expires_at.getTime() > now.getTime());

export async function liveOverrides(db: Queryable, workspaceId: string): Promise<OverrideRow[]> {
  return many<OverrideRow>(db,
    `SELECT * FROM entitlement_overrides WHERE workspace_id=$1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now()) ORDER BY created_at`, [workspaceId]);
}

function defaultReason(b: BillingState): string {
  switch (b.status) {
    case 'expired': return 'Your trial has ended. Choose a plan to resume paid actions.';
    case 'past_due': return 'A payment failed. Update your payment details to resume paid actions.';
    case 'payment_action_required': return 'Your bank needs you to confirm a payment.';
    case 'cancelled': return 'Your subscription has ended. Choose a plan to resume paid actions.';
    case 'incomplete': return 'Your first payment is not confirmed yet.';
    default: return 'Paid actions are paused for this workspace.';
  }
}

/** Allowances that only make sense with a feature (used when an override grants the feature). */
const FEATURE_ALLOWANCE_DEFAULT: Partial<Record<Allowance, Feature>> = { listening_searches: 'listening', integration_jobs: 'integrations_business', mcp_calls: 'mcp' };

/** Pure derivation (unit-tested): billing state + live overrides ⇒ entitlements. */
export function deriveEntitlements(b: BillingState, overrides: OverrideRow[], now = new Date()): EntitlementsCore {
  const live = overrides.filter((o) => activeOverride(o, now));
  const plan = b.plan_id && PLANS[b.plan_id as PlanId] ? PLANS[b.plan_id as PlanId] : null;
  const trialActive = isTrialActive(b, now);
  // Access: staff suspension wins (never overridable here); no plan ⇒ restricted; an access override lifts a billing
  // restriction only (temporary, expiry required by the schema).
  let access: AccessLevel = b.service_suspended || b.access === 'suspended' ? 'suspended' : !plan ? 'restricted' : b.access;
  let accessReason: string | null = access === 'suspended' ? (b.access_reason ?? 'This workspace is suspended by Relay.')
    : access === 'restricted' ? (plan ? (b.access_reason ?? defaultReason(b)) : 'This workspace has no plan. Choose a plan to resume paid actions.') : null;
  let accessOverridden = false;
  if (access === 'restricted' && live.some((o) => o.kind === 'access' && o.value.level === 'full')) {
    access = 'full'; accessReason = null; accessOverridden = true;
  }
  const features = {} as Record<Feature, FeatureState>;
  for (const f of FEATURES) {
    const o = live.find((x) => x.kind === 'feature' && x.key === f);
    if (ALWAYS_AVAILABLE.includes(f)) features[f] = { enabled: true, source: 'always' };
    else if (o) features[f] = { enabled: o.value.enabled === true, source: 'override' };
    else features[f] = { enabled: !!plan?.features.includes(f), source: 'plan' };
  }
  const table = plan ? (trialActive ? PLANS[b.trial!.plan_id]?.trial_allowances ?? plan.trial_allowances : plan.allowances) : null;
  const seats = Math.max(1, Math.floor(b.seats || 1));
  const limits = {} as Record<Allowance, AllowanceLimit>;
  for (const a of ALLOWANCES) {
    const included = table ? allowanceFor(table, a, seats) : null;
    const o = live.find((x) => x.kind === 'allowance' && x.key === a);
    if (o) {
      const v = o.value.limit;
      const lim = typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : null;
      limits[a] = { limit: lim, included: lim, source: 'override' };
    } else if (included === 0 && FEATURE_ALLOWANCE_DEFAULT[a] && features[FEATURE_ALLOWANCE_DEFAULT[a]!].source === 'override' && features[FEATURE_ALLOWANCE_DEFAULT[a]!].enabled) {
      // A feature granted by override comes with the Professional default allowance (otherwise it would be unusable);
      // an explicit allowance override still wins.
      const lim = allowanceFor(PLANS.professional.allowances, a, seats);
      limits[a] = { limit: lim, included: lim, source: 'override' };
    } else {
      limits[a] = { limit: included, included, source: included === null ? 'unmetered' : trialActive ? 'trial' : 'plan' };
    }
  }
  return { workspaceId: b.workspace_id, billing: b, plan, trialActive, access, accessReason, accessOverridden, features, limits, period: periodOf(b, now), overrides: live };
}

/** Uncached resolution — use in every enforcement path (inside the caller's transaction when given one). */
export async function entitlementsCore(db: Queryable, workspaceId: string): Promise<EntitlementsCore> {
  const [b, o] = await Promise.all([billingStateFor(db, workspaceId), liveOverrides(db, workspaceId)]);
  return deriveEntitlements(b, o);
}

// Short-lived per-process cache for READ paths only (UI hook, banners). Enforcement never uses it.
const cache = new Map<string, { at: number; v: EntitlementsCore }>();
const TTL_MS = 5_000;
export async function entitlementsCoreCached(workspaceId: string, db: Queryable = getPool()): Promise<EntitlementsCore> {
  const hit = cache.get(workspaceId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.v;
  const v = await entitlementsCore(db, workspaceId);
  cache.set(workspaceId, { at: Date.now(), v });
  if (cache.size > 2000) cache.delete(cache.keys().next().value!);
  return v;
}
/** Invalidate after overrides / billing.access_changed (this process). */
export function invalidateEntitlements(workspaceId?: string): void {
  if (workspaceId) cache.delete(workspaceId); else cache.clear();
}

// ------------------------------------------------------------------ checks
export type Check = { ok: true } | { ok: false; reason: BlockReason; message: string; details: EntitlementErrorDetails };

/** Smallest PAID public plan that includes the feature (Free is never an upgrade target). */
export function upgradeTarget(feature: Feature): PlanId | null {
  return PUBLIC_PLAN_IDS.find((id) => (PLANS[id].unit_amount_minor ?? 0) > 0 && PLANS[id].features.includes(feature)) ?? null;
}

/**
 * May the workspace use `feature`? `paid` = the action is a paid action (held while access is restricted).
 * Reading, billing, support, exports, drafts and recording approvals are NOT paid actions.
 */
export function checkFeature(core: EntitlementsCore, feature: Feature, opts: { paid: boolean }): Check {
  if (ALWAYS_AVAILABLE.includes(feature)) return { ok: true };
  if (opts.paid && core.access === 'suspended') {
    return { ok: false, reason: 'access_suspended', message: core.accessReason ?? 'This workspace is suspended by Relay.', details: { reason: 'access_suspended', feature, access: 'suspended' } };
  }
  const f = core.features[feature];
  if (!f.enabled) {
    if (!core.plan && f.source === 'plan') {
      return { ok: false, reason: 'no_plan', message: 'This workspace has no plan. Choose a plan to continue.', details: { reason: 'no_plan', feature, upgrade_to: upgradeTarget(feature) } };
    }
    const to = upgradeTarget(feature);
    const message = f.source === 'override' ? `${FEATURE_LABEL[feature]} is turned off for this workspace by Relay.`
      : featureUpgradeMessage(FEATURE_LABEL[feature], core.plan?.name, to);
    return { ok: false, reason: 'feature_not_in_plan', message, details: { reason: 'feature_not_in_plan', feature, upgrade_to: to } };
  }
  if (opts.paid && core.access === 'restricted') {
    return { ok: false, reason: 'access_restricted', message: `${core.accessReason ?? 'Paid actions are paused.'} Billing and support stay available.`, details: { reason: 'access_restricted', feature, access: 'restricted' } };
  }
  return { ok: true };
}

export function entitlementError(c: Exclude<Check, { ok: true }>): AppError {
  return new AppError('entitlement_required', c.message, undefined, { ...c.details });
}

/** Throw entitlement_required unless allowed. */
export function assertFeature(core: EntitlementsCore, feature: Feature, opts: { paid: boolean }): void {
  const c = checkFeature(core, feature, opts);
  if (!c.ok) throw entitlementError(c);
}

/** Convenience for services: resolve + assert in one call (inside `db` when given). */
export async function requireEntitlement(db: Queryable, workspaceId: string, feature: Feature, opts: { paid: boolean }): Promise<EntitlementsCore> {
  const core = await entitlementsCore(db, workspaceId);
  assertFeature(core, feature, opts);
  return core;
}

// ------------------------------------------------------------------ budget meters (used by product/budgets.ts)
export type MeterKey = 'ai.tokens' | 'x.write' | 'x.read' | 'storage.bytes' | 'exports.count' | 'mcp.calls' | 'integration.jobs' | 'posts.scheduled';

/** Which entitlement guards consumption of a meter. exports and X reads are never held by access (§13). */
export const METER_GATE: Record<MeterKey, { feature: Feature; paid: boolean } | null> = {
  'ai.tokens': { feature: 'ai_drafting', paid: true },
  'storage.bytes': { feature: 'media_library', paid: true },
  'x.write': { feature: 'publishing', paid: true },
  'integration.jobs': { feature: 'integrations_business', paid: true },
  'mcp.calls': { feature: 'mcp', paid: false },
  'exports.count': null,
  'posts.scheduled': { feature: 'publishing', paid: false }, // D33: counted when a post is scheduled / published now
  'x.read': null, // reconciliation of in-flight publications must continue whatever the billing state
};

const METER_ALLOWANCE = Object.fromEntries(Object.entries(ALLOWANCE_METER).filter(([, m]) => m !== 'gauge').map(([a, m]) => [m, a])) as Record<MeterKey, Allowance>;
export const allowanceOfMeter = (meter: MeterKey): Allowance => METER_ALLOWANCE[meter];

export interface MeterRules { period: string; ceiling: number | null; gate: Check }

/** Period key, plan ceiling and access gate for one meter (called inside reservations under the counter locks). */
export function meterRules(core: EntitlementsCore, meter: MeterKey, periodKind: 'month' | 'total'): MeterRules {
  const g = METER_GATE[meter];
  return {
    period: periodKind === 'total' ? 'total' : core.period.key,
    ceiling: core.limits[allowanceOfMeter(meter)]?.limit ?? null,
    gate: g ? checkFeature(core, g.feature, { paid: g.paid }) : { ok: true },
  };
}

/** Days until a trial ends (UI copy); null when not trialing. */
export function trialDaysLeft(core: EntitlementsCore, now = new Date()): number | null {
  if (!core.trialActive || !core.billing.trial) return null;
  return Math.max(0, Math.ceil((new Date(core.billing.trial.ends_at).getTime() - now.getTime()) / DAY));
}
