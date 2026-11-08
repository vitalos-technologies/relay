// GET /api/review/:id — exact outgoing variants, media previews, shared comments, stage progress (share re-checked).
import { getReview } from '@social-lite/services';
import { route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route<{ id: string }>(async ({ ctx, params }) => getReview(ctx, params.id));
