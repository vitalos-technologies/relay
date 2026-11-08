// POST /api/security/sessions/revoke-others — sign out every other session of the caller.
import { revokeMyOtherSessions } from '@social-lite/services/security';
import { route } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = route(async ({ session, ctx }) => revokeMyOtherSessions(ctx.actor.userId, session), { workspace: false });
