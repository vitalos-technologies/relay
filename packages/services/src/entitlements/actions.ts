// Action guards used by domain services (V4 §12: enforced server-side for app, API, workers, MCP, AI, integrations).
// Each runs in the caller's transaction when given one and throws `entitlement_required` (HTTP 402, MCP error code
// `entitlement_required`) with a concise reason + upgrade target. Read paths are never guarded here.
import { AppError } from '@social-lite/core';
import type { Feature, PlanId } from '@social-lite/core/contracts/v4-plans';
import { cheapestPlanWithMore, upgradeSentence } from '@social-lite/core/contracts/plan-copy';
import { one, withTx, type Queryable } from '@social-lite/db';
import { assertFeature, checkFeature, entitlementError, entitlementsCore, type EntitlementsCore } from './resolve.js';
import { assertGaugeCapacity, brandHeld, gaugeCount, gaugeFullError, heldIds } from './gauges.js';
import { consumeUsage } from '../product/budgets.js';

/** Schedule / submit / publish-now: publishing in the plan; publish-now is a paid action; held accounts/brands refused. */
export async function assertSchedulingEntitled(tx: Queryable, workspaceId: string, connectionIds: string[], opts: { immediate: boolean; brandId?: string }): Promise<void> {
  const core = await entitlementsCore(tx, workspaceId);
  if (core.access === 'suspended') return; // staff suspension is enforced by its own mechanics (requests are already refused)
  assertFeature(core, 'publishing', { paid: opts.immediate });
  if (opts.brandId) {
    const b = await brandHeld(tx, workspaceId, opts.brandId, core);
    if (b.held) {
      throw new AppError('entitlement_required', `This brand is over ${core.plan?.name ?? 'the plan'}’s limit of ${b.limit} brand${b.limit === 1 ? '' : 's'}. Upgrade, or choose which brand stays active in Usage.`,
        undefined, { reason: 'over_limit_held', allowance: 'brands', upgrade_to: cheapestPlanWithMore('brands', core.plan?.id) });
    }
  }
  if (core.limits.social_accounts.limit === null) return;
  const held = await heldIds(tx, workspaceId, 'social_accounts', core);
  if (connectionIds.some((id) => held.has(id))) {
    throw new AppError('entitlement_required', `One of these accounts is over the plan’s limit of ${core.limits.social_accounts.limit} connected accounts. Choose which accounts stay active in Usage.`,
      undefined, { reason: 'over_limit_held', allowance: 'social_accounts' });
  }
}

/** Calendar month (UTC) a post publishes in: the scheduled_posts counter bucket (D33 "10 scheduled posts a month"). */
export const postMonth = (dueAt: Date): string => dueAt.toISOString().slice(0, 7);

export type PostCharge = { ok: true; counted: boolean } | { ok: false; message: string; limit: number; used: number; month: string; upgradeTo: PlanId | null };

/**
 * Count a post against the scheduled_posts allowance (D33) in the calendar month it publishes. ONE unit per post per month
 * whatever the number of destinations; idempotent (ledger dedupe key post:<id>:<month>, so re-scheduling within the month
 * or a retried request is free); race-safe for the last unit (the counter row is locked inside `tx`). Not metered ⇒ no-op.
 */
export async function chargeScheduledPost(tx: Queryable, workspaceId: string, p: { postId: string; dueAt: Date; userId: string | null; core?: EntitlementsCore }): Promise<PostCharge> {
  const core = p.core ?? await entitlementsCore(tx, workspaceId);
  const limit = core.limits.scheduled_posts.limit;
  if (limit === null) return { ok: true, counted: false };
  const month = postMonth(p.dueAt);
  const r = await consumeUsage(tx, { workspaceId, meter: 'posts.scheduled', amount: 1, userId: p.userId, period: month, ref: `post:${p.postId}`, dedupeKey: `post:${p.postId}:${month}` });
  if (r.ok) return { ok: true, counted: !r.duplicate };
  const used = r.detail?.used ?? limit;
  const label = new Date(`${month}-01T00:00:00Z`).toLocaleString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  const override = core.limits.scheduled_posts.source === 'override';
  const plan = override ? 'This workspace' : core.plan?.name ?? 'Your plan';
  const to = override ? null : cheapestPlanWithMore('scheduled_posts', core.plan?.id);
  return { ok: false, limit, used, month, upgradeTo: to,
    message: r.reason === 'entitlement' ? r.message
      : `${plan} includes ${limit} scheduled post${limit === 1 ? '' : 's'} a month, and ${label} has none left. ${upgradeSentence(to) || 'Pick another month.'}` };
}

/** Scheduling / publish-now gate for the scheduled_posts allowance: throws entitlement_required when the month is full. */
export async function assertScheduledPostAllowed(tx: Queryable, workspaceId: string, p: { postId: string; dueAt: Date; userId: string | null }): Promise<void> {
  const core = await entitlementsCore(tx, workspaceId);
  if (core.access === 'suspended') return;
  const r = await chargeScheduledPost(tx, workspaceId, { ...p, core });
  if (!r.ok) {
    throw new AppError('entitlement_required', r.message, undefined,
      { reason: 'allowance_exhausted', allowance: 'scheduled_posts', limit: r.limit, used: r.used, period: r.month, upgrade_to: r.upgradeTo });
  }
}

/** A NEW brand (D33 brands gauge; Free = 1), race-free in `tx`. */
export async function assertCanCreateBrand(tx: Queryable, workspaceId: string): Promise<void> {
  await assertGaugeCapacity(tx, workspaceId, 'brands');
}

/**
 * A NEW person (D33 members gauge; Free = 1 user, i.e. no teammates). `invite`: active people + pending invitations + this
 * one must fit; `accept`: active people + the accepting one (its own pending invitation is the one being used).
 * Race-free in `tx` (advisory lock on the members gauge). Not metered (paid plans: seats are billing's job) ⇒ no-op.
 */
export async function assertCanAddMember(tx: Queryable, workspaceId: string, p: { phase: 'invite' | 'accept' }): Promise<void> {
  const core = await entitlementsCore(tx, workspaceId);
  const limit = core.limits.members.limit;
  if (limit === null) return;
  await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`entitlement:${workspaceId}:members`]);
  const n = await gaugeCount(tx, workspaceId, 'members');
  const pending = p.phase === 'invite' ? (await one<{ n: number }>(tx,
    `SELECT count(*)::int n FROM invitations WHERE workspace_id=$1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now()`, [workspaceId])).n : 0;
  if (n + pending + 1 > limit) throw gaugeFullError(core, 'members', limit, n + pending);
}

/** Is this person over the plan's user limit (not an owner, not chosen)? null = not held; otherwise the reason. */
export async function memberHold(db: Queryable, workspaceId: string, userId: string, core?: EntitlementsCore): Promise<string | null> {
  const c = core ?? await entitlementsCore(db, workspaceId);
  const limit = c.limits.members.limit;
  if (limit === null) return null;
  if (!(await heldIds(db, workspaceId, 'members', c)).has(userId)) return null;
  const plan = c.limits.members.source === 'override' ? 'This workspace' : c.plan?.name ?? 'The plan';
  return `${plan} includes ${limit === 1 ? '1 user' : `${limit} users`}, so your access is paused. Ask the owner to upgrade. Billing, support and your data export stay available.`;
}

/** A NEW social account connection (not a reconnect of the same identity): gauge limit, race-free in `tx`. */
export async function assertCanConnectAccount(tx: Queryable, workspaceId: string): Promise<void> {
  await assertGaugeCapacity(tx, workspaceId, 'social_accounts');
}

/** A NEW (or un-archived) listening search: listening in the plan + active-search gauge, race-free in `tx`. */
export async function assertCanActivateSearch(tx: Queryable, workspaceId: string): Promise<void> {
  assertFeature(await entitlementsCore(tx, workspaceId), 'listening', { paid: false });
  await assertGaugeCapacity(tx, workspaceId, 'listening_searches');
}

/** Configuration of a plan feature (automation rules/policies, multi-step approvals, care routing…). Not a paid action. */
export async function assertFeatureConfigurable(db: Queryable, workspaceId: string, feature: Feature): Promise<void> {
  assertFeature(await entitlementsCore(db, workspaceId), feature, { paid: false });
}

/** A paid action right now (AI run request, publish-now, upload…). */
export async function assertPaidAction(db: Queryable, workspaceId: string, feature: Feature): Promise<void> {
  assertFeature(await entitlementsCore(db, workspaceId), feature, { paid: true });
}

/**
 * MCP tool call (mcp/tools.ts register()): the plan must include MCP; write tools are paid actions (held while
 * restricted; read tools stay available); every call consumes one `mcp.calls` unit. A retried call with the same
 * idempotency key is charged once (ledger dedupe).
 */
export async function chargeMcpCall(workspaceId: string, call: { tool: string; readOnly: boolean; userId: string | null; dedupeKey?: string | null }): Promise<void> {
  await withTx(async (tx) => {
    const core = await entitlementsCore(tx, workspaceId);
    const c = checkFeature(core, 'mcp', { paid: !call.readOnly });
    if (!c.ok) throw entitlementError(c);
    const r = await consumeUsage(tx, { workspaceId, meter: 'mcp.calls', amount: 1, userId: call.userId, ref: `mcp:${call.tool}`.slice(0, 200),
      dedupeKey: call.dedupeKey ? `mcp:${call.tool}:${call.dedupeKey}` : null });
    if (!r.ok) {
      if (r.reason === 'entitlement') throw new AppError('entitlement_required', r.message, undefined, r.entitlement);
      throw new AppError('budget_exhausted', r.message, undefined, r.detail ? { ...r.detail } : undefined);
    }
  });
}
