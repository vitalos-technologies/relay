// POST /api/inbox/replies/:id/resolve { outcome: sent | not_sent } — a person settles an unconfirmed send after checking.
import { resolveUnknownReply, resolveUnknownSchema } from '@social-lite/services/inbox/index';
import { parseJson, route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = route<{ id: string }>(async ({ req, ctx, params }) => resolveUnknownReply(ctx, params.id, (await parseJson(req, resolveUnknownSchema)).outcome));
