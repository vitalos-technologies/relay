// POST /api/inbox/channels/integration { integration_id, account_id, brand_id? } — add a WhatsApp number or a Google
// Business Profile location (selected in Integrations) to the inbox (inbox.manage). Stream B.
import { enableIntegrationChannel, enableIntegrationChannelSchema } from '@social-lite/services/inbox/index';
import { parseJson, route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = route(async ({ req, ctx }) => enableIntegrationChannel(ctx, await parseJson(req, enableIntegrationChannelSchema)));
