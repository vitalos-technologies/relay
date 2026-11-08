// POST /api/review/:id/comments — shared comment from the review portal.
import { z } from 'zod';
import { addReviewComment } from '@social-lite/services';
import { parseJson, route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const body = z.object({ body: z.string().min(1).max(5000), client_key: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/).nullable().optional() }).strict();
export const POST = route<{ id: string }>(async ({ req, ctx, params }) => {
  const b = await parseJson(req, body);
  return addReviewComment(ctx, params.id, b.body, { client_key: b.client_key });
});
