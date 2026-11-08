// GET /api/content-hub/oauth/:source/callback — public redirect target; the state is consumed only by the
// session user who started the flow. 302 → /settings/connections/<source>?connected=<id> | ?error=<code>. Provider text never echoed.
import { NextResponse } from 'next/server';
import { config, log } from '@social-lite/services';
import { contentReturnPath, handleContentOAuthCallback } from '@social-lite/services/content-hub/index';
import { clientIp, enforceRateLimit } from '@social-lite/services/ratelimit';
import { currentSession, publicRoute } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = publicRoute<{ source: string }>(async ({ req, params, correlationId }) => {
  let location: string;
  try {
    await enforceRateLimit('oauthCallback', clientIp(req.headers), { capacity: 30, refillPerSecond: 30 / 60 });
    const session = await currentSession();
    const r = await handleContentOAuthCallback({ source: params.source, params: req.nextUrl.searchParams, sessionUserId: session?.actor.userId ?? null });
    if (r.error) log.warn('content_oauth_refused', { correlationId, source: params.source, code: r.error });
    location = r.location;
  } catch (err) {
    log.error('content_oauth_callback_failed', { correlationId, source: params.source, err: err as Error });
    location = `${contentReturnPath(params.source)}?error=internal`;
  }
  const res = NextResponse.redirect(new URL(location, config().APP_BASE_URL), 302);
  res.headers.set('cache-control', 'no-store');
  res.headers.set('referrer-policy', 'no-referrer');
  return res;
});
