// PUT /api/inbox/channels/:id/csat { enabled } — satisfaction requests on this channel (inbox.manage; private chats only).
import { csatToggleSchema, setCsatEnabled } from '@social-lite/services/inbox/index';
import { parseJson, route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const PUT = route<{ id: string }>(async ({ req, ctx, params }) => setCsatEnabled(ctx, params.id, (await parseJson(req, csatToggleSchema)).enabled));
