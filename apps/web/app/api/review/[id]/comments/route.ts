// POST /api/review/:id/comments — shared comment from the review portal.
import { z } from 'zod';
import { addReviewComment } from '@social-lite/services';
import { parseJson, route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const body = z.object({ body: z.string().min(1).max(5000) }).strict();
export const POST = route<{ id: string }>(async ({ req, ctx, params }) => addReviewComment(ctx, params.id, (await parseJson(req, body)).body));
