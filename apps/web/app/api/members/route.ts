// GET /api/members — { members, invitations } (invitations only for owner/admin).
import { listMembers } from '@social-lite/services/members';
import { route } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route(async ({ ctx }) => listMembers(ctx));
