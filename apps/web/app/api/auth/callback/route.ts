// GET /api/auth/callback — completes OIDC, binds/creates the user, accepts a pending invitation,
// sets the session cookie and 302s to returnTo (or /invite/<token>?error=... / /login?error=...).
import { NextResponse } from 'next/server';
import { AppError } from '@social-lite/core';
import { SESSION_COOKIE, SESSION_TTL_MS, config, log } from '@social-lite/services';
import { LOGIN_BINDING_COOKIE, completeLogin, loginErrorRedirect } from '@social-lite/services/auth/oidc';
import { LoginError } from '@social-lite/services/auth/users';
import { clientIp, enforceRateLimit } from '@social-lite/services/ratelimit';
import { publicRoute } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = publicRoute(async ({ req, correlationId }) => {
  const base = config().APP_BASE_URL;
  const secure = config().APP_ENV === 'production';
  let res: NextResponse;
  try {
    enforceRateLimit('authCallback', clientIp(req.headers));
    const ip = clientIp(req.headers);
    const result = await completeLogin(req.nextUrl.searchParams, {
      binding: req.cookies.get(LOGIN_BINDING_COOKIE)?.value, userAgent: req.headers.get('user-agent'), ip: ip === 'unknown' ? null : ip,
    });
    res = NextResponse.redirect(new URL(result.redirectTo, base), 302);
    res.cookies.set(SESSION_COOKIE, result.token, { httpOnly: true, sameSite: 'lax', secure, path: '/', maxAge: Math.floor(SESSION_TTL_MS / 1000) });
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
