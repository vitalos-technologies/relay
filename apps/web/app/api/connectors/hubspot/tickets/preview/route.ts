// POST /api/connectors/hubspot/tickets/preview — what leaves Relay
import { previewHubspotTicket, ticketSchema } from '@social-lite/services/integrations-v35/index';
import { parseJson, route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = route(async ({ req, ctx }) => previewHubspotTicket(ctx, await parseJson(req, ticketSchema)));
