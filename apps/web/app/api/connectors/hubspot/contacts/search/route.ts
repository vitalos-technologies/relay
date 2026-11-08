// POST /api/connectors/hubspot/contacts/search { integration_id, email | query } — masked results; linking is a separate explicit step
import { contactSearchSchema, searchHubspotContacts } from '@social-lite/services/integrations-v35/index';
import { parseJson, route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = route(async ({ req, ctx }) => searchHubspotContacts(ctx, await parseJson(req, contactSearchSchema)));
