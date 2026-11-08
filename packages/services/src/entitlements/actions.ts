// Action guards used by domain services (V4 §12: enforced server-side for app, API, workers, MCP, AI, integrations).
// Each runs in the caller's transaction when given one and throws `entitlement_required` (HTTP 402, MCP error code
// `entitlement_required`) with a concise reason + upgrade target. Read paths are never guarded here.
import { AppError } from '@social-lite/core';
import type { Feature } from '@social-lite/core/contracts/v4-plans';
import { withTx, type Queryable } from '@social-lite/db';
import { assertFeature, checkFeature, entitlementError, entitlementsCore } from './resolve.js';
import { assertGaugeCapacity, heldIds } from './gauges.js';
import { consumeUsage } from '../product/budgets.js';

/** Schedule / submit / publish-now: publishing in the plan; publish-now is a paid action; held accounts refused. */
export async function assertSchedulingEntitled(tx: Queryable, workspaceId: string, connectionIds: string[], opts: { immediate: boolean }): Promise<void> {
  const core = await entitlementsCore(tx, workspaceId);
  if (core.access === 'suspended') return; // staff suspension is enforced by its own mechanics (requests are already refused)
  assertFeature(core, 'publishing', { paid: opts.immediate });
  if (core.limits.social_accounts.limit === null) return;
  const held = await heldIds(tx, workspaceId, 'social_accounts', core);
  if (connectionIds.some((id) => held.has(id))) {
    throw new AppError('entitlement_required', `One of these accounts is over the plan’s limit of ${core.limits.social_accounts.limit} connected accounts. Choose which accounts stay active in Usage.`,
      undefined, { reason: 'over_limit_held', allowance: 'social_accounts' });
  }
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
