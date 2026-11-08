// GET/POST /api/posts/:id/comments — internal notes (staff with comments.internal) and shared comments.
import { z } from 'zod';
import { createComment, listComments } from '@social-lite/services';
import { parseJson, route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const body = z.object({ body: z.string().min(1).max(5000), visibility: z.enum(['internal', 'shared']), mention_user_ids: z.array(z.string().uuid()).max(20).optional(), approval_id: z.string().uuid().nullable().optional() }).strict();
export const GET = route<{ id: string }>(async ({ ctx, params }) => listComments(ctx, params.id));
export const POST = route<{ id: string }>(async ({ req, ctx, params }) => createComment(ctx, params.id, await parseJson(req, body)));
