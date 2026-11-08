// PUT /api/connectors/hub/:id/hubspot-defaults { default_pipeline, default_stage }
import { z } from 'zod';
import { setHubspotDefaults } from '@social-lite/services/integrations-v35/index';
import { parseJson, route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const body = z.object({ default_pipeline: z.string().max(40), default_stage: z.string().max(40) }).strict();
export const PUT = route<{ id: string }>(async ({ req, ctx, params }) => setHubspotDefaults(ctx, params.id, await parseJson(req, body)));
