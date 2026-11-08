// DELETE /api/grants/:id — revoke a member grant (delegation ceiling; owner grants: owner + last-owner rule).
import { revokeGrant } from '@social-lite/services/members';
import { route } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const DELETE = route<{ id: string }>(async ({ ctx, params }) => revokeGrant(ctx, params.id));
