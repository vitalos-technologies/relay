// GET /api/notifications?unread=1&category=mentions|discussion|tasks|reviews|reminders|publishing&cursor= — { items, unread_count, next_cursor }
import { listNotificationFeed } from '@social-lite/services';
import { route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route(async ({ req, ctx }) => {
  const q = req.nextUrl.searchParams;
  return listNotificationFeed(ctx, { unread: q.get('unread') === '1', category: q.get('category'), cursor: q.get('cursor'), limit: Number(q.get('limit')) || null });
});
