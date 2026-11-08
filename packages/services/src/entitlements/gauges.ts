// Gauge allowances (live counts, no period): connected social accounts and active listening searches (V4 §12–13).
//  - New resources are refused at the limit (race-free: a per-workspace advisory lock serializes the count + insert in
//    the caller's transaction, so two concurrent connects cannot both take the last slot).
//  - When a limit is LOWERED (downgrade, seat reduction, override), nothing is deleted or disconnected: the customer
//    chooses which resources stay active (entitlement_selections); the rest are HELD — publishing to a held account is
//    held, a held search does not match new items. Without a choice, the oldest resources stay active.
import { AppError } from '@social-lite/core';
import type { Allowance } from '@social-lite/core/contracts/v4-plans';
import { ALLOWANCE_LABEL, type SelectableAllowance } from '@social-lite/core/contracts/v4-entitlements';
import { many, maybeOne, type Queryable } from '@social-lite/db';
import { entitlementsCore, type EntitlementsCore } from './resolve.js';

export interface GaugeItem { id: string; name: string; detail: string | null; created_at: Date }

const GAUGE_SQL: Record<SelectableAllowance, string> = {
  // Synthetic analytics demo rows are not accounts; simulated (mock_) destinations count like real ones (they look the same in the UI).
  social_accounts: `SELECT id, display_name AS name, provider::text AS detail, created_at FROM connections
                     WHERE workspace_id=$1 AND disconnected_at IS NULL AND NOT coalesce(is_synthetic, false) ORDER BY created_at, id`,
  listening_searches: `SELECT id, name, role AS detail, created_at FROM listening_searches WHERE workspace_id=$1 AND archived_at IS NULL ORDER BY created_at, id`,
};

export async function gaugeItems(db: Queryable, workspaceId: string, allowance: SelectableAllowance): Promise<GaugeItem[]> {
  return many<GaugeItem>(db, GAUGE_SQL[allowance], [workspaceId]);
}

export async function gaugeCount(db: Queryable, workspaceId: string, allowance: SelectableAllowance): Promise<number> {
  return (await gaugeItems(db, workspaceId, allowance)).length;
}

/** Which resources are active under `limit`: chosen ones first (creation order), then the oldest others. */
export async function activeSplit(db: Queryable, workspaceId: string, allowance: SelectableAllowance, limit: number | null): Promise<{ items: GaugeItem[]; active: Set<string>; chosen: Set<string> }> {
  const items = await gaugeItems(db, workspaceId, allowance);
  const chosenRows = await many<{ resource_id: string }>(db, `SELECT resource_id FROM entitlement_selections WHERE workspace_id=$1 AND allowance=$2`, [workspaceId, allowance]);
  const chosen = new Set(chosenRows.map((r) => r.resource_id).filter((id) => items.some((i) => i.id === id)));
  if (limit === null || items.length <= limit) return { items, active: new Set(items.map((i) => i.id)), chosen };
  const ordered = [...items.filter((i) => chosen.has(i.id)), ...items.filter((i) => !chosen.has(i.id))];
  return { items, active: new Set(ordered.slice(0, limit).map((i) => i.id)), chosen };
}

/** Held (over-limit, not chosen) resource ids for a gauge allowance; empty when within the limit. */
export async function heldIds(db: Queryable, workspaceId: string, allowance: SelectableAllowance, core?: EntitlementsCore): Promise<Set<string>> {
  const c = core ?? await entitlementsCore(db, workspaceId);
  const limit = c.limits[allowance].limit;
  if (limit === null) return new Set();
  const { items, active } = await activeSplit(db, workspaceId, allowance, limit);
  return new Set(items.filter((i) => !active.has(i.id)).map((i) => i.id));
}

const lockKey = (workspaceId: string, allowance: Allowance) => `entitlement:${workspaceId}:${allowance}`;

/**
 * Refuse a NEW resource when the gauge is at (or over) its limit. MUST run in the transaction that inserts the resource:
 * the advisory lock is held until commit, so concurrent creations are serialized and the last slot is taken once.
 */
export async function assertGaugeCapacity(tx: Queryable, workspaceId: string, allowance: SelectableAllowance, adding = 1): Promise<void> {
  const core = await entitlementsCore(tx, workspaceId);
  const limit = core.limits[allowance].limit;
  if (limit === null) return;
  await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [lockKey(workspaceId, allowance)]);
  const n = await gaugeCount(tx, workspaceId, allowance);
  if (n + adding > limit) {
    const what = ALLOWANCE_LABEL[allowance].label.toLowerCase();
    const plan = core.limits[allowance].source === 'override' ? 'This workspace' : `${core.plan?.name ?? 'Your'} plan`;
    throw new AppError('entitlement_required',
      `${plan} includes ${limit} ${what}${n > limit ? ` and ${n} are active` : ''}. Upgrade in Billing, or remove one first.`,
      undefined, { reason: 'allowance_exhausted', allowance, limit, used: n });
  }
}

/** Is this connection held by a lowered social-account limit? (publishing gate) */
export async function connectionHeld(db: Queryable, workspaceId: string, connectionId: string, core: EntitlementsCore): Promise<{ held: boolean; limit: number | null }> {
  const limit = core.limits.social_accounts.limit;
  if (limit === null) return { held: false, limit };
  const held = await heldIds(db, workspaceId, 'social_accounts', core);
  return { held: held.has(connectionId), limit };
}

export async function searchActiveUnderLimit(db: Queryable, workspaceId: string, searchId: string): Promise<boolean> {
  const r = await maybeOne<{ id: string }>(db, `SELECT id FROM listening_searches WHERE id=$1 AND workspace_id=$2 AND archived_at IS NULL`, [searchId, workspaceId]);
  if (!r) return false;
  return !(await heldIds(db, workspaceId, 'listening_searches')).has(searchId);
}
