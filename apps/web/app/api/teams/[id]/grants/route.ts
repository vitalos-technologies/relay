// POST /api/teams/:id/grants { role, brand_id?, connection_id? } — team grant (team roles only; ceiling of the actor).
import { z } from 'zod';
import { addTeamGrant } from '@social-lite/services/teams';
import { parseJson, route } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const body = z.object({ role: z.string().max(40), brand_id: z.string().max(64).nullable().optional(), connection_id: z.string().max(64).nullable().optional() }).strict();

export const POST = route<{ id: string }>(async ({ req, ctx, params }) => addTeamGrant(ctx, params.id, await parseJson(req, body)));
