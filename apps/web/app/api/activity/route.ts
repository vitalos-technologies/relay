// GET /api/activity?category=&brand_id=&actor_user_id=&action=&q=&from=&to=&cursor=&limit= (audit.read)
// → { items, next_cursor, can_export }. Workspace-scoped; brand-restricted events are hidden.
import { listActivity } from '@social-lite/services/product/activity';
import { route } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route(async ({ req, ctx }) => {
  const sp = req.nextUrl.searchParams;
  const q: Record<string, string> = {};
  for (const k of ['category', 'brand_id', 'actor_user_id', 'action', 'q', 'from', 'to', 'cursor', 'limit']) {
    const v = sp.get(k);
    if (v) q[k] = v;
  }
  return listActivity(ctx, q);
});
