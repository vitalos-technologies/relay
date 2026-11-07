// GET /api/platform/me — is this user a platform operator, and is the session fresh enough for platform changes.
import { loadOperatorRole } from '@social-lite/services/admin/platform';
import { DEFAULT_STEP_UP_SECONDS } from '@social-lite/services/security';
import { route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route(async ({ ctx, session }) => {
  const role = await loadOperatorRole(ctx.actor.userId);
  const fresh = !!session.mfaVerified && !!session.authTime && Date.now() - session.authTime.getTime() <= DEFAULT_STEP_UP_SECONDS * 1000;
  return { operator: !!role, role, fresh };
}, { workspace: false });
