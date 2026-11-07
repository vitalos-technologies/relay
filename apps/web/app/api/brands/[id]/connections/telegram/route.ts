// POST /api/brands/:id/connections/telegram { bot_token, channel } — verified before Ready (AC-03).
// The bot token is never logged or returned.
import { connectTelegram, telegramConnectSchema } from '@social-lite/services/connections/index';
import { clientIp, enforceRateLimit } from '@social-lite/services/ratelimit';
import { parseJson, route } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = route<{ id: string }>(async ({ req, ctx, params }) => {
  await enforceRateLimit('telegramConnect', `${ctx.actor.userId}:${clientIp(req.headers)}`, { capacity: 10, refillPerSecond: 10 / 600 });
  return connectTelegram(ctx, params.id, await parseJson(req, telegramConnectSchema));
});
