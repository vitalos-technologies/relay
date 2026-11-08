// GET  /api/inbox/conversations/:id/replies — send attempts with their actual provider result.
// POST /api/inbox/conversations/:id/replies { mode, body, base_version, idempotency_key, acknowledge_version? }
//   201 queued (or 200 with the existing attempt for a repeated key); 409 reply_collision / thread_changed with details.
import { listAttempts, replySchema, requestReply } from '@social-lite/services/inbox/index';
import { parseJson, route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route<{ id: string }>(async ({ ctx, params }) => listAttempts(ctx, params.id));
export const POST = route<{ id: string }>(async ({ req, ctx, params }) => {
  const r = await requestReply(ctx, params.id, await parseJson(req, replySchema));
  return Response.json(r, { status: r.created ? 201 : 200 });
});
