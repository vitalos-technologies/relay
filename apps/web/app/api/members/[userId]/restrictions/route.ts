// GET /api/members/:userId/restrictions · POST { actions[], brand_id?, reason?, expires_at? } — explicit deny.
import { z } from 'zod';
import { addRestriction, listRestrictions } from '@social-lite/services/members';
import { parseJson, route } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const body = z.object({
  actions: z.array(z.string().max(40)).min(1).max(40), brand_id: z.string().max(64).nullable().optional(),
  reason: z.string().max(300).nullable().optional(), expires_at: z.string().max(40).nullable().optional(),
}).strict();

export const GET = route<{ userId: string }>(async ({ ctx, params }) => listRestrictions(ctx, params.userId));
export const POST = route<{ userId: string }>(async ({ req, ctx, params }) => addRestriction(ctx, params.userId, await parseJson(req, body)));
