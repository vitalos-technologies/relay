// POST /api/connectors/oauth/:connector/start { brand_id?, reconnect_id? } → { authorization_url } (integrations.manage; needs operator app setup)
import { z } from 'zod';
import { startIntegrationOAuth } from '@social-lite/services/integrations-v35/index';
import { parseJson, route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const body = z.object({ brand_id: z.string().uuid().nullable().optional(), reconnect_id: z.string().uuid().nullable().optional() }).strict();
export const POST = route<{ connector: string }>(async ({ req, ctx, params }) => startIntegrationOAuth(ctx, { connector: params.connector, ...(await parseJson(req, body)) }));
