// GET /api/posts/:id/activity?cursor= — who did what on this post (no comment text).
import { postActivity } from '@social-lite/services';
import { route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route<{ id: string }>(async ({ req, ctx, params }) => postActivity(ctx, params.id, { cursor: req.nextUrl.searchParams.get('cursor') }));
