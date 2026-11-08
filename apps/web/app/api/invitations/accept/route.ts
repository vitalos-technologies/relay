// POST /api/invitations/accept { token } — a signed-in user joins another workspace with THEIR identity
// (issuer+subject; IdP-verified email must match). Switches the session to the new workspace.
import { z } from 'zod';
import { AppError } from '@social-lite/core';
import { acceptInvitationForUser } from '@social-lite/services/auth/invitations';
import { LoginError } from '@social-lite/services/auth/users';
import { setActiveWorkspace } from '@social-lite/services/auth/session';
import { getPool } from '@social-lite/db';
import { parseJson, route } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const body = z.object({ token: z.string().min(1).max(200) }).strict();

export const POST = route(async ({ req, ctx, session }) => {
  const { token } = await parseJson(req, body);
  try {
    const r = await acceptInvitationForUser(ctx.actor.userId, token);
    await setActiveWorkspace(getPool(), session.id, r.workspaceId);
    return { workspace_id: r.workspaceId, already_member: r.alreadyMember };
  } catch (e) {
    if (e instanceof LoginError) throw new AppError('invalid_state', e.message, undefined, { reason: e.code });
    throw e;
  }
}, { workspace: false });
