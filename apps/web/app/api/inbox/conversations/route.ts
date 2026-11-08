// GET /api/inbox/conversations?queue=&brand_id=&channel_id=&kind=&assignee_id=&priority=&language=&label=&q=&cursor=&limit=
import { listConversations } from '@social-lite/services/inbox/index';
import { queryOf, route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route(async ({ req, ctx }) => listConversations(ctx, queryOf(req) as never));
