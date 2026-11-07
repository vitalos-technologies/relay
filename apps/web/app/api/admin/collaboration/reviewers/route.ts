// GET /api/admin/collaboration/reviewers?brand_id= — eligible reviewers per approval stage.
import { eligibleReviewersByBrand } from '@social-lite/services';
import { route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route(async ({ req, ctx }) => eligibleReviewersByBrand(ctx, req.nextUrl.searchParams.get('brand_id') ?? ''));
