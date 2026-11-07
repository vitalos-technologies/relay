// GET /api/members/:userId/access — effective access: brands/connections, actions, source grant
// (direct/team), expiry, restrictions and the policy version used.
import { effectiveAccess } from '@social-lite/services/access';
import { route } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route<{ userId: string }>(async ({ ctx, params }) => effectiveAccess(ctx, params.userId));
