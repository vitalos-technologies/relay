// PUT /api/connectors/hub/:id/scenario { scenario } — simulated installs only (outage, rate limit, lost response, revoked…)
import { z } from 'zod';
import { setSimScenario } from '@social-lite/services/integrations-v35/index';
import { parseJson, route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const body = z.object({ scenario: z.string().max(40) }).strict();
export const PUT = route<{ id: string }>(async ({ req, ctx, params }) => setSimScenario(ctx, params.id, (await parseJson(req, body)).scenario));
