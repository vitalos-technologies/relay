// GET/PATCH /api/posts/:id/planning — campaign, assignee (must be entitled to the brand), due date, owning team.
import { z } from 'zod';
import { getPostPlanning, updatePostPlanning } from '@social-lite/services';
import { parseJson, route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const body = z.object({ campaign_id: z.string().uuid().nullable().optional(), assignee_user_id: z.string().uuid().nullable().optional(), due_at: z.string().max(40).nullable().optional(), team_id: z.string().uuid().nullable().optional() }).strict();
export const GET = route<{ id: string }>(async ({ ctx, params }) => getPostPlanning(ctx, params.id));
export const PATCH = route<{ id: string }>(async ({ req, ctx, params }) => updatePostPlanning(ctx, params.id, await parseJson(req, body)));
