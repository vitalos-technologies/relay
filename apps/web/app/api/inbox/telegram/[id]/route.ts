// POST /api/inbox/telegram/:channelId — Telegram webhook for a channel whose updates Relay owns. Authenticated by the
// per-channel secret token (X-Telegram-Bot-Api-Secret-Token), persisted + deduplicated BEFORE the 200.
import { receiveTelegramUpdate } from '@social-lite/services/inbox/index';
import { publicRoute } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = publicRoute<{ id: string }>(async ({ req, params }) => {
  const r = await receiveTelegramUpdate(params.id, await req.text(), req.headers.get('x-telegram-bot-api-secret-token'));
  return Response.json(r.body, { status: r.status });
});
