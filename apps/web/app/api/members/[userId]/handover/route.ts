// GET /api/members/:userId/handover — what is affected (drafts, approvals, scheduled, service accounts,
// connections) + authorised candidates per affected brand. POST { to_user_id, items? } — reassign.
import { z } from 'zod';
import { handoverPreview, reassignWork } from '@social-lite/services/lifecycle';
import { parseJson, route } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const body = z.object({
  to_user_id: z.string().max(64),
  items: z.array(z.enum(['drafts', 'approvals', 'scheduled', 'service_accounts'])).max(4).optional(),
}).strict();

export const GET = route<{ userId: string }>(async ({ ctx, params }) => handoverPreview(ctx, params.userId));
export const POST = route<{ userId: string }>(async ({ req, ctx, params }) => reassignWork(ctx, params.userId, await parseJson(req, body)));
