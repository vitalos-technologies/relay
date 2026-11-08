// GET /api/teams/:id (members, grants, ceiling) · PATCH { name?, description?, archived? }.
import { z } from 'zod';
import { getTeam, updateTeam } from '@social-lite/services/teams';
import { parseJson, route } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const patch = z.object({ name: z.string().max(80).optional(), description: z.string().max(300).nullable().optional(), archived: z.boolean().optional() }).strict();

export const GET = route<{ id: string }>(async ({ ctx, params }) => getTeam(ctx, params.id));
export const PATCH = route<{ id: string }>(async ({ req, ctx, params }) => updateTeam(ctx, params.id, await parseJson(req, patch)));
