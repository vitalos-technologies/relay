// POST publish now (202) — same durable pipeline as scheduling. Idempotency-Key required.
import { z } from 'zod';
import { publishNow } from '@social-lite/services';
import { idempotencyKey, parseJson, route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const body = z.object({ expected_version: z.number().int().positive(), connection_ids: z.array(z.string().uuid()).min(1).max(50) });
export const POST = route<{ id: string }>(async ({ req, ctx, params }) => {
  const r = await publishNow(ctx, params.id, await parseJson(req, body), idempotencyKey(req));
  return Response.json(r.body, { status: r.status });
});
