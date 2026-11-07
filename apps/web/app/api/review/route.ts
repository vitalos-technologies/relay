// GET /api/review — the caller's shared review requests (guest portal).
import { listMyReviews } from '@social-lite/services';
import { route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route(async ({ ctx }) => listMyReviews(ctx));
