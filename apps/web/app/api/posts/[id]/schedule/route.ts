// POST schedule (202). Idempotency-Key required.
import { schedulePost } from '@social-lite/services';
import { idempotencyKey, parseJson, route } from '@/lib/api';
import { z } from 'zod';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = route<{ id: string }>(async ({ req, ctx, params }) => {
  const r = await schedulePost(ctx, params.id, await parseJson(req, z.unknown()), idempotencyKey(req));
  return Response.json(r.body, { status: r.status });
});
