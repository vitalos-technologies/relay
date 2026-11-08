// GET /api/inbox/saved-replies?brand_id= · POST { brand_id?, title, body } (inbox.manage)
import { listSavedReplies, saveSavedReply, savedReplySchema } from '@social-lite/services/inbox/index';
import { parseJson, queryOf, route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route(async ({ req, ctx }) => listSavedReplies(ctx, queryOf(req)));
export const POST = route(async ({ req, ctx }) => saveSavedReply(ctx, await parseJson(req, savedReplySchema)));
