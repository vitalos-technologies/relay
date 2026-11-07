// PUT /api/teams/:id/delegation { grantable_roles, brand_ids } — ceiling for this team's managers.
import { z } from 'zod';
import { setDelegationLimits } from '@social-lite/services/teams';
import { parseJson, route } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const body = z.object({ grantable_roles: z.array(z.string().max(40)).max(12), brand_ids: z.array(z.string().max(64)).max(200) }).strict();

export const PUT = route<{ id: string }>(async ({ req, ctx, params }) => setDelegationLimits(ctx, params.id, await parseJson(req, body)));
