// Route-level feature gates (D33). Whole API areas whose plan feature is missing are refused with 402
// `entitlement_required` before the handler runs — the same shared check (checkFeature) every service uses, applied by
// the API wrapper (apps/web/lib/api.ts route()). Only areas that Free lacks but every paid plan has are listed here; the
// Professional-only areas (listening, automation, integrations, MCP, saved reports, multi-step approvals) keep their
// finer-grained gates in their services (reading stays allowed on Standard, activation/configuration is refused).
// Approvals: submitting and turning approvals on are gated in their services (deciding existing approvals and reading
// stay available — nothing in progress is locked by a plan change).
// The workspace data export (brand handover bundle, activity log) is never gated (D33: export always works).
import type { Feature } from '@social-lite/core/contracts/v4-plans';
import type { Queryable } from '@social-lite/db';
import { checkFeature, entitlementError, entitlementsCoreCached } from './resolve.js';

export const ROUTE_FEATURES: ReadonlyArray<{ prefix: string; feature: Feature }> = [
  { prefix: '/api/analytics', feature: 'analytics_standard' }, // analytics pages + API, report exports
  { prefix: '/api/inbox', feature: 'inbox' },
];

export function routeFeature(pathname: string): Feature | null {
  return ROUTE_FEATURES.find((r) => pathname === r.prefix || pathname.startsWith(`${r.prefix}/`))?.feature ?? null;
}

/** Throw entitlement_required when the API area's feature is not in the workspace's plan. Not a paid-action check. */
export async function assertRouteEntitled(pathname: string, workspaceId: string, db?: Queryable): Promise<void> {
  const feature = routeFeature(pathname);
  if (!feature) return;
  const c = checkFeature(await entitlementsCoreCached(workspaceId, db), feature, { paid: false });
  if (!c.ok) throw entitlementError(c);
}
