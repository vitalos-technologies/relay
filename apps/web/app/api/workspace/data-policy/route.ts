// GET/PUT /api/workspace/data-policy — draft recovery policy (persistent / session / off local recovery).
import { z } from 'zod';
import { getDataPolicy, updateDataPolicy } from '@social-lite/services/data/policy';
import { parseJson, route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const body = z.object({
  local_recovery: z.enum(['persistent', 'session', 'off']).optional(), max_age_hours: z.number().int().min(1).max(720).optional(), clear_on_logout: z.boolean().optional(),
});

export const GET = route(async ({ ctx }) => getDataPolicy(ctx));
export const PUT = route(async ({ req, ctx }) => updateDataPolicy(ctx, await parseJson(req, body)));
