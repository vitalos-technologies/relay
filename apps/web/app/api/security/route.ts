// GET /api/security — the caller's own assurance, sign-in factors (from the IdP), sessions and recent security events.
import { securityOverview } from '@social-lite/services/security';
import { route } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route(async ({ session, ctx }) => securityOverview(ctx.actor.userId, session), { workspace: false });
