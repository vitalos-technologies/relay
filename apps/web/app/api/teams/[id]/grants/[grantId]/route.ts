// DELETE /api/teams/:id/grants/:grantId — revoke a team grant (holds affected queued publications).
import { revokeTeamGrant } from '@social-lite/services/teams';
import { route } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const DELETE = route<{ id: string; grantId: string }>(async ({ ctx, params }) => revokeTeamGrant(ctx, params.id, params.grantId));
