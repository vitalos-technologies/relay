// DELETE /api/posts/:id/review-shares/:userId — revoke (takes effect on the guest's next request).
import { revokeReviewShare } from '@social-lite/services';
import { route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const DELETE = route<{ id: string; userId: string }>(async ({ ctx, params }) => revokeReviewShare(ctx, params.id, params.userId));
