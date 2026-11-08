// GET /api/entitlements — the workspace's plan, features and access (every member; drives UI gating + upgrade prompts);
// usage allowances, held work and overrides for billing.read / workspace.manage holders. Server state only: nothing a
// client sends here (or anywhere) grants a capability; every action is re-checked by the shared entitlement service.
import { workspaceEntitlements } from '@social-lite/services/entitlements/usage';
import { route } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route(async ({ ctx }) => workspaceEntitlements(ctx));
