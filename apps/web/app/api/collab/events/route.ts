// GET /api/collab/events?post=<id>&after=<cursor|now> — change-feed polling fallback (same filtering as the stream).
// after=now returns only the current cursor (where a freshly loaded page starts listening).
import { currentCursor, postAudiences, readCollabEvents } from '@social-lite/services';
import { route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route(async ({ req, ctx }) => {
  const post = req.nextUrl.searchParams.get('post');
  const after = req.nextUrl.searchParams.get('after');
  if (after === 'now') {
    const visible = post ? !!(await postAudiences(ctx, post)) : true;
    return { events: [], cursor: await currentCursor(), more: false, reset: false, visible };
  }
  return readCollabEvents(ctx, { postId: post, after: Number(after ?? 0) });
});
