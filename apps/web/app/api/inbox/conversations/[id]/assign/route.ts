// POST /api/inbox/conversations/:id/assign { assignee_id | null, team_id? } — assignee must have inbox access on the brand.
import { assignConversation, assignSchema } from '@social-lite/services/inbox/index';
import { parseJson, route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = route<{ id: string }>(async ({ req, ctx, params }) => assignConversation(ctx, params.id, await parseJson(req, assignSchema)));
