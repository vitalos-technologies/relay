// GET /api/teams/:id/candidates — active workspace members not yet in the team (picker).
import { teamCandidates } from '@social-lite/services/teams';
import { route } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route<{ id: string }>(async ({ ctx, params }) => teamCandidates(ctx, params.id));
