// GET /api/connectors/oauth/:connector/callback — public redirect target; the state is consumed only by the session user who
// started the flow; authority re-checked; 302 → /integrations/<connector>?connected=<id> | ?error=<code>. Provider text never echoed.
import { NextResponse } from 'next/server';
import { config, log } from '@social-lite/services';
import { handleIntegrationOAuthCallback, integrationReturnPath } from '@social-lite/services/integrations-v35/index';
import { clientIp, enforceRateLimit } from '@social-lite/services/ratelimit';
import { currentSession, publicRoute } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = publicRoute<{ connector: string }>(async ({ req, params, correlationId }) => {
  let location: string;
  try {
    await enforceRateLimit('oauthCallback', clientIp(req.headers), { capacity: 30, refillPerSecond: 30 / 60 });
    const session = await currentSession();
    const r = await handleIntegrationOAuthCallback({ connector: params.connector, params: req.nextUrl.searchParams, sessionUserId: session?.actor.userId ?? null });
    if (r.error) log.warn('integration_oauth_refused', { correlationId, connector: params.connector, code: r.error });
    location = r.location;
  } catch (err) {
    log.error('integration_oauth_callback_failed', { correlationId, connector: params.connector, err: err as Error });
    location = `${integrationReturnPath(params.connector) || '/integrations'}?error=internal`;
  }
  const res = NextResponse.redirect(new URL(location, config().APP_BASE_URL), 302);
  res.headers.set('cache-control', 'no-store');
  res.headers.set('referrer-policy', 'no-referrer');
  return res;
});
