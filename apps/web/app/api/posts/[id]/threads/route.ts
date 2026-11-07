// GET  /api/posts/:id/threads?status=open|resolved|all&cursor=&approval_id= — one page of discussion threads (staff).
// POST /api/posts/:id/threads — start a thread { visibility, body, anchor?, approval_id?, client_key? }.
import { z } from 'zod';
import { createThread, listThreads } from '@social-lite/services';
import { parseJson, route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const anchor = z.union([
  z.object({ kind: z.literal('text'), field: z.enum(['base', 'variant']), connection_id: z.string().uuid().nullable().optional(), quote: z.string().min(1).max(500), prefix: z.string().max(80).optional(), suffix: z.string().max(80).optional() }).strict(),
  z.object({ kind: z.literal('media'), asset_id: z.string().uuid() }).strict(),
]);
const body = z.object({
  body: z.string().min(1).max(5000), visibility: z.enum(['internal', 'shared']), anchor: anchor.nullable().optional(),
  approval_id: z.string().uuid().nullable().optional(), client_key: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/).nullable().optional(),
  mention_user_ids: z.array(z.string().uuid()).max(20).optional(),
}).strict();

export const GET = route<{ id: string }>(async ({ req, ctx, params }) => {
  const q = req.nextUrl.searchParams;
  return listThreads(ctx, params.id, { status: q.get('status'), cursor: q.get('cursor'), approval_id: q.get('approval_id'), limit: Number(q.get('limit')) || undefined });
});
export const POST = route<{ id: string }>(async ({ req, ctx, params }) => createThread(ctx, params.id, await parseJson(req, body)));
