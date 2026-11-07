// POST /api/content-hub/connections/test { source, brand_id } — labelled TEST connection (non-production only).
import { z } from 'zod';
import * as ch from '@social-lite/services/content-hub/index';
import { parseJson, route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const body = z.object({ source: z.enum(['google', 'notion']), brand_id: z.string().uuid().nullable() }).strict();
export const POST = route(async ({ req, ctx }) => ch.connectTestSource(ctx, await parseJson(req, body)));
