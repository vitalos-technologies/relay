// GET  /api/approvals/:id/reviewers — requested reviewers. POST { user_ids } — ask eligible people to review.
import { z } from 'zod';
import { listRequestedReviewers, requestReviewers } from '@social-lite/services';
import { parseJson, route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const body = z.object({ user_ids: z.array(z.string().uuid()).min(1).max(10) }).strict();
export const GET = route<{ id: string }>(async ({ ctx, params }) => listRequestedReviewers(ctx, params.id));
export const POST = route<{ id: string }>(async ({ req, ctx, params }) => requestReviewers(ctx, params.id, (await parseJson(req, body)).user_ids));
