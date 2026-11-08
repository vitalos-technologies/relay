// POST /api/teams/:id/members { user_id, is_manager? } — admins, or this team's managers within the ceiling.
// Joining a team with grants is a privilege grant (ceiling-checked + audited).
import { z } from 'zod';
import { addTeamMember } from '@social-lite/services/teams';
import { parseJson, route } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const body = z.object({ user_id: z.string().max(64), is_manager: z.boolean().optional() }).strict();

export const POST = route<{ id: string }>(async ({ req, ctx, params }) => addTeamMember(ctx, params.id, await parseJson(req, body)));
