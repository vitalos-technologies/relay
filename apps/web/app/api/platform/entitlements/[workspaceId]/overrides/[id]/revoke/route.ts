// POST /api/platform/entitlements/:workspaceId/overrides/:id/revoke { reason } — end an override early (operator/billing
// staff, step-up; platform + workspace audit). The row is kept for history.
import { z } from 'zod';
import { revokeOverride } from '@social-lite/services/entitlements/overrides';
import { parseJson, platformRoute } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = platformRoute<{ workspaceId: string; id: string }>(async ({ req, p, params }) => revokeOverride(p, params.workspaceId, params.id, await parseJson(req, z.unknown())));
