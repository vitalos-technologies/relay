// POST /api/members/:userId/grants { role, brand_id?, connection_id?, expires_at? } — add a scoped grant.
// Scope, workspace, granted_by and source are derived server-side; unknown keys are rejected.
import { z } from 'zod';
import { addMemberGrant } from '@social-lite/services/members';
import { parseJson, route } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const body = z.object({
  role: z.string().max(40), brand_id: z.string().max(64).nullable().optional(), connection_id: z.string().max(64).nullable().optional(),
  expires_at: z.string().max(40).nullable().optional(),
}).strict();

export const POST = route<{ userId: string }>(async ({ req, ctx, params }) => addMemberGrant(ctx, params.userId, await parseJson(req, body)));
