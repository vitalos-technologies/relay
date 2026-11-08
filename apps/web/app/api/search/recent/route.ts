// GET /api/search/recent — my recent items (re-authorized) · POST { kind, id } — record that I opened an item.
import { z } from 'zod';
import { recentItems, recordRecent } from '@social-lite/services/data/search';
import { parseJson, route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const body = z.object({ kind: z.enum(['post', 'campaign', 'asset', 'brand']), id: z.string().uuid() });

export const GET = route(async ({ req, ctx }) => {
  const l = Number(req.nextUrl.searchParams.get('limit') ?? '10');
  return Response.json(await recentItems(ctx, { limit: Number.isFinite(l) ? l : 10 }), { headers: { 'cache-control': 'private, no-store' } });
});
export const POST = route(async ({ req, ctx }) => {
  const b = await parseJson(req, body);
  return recordRecent(ctx, b.kind, b.id);
});
