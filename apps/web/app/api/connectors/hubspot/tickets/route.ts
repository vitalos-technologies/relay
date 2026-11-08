// POST /api/connectors/hubspot/tickets — case → ONE ticket (idempotent per case; durable job)
import { createHubspotTicket, ticketSchema } from '@social-lite/services/integrations-v35/index';
import { parseJson, route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = route(async ({ req, ctx }) => createHubspotTicket(ctx, await parseJson(req, ticketSchema)));
