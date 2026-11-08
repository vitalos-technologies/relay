// POST /api/brands/:id/connections/bluesky { handle, app_password, service? } — verified with Bluesky before Ready.
// The app password is never logged or returned; it is stored envelope-encrypted to re-create expired sessions.
import { blueskyConnectSchema, connectBluesky } from '@social-lite/services/connections/index';
import { clientIp, enforceRateLimit } from '@social-lite/services/ratelimit';
import { parseJson, route } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = route<{ id: string }>(async ({ req, ctx, params }) => {
  await enforceRateLimit('blueskyConnect', `${ctx.actor.userId}:${clientIp(req.headers)}`, { capacity: 10, refillPerSecond: 10 / 600 });
  return connectBluesky(ctx, params.id, await parseJson(req, blueskyConnectSchema));
});
