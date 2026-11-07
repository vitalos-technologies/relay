// GET /api/content-hub/notion/search?connection_id&brand_id&type=page|data_source&q&cursor — objects shared with the connection.
import * as ch from '@social-lite/services/content-hub/index';
import { route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route(async ({ req, ctx }) => {
  const q = req.nextUrl.searchParams;
  return ch.searchNotion(ctx, { connection_id: q.get('connection_id') ?? '', brand_id: q.get('brand_id') ?? '', query: q.get('q') ?? undefined,
    type: q.get('type') === 'data_source' ? 'data_source' : 'page', cursor: q.get('cursor') });
});
