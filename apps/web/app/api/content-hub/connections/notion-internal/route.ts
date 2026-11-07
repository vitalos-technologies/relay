// POST /api/content-hub/connections/notion-internal { brand_id } — internal token for a TEST installation only.
import { z } from 'zod';
import * as ch from '@social-lite/services/content-hub/index';
import { parseJson, route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const body = z.object({ brand_id: z.string().uuid().nullable() }).strict();
export const POST = route(async ({ req, ctx }) => ch.connectNotionInternal(ctx, await parseJson(req, body)));
