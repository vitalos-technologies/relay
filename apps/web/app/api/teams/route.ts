// GET /api/teams?q=&archived= — teams directory (teams.read) · POST { name, description? } (teams.manage).
import { z } from 'zod';
import { createTeam, listTeams } from '@social-lite/services/teams';
import { parseJson, route } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const body = z.object({ name: z.string().max(80), description: z.string().max(300).nullable().optional() }).strict();

export const GET = route(async ({ req, ctx }) => listTeams(ctx, { q: req.nextUrl.searchParams.get('q') ?? undefined, archived: req.nextUrl.searchParams.get('archived') === 'true' }));
export const POST = route(async ({ req, ctx }) => createTeam(ctx, await parseJson(req, body)));
