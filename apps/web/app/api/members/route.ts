// GET /api/members?q=&status=&team_id=&role= — V2 member directory (members.read): grants (scope, source,
// expiry), teams, status, last sign-in; plus open invitations for those who may invite.
import { listMembers } from '@social-lite/services/members';
import { route } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route(async ({ req, ctx }) => {
  const sp = req.nextUrl.searchParams;
  const status = sp.get('status');
  return listMembers(ctx, { q: sp.get('q') ?? undefined, team_id: sp.get('team_id') ?? undefined, role: sp.get('role') ?? undefined,
    status: status === 'active' || status === 'suspended' ? status : undefined });
});
