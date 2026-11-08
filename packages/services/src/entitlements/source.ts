// Billing facts for entitlements come ONLY from the billing stream's getBillingState(db, workspaceId)
// (contract: @social-lite/core/contracts/v4-billing; never read billing tables here). Workspaces without a billing row
// are `legacy` there (full access, Professional features, unmetered by plan) — the migration behaviour for pre-V4
// workspaces, seeded/test workspaces included.
import type { BillingState } from '@social-lite/core/contracts/v4-billing';
import { maybeOne, type Queryable } from '@social-lite/db';
import { getBillingState } from '../billing/state.js';

export type BillingStateSource = (db: Queryable, workspaceId: string) => Promise<BillingState>;

/**
 * A legacy BillingState built without the billing tables (tests use it as a base to inject trial / restricted /
 * Standard states). Staff service suspension (workspaces.state, V3.1) is reflected because it is not a billing fact.
 */
export async function stubBillingState(db: Queryable, workspaceId: string): Promise<BillingState> {
  const w = await maybeOne<{ state: string }>(db, `SELECT state FROM workspaces WHERE id=$1`, [workspaceId]);
  const suspended = !!w && w.state !== 'active';
  return {
    workspace_id: workspaceId, plan_id: 'legacy', plan_version_id: null, status: 'legacy', seats: 1, trial: null, current_period: null,
    cancel_at: null, scheduled_change: null, grace_ends_at: null, service_suspended: suspended,
    access: suspended ? 'suspended' : 'full', access_reason: suspended ? 'This workspace is suspended by Relay.' : null, as_of: new Date().toISOString(),
  };
}

// Deployment ordering guard: until the billing migration (035) is applied, no workspace has billing facts and every
// workspace is legacy by definition (that migration writes legacy rows). Checked with to_regclass (no error inside the
// caller's transaction); once present, cached for the process lifetime.
let billingTablesReady = false;
let lastCheck = 0;
async function billingReady(db: Queryable): Promise<boolean> {
  if (billingTablesReady) return true;
  if (Date.now() - lastCheck < 30_000 && lastCheck) return false;
  lastCheck = Date.now();
  const r = await maybeOne<{ ok: boolean }>(db, `SELECT to_regclass('public.workspace_billing') IS NOT NULL AS ok`);
  billingTablesReady = !!r?.ok;
  return billingTablesReady;
}

const defaultSource: BillingStateSource = async (db, workspaceId) => ((await billingReady(db)) ? getBillingState(db, workspaceId) : stubBillingState(db, workspaceId));
let source: BillingStateSource = defaultSource;

/** The billing state for a workspace (inside the caller's transaction when `db` is a transaction client). */
export function billingStateFor(db: Queryable, workspaceId: string): Promise<BillingState> {
  return source(db, workspaceId);
}

/**
 * Test seam: integration tests inject billing states (trial, restricted, Standard…) without driving the billing
 * provider. Production code never calls this; passing null restores getBillingState.
 */
export function setBillingStateSourceForTests(fn: BillingStateSource | null): void {
  source = fn ?? defaultSource;
}
