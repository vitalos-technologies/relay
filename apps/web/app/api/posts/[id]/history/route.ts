// GET /api/posts/:id/history?cursor= — paginated versions with change summaries + submitted revisions (reviews, publications).
import { listVersionHistory } from '@social-lite/services';
import { route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route<{ id: string }>(async ({ req, ctx, params }) => listVersionHistory(ctx, params.id, { cursor: req.nextUrl.searchParams.get('cursor') }));
