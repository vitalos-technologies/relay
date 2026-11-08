// POST /api/connectors/hub/simulated { connector, brand_id? } — simulated installation (development/demo only; refused in production).
import { z } from 'zod';
import { createSimulatedHubInstallation } from '@social-lite/services/integrations-v35/index';
import { parseJson, route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const body = z.object({ connector: z.string().max(40), brand_id: z.string().uuid().nullable().optional() }).strict();
export const POST = route(async ({ req, ctx }) => createSimulatedHubInstallation(ctx, await parseJson(req, body)));
