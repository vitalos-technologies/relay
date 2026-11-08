// POST /api/auth/logout — revokes the server-side session, clears the cookie and returns the IdP's
// RP-initiated logout URL (ends the identity-provider session too) for the client to navigate to.
import { NextResponse } from 'next/server';
import { getPool } from '@social-lite/db';
import { SESSION_COOKIE, audit, config, revokeSession } from '@social-lite/services';
import { idpLogoutUrl } from '@social-lite/services/auth/oidc';
import { route } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = route(async ({ session, ctx }) => {
  const logoutUrl = await idpLogoutUrl(session.id);
  await revokeSession(getPool(), session.id, 'signed_out');
  await audit(getPool(), { workspaceId: null, actorUserId: ctx.actor.userId, action: 'session.signed_out', resourceType: 'session', resourceId: session.id });
  const res = NextResponse.json({ ok: true, logout_url: logoutUrl });
  res.cookies.set(SESSION_COOKIE, '', { httpOnly: true, sameSite: 'lax', secure: config().APP_ENV === 'production', path: '/', maxAge: 0 });
  return res;
}, { workspace: false });
