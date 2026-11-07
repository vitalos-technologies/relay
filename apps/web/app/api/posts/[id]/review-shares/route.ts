// GET/POST /api/posts/:id/review-shares — share this post's review requests with a guest of the brand.
import { z } from 'zod';
import { listReviewShares, shareReview } from '@social-lite/services';
import { parseJson, route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const body = z.object({ user_id: z.string().uuid() }).strict();
export const GET = route<{ id: string }>(async ({ ctx, params }) => listReviewShares(ctx, params.id));
export const POST = route<{ id: string }>(async ({ req, ctx, params }) => shareReview(ctx, params.id, (await parseJson(req, body)).user_id));
