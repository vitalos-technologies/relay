import { z } from 'zod';
import { reschedule } from '@social-lite/services';
import { idempotencyKey, parseJson, route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const body = z.object({
  input_local_time: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/), timezone: z.string().max(64).optional(),
  offset: z.string().regex(/^[+-]\d{2}:\d{2}$/).optional(), expected_generation: z.number().int().positive(), deadline_minutes: z.number().int().min(1).max(10080).optional(),
});
export const POST = route<{ id: string }>(async ({ req, ctx, params }) => {
  const r = await reschedule(ctx, params.id, await parseJson(req, body), idempotencyKey(req));
  return Response.json(r.body, { status: r.status });
});
