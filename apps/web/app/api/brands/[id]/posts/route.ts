// GET list posts · POST create post (Idempotency-Key)
import { z } from 'zod';
import { createPost, listPosts } from '@social-lite/services';
import { idempotencyKey, parseJson, route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const body = z.object({ title: z.string().max(200).optional(), template_id: z.string().uuid().optional(), draft: z.unknown().optional(), connection_ids: z.array(z.string().uuid()).max(50).optional() });

export const GET = route<{ id: string }>(async ({ req, ctx, params }) => {
  const q = req.nextUrl.searchParams;
  return listPosts(ctx, params.id, { q: q.get('q') ?? undefined, tag: q.get('tag') ?? undefined, cursor: q.get('cursor') ?? undefined, limit: Number(q.get('limit')) || undefined, archived: q.get('archived') === '1', status: q.get('status') ?? undefined });
});
export const POST = route<{ id: string }>(async ({ req, ctx, params }) => {
  const r = await createPost(ctx, params.id, await parseJson(req, body), idempotencyKey(req));
  return Response.json(await (await import('@social-lite/services')).getPostDetail(ctx, r.id), { status: 201 });
});
