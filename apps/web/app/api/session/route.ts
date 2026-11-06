// GET /api/session — SessionInfo (user, csrf token, active workspace, permissions).
import { sessionInfo } from '@social-lite/services/workspaces';
import { route } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route(async ({ session, ctx }) => sessionInfo(session, ctx.actor), { workspace: false });
