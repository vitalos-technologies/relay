// GET /api/analytics/content?{filters}&sort=&dir=&page=&page_size= — thumbnail-led, sortable, paginated content table.
import { filtersFromQuery } from '@social-lite/services/analytics/api';
import { contentTable } from '@social-lite/services/analytics/query';
import { route } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route(async ({ req, ctx }) => {
  const q = req.nextUrl.searchParams;
  return contentTable(ctx, await filtersFromQuery(ctx, q), { sort: q.get('sort'), dir: q.get('dir'), page: Number(q.get('page') ?? 1) || 1, page_size: Number(q.get('page_size') ?? 25) || 25 });
});
