// GET /api/members/:userId/removal-impact — handover preview (kept for the V1 removal dialog).
import { handoverPreview } from '@social-lite/services/lifecycle';
import { route } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route<{ userId: string }>(async ({ ctx, params }) => handoverPreview(ctx, params.userId));
