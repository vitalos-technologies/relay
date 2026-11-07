// DELETE /api/teams/:id/members/:userId · PATCH { is_manager } (admins only).
import { z } from 'zod';
import { removeTeamMember, setTeamManager } from '@social-lite/services/teams';
import { parseJson, route } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const patch = z.object({ is_manager: z.boolean() }).strict();

export const DELETE = route<{ id: string; userId: string }>(async ({ ctx, params }) => removeTeamMember(ctx, params.id, params.userId));
export const PATCH = route<{ id: string; userId: string }>(async ({ req, ctx, params }) => setTeamManager(ctx, params.id, params.userId, (await parseJson(req, patch)).is_manager));
