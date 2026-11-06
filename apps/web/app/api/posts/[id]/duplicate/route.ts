import { duplicatePost, getPostDetail } from '@social-lite/services';
import { idempotencyKey, route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = route<{ id: string }>(async ({ req, ctx, params }) => {
  const r = await duplicatePost(ctx, params.id, idempotencyKey(req));
  return Response.json(await getPostDetail(ctx, r.id), { status: 201 });
});
