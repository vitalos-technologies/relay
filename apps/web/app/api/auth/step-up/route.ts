// GET /api/auth/step-up?returnTo=/path[&mode=fresh|mfa] — re-authenticate the CURRENT session at the IdP.
//  fresh (default): acr_values=mfa + max_age=0 → password + second factor again, new auth_time.
//  mfa: acr_values=mfa → second factor only on top of the IdP session (used right after password sign-in).
// Users without a second factor are sent to My Security to set one up. Assurance is only ever updated by the
// callback from the verified ID token, and only if the returned subject is this session's subject.
import { NextResponse } from 'next/server';
import { AppError } from '@social-lite/core';
import { SESSION_COOKIE, config, log, resolveSession } from '@social-lite/services';
import { LOGIN_BINDING_COOKIE, LOGIN_STATE_TTL_MS, safeReturnTo, startStepUp } from '@social-lite/services/auth/oidc';
import { clientIp, enforceRateLimit } from '@social-lite/services/ratelimit';
import { publicRoute } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = publicRoute(async ({ req, correlationId }) => {
  const base = config().APP_BASE_URL;
  const sp = req.nextUrl.searchParams;
  const returnTo = safeReturnTo(sp.get('returnTo'));
  const current = await resolveSession(req.cookies.get(SESSION_COOKIE)?.value);
  if (!current) return NextResponse.redirect(new URL(`/login?returnTo=${encodeURIComponent(returnTo)}`, base), 302);
  try {
    await enforceRateLimit('authLogin', clientIp(req.headers));
    const started = await startStepUp(current.session, { returnTo, mode: sp.get('mode') === 'mfa' ? 'mfa' : 'fresh', loginHint: current.actor.email });
    if ('setupRequired' in started) {
      // Right after sign-in nothing to add; otherwise ask the user to set up a second factor first.
      const to = sp.get('mode') === 'mfa' ? returnTo : '/security?setup=mfa';
      return NextResponse.redirect(new URL(to, base), 302);
    }
    const res = NextResponse.redirect(started.authorizationUrl, 302);
    res.cookies.set(LOGIN_BINDING_COOKIE, started.binding, {
      httpOnly: true, sameSite: 'lax', secure: config().APP_ENV === 'production', path: '/', maxAge: LOGIN_STATE_TTL_MS / 1000,
    });
    res.headers.set('cache-control', 'no-store');
    return res;
  } catch (err) {
    if (!(err instanceof AppError)) log.error('oidc_step_up_start_failed', { correlationId, err: err as Error });
    return NextResponse.redirect(new URL(`/security?error=${err instanceof AppError && err.code === 'rate_limited' ? 'rate_limited' : 'idp_unavailable'}`, base), 302);
  }
});
