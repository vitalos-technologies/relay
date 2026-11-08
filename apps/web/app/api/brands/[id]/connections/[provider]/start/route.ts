// POST /api/brands/:id/connections/:provider/start {} — begin OAuth (facebook, instagram, x).
// => { authorization_url } or 412 provider_not_configured.
import { z } from 'zod';
import { startOAuth } from '@social-lite/services/connections/index';
import { parseJson, route } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = route<{ id: string; provider: string }>(async ({ req, ctx, params }) => {
  await parseJson(req, z.object({}).passthrough());
  return startOAuth(ctx, params.id, params.provider);
});
