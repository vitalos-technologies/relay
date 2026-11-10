// Gauge allowances (live counts, no period): connected social accounts, active listening searches, and (D33) brands and
// members (V4 §12–13).
//  - New resources are refused at the limit (race-free: a per-workspace advisory lock serializes the count + insert in
//    the caller's transaction, so two concurrent connects cannot both take the last slot).
//  - When a limit is LOWERED (downgrade, seat reduction, override), nothing is deleted or disconnected: the customer
//    chooses which resources stay active (entitlement_selections); the rest are HELD — publishing to a held account is
//    held, a held search does not match new items, a held brand's posts are not published (its content stays editable), a
//    held member keeps their account but loses product access (billing, support and export stay reachable). Without a
//    choice, the oldest resources stay active. Owners always stay active members (they can upgrade or remove people).
import { AppError } from '@social-lite/core';
import type { Allowance } from '@social-lite/core/contracts/v4-plans';
import { ALLOWANCE_LABEL, type SelectableAllowance } from '@social-lite/core/contracts/v4-entitlements';
import { cheapestPlanWithMore, limitUpgradeMessage } from '@social-lite/core/contracts/plan-copy';
import { many, maybeOne, type Queryable } from '@social-lite/db';
import { entitlementsCore, type EntitlementsCore } from './resolve.js';

export interface GaugeItem { id: string; name: string; detail: string | null; created_at: Date }

const GAUGE_SQL: Record<SelectableAllowance, string> = {
  // Synthetic analytics demo rows are not accounts; simulated (mock_) destinations count like real ones (they look the same in the UI).
  social_accounts: `SELECT id, display_name AS name, provider::text AS detail, created_at FROM connections
                     WHERE workspace_id=$1 AND disconnected_at IS NULL AND NOT coalesce(is_synthetic, false) ORDER BY created_at, id`,
  listening_searches: `SELECT id, name, role AS detail, created_at FROM listening_searches WHERE workspace_id=$1 AND archived_at IS NULL ORDER BY created_at, id`,
  // The synthetic analytics demo brand added to a real workspace is not counted (in a demo workspace every brand counts).
  brands: `SELECT b.id, b.name, NULL::text AS detail, b.created_at FROM brands b JOIN workspaces w ON w.id=b.workspace_id
            WHERE b.workspace_id=$1 AND b.archived_at IS NULL AND NOT (b.is_demo AND NOT w.is_demo) ORDER BY b.created_at, b.id`,
  // Active people (owner included). Not counted: Relay operators present through a support-access grant, disabled accounts.
  members: `SELECT m.user_id AS id, coalesce(nullif(u.name, ''), u.email::text) AS name, m.role::text AS detail, m.created_at FROM memberships m JOIN users u ON u.id=m.user_id
             WHERE m.workspace_id=$1 AND m.status='active' AND m.removed_at IS NULL AND u.disabled_at IS NULL
               AND NOT EXISTS (SELECT 1 FROM support_access_grants s WHERE s.workspace_id=m.workspace_id AND s.operator_user_id=m.user_id AND s.status='active' AND s.created_membership)
             ORDER BY (m.role = 'owner') DESC, m.created_at, m.user_id`,
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
  // Members: owners first, always (the person who can upgrade or remove people never loses access).
  const pinned = allowance === 'members' ? items.filter((i) => i.detail === 'owner') : [];
  const rest = items.filter((i) => !pinned.includes(i));
  const ordered = [...pinned, ...rest.filter((i) => chosen.has(i.id)), ...rest.filter((i) => !chosen.has(i.id))];
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
  if (n + adding > limit) throw gaugeFullError(core, allowance, limit, n);
}

/** The refusal for a full gauge (shared by the capacity checks): concise, with the upgrade target. */
export function gaugeFullError(core: EntitlementsCore, allowance: SelectableAllowance, limit: number, used: number): AppError {
  const override = core.limits[allowance].source === 'override';
  const plan = override ? 'This workspace' : core.plan?.name ?? 'Your plan';
  const upgrade_to = override ? null : cheapestPlanWithMore(allowance, core.plan?.id);
  const what = allowance === 'members' ? (limit === 1 ? '1 user' : `${limit} users`)
    : allowance === 'brands' ? (limit === 1 ? '1 brand' : `${limit} brands`)
    : `${limit} ${ALLOWANCE_LABEL[allowance].label.toLowerCase()}`;
  const message = allowance === 'members'
    ? `${plan} includes ${what}. ${upgrade_to ? 'Upgrade to add teammates.' : 'Remove someone first, or contact support.'}`
    : limitUpgradeMessage(`${what}${used > limit ? ` and ${used} are active` : ''}`, plan, upgrade_to);
  return new AppError('entitlement_required', message, undefined, { reason: 'allowance_exhausted', allowance, limit, used, upgrade_to });
}

/** Is this connection held by a lowered social-account limit? (publishing gate) */
export async function connectionHeld(db: Queryable, workspaceId: string, connectionId: string, core: EntitlementsCore): Promise<{ held: boolean; limit: number | null }> {
  const limit = core.limits.social_accounts.limit;
  if (limit === null) return { held: false, limit };
  const held = await heldIds(db, workspaceId, 'social_accounts', core);
  return { held: held.has(connectionId), limit };
}

/** Is this brand held by a lowered brand limit? (publishing + scheduling gate) */
export async function brandHeld(db: Queryable, workspaceId: string, brandId: string, core: EntitlementsCore): Promise<{ held: boolean; limit: number | null }> {
  const limit = core.limits.brands.limit;
  if (limit === null) return { held: false, limit };
  return { held: (await heldIds(db, workspaceId, 'brands', core)).has(brandId), limit };
}

export async function searchActiveUnderLimit(db: Queryable, workspaceId: string, searchId: string): Promise<boolean> {
  const r = await maybeOne<{ id: string }>(db, `SELECT id FROM listening_searches WHERE id=$1 AND workspace_id=$2 AND archived_at IS NULL`, [searchId, workspaceId]);
  if (!r) return false;
  return !(await heldIds(db, workspaceId, 'listening_searches')).has(searchId);
}
