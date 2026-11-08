// V3.1 §13 — evergreen content queue for a brand.
// GET (inspect) · POST { post_id } (add an eligible post) · PATCH { paused, reason? } (pause/resume).
import { z } from 'zod';
import { addToContentQueue, getContentQueue, setContentQueuePaused } from '@social-lite/services/gov/reuse';
import { parseJson, route } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route<{ id: string }>(async ({ req, ctx, params }) => getContentQueue(ctx, params.id, { include_removed: req.nextUrl.searchParams.get('include_removed') === '1' }));
export const POST = route<{ id: string }>(async ({ req, ctx, params }) => {
  const { post_id } = await parseJson(req, z.object({ post_id: z.string().uuid() }).strict());
  return addToContentQueue(ctx, post_id, params.id);
});
export const PATCH = route<{ id: string }>(async ({ req, ctx, params }) => setContentQueuePaused(ctx, params.id, await parseJson(req, z.unknown())));
