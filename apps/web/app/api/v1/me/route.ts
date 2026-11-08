// GET /api/v1/me — the calling service account (API key auth): name, workspace, brand-scoped grants.
import { machineRoute } from '@/lib/machine';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = machineRoute(async ({ ctx, principal }) => ({
  service_account: { id: principal.serviceAccountId, name: principal.name, key_prefix: principal.prefix },
  workspace_id: principal.workspaceId,
  grants: ctx.access.authz!.subject.grants.map((g) => ({ role: g.role, scope: g.scopeType, brand_id: g.brandId })),
}));
