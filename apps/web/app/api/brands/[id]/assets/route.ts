// GET /api/brands/:id/assets?status=&tag=&q=&cursor=&limit= — { items, next_cursor }
import { listAssets } from '@social-lite/services/media/assets';
import { route } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route<{ id: string }>(async ({ req, ctx, params }) => {
  const sp = req.nextUrl.searchParams;
  const limit = sp.get('limit');
  return listAssets(ctx, params.id, {
    status: sp.get('status'), tag: sp.get('tag'), q: sp.get('q'), cursor: sp.get('cursor'),
    limit: limit && /^\d{1,3}$/.test(limit) ? Number(limit) : null,
  });
});
