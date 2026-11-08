// GET  /api/inbox/channels — channels in the caller's inbox brands (status, missing permissions, capability record)
// POST /api/inbox/channels { connection_id, enabled_types? } — use a connected account in the inbox (inbox.manage)
import { enableChannel, enableChannelSchema, listChannels } from '@social-lite/services/inbox/index';
import { parseJson, route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route(async ({ ctx }) => listChannels(ctx));
export const POST = route(async ({ req, ctx }) => enableChannel(ctx, await parseJson(req, enableChannelSchema)));
