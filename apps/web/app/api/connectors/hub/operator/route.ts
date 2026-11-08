// POST /api/connectors/hub/operator { connector } — connect with operator credentials (Cloud Translation).
import { z } from 'zod';
import { connectWithOperatorCredentials } from '@social-lite/services/integrations-v35/index';
import { parseJson, route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const body = z.object({ connector: z.literal('google_translate') }).strict();
export const POST = route(async ({ req, ctx }) => connectWithOperatorCredentials(ctx, await parseJson(req, body)));
