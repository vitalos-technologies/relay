// GET /api/auth/callback — completes OIDC for login, step-up and IdP (Keycloak) actions.
//  login: binds/creates the user, accepts a pending invitation, revokes any session the browser already had,
//         sets a NEW session cookie; if the user has a second factor that this sign-in did not use, continues to
//         a second-factor prompt (acr_values=mfa) before landing.
//  step_up / idp_action: only for the SAME live session; assurance re-read from the verified ID token and the
//         session token rotated.
import { NextResponse } from 'next/server';
import { AppError } from '@social-lite/core';
import { SESSION_COOKIE, SESSION_TTL_MS, config, log, resolveSession } from '@social-lite/services';
import { LOGIN_BINDING_COOKIE, completeLogin, loginErrorRedirect } from '@social-lite/services/auth/oidc';
import { LoginError } from '@social-lite/services/auth/users';
import { clientIp, enforceRateLimit } from '@social-lite/services/ratelimit';
import { publicRoute } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = publicRoute(async ({ req, correlationId }) => {
  const base = config().APP_BASE_URL;
  const secure = config().APP_ENV === 'production';
  const cookie = { httpOnly: true, sameSite: 'lax' as const, secure, path: '/', maxAge: Math.floor(SESSION_TTL_MS / 1000) };
  let res: NextResponse;
  try {
    await enforceRateLimit('authCallback', clientIp(req.headers));
    const ip = clientIp(req.headers);
    const current = await resolveSession(req.cookies.get(SESSION_COOKIE)?.value);
    const result = await completeLogin(req.nextUrl.searchParams, {
      binding: req.cookies.get(LOGIN_BINDING_COOKIE)?.value, userAgent: req.headers.get('user-agent'), ip: ip === 'unknown' ? null : ip,
      currentSession: current?.session ?? null,
    });
    let target = result.redirectTo;
    if (result.purpose === 'login' && result.needsSecondFactor && !result.invitation?.error) {
      target = `/api/auth/step-up?mode=mfa&returnTo=${encodeURIComponent(result.redirectTo)}`;
    }
    res = NextResponse.redirect(new URL(target, base), 302);
    if (result.token) res.cookies.set(SESSION_COOKIE, result.token, cookie);
  } catch (err) {
    if (!(err instanceof LoginError) && !(err instanceof AppError)) log.error('oidc_callback_failed', { correlationId, err: err as Error });
    else log.warn('oidc_login_refused', { correlationId, code: err instanceof LoginError ? err.code : err.code });
    const path = err instanceof AppError && err.code === 'rate_limited' ? '/login?error=rate_limited' : loginErrorRedirect(err);
    res = NextResponse.redirect(new URL(path, base), 302);
  }
  res.cookies.set(LOGIN_BINDING_COOKIE, '', { httpOnly: true, sameSite: 'lax', secure, path: '/', maxAge: 0 });
  res.headers.set('cache-control', 'no-store');
  return res;
});
