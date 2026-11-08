// POST /api/members/:userId/reactivate — end a suspension (held publications stay held until adopted).
import { reactivateMember } from '@social-lite/services/lifecycle';
import { route } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = route<{ userId: string }>(async ({ ctx, params }) => reactivateMember(ctx, params.userId));
