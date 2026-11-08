// GET /api/analytics/sync?{filters} — sync status per account. POST {connection_id} — ask for a sync soon (throttled; the
// worker performs provider calls, never this request).
import { z } from 'zod';
import { filtersFromQuery, requestSync, syncStatus } from '@social-lite/services/analytics/api';
import { parseJson, route } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route(async ({ req, ctx }) => syncStatus(ctx, await filtersFromQuery(ctx, req.nextUrl.searchParams)));
export const POST = route(async ({ req, ctx }) => {
  const body = await parseJson(req, z.object({ connection_id: z.string() }).strict());
  return requestSync(ctx, body.connection_id);
});
