// GET  /api/connectors?connector= — V3.5 integration installations (integrations.read)
// POST /api/connectors/simulated is not exposed here; see POST below (simulated only, never in production).
import { createSimulatedIntegration, listIntegrations, simulatedIntegrationSchema } from '@social-lite/services/connectors/index';
import { parseJson, queryOf, route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route(async ({ req, ctx }) => listIntegrations(ctx, queryOf(req)));
/** POST { connector, brand_id?, display_name? } — creates a SIMULATED installation (mock providers only). Real connects use each connector's OAuth flow (stream C). */
export const POST = route(async ({ req, ctx }) => createSimulatedIntegration(ctx, await parseJson(req, simulatedIntegrationSchema)));
