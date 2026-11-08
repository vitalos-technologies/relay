// POST /api/connectors/hubspot/contacts/link { integration_id, customer_id, contact_id } — explicit, audited, reversible (DELETE /api/connectors/links/:id)
import { linkContactSchema, linkHubspotContact } from '@social-lite/services/integrations-v35/index';
import { parseJson, route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = route(async ({ req, ctx }) => linkHubspotContact(ctx, await parseJson(req, linkContactSchema)));
