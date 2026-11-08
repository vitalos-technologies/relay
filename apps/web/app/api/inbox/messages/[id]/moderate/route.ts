// POST /api/inbox/messages/:id/moderate { action: 'hide' | 'unhide' | 'delete_own' } — only actions the network permits.
import { moderateMessage, moderateSchema } from '@social-lite/services/inbox/index';
import { parseJson, route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = route<{ id: string }>(async ({ req, ctx, params }) => moderateMessage(ctx, params.id, (await parseJson(req, moderateSchema)).action));
