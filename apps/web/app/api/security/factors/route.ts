// POST /api/security/factors { action, credential_id? } — start a Keycloak application-initiated action for the
// caller's OWN account (set up TOTP / passkey / recovery codes, or remove a factor). Removal, regeneration and
// replacement need a fresh MFA-verified session (401 step_up_required). Returns { redirect_url } and binds the
// round trip to this browser with the short-lived login-binding cookie.
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { config } from '@social-lite/services';
import { LOGIN_BINDING_COOKIE, LOGIN_STATE_TTL_MS } from '@social-lite/services/auth/oidc';
import { startFactorAction } from '@social-lite/services/security';
import { parseJson, route } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const body = z.object({ action: z.string().max(60), credential_id: z.string().uuid().nullish() });

export const POST = route(async ({ req, session, ctx }) => {
  const input = await parseJson(req, body);
  const started = await startFactorAction(ctx.actor.userId, session, input);
  const res = NextResponse.json({ redirect_url: started.authorizationUrl });
  res.cookies.set(LOGIN_BINDING_COOKIE, started.binding, { httpOnly: true, sameSite: 'lax', secure: config().APP_ENV === 'production', path: '/', maxAge: LOGIN_STATE_TTL_MS / 1000 });
  return res;
}, { workspace: false });
