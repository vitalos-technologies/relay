// GET /api/auth/login?returnTo=/path&invite=<token>[&mode=signup][&login_hint=email] — starts OIDC (state + nonce + PKCE) and
// 302s to the IdP's passwordless sign-in page (D34: Continue with Google · or · email link + code; mode=signup shows the
// "Create your Relay account" heading).
import { NextResponse } from 'next/server';
import { AppError } from '@social-lite/core';
import { config, log } from '@social-lite/services';
import { LOGIN_BINDING_COOKIE, LOGIN_STATE_TTL_MS, startLogin } from '@social-lite/services/auth/oidc';
import { clientIp, enforceRateLimit } from '@social-lite/services/ratelimit';
import { publicRoute } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = publicRoute(async ({ req, correlationId }) => {
  const base = config().APP_BASE_URL;
  try {
    await enforceRateLimit('authLogin', clientIp(req.headers));
    const sp = req.nextUrl.searchParams;
    const { authorizationUrl, binding } = await startLogin({ returnTo: sp.get('returnTo'), invite: sp.get('invite'), mode: sp.get('mode'), loginHint: sp.get('login_hint') });
    const res = NextResponse.redirect(authorizationUrl, 302);
    res.cookies.set(LOGIN_BINDING_COOKIE, binding, {
      httpOnly: true, sameSite: 'lax', secure: config().APP_ENV === 'production', path: '/', maxAge: LOGIN_STATE_TTL_MS / 1000,
    });
    res.headers.set('cache-control', 'no-store');
    return res;
  } catch (err) {
    const code = err instanceof AppError ? (err.code === 'rate_limited' ? 'rate_limited' : err.code === 'provider_not_configured' ? 'not_configured' : 'login_failed') : 'idp_unavailable';
    if (!(err instanceof AppError)) log.error('oidc_login_start_failed', { correlationId, err: err as Error });
    return NextResponse.redirect(new URL(`/login?error=${code}`, base), 302);
  }
});
