// Relay support (V4 SUP) — commercial facts for the staff workspace-context card: plan, billing status, access level,
// trial/renewal dates. From the billing stream's metadata-only summary (no provider references, amounts or card data —
// support staff are not billing staff). Missing/failed billing data never blocks the ticket view.
import type { WorkspaceSupportContext } from '@social-lite/core/contracts/v4-support';
import type { Queryable } from '@social-lite/db';
import { workspaceCommercialSummary } from '../billing/state.js';
import { log } from '../log.js';

export async function commercialSummary(db: Queryable, workspaceId: string): Promise<WorkspaceSupportContext['commercial']> {
  try {
    const s = await workspaceCommercialSummary(workspaceId, db);
    return { plan: s.plan.name, status: s.payment_issue ? `${s.status} (payment issue)` : s.status, access: s.access, trial_ends_at: s.trial_ends_at, renews_at: s.cancel_at ? null : s.renews_at };
  } catch (err) {
    log.warn('support_commercial_summary_failed', { err: err as Error });
    return null;
  }
}
