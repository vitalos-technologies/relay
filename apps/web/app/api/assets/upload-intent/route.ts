// POST /api/assets/upload-intent { brand_id, filename, content_type, bytes }
// → { asset_id, upload: { method: 'POST', url, fields } } — presigned POST (exact key, type, size range; 10 min).
import { z } from 'zod';
import { createUploadIntent } from '@social-lite/services/media/assets';
import { enforceRateLimit } from '@social-lite/services/ratelimit';
import { parseJson, route } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const body = z.object({
  brand_id: z.string().max(64),
  filename: z.string().min(1).max(500),
  content_type: z.string().max(100),
  bytes: z.number().int().positive(),
}).strict();

export const POST = route(async ({ req, ctx }) => {
  const input = await parseJson(req, body);
  await enforceRateLimit('uploadIntent', ctx.actor.userId);
  return createUploadIntent(ctx, input);
});
