// GET /api/members/:userId/removal-impact — consequences shown before removal (spec §6).
import { removalImpact } from '@social-lite/services/members';
import { route } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route<{ userId: string }>(async ({ ctx, params }) => removalImpact(ctx, params.userId));
