// POST /api/content-hub/connections/start { source, brand_id|null, reconnect_connection_id? } → { authorization_url }
import { z } from 'zod';
import * as ch from '@social-lite/services/content-hub/index';
import { parseJson, route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const body = z.object({ source: z.enum(['google', 'notion']), brand_id: z.string().uuid().nullable(), reconnect_connection_id: z.string().uuid().nullish() }).strict();
export const POST = route(async ({ req, ctx }) => ch.startContentOAuth(ctx, await parseJson(req, body)));
