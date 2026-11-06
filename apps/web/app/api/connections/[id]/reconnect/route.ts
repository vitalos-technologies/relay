// POST /api/connections/:id/reconnect — OAuth: {} => { authorization_url }; Telegram: { bot_token } => Connection.
import { reconnectConnection, reconnectSchema } from '@social-lite/services/connections/index';
import { parseJson, route } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = route<{ id: string }>(async ({ req, ctx, params }) => reconnectConnection(ctx, params.id, await parseJson(req, reconnectSchema)));
