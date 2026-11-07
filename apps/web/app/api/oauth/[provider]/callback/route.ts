// GET /api/oauth/:provider/callback — public (provider redirect) but REQUIRES the current session user to
// be the user who started the flow. 302 => /accounts/select?flow=<id> or /accounts?error=<code>.
// Provider error text is never echoed.
import { NextResponse } from 'next/server';
import { config, log } from '@social-lite/services';
import { handleOAuthCallback } from '@social-lite/services/connections/index';
import { clientIp, enforceRateLimit } from '@social-lite/services/ratelimit';
import { currentSession, publicRoute } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = publicRoute<{ provider: string }>(async ({ req, params, correlationId }) => {
  const base = config().APP_BASE_URL;
  let location: string;
  try {
    await enforceRateLimit('oauthCallback', clientIp(req.headers), { capacity: 30, refillPerSecond: 30 / 60 });
    const session = await currentSession();
    const r = await handleOAuthCallback({ provider: params.provider, params: req.nextUrl.searchParams, sessionUserId: session?.actor.userId ?? null });
    if (r.error) log.warn('oauth_connect_refused', { correlationId, provider: params.provider, code: r.error });
    location = r.location;
  } catch (err) {
    log.error('oauth_connect_callback_failed', { correlationId, provider: params.provider, err: err as Error });
    location = '/accounts?error=internal';
  }
  const res = NextResponse.redirect(new URL(location, base), 302);
  res.headers.set('cache-control', 'no-store');
  res.headers.set('referrer-policy', 'no-referrer');
  return res;
});
